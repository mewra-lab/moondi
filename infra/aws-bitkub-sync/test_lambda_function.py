import hashlib
import hmac
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load_lambda_module():
    sys.modules.setdefault("boto3", SimpleNamespace(client=lambda _service: object()))
    source = Path(__file__).with_name("lambda_function.py")
    spec = importlib.util.spec_from_file_location("moondi_bitkub_sync", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load Lambda source")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LAMBDA = load_lambda_module()


class BitkubTradeTests(unittest.TestCase):
    def test_accepts_string_zero_as_a_success_code(self):
        self.assertEqual(LAMBDA.response_data({"error": "0", "result": [1]}, "test"), [1])

    def test_uses_all_active_exchange_quote_pairs_for_order_history(self):
        with patch.object(LAMBDA, "read_json", return_value={
            "error": 0,
            "result": [
                {"source": "exchange", "status": "active", "symbol": "BTC_THB"},
                {"source": "exchange", "status": "active", "symbol": "BTC_USDT"},
                {"source": "exchange", "status": "inactive", "symbol": "OLD_THB"},
                {"source": "broker", "status": "active", "symbol": "BROKER_THB"},
            ],
        }):
            self.assertEqual(LAMBDA.bitkub_trade_symbols(), {"BTC_THB", "BTC_USDT"})

    def test_maps_sell_amount_and_quote_amount_in_their_correct_units(self):
        self.assertEqual(
            LAMBDA.map_trade(
                {"txn_id": "sell-1", "side": "sell", "rate": "60000", "amount": "0.5", "fee": "0.1", "ts": 1_700_000_000},
                "BTC_USDT",
            ),
            {
                "id": "sell-1",
                "side": "sell",
                "baseAsset": "BTC",
                "quoteAsset": "USDT",
                "price": 60000.0,
                "amount": 0.5,
                "quoteAmount": 30000.0,
                "fee": 0.1,
                "feeAsset": "THB",
                "executedAt": 1_700_000_000_000,
            },
        )

    def test_skips_symbol_without_order_history(self):
        with (
            patch.object(LAMBDA, "bitkub_trade_symbols", return_value={"BTC_THB"}),
            patch.object(LAMBDA, "bitkub_secure_json", return_value={"error": 81}),
        ):
            self.assertEqual(list(LAMBDA.bitkub_trades("key", "secret", None)), [])

    def test_omits_cursor_from_the_first_keyset_request(self):
        queries = []

        def request(_api_key, _api_secret, _path, query, _stage):
            queries.append(query)
            return {"error": 0, "pagination": {"has_next": False}, "result": []}

        with (
            patch.object(LAMBDA, "bitkub_trade_symbols", return_value={"BTC_THB"}),
            patch.object(LAMBDA, "bitkub_secure_json", side_effect=request),
        ):
            self.assertEqual(list(LAMBDA.bitkub_trades("key", "secret", None)), [])
        self.assertNotIn(("cursor", "e30="), queries[0])

    def test_keeps_non_81_provider_errors_visible(self):
        with (
            patch.object(LAMBDA, "bitkub_trade_symbols", return_value={"BTC_THB"}),
            patch.object(LAMBDA, "bitkub_secure_json", return_value={"error": 999}),
        ):
            with self.assertRaises(LAMBDA.BitkubApplicationError) as error:
                list(LAMBDA.bitkub_trades("key", "secret", None))
        self.assertEqual(error.exception.code, "999")


class HistoryIngestionTests(unittest.TestCase):
    def test_chunks_large_history_and_marks_only_the_last_chunk_complete(self):
        payloads = []

        def post(_url, _endpoint, _client_id, _client_secret, _secret, payload):
            payloads.append(payload)
            return {
                "complete": payload["complete"],
                "dataType": payload["dataType"],
                "ingested": True,
                "recordCount": len(payload["records"]),
            }

        records = ({"id": f"trade-{index}"} for index in range(1_001))
        with patch.object(LAMBDA, "post_ingestion", side_effect=post):
            count = LAMBDA.ingest_history_records(
                "https://example.invalid",
                "client-id",
                "client-secret",
                "ingestion-secret",
                "bitkub-main",
                "trades",
                records,
                1_700_000_000_000,
            )

        self.assertEqual(count, 1_001)
        self.assertGreater(len(payloads), 1)
        self.assertTrue(all(len(payload["records"]) <= 250 for payload in payloads))
        self.assertTrue(all(payload["complete"] is False for payload in payloads[:-1]))
        self.assertIs(payloads[-1]["complete"], True)

    def test_follows_every_crypto_transfer_page(self):
        responses = [
            {"error": 0, "data": {"items": [{"page": 1}], "total_page": 2}},
            {"error": 0, "data": {"items": [{"page": 2}], "total_page": 2}},
        ]
        queries = []

        def request(_api_key, _api_secret, _path, query, _stage):
            queries.append(query)
            return responses.pop(0)

        with (
            patch.object(LAMBDA, "bitkub_secure_json", side_effect=request),
            patch.object(LAMBDA, "map_crypto_transfer", side_effect=lambda item, _direction: item),
        ):
            records = list(LAMBDA.bitkub_crypto_transfers("key", "secret", "/crypto", "deposit", None))

        self.assertEqual(records, [{"page": 1}, {"page": 2}])
        self.assertEqual([dict(query)["page"] for query in queries], ["1", "2"])

    def test_follows_fiat_pages_until_a_short_page(self):
        responses = [
            {"error": 0, "data": [{"page": 1}] * 100},
            {"error": 0, "data": [{"page": 2}]},
        ]
        queries = []

        def request(_api_key, _api_secret, _path, query, _stage):
            queries.append(query)
            return responses.pop(0)

        with (
            patch.object(LAMBDA, "bitkub_secure_json", side_effect=request),
            patch.object(LAMBDA, "map_fiat_transfer", side_effect=lambda item, _direction: item),
        ):
            records = list(LAMBDA.bitkub_fiat_transfers("key", "secret", "/fiat", "deposit", None))

        self.assertEqual(len(records), 101)
        self.assertEqual([dict(query)["page"] for query in queries], ["1", "2"])

    def test_ingestion_signature_covers_timestamp_nonce_and_body(self):
        with (
            patch.object(LAMBDA.time, "time", return_value=1_700_000_000),
            patch.object(LAMBDA.uuid, "uuid4", return_value=SimpleNamespace(hex="nonce123")),
        ):
            headers = LAMBDA.ingestion_headers("client", "access", "secret", '{"ok":true}')

        canonical = b'1700000000000\nnonce123\n{"ok":true}'
        expected = hmac.new(b"secret", canonical, hashlib.sha256).hexdigest()
        self.assertEqual(headers["X-Moond-Ingest-Signature"], expected)


class RecordValidationTests(unittest.TestCase):
    def test_replaces_missing_crypto_transfer_id_with_a_bounded_stable_id(self):
        record = {
            "symbol": "BTC",
            "amount": "0.1",
            "fee": "0",
            "created_at": "2026-09-02T00:00:00.000Z",
            "hash": "x" * 600,
        }

        first = LAMBDA.map_crypto_transfer(record, "deposit")
        second = LAMBDA.map_crypto_transfer(record, "deposit")

        self.assertEqual(first["id"], second["id"])
        self.assertLessEqual(len(first["id"]), 256)
        self.assertNotIn("txHash", first)

    def test_rejects_record_ids_that_the_ingestion_api_would_reject(self):
        with self.assertRaisesRegex(RuntimeError, "invalid trade ID"):
            LAMBDA.map_trade(
                {"txn_id": "unsafe id", "side": "buy", "rate": "1", "amount": "1", "fee": "0", "ts": 1},
                "BTC_THB",
            )


if __name__ == "__main__":
    unittest.main()
