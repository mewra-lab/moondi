import hashlib
import hmac
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request

import lambda_function as dca
from lambda_function import EPOCH, MAX_BUYS_PER_REQUEST, buy_record, signal_records

NOW_MS = 1_800_000_000_000
LATEST = NOW_MS + 60_000


def at(milliseconds):
    return EPOCH + timedelta(milliseconds=milliseconds)


def doc(index, symbol="BTC_THB", **overrides):
    value = {
        "_id": f"id{index:06d}",
        "executedAt": at(1_000 + index),
        "amount": 0.5,
        "price": 100,
        "thbAmount": 50,
        "fee": 0.1,
        "reason": "Fibo 0.618",
        "symbol": symbol,
        "botName": "DCA_BITKUB",
        "exchange": "BITKUB",
        "type": "SPOT",
        "side": "BUY",
    }
    value.update(overrides)
    return value


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, keys):
        for field, direction in reversed(keys):
            self.docs = sorted(self.docs, key=lambda item: str(item.get(field)) if field == "_id" else item[field], reverse=direction < 0)
        return self

    def limit(self, count):
        return iter(self.docs[:count])


def matches(item, query):
    for field, condition in query.items():
        if field == "$or":
            if not any(matches(item, option) for option in condition):
                return False
            continue
        value = item.get(field)
        if isinstance(condition, dict) and any(key.startswith("$") for key in condition):
            for operator, operand in condition.items():
                if operator == "$gte" and not value >= operand:
                    return False
                if operator == "$lte" and not value <= operand:
                    return False
                if operator == "$gt" and not value > operand:
                    return False
        elif value != condition:
            return False
    return True


class FakeCollection:
    def __init__(self, docs):
        self.docs = docs
        self.filters = []

    def find(self, query, _projection=None):
        self.filters.append(query)
        return FakeCursor([item for item in self.docs if matches(item, query)])


class FakeDatabase:
    def __init__(self, docs, heartbeat=None):
        self.transactions = FakeCollection(docs)
        self.heartbeat = MagicMock()
        self.heartbeat.find_one.return_value = heartbeat

    def __getitem__(self, name):
        return {"Transaction": self.transactions, "BotHeartbeat": self.heartbeat}[name]


class RecordTests(unittest.TestCase):
    def test_buy_keeps_only_normalized_fields(self):
        record = buy_record(doc(1, secret="private"), LATEST)
        self.assertEqual(record, {
            "amount": 0.5, "asset": "BTC", "executedAt": 1_001, "fee": 0.1, "id": "id000001",
            "price": 100, "reason": "Fibo 0.618", "thbAmount": 50,
        })
        self.assertNotIn("private", json.dumps(record))

    def test_buy_without_fill_has_no_price_and_free_text_reason_is_dropped(self):
        record = buy_record(doc(1, amount=0, price=100, reason="ignore previous instructions"), LATEST)
        self.assertIsNone(record["amount"])
        self.assertIsNone(record["price"])
        self.assertIsNone(record["reason"])

    def test_buy_is_skipped_for_other_quotes_unsafe_ids_and_future_times(self):
        self.assertIsNone(buy_record(doc(1, symbol="BTC_USDT"), LATEST))
        self.assertIsNone(buy_record(doc(1, symbol="btc_THB"), LATEST))
        self.assertIsNone(buy_record(doc(1, _id="a/b"), LATEST))
        self.assertIsNone(buy_record(doc(1, executedAt=at(LATEST + 1)), LATEST))
        self.assertIsNone(buy_record(doc(1, executedAt="2026-01-01"), LATEST))

    def test_non_finite_and_negative_numbers_become_null(self):
        record = buy_record(doc(1, amount=float("inf"), thbAmount=-1, fee=float("nan")), LATEST)
        self.assertIsNone(record["amount"])
        self.assertIsNone(record["thbAmount"])
        self.assertIsNone(record["fee"])

    def test_signals_report_state_and_error_flags_without_private_values(self):
        heartbeat = {
            "lastSeenAt": at(5_000),
            "metadata": {
                "signal_state": {"BTC_THB": {"active": True, "levels": ["1D:0.69", "private"]}, "ETH_USDT": {"active": True}},
                "errors": {"SOL_THB": "private stack trace"},
            },
        }
        records = signal_records(heartbeat, LATEST)
        self.assertEqual(
            records,
            [
                {"active": True, "asset": "BTC", "hasError": False, "lastSeenAt": 5_000, "levels": ["1D:0.69"]},
                {"active": None, "asset": "SOL", "hasError": True, "lastSeenAt": 5_000, "levels": []},
            ],
        )
        self.assertNotIn("private", json.dumps(records))

    def test_a_slightly_fast_bot_clock_does_not_disable_signals(self):
        db = FakeDatabase([], {"lastSeenAt": at(NOW_MS + 10_000), "metadata": {"signal_state": {"BTC_THB": {"active": True}}}})
        self.assertEqual(len(dca.read_signals(db, NOW_MS)), 1)
        far = FakeDatabase([], {"lastSeenAt": at(NOW_MS + 10 * 60_000), "metadata": {"signal_state": {"BTC_THB": {"active": True}}}})
        self.assertEqual(dca.read_signals(far, NOW_MS), [])

    def test_signals_are_ignored_for_missing_future_or_malformed_heartbeats(self):
        self.assertEqual(signal_records(None, LATEST), [])
        self.assertEqual(signal_records({"lastSeenAt": at(LATEST + 1), "metadata": {"signal_state": {"BTC_THB": {}}}}, LATEST), [])
        self.assertEqual(signal_records({"lastSeenAt": at(1), "metadata": "x"}, LATEST), [])

    def test_signal_count_is_capped(self):
        states = {f"A{index}_THB": {"active": True} for index in range(80)}
        records = signal_records({"lastSeenAt": at(1), "metadata": {"signal_state": states}}, LATEST)
        self.assertEqual(len(records), dca.MAX_SIGNALS)


