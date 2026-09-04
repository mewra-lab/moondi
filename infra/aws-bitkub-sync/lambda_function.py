"""Read Bitkub account data and deliver only normalized data to Moondi's API.

The function has no public HTTP trigger or database credentials. EventBridge
Scheduler is its production invoker, and secrets stay in SSM Parameter Store.
"""

import hashlib
import hmac
import json
import logging
import math
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from itertools import chain
from typing import Any, Iterable, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

import boto3


LOG = logging.getLogger()
LOG.setLevel(logging.INFO)
SSM = boto3.client("ssm")
BITKUB_BASE_URL = "https://api.bitkub.com"
MAX_RESPONSE_BYTES = 1_048_576
MAX_INGESTION_RECORDS = 250
MAX_INGESTION_BODY_BYTES = 400 * 1_024
MAX_PAGINATION_PAGES = 1_000
USER_AGENT = "moondi-aws-bitkub-sync/1.0"


class HttpStageError(RuntimeError):
    """A redacted HTTP error that identifies only the failing integration boundary."""

    def __init__(self, stage: str, status: int, content_type: str, cf_ray: str) -> None:
        super().__init__(f"{stage} returned HTTP {status}")
        self.stage = stage
        self.status = status
        self.content_type = content_type
        self.cf_ray = cf_ray


class BitkubApplicationError(RuntimeError):
    """A redacted Bitkub application error safe to identify in CloudWatch."""

    def __init__(self, stage: str, code: str) -> None:
        super().__init__(f"{stage} returned provider error {code}")
        self.stage = stage
        self.code = code


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing environment configuration: {name}")
    return value


def read_secure_parameter(name: str) -> str:
    response = SSM.get_parameter(Name=name, WithDecryption=True)
    value = response["Parameter"]["Value"]
    if not value:
        raise RuntimeError("received an empty secure parameter")
    return value


def read_json(url: str, headers: dict[str, str], stage: str) -> Any:
    try:
        request = Request(url, headers=headers, method="GET")
        with urlopen(request, timeout=10) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise RuntimeError("provider response exceeded size limit")
            return json.loads(body.decode("utf-8"))
    except HTTPError as error:
        raise HttpStageError(
            stage,
            error.code,
            error.headers.get_content_type(),
            error.headers.get("CF-Ray", "")[:64],
        ) from None


def bitkub_headers(api_key: str, api_secret: str, timestamp: str, path: str) -> dict[str, str]:
    payload = f"{timestamp}GET{path}".encode("utf-8")
    signature = hmac.new(api_secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-BTK-APIKEY": api_key,
        "X-BTK-TIMESTAMP": timestamp,
        "X-BTK-SIGN": signature,
    }


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def safe_asset(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not value.isupper()
        or not value.replace("_", "").replace("-", "").isalnum()
        or len(value) > 20
    ):
        raise RuntimeError("Bitkub returned an unsafe asset")
    return value


def safe_record_id(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 256
        or not all(character.isascii() and (character.isalnum() or character in "._:-") for character in value)
    ):
        raise RuntimeError(f"Bitkub returned an invalid {field}")
    return value


def finite_number(value: Any, field: str, *, positive: bool = False) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"Bitkub returned a non-numeric {field}") from None
    if not math.isfinite(number) or number < 0 or (positive and number == 0):
        raise RuntimeError(f"Bitkub returned an unsafe {field}")
    return number


def milliseconds(value: Any, field: str) -> int:
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"Bitkub returned an invalid {field}") from None
    if not math.isfinite(timestamp) or timestamp <= 0:
        raise RuntimeError(f"Bitkub returned an invalid {field}")
    return int(timestamp * 1_000) if timestamp < 10_000_000_000 else int(timestamp)


