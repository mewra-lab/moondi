"""Read DCA bot activity from MongoDB and deliver only normalized data to Moondi's API.

The function has no public HTTP trigger. EventBridge Scheduler is its production
invoker, every secret stays in SSM Parameter Store, and only bounded, validated
fields (never raw documents) leave this function.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

BOT_NAME = "DCA_BITKUB"
DATABASE_NAME = "devme_trading"
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
MAX_BUYS_PER_REQUEST = 200
MAX_PAGES = 25
MAX_SIGNALS = 50
MAX_SIGNAL_LEVELS = 24
MAX_QUANTITY = 1e15
MAX_FUTURE_SKEW_MS = 4 * 60 * 1_000
OVERLAP_MS = 24 * 60 * 60 * 1_000
MAX_BODY_BYTES = 400 * 1_024
USER_AGENT = "moondi-aws-dca-sync/1.0"

SYMBOL = re.compile(r"([A-Z0-9]{1,20})_THB")
BUY_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
LEVEL = re.compile(r"(?:1D:)?[0-9]{1,3}(?:\.[0-9]{1,6})?")
REASON = re.compile(r"Signal|DCA|Fibo (?:1D )?[0-9]{1,3}(?:\.[0-9]{1,6})?")


class HttpStageError(RuntimeError):
    """A redacted HTTP error that identifies only the failing integration boundary."""

    def __init__(self, stage: str, status: int, content_type: str, cf_ray: str) -> None:
        super().__init__(f"{stage} returned HTTP {status}")
        self.stage = stage
        self.status = status
        self.content_type = content_type
        self.cf_ray = cf_ray


class RefuseRedirects(HTTPRedirectHandler):
    """Never forward Access credentials or the signed body to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


OPENER = build_opener(RefuseRedirects)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing environment configuration: {name}")
    return value


def read_secure_parameter(name: str) -> str:
    import boto3

    response = boto3.client("ssm").get_parameter(Name=name, WithDecryption=True)
    value = response["Parameter"]["Value"]
    if not value:
        raise RuntimeError("received an empty secure parameter")
    return value


