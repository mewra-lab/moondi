import json
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from lambda_function import BOT_NAME, EPOCH, MAX_BUYS, lambda_handler, read_activity


class DcaReaderTests(unittest.TestCase):
    def test_unauthenticated_request_does_not_open_mongo(self):
        with patch.dict("os.environ", {"DCA_READER_TOKEN": "fixture"}), patch("lambda_function.database") as db:
            result = lambda_handler({"headers": {"authorization": "Bearer wrong"}}, None)
        self.assertEqual(result["statusCode"], 401)
        db.assert_not_called()

    def test_reads_only_requested_bot_and_pair_and_filters_output(self):
        db = MagicMock()
        trades = db["Transaction"]
        heartbeat = MagicMock()
        db.__getitem__.side_effect = {"Transaction": trades, "BotHeartbeat": heartbeat}.__getitem__
        executed = datetime(2026, 1, 1, tzinfo=timezone.utc)
        cursor = trades.find.return_value.sort.return_value
        cursor.limit.return_value = [
            {"_id": "pending", "executedAt": executed, "price": 0, "amount": 0, "thbAmount": 10, "reason": "Signal"},
            {"_id": "reported", "executedAt": executed, "price": 100, "amount": 0.25, "reason": "Fibo 1D 0.69", "secret": "private"},
        ]
        heartbeat.find_one.return_value = {
            "lastSeenAt": executed,
            "metadata": {
                "signal_state": {"BTC_THB": {"active": False, "levels": ["1D:0.69", "private"]}},
                "errors": {"BTC_THB": "private"},
            },
        }
        activity = read_activity(db, "BTC_THB", EPOCH, executed)
        self.assertEqual(trades.find.call_args.args[0], {
            "botName": BOT_NAME, "exchange": "BITKUB", "type": "SPOT", "side": "BUY",
            "symbol": "BTC_THB", "executedAt": {"$gte": EPOCH, "$lte": executed},
        })
        cursor.limit.assert_called_once_with(MAX_BUYS + 1)
        self.assertIsNone(activity["buys"][0]["price"])
        self.assertEqual(activity["buys"][1]["price"], 100)
        self.assertEqual(activity["signal"]["levels"], ["1D:0.69"])
        self.assertTrue(activity["signal"]["hasError"])
        self.assertNotIn("private", json.dumps(activity))

    def test_authorized_get_returns_the_normalized_feed(self):
        activity = {"buys": [], "signal": None, "truncated": False}
        event = {
            "headers": {"authorization": "Bearer fixture"},
            "requestContext": {"http": {"method": "GET"}},
            "queryStringParameters": {"asset": "BTC", "from": "0", "to": "1000"},
        }
        with patch.dict("os.environ", {"DCA_READER_TOKEN": "fixture"}), \
             patch("lambda_function.database"), patch("lambda_function.read_activity", return_value=activity) as read:
            result = lambda_handler(event, None)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(json.loads(result["body"]), {"activity": activity})
        self.assertEqual(read.call_args.args[1], "BTC_THB")