def iso_milliseconds(value: Any, field: str) -> int:
    if not isinstance(value, str) or len(value) > 64:
        raise RuntimeError(f"Bitkub returned an invalid {field}")
    try:
        from datetime import datetime

        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        timestamp = int(parsed.timestamp() * 1_000)
    except ValueError:
        raise RuntimeError(f"Bitkub returned an invalid {field}") from None
    if timestamp <= 0:
        raise RuntimeError(f"Bitkub returned an invalid {field}")
    return timestamp


def response_data(response: Any, stage: str) -> Any:
    if not isinstance(response, dict):
        raise RuntimeError(f"{stage} returned an invalid response")
    error = response.get("error")
    code = response.get("code")
    if (error is not None and str(error) != "0") or (code is not None and str(code) != "0"):
        provider_code = str(error if error is not None and str(error) != "0" else code)
        raise BitkubApplicationError(stage, provider_code)
    if "data" in response:
        return response["data"]
    if "result" in response:
        return response["result"]
    raise RuntimeError(f"{stage} returned no data")


def bitkub_secure_json(api_key: str, api_secret: str, path: str, query: list[tuple[str, str]], stage: str) -> Any:
    encoded_query = urlencode(query)
    request_path = path if not encoded_query else f"{path}?{encoded_query}"
    timestamp = str(read_json(f"{BITKUB_BASE_URL}/api/v3/servertime", {"Accept": "application/json"}, "bitkub_servertime"))
    return read_json(
        f"{BITKUB_BASE_URL}{request_path}",
        bitkub_headers(api_key, api_secret, timestamp, request_path),
        stage,
    )


def bitkub_balances(api_key: str, api_secret: str) -> list[dict[str, float | str]]:
    raw_balances = response_data(
        bitkub_secure_json(api_key, api_secret, "/api/v4/wallet/balances", [], "bitkub_balances"),
        "bitkub_balances",
    )
    if not isinstance(raw_balances, list) or not raw_balances or len(raw_balances) > 250:
        raise RuntimeError("Bitkub returned an invalid balance collection")

    normalized: list[dict[str, float | str]] = []
    seen_assets: set[str] = set()
    for balance in raw_balances:
        if not isinstance(balance, dict):
            raise RuntimeError("Bitkub returned an invalid balance item")
        asset = safe_asset(balance.get("currency"))
        available = finite_number(balance.get("available"), "balance")
        reserved = finite_number(balance.get("reserved"), "balance")
        if asset in seen_assets:
            raise RuntimeError("Bitkub returned an unsafe balance item")
        seen_assets.add(asset)
        normalized.append({"asset": asset, "available": available, "reserved": reserved})
    return normalized