def api_origin(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("MOONDI_API_ORIGIN must be an HTTPS origin without credentials, path, or query")
    return f"https://{parsed.netloc}"


def compact_json(value: Any) -> str:
    return json.dumps(value, allow_nan=False, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def ingestion_headers(access_client_id: str, access_client_secret: str, ingestion_secret: str, body: str) -> dict[str, str]:
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


def post_ingestion(origin: str, endpoint: str, credentials: tuple[str, str, str], payload: dict[str, Any]) -> dict[str, Any]:
    body = compact_json(payload)
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise RuntimeError("ingestion payload exceeded size limit")
    stage = f"moondi_dca_{endpoint}"
    try:
        request = Request(
            f"{origin}/internal/aws-sync/dca/{endpoint}",
            data=body.encode("utf-8"),
            headers=ingestion_headers(*credentials, body),
            method="POST",
        )
        with OPENER.open(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"unexpected ingestion status: {response.status}")
            response_body = response.read(4_096)
    except HTTPError as error:
        raise HttpStageError(stage, error.code, error.headers.get_content_type(), error.headers.get("CF-Ray", "")[:64]) from None
    decoded = json.loads(response_body.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise RuntimeError("ingestion response was not accepted")
    return decoded


def timestamp_ms(value: Any) -> int | None:
    if not isinstance(value, datetime):
        return None
    utc = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return (utc - EPOCH) // timedelta(milliseconds=1)


def nonnegative(value: Any) -> float | int | None:
    if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= MAX_QUANTITY:
        return value
    return None


def thb_asset(symbol: Any) -> str | None:
    match = SYMBOL.fullmatch(symbol) if isinstance(symbol, str) else None
    return match.group(1) if match else None


def buy_record(doc: dict[str, Any], latest_ms: int) -> dict[str, Any] | None:
    asset = thb_asset(doc.get("symbol"))
    executed_at = timestamp_ms(doc.get("executedAt"))
    buy_id = str(doc.get("_id", ""))
    if asset is None or executed_at is None or executed_at > latest_ms or not BUY_ID.fullmatch(buy_id):
        return None
    amount = nonnegative(doc.get("amount"))
    price = nonnegative(doc.get("price"))
    reason = doc.get("reason")
    return {
        "amount": amount or None,
        "asset": asset,
        "executedAt": executed_at,
        "fee": nonnegative(doc.get("fee")),
        "id": buy_id,
        "price": price if amount and price else None,
        "reason": reason if isinstance(reason, str) and REASON.fullmatch(reason) else None,
        "thbAmount": nonnegative(doc.get("thbAmount")),
    }


def signal_records(heartbeat: dict[str, Any] | None, latest_ms: int) -> list[dict[str, Any]]:
    if not heartbeat:
        return []
    last_seen = timestamp_ms(heartbeat.get("lastSeenAt"))
    metadata = heartbeat.get("metadata")
    if last_seen is None or last_seen > latest_ms or not isinstance(metadata, dict):
        return []
    states = metadata.get("signal_state")
    errors = metadata.get("errors")
    states = states if isinstance(states, dict) else {}
    errors = errors if isinstance(errors, dict) else {}
    records = []
    for symbol in sorted({*states.keys(), *errors.keys()}, key=str):
        asset = thb_asset(symbol)
        state = states.get(symbol)
        has_error = symbol in errors
        if asset is None or (not isinstance(state, dict) and not has_error):
            continue
        active = state.get("active") if isinstance(state, dict) else None
        levels = state.get("levels") if isinstance(state, dict) else None
        records.append({
            "active": active if isinstance(active, bool) else None,
            "asset": asset,
            "hasError": has_error,
            "lastSeenAt": last_seen,
            "levels": [level for level in levels[:MAX_SIGNAL_LEVELS] if isinstance(level, str) and LEVEL.fullmatch(level)]
            if isinstance(levels, list) else [],
        })
        if len(records) == MAX_SIGNALS:
            break
    return records


def read_buy_pages(db: Any, since_ms: int, until_ms: int) -> Iterator[list[dict[str, Any]]]:
    """Yield buys in ascending (executedAt, _id) order, resuming after the last row of a full page."""
    until = EPOCH + timedelta(milliseconds=until_ms)
    base = {"botName": BOT_NAME, "exchange": "BITKUB", "type": "SPOT", "side": "BUY"}
    window = {"$gte": EPOCH + timedelta(milliseconds=since_ms), "$lte": until}
    query = {**base, "executedAt": window}
    for _ in range(MAX_PAGES):
        docs = list(
            db["Transaction"]
            .find(query, {"executedAt": 1, "amount": 1, "price": 1, "thbAmount": 1, "fee": 1, "reason": 1, "symbol": 1})
            .sort([("executedAt", 1), ("_id", 1)])
            .limit(MAX_BUYS_PER_REQUEST)
        )
        yield [record for doc in docs if (record := buy_record(doc, until_ms + MAX_FUTURE_SKEW_MS)) is not None]
        if len(docs) < MAX_BUYS_PER_REQUEST:
            return
        last_at = docs[-1].get("executedAt")
        if not isinstance(last_at, datetime):
            return
        query = {
            **base,
            "executedAt": {"$gte": last_at, "$lte": until},
            "$or": [
                {"executedAt": {"$gt": last_at}},
                {"executedAt": last_at, "_id": {"$gt": docs[-1]["_id"]}},
            ],
        }


def read_signals(db: Any, until_ms: int) -> list[dict[str, Any]]:
    heartbeat = db["BotHeartbeat"].find_one(
        {"botName": BOT_NAME},
        {"_id": 0, "lastSeenAt": 1, "metadata.signal_state": 1, "metadata.errors": 1},
        sort=[("lastSeenAt", -1)],
    )
    return signal_records(heartbeat, until_ms + MAX_FUTURE_SKEW_MS)


def latest_checkpoint(value: Any) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise RuntimeError("Moondi returned an invalid DCA checkpoint")
    return value


def sync(db: Any, origin: str, account_id: str, credentials: tuple[str, str, str]) -> tuple[int, int]:
    state = post_ingestion(origin, "state", credentials, {"accountId": account_id})
    latest = latest_checkpoint(state.get("latestBuyAt"))
    since_ms = max(0, latest - OVERLAP_MS) if latest is not None else 0
    until_ms = int(time.time() * 1_000)

    pages = [page for page in read_buy_pages(db, since_ms, until_ms) if page]
    signals = read_signals(db, until_ms)
    if not pages and not signals:
        return 0, 0
    buy_count = 0
    outgoing = pages or [[]]
    for index, page in enumerate(outgoing):
        is_last = index == len(outgoing) - 1
        response = post_ingestion(origin, "activity", credentials, {
            "accountId": account_id,
            "buys": page,
            "signals": signals if is_last else [],
            "syncAt": int(time.time() * 1_000),
        })
        if response.get("ingested") is not True:
            raise RuntimeError("DCA ingestion response was not accepted")
        buy_count += len(page)
    return buy_count, len(signals)


def open_database(uri: str) -> Any:
    from pymongo import MongoClient

    return MongoClient(uri, appname="moondi-dca-sync", tz_aware=True, timeoutMS=10_000)


def lambda_handler(_event: dict[str, Any], _context: Any) -> dict[str, int | bool]:
    mongo_uri = read_secure_parameter(required_environment("MONGODB_URI_PARAMETER"))
    credentials = (
        read_secure_parameter(required_environment("CF_ACCESS_CLIENT_ID_PARAMETER")),
        read_secure_parameter(required_environment("CF_ACCESS_CLIENT_SECRET_PARAMETER")),
        read_secure_parameter(required_environment("AWS_INGESTION_SECRET_PARAMETER")),
    )
    account_id = required_environment("MOONDI_ACCOUNT_ID")
    origin = api_origin(required_environment("MOONDI_API_ORIGIN"))

    client = open_database(mongo_uri)
    try:
        buys, signals = sync(client[DATABASE_NAME], origin, account_id, credentials)
    except HttpStageError as error:
        LOG.error(
            "aws_dca_sync_http_failed stage=%s status=%s content_type=%s cf_ray=%s",
            error.stage, error.status, error.content_type, error.cf_ray,
        )
        raise RuntimeError("AWS DCA sync request failed") from None
    except URLError:
        LOG.error("aws_dca_sync_network_failed")
        raise RuntimeError("AWS DCA sync network failed") from None
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        LOG.error("aws_dca_sync_response_failed type=%s", type(error).__name__)
        raise RuntimeError("AWS DCA sync received an invalid response") from None
    except RuntimeError as error:
        LOG.error("aws_dca_sync_rejected reason=%s", error)
        raise RuntimeError("AWS DCA sync rejected a response") from None
    except Exception as error:
        LOG.error("aws_dca_sync_failed type=%s", type(error).__name__)
        raise RuntimeError("AWS DCA sync failed") from None
    finally:
        client.close()

    LOG.info("aws_dca_sync_succeeded account_id=%s buys=%s signals=%s", account_id, buys, signals)
    return {"ok": True, "buys": buys, "signals": signals}