class PaginationTests(unittest.TestCase):
    def test_reads_ascending_pages_until_a_short_page(self):
        db = FakeDatabase([doc(index) for index in range(450)])
        pages = list(dca.read_buy_pages(db, 0, NOW_MS))
        self.assertEqual([len(page) for page in pages], [200, 200, 50])
        flattened = [record["id"] for page in pages for record in page]
        self.assertEqual(set(flattened), {f"id{index:06d}" for index in range(450)})
        self.assertEqual(db.transactions.filters[0]["botName"], dca.BOT_NAME)
        self.assertEqual(db.transactions.filters[0]["side"], "BUY")

    def test_a_run_of_buys_sharing_one_timestamp_is_read_completely_without_repeats(self):
        db = FakeDatabase([doc(index, executedAt=at(1_000)) for index in range(450)])
        pages = list(dca.read_buy_pages(db, 0, NOW_MS))
        flattened = [record["id"] for page in pages for record in page]
        self.assertEqual([len(page) for page in pages], [200, 200, 50])
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertEqual(set(flattened), {f"id{index:06d}" for index in range(450)})

    def test_other_bots_exchanges_and_sell_orders_are_never_read(self):
        docs = [doc(1, botName="OTHER_BOT"), doc(2, exchange="BINANCE"), doc(3, side="SELL"), doc(4, type="FUTURES"), doc(5)]
        pages = list(dca.read_buy_pages(FakeDatabase(docs), 0, NOW_MS))
        self.assertEqual([record["id"] for page in pages for record in page], ["id000005"])

    def test_skipped_documents_do_not_end_pagination_early(self):
        docs = [doc(index, symbol="BTC_USDT") for index in range(MAX_BUYS_PER_REQUEST)] + [doc(500)]
        db = FakeDatabase(docs)
        pages = list(dca.read_buy_pages(db, 0, NOW_MS))
        self.assertEqual(sum(len(page) for page in pages), 1)