def safe_symbol(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 41:
        raise RuntimeError("Bitkub returned an unsafe symbol")
    base_asset, separator, quote_asset = value.rpartition("_")
    if not separator or value != f"{safe_asset(base_asset)}_{safe_asset(quote_asset)}":
        raise RuntimeError("Bitkub returned an unsafe symbol")
    return value


def bitkub_trade_symbols() -> set[str]:
    response = read_json(f"{BITKUB_BASE_URL}/api/v3/market/symbols", {"Accept": "application/json"}, "bitkub_symbols")
    symbols = response_data(response, "bitkub_symbols") if isinstance(response, dict) else response
    if not isinstance(symbols, list) or len(symbols) > 1_000:
        raise RuntimeError("Bitkub returned an invalid symbol collection")
    symbols_for_history: set[str] = set()
    for item in symbols:
        if not isinstance(item, dict) or item.get("source") != "exchange" or item.get("status") != "active":
            continue
        symbols_for_history.add(safe_symbol(item.get("symbol")))
    return symbols_for_history


def map_trade(order: Any, symbol: str) -> dict[str, Any]:
    if not isinstance(order, dict):
        raise RuntimeError("Bitkub returned an invalid trade")
    external_id = safe_record_id(order.get("txn_id"), "trade ID")
    side = order.get("side")
    if side not in {"buy", "sell"}:
        raise RuntimeError("Bitkub returned an invalid trade")
    base_asset, _, quote_asset = safe_symbol(symbol).rpartition("_")
    price = finite_number(order.get("rate"), "trade price", positive=True)
    fee = finite_number(order.get("fee"), "trade fee")
    order_amount = finite_number(order.get("amount"), "trade amount")
    credit = finite_number(order.get("credit", 0), "trade credit")
    received = order.get("receive")
    amount = order_amount if side == "sell" else (finite_number(received, "trade receive") if received is not None else (order_amount - max(fee - credit, 0)) / price)
    quote_amount = order_amount if side == "buy" else amount * price
    if not math.isfinite(amount) or amount < 0:
        raise RuntimeError("Bitkub returned an invalid trade amount")
    return {
        "id": external_id,
        "side": side,
        "baseAsset": safe_asset(base_asset),
        "quoteAsset": safe_asset(quote_asset),
        "price": price,
        "amount": amount,
        "quoteAmount": quote_amount,
        "fee": fee,
        "feeAsset": "THB",
        "executedAt": milliseconds(order.get("ts"), "trade timestamp"),
    }


def bitkub_trades(api_key: str, api_secret: str, since: int | None) -> Iterator[dict[str, Any]]:
    tradable_symbols = sorted(bitkub_trade_symbols())

    def for_symbol(symbol: str) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        cursor: str | None = None
        page_count = 0
        while True:
            page_count += 1
            if page_count > MAX_PAGINATION_PAGES:
                raise RuntimeError("Bitkub returned unsafe trade pagination")
            query = [("lmt", "100"), ("pagination_type", "keyset"), ("sym", symbol)]
            if cursor is not None:
                query.append(("cursor", cursor))
            if since is not None:
                query.append(("start", str(since)))
            response = bitkub_secure_json(api_key, api_secret, "/api/v3/market/my-order-history", query, "bitkub_trades")
            if isinstance(response, dict) and (str(response.get("error")) == "81" or str(response.get("code")) == "81"):
                return []
            page = response_data(response, "bitkub_trades")
            if not isinstance(page, list):
                raise RuntimeError("Bitkub returned an invalid trade collection")
            records.extend(map_trade(order, symbol) for order in page)
            pagination = response.get("pagination") if isinstance(response, dict) else None
            next_cursor = pagination.get("cursor") if isinstance(pagination, dict) else None
            if not isinstance(pagination, dict) or pagination.get("has_next") is not True or not isinstance(next_cursor, str) or next_cursor == cursor:
                break
            cursor = next_cursor
        return records

    with ThreadPoolExecutor(max_workers=3) as executor:
        for offset in range(0, len(tradable_symbols), 3):
            for symbol_records in executor.map(for_symbol, tradable_symbols[offset:offset + 3]):
                yield from symbol_records


def map_crypto_transfer(record: Any, direction: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise RuntimeError("Bitkub returned an invalid crypto transfer")
    asset = safe_asset(record.get("symbol"))
    created_at = record.get("created_at")
    transaction_id = record.get("txn_id")
    tx_hash = record.get("hash")
    if transaction_id is None:
        fingerprint = compact_json([direction, asset, tx_hash, created_at]).encode("utf-8")
        transaction_id = f"{direction}:{asset}:{hashlib.sha256(fingerprint).hexdigest()}"
    result: dict[str, Any] = {
        "id": safe_record_id(transaction_id, "crypto transfer ID"),
        "direction": direction,
        "asset": asset,
        "amount": finite_number(record.get("amount"), "crypto transfer amount"),
        "fee": finite_number(record.get("fee", 0), "crypto transfer fee"),
        "executedAt": iso_milliseconds(record.get("completed_at") or created_at, "crypto transfer timestamp"),
    }
    if isinstance(tx_hash, str) and tx_hash and tx_hash.isascii() and tx_hash.isprintable() and len(tx_hash) <= 512:
        result["txHash"] = tx_hash
    return result


def bitkub_crypto_transfers(api_key: str, api_secret: str, path: str, direction: str, since: int | None) -> Iterator[dict[str, Any]]:
    page = 1
    total_pages = 1
    while page <= total_pages:
        query = [("limit", "200"), ("page", str(page))]
        if since is not None:
            query.append(("created_start", time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(since / 1_000))))
        data = response_data(bitkub_secure_json(api_key, api_secret, path, query, f"bitkub_{direction}s"), f"bitkub_{direction}s")
        if not isinstance(data, dict) or not isinstance(data.get("items"), list) or not isinstance(data.get("total_page"), int):
            raise RuntimeError("Bitkub returned an invalid crypto transfer collection")
        total_pages = data["total_page"]
        if total_pages < page or total_pages > MAX_PAGINATION_PAGES:
            raise RuntimeError("Bitkub returned an unsafe crypto transfer pagination")
        for item in data["items"]:
            yield map_crypto_transfer(item, direction)
        page += 1


def map_fiat_transfer(record: Any, direction: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise RuntimeError("Bitkub returned an invalid fiat transfer")
    return {
        "id": safe_record_id(record.get("txn_id"), "fiat transfer ID"),
        "direction": direction,
        "currency": safe_asset(record.get("currency")),
        "amount": finite_number(record.get("amount"), "fiat transfer amount"),
        "fee": finite_number(record.get("fee", 0), "fiat transfer fee"),
        "executedAt": milliseconds(record.get("time"), "fiat transfer timestamp"),
    }


def bitkub_fiat_transfers(api_key: str, api_secret: str, path: str, direction: str, since: int | None) -> Iterator[dict[str, Any]]:
    page = 1
    while True:
        data = response_data(bitkub_secure_json(api_key, api_secret, path, [("limit", "100"), ("page", str(page))], f"bitkub_fiat_{direction}s"), f"bitkub_fiat_{direction}s")
        if not isinstance(data, list) or len(data) > 100:
            raise RuntimeError("Bitkub returned an invalid fiat transfer collection")
        mapped = [map_fiat_transfer(item, direction) for item in data]
        yield from (record for record in mapped if since is None or record["executedAt"] >= since)
        if len(data) < 100:
            return
        page += 1
        if page > MAX_PAGINATION_PAGES:
            raise RuntimeError("Bitkub returned unsafe fiat transfer pagination")


def ingestion_headers(
    access_client_id: str,
    access_client_secret: str,
    ingestion_secret: str,
    body: str,
) -> dict[str, str]:
    timestamp = str(int(time.time() * 1_000))
    nonce = uuid.uuid4().hex
    canonical = f"{timestamp}\n{nonce}\n{body}".encode("utf-8")
    signature = hmac.new(ingestion_secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
    return {
        "CF-Access-Client-Id": access_client_id,
        "CF-Access-Client-Secret": access_client_secret,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Moond-Ingest-Nonce": nonce,
        "X-Moond-Ingest-Signature": signature,
        "X-Moond-Ingest-Timestamp": timestamp,
    }


def internal_url(ingestion_url: str, endpoint: str) -> str:
    parsed_url = urlparse(ingestion_url)
    if parsed_url.scheme != "https" or not parsed_url.netloc or parsed_url.username or parsed_url.password:
        raise RuntimeError("MOONDI_INGESTION_URL must be an HTTPS URL without credentials")
    return f"{parsed_url.scheme}://{parsed_url.netloc}/internal/aws-sync/bitkub/{endpoint}"


def deliver(ingestion_url: str, headers: dict[str, str], body: str, stage: str) -> dict[str, Any]:
    try:
        request = Request(ingestion_url, data=body.encode("utf-8"), headers=headers, method="POST")
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"unexpected ingestion status: {response.status}")
            response_body = response.read(4_096)
    except HTTPError as error:
        raise HttpStageError(
            stage,
            error.code,
            error.headers.get_content_type(),
            error.headers.get("CF-Ray", "")[:64],
        ) from None
    decoded = json.loads(response_body.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise RuntimeError("ingestion response was not accepted")
    return decoded


def post_ingestion(
    ingestion_url: str,
    endpoint: str,
    access_client_id: str,
    access_client_secret: str,
    ingestion_secret: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    body = compact_json(payload)
    return deliver(
        internal_url(ingestion_url, endpoint),
        ingestion_headers(access_client_id, access_client_secret, ingestion_secret, body),
        body,
        f"moondi_{endpoint}",
    )


def optional_checkpoint(value: Any, name: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or value <= 0:
        raise RuntimeError(f"Moondi returned an invalid {name} checkpoint")
    return value


def sync_state(
    ingestion_url: str,
    access_client_id: str,
    access_client_secret: str,
    ingestion_secret: str,
    account_id: str,
) -> tuple[int | None, int | None, int | None]:
    response = post_ingestion(
        ingestion_url,
        "state",
        access_client_id,
        access_client_secret,
        ingestion_secret,
        {"accountId": account_id},
    )
    return (
        optional_checkpoint(response.get("tradesSince"), "trades"),
        optional_checkpoint(response.get("cryptoTransfersSince"), "crypto transfers"),
        optional_checkpoint(response.get("fiatTransfersSince"), "fiat transfers"),
    )


def ingest_history_chunk(
    ingestion_url: str,
    access_client_id: str,
    access_client_secret: str,
    ingestion_secret: str,
    account_id: str,
    data_type: str,
    records: list[dict[str, Any]],
    sync_at: int,
    complete: bool,
) -> None:
    response = post_ingestion(
        ingestion_url,
        "history",
        access_client_id,
        access_client_secret,
        ingestion_secret,
        {"accountId": account_id, "complete": complete, "dataType": data_type, "records": records, "syncAt": sync_at},
    )
    if (
        response.get("ingested") is not True
        or response.get("complete") is not complete
        or response.get("dataType") != data_type
        or response.get("recordCount") != len(records)
    ):
        raise RuntimeError("history ingestion response was not accepted")


def ingest_history_records(
    ingestion_url: str,
    access_client_id: str,
    access_client_secret: str,
    ingestion_secret: str,
    account_id: str,
    data_type: str,
    records: Iterable[dict[str, Any]],
    sync_at: int,
) -> int:
    buffered: list[dict[str, Any]] = []
    record_count = 0
    for record in records:
        candidate = buffered + [record]
        candidate_payload = {
            "accountId": account_id,
            "complete": False,
            "dataType": data_type,
            "records": candidate,
            "syncAt": sync_at,
        }
        if buffered and (
            len(candidate) > MAX_INGESTION_RECORDS
            or len(compact_json(candidate_payload).encode("utf-8")) > MAX_INGESTION_BODY_BYTES
        ):
            ingest_history_chunk(
                ingestion_url,
                access_client_id,
                access_client_secret,
                ingestion_secret,
                account_id,
                data_type,
                buffered,
                sync_at,
                False,
            )
            buffered = [record]
        else:
            buffered = candidate
        record_count += 1

    final_payload = {
        "accountId": account_id,
        "complete": True,
        "dataType": data_type,
        "records": buffered,
        "syncAt": sync_at,
    }
    if len(compact_json(final_payload).encode("utf-8")) > MAX_INGESTION_BODY_BYTES:
        raise RuntimeError("normalized history record exceeded ingestion size limit")
    ingest_history_chunk(
        ingestion_url,
        access_client_id,
        access_client_secret,
        ingestion_secret,
        account_id,
        data_type,
        buffered,
        sync_at,
        True,
    )
    return record_count


def lambda_handler(_event: dict[str, Any], _context: Any) -> dict[str, int | bool]:
    api_key = read_secure_parameter(required_environment("BITKUB_API_KEY_PARAMETER"))
    api_secret = read_secure_parameter(required_environment("BITKUB_API_SECRET_PARAMETER"))
    access_client_id = read_secure_parameter(required_environment("CF_ACCESS_CLIENT_ID_PARAMETER"))
    access_client_secret = read_secure_parameter(required_environment("CF_ACCESS_CLIENT_SECRET_PARAMETER"))
    ingestion_secret = read_secure_parameter(required_environment("AWS_INGESTION_SECRET_PARAMETER"))
    account_id = required_environment("MOONDI_ACCOUNT_ID")
    ingestion_url = required_environment("MOONDI_INGESTION_URL")

    try:
        trades_since, crypto_since, fiat_since = sync_state(
            ingestion_url,
            access_client_id,
            access_client_secret,
            ingestion_secret,
            account_id,
        )
        cycle_started_at = int(time.time() * 1_000)
        balances = bitkub_balances(api_key, api_secret)
        balance_response = post_ingestion(
            ingestion_url,
            "balances",
            access_client_id,
            access_client_secret,
            ingestion_secret,
            {"accountId": account_id, "balances": balances, "snapshotAt": cycle_started_at},
        )
        if balance_response.get("ingested") is not True:
            raise RuntimeError("balance ingestion response was not accepted")

        trades_count = ingest_history_records(
            ingestion_url, access_client_id, access_client_secret, ingestion_secret, account_id,
            "trades", bitkub_trades(api_key, api_secret, trades_since), cycle_started_at,
        )
        crypto_transfers_count = ingest_history_records(
            ingestion_url, access_client_id, access_client_secret, ingestion_secret, account_id,
            "crypto_transfers",
            chain(
                bitkub_crypto_transfers(api_key, api_secret, "/api/v4/crypto/deposits", "deposit", crypto_since),
                bitkub_crypto_transfers(api_key, api_secret, "/api/v4/crypto/withdraws", "withdraw", crypto_since),
            ),
            cycle_started_at,
        )
        fiat_transfers_count = ingest_history_records(
            ingestion_url, access_client_id, access_client_secret, ingestion_secret, account_id,
            "fiat_transfers",
            chain(
                bitkub_fiat_transfers(api_key, api_secret, "/api/v4/fiat/deposit/history", "deposit", fiat_since),
                bitkub_fiat_transfers(api_key, api_secret, "/api/v4/fiat/withdraw/history", "withdraw", fiat_since),
            ),
            cycle_started_at,
        )
    except HttpStageError as error:
        LOG.error(
            "aws_bitkub_sync_http_failed stage=%s status=%s content_type=%s cf_ray=%s",
            error.stage,
            error.status,
            error.content_type,
            error.cf_ray,
        )
        raise RuntimeError("AWS Bitkub sync request failed") from None
    except BitkubApplicationError as error:
        LOG.error("aws_bitkub_sync_provider_failed stage=%s provider_code=%s", error.stage, error.code)
        raise RuntimeError("AWS Bitkub sync provider rejected a request") from None
    except URLError:
        LOG.error("aws_bitkub_sync_network_failed")
        raise RuntimeError("AWS Bitkub sync network failed") from None
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        LOG.error("aws_bitkub_sync_response_failed type=%s", type(error).__name__)
        raise RuntimeError("AWS Bitkub sync received an invalid response") from None

    LOG.info(
        "aws_bitkub_sync_succeeded account_id=%s balances=%s trades=%s crypto_transfers=%s fiat_transfers=%s",
        account_id,
        len(balances),
        trades_count,
        crypto_transfers_count,
        fiat_transfers_count,
    )
    return {"ok": True, "balances": len(balances), "trades": trades_count, "cryptoTransfers": crypto_transfers_count, "fiatTransfers": fiat_transfers_count}