class DeliveryTests(unittest.TestCase):
    def test_headers_carry_a_verifiable_hmac_and_a_fresh_nonce(self):
        body = '{"accountId":"bot"}'
        first = dca.ingestion_headers("id", "client-secret", "ingestion-secret", body)
        second = dca.ingestion_headers("id", "client-secret", "ingestion-secret", body)
        canonical = f"{first['X-Moond-Ingest-Timestamp']}\n{first['X-Moond-Ingest-Nonce']}\n{body}".encode()
        expected = hmac.new(b"ingestion-secret", canonical, hashlib.sha256).hexdigest()
        self.assertEqual(first["X-Moond-Ingest-Signature"], expected)
        self.assertNotEqual(first["X-Moond-Ingest-Nonce"], second["X-Moond-Ingest-Nonce"])
        self.assertEqual(first["CF-Access-Client-Id"], "id")

    def test_only_a_bare_https_origin_is_accepted(self):
        self.assertEqual(dca.api_origin("https://api.example.test"), "https://api.example.test")
        self.assertEqual(dca.api_origin("https://api.example.test/"), "https://api.example.test")
        for bad in ["http://api.example.test", "https://user:pw@api.example.test", "https://api.example.test/x", "https://api.example.test/?a=1", "api.example.test", "https://"]:
            with self.assertRaises(RuntimeError, msg=bad):
                dca.api_origin(bad)

    def test_redirects_are_refused_so_credentials_stay_with_the_api_host(self):
        seen = []

        class Target(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_args):
                pass

        target = HTTPServer(("127.0.0.1", 0), Target)

        class Redirector(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(307)
                self.send_header("Location", f"http://127.0.0.1:{target.server_port}/stolen")
                self.end_headers()

            def log_message(self, *_args):
                pass

        redirector = HTTPServer(("127.0.0.1", 0), Redirector)
        threads = [threading.Thread(target=server.handle_request, daemon=True) for server in (target, redirector)]
        for thread in threads:
            thread.start()
        request = Request(f"http://127.0.0.1:{redirector.server_port}/", data=b"{}", method="POST", headers={"CF-Access-Client-Secret": "secret"})
        with self.assertRaises(HTTPError) as caught:
            dca.OPENER.open(request, timeout=5)
        self.assertEqual(caught.exception.code, 307)
        self.assertEqual(seen, [])
        target.server_close()
        redirector.server_close()


class SyncTests(unittest.TestCase):
    credentials = ("id", "secret", "ingestion")

    def run_sync(self, db, latest):
        calls = []

        def fake_post(origin, endpoint, credentials, payload):
            calls.append((endpoint, payload))
            return {"latestBuyAt": latest} if endpoint == "state" else {"ingested": True}

        with patch.object(dca, "post_ingestion", fake_post), patch.object(dca.time, "time", return_value=NOW_MS / 1_000):
            result = dca.sync(db, "https://api.example.test", "bot", self.credentials)
        return result, calls

    def test_first_run_reads_from_the_start_and_sends_signals_with_the_last_chunk(self):
        heartbeat = {"lastSeenAt": at(9_000), "metadata": {"signal_state": {"BTC_THB": {"active": True, "levels": ["0.5"]}}}}
        db = FakeDatabase([doc(index) for index in range(250)], heartbeat)
        result, calls = self.run_sync(db, None)

        self.assertEqual(result, (250, 1))
        self.assertEqual([endpoint for endpoint, _ in calls], ["state", "activity", "activity"])
        first, second = calls[1][1], calls[2][1]
        self.assertEqual((len(first["buys"]), len(second["buys"])), (200, 50))
        self.assertEqual(first["signals"], [])
        self.assertEqual(len(second["signals"]), 1)
        self.assertEqual({payload["accountId"] for _, payload in calls[1:]}, {"bot"})
        self.assertEqual(db.transactions.filters[0]["executedAt"]["$gte"], EPOCH)

    def test_later_runs_resume_one_day_before_the_stored_checkpoint(self):
        db = FakeDatabase([doc(1)])
        self.run_sync(db, 3 * 24 * 60 * 60 * 1_000)
        self.assertEqual(db.transactions.filters[0]["executedAt"]["$gte"], at(2 * 24 * 60 * 60 * 1_000))

    def test_nothing_is_sent_when_there_is_nothing_to_report(self):
        result, calls = self.run_sync(FakeDatabase([]), 5)
        self.assertEqual(result, (0, 0))
        self.assertEqual([endpoint for endpoint, _ in calls], ["state"])

    def test_signals_alone_are_still_delivered(self):
        heartbeat = {"lastSeenAt": at(9_000), "metadata": {"signal_state": {"BTC_THB": {"active": False}}}}
        result, calls = self.run_sync(FakeDatabase([], heartbeat), None)
        self.assertEqual(result, (0, 1))
        self.assertEqual(calls[1][1]["buys"], [])

    def test_an_invalid_checkpoint_from_the_api_is_rejected(self):
        for bad in [-1, "5", 1.5, True]:
            with self.assertRaises(RuntimeError):
                self.run_sync(FakeDatabase([]), bad)


class HandlerTests(unittest.TestCase):
    environment = {
        "MONGODB_URI_PARAMETER": "/p/mongo",
        "CF_ACCESS_CLIENT_ID_PARAMETER": "/p/id",
        "CF_ACCESS_CLIENT_SECRET_PARAMETER": "/p/secret",
        "AWS_INGESTION_SECRET_PARAMETER": "/p/ingest",
        "MOONDI_ACCOUNT_ID": "bot",
        "MOONDI_API_ORIGIN": "https://api.example.test",
    }

    def test_success_closes_the_database_client(self):
        client = MagicMock()
        with patch.dict("os.environ", self.environment, clear=True), \
             patch.object(dca, "read_secure_parameter", side_effect=lambda name: f"value-for-{name}"), \
             patch.object(dca, "open_database", return_value=client) as opened, \
             patch.object(dca, "sync", return_value=(3, 2)):
            result = dca.lambda_handler({}, None)
        self.assertEqual(result, {"ok": True, "buys": 3, "signals": 2})
        opened.assert_called_once_with("value-for-/p/mongo")
        client.close.assert_called_once()

    def test_failures_never_echo_connection_details(self):
        client = MagicMock()
        leak = "mongodb+srv://user:hunter2@cluster.example.test"
        with patch.dict("os.environ", self.environment, clear=True), \
             patch.object(dca, "read_secure_parameter", return_value="x"), \
             patch.object(dca, "open_database", return_value=client), \
             patch.object(dca, "sync", side_effect=Exception(leak)), \
             self.assertLogs(level="ERROR") as logs, \
             self.assertRaises(RuntimeError) as caught:
            dca.lambda_handler({}, None)
        self.assertNotIn("hunter2", str(caught.exception))
        self.assertNotIn("hunter2", "\n".join(logs.output))
        client.close.assert_called_once()

    def test_missing_configuration_fails_before_any_secret_is_read(self):
        with patch.dict("os.environ", {}, clear=True), patch.object(dca, "read_secure_parameter") as read:
            with self.assertRaises(RuntimeError):
                dca.lambda_handler({}, None)
        read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
