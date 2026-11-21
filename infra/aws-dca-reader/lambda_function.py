import hmac
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache


BOT_NAME = "DCA_BITKUB"
MAX_BUYS = 200
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
ASSET = re.compile(r"[A-Z0-9_-]{1,20}")
LEVEL = re.compile(r"(?:1D:)?[0-9]{1,3}(?:\.[0-9]{1,6})?")
REASON = re.compile(r"Signal|DCA|Fibo (?:1D )?[0-9]{1,3}(?:\.[0-9]{1,6})?")


@lru_cache(maxsize=1)
def database():
    from pymongo import MongoClient

    client = MongoClient(os.environ["MONGODB_URI"], tz_aware=True, timeoutMS=3500)
    return client["devme_trading"]


def timestamp(value):
    if not isinstance(value, datetime):
        return None
    utc = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return (utc - EPOCH) // timedelta(milliseconds=1)


def nonnegative(value):
    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
        return value
    return None


def buy_record(doc):
    executed_at = timestamp(doc.get("executedAt"))
    if executed_at is None:
        return None
    amount = nonnegative(doc.get("amount"))
    price = nonnegative(doc.get("price"))
    reason = doc.get("reason")
    return {
        "id": str(doc["_id"]),
        "executedAt": executed_at,
        "amount": amount or None,
        "price": price if amount and price else None,
        "thbAmount": nonnegative(doc.get("thbAmount")),
        "fee": nonnegative(doc.get("fee")),
        "reason": reason if isinstance(reason, str) and REASON.fullmatch(reason) else None,
    }


def signal_state(doc, symbol):
    if not doc:
        return None
    last_seen = timestamp(doc.get("lastSeenAt"))
    if last_seen is None:
        return None
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict):
        return None
    states = metadata.get("signal_state")
    state = states.get(symbol) if isinstance(states, dict) else None
    errors = metadata.get("errors")
    has_error = isinstance(errors, dict) and symbol in errors
    if not isinstance(state, dict) and not has_error:
        return None
    active = state.get("active") if isinstance(state, dict) else None
    levels = state.get("levels") if isinstance(state, dict) else None
    return {
        "lastSeenAt": last_seen,
        "active": active if isinstance(active, bool) else None,
        "levels": [level for level in levels[:24] if isinstance(level, str) and LEVEL.fullmatch(level)]
        if isinstance(levels, list) else [],
        "hasError": has_error,
    }


def read_activity(db, symbol, since, until):
    buys = db["Transaction"].find(
        {
            "botName": BOT_NAME, "exchange": "BITKUB", "type": "SPOT",
            "side": "BUY", "symbol": symbol, "executedAt": {"$gte": since, "$lte": until},
        },
        {"executedAt": 1, "amount": 1, "price": 1, "thbAmount": 1, "fee": 1, "reason": 1},
    ).sort([("executedAt", -1), ("_id", -1)]).limit(MAX_BUYS + 1)
    docs = list(buys)
    heartbeat = db["BotHeartbeat"].find_one(
        {"botName": BOT_NAME},
        {"_id": 0, "lastSeenAt": 1, "metadata.signal_state": 1, "metadata.errors": 1},
        sort=[("lastSeenAt", -1)],
    )
    return {
        "buys": [buy for doc in docs[:MAX_BUYS] if (buy := buy_record(doc)) is not None],
        "truncated": len(docs) > MAX_BUYS,
        "signal": signal_state(heartbeat, symbol),
    }


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "private, no-store"},
        "body": json.dumps(body, allow_nan=False),
    }


def lambda_handler(event, _context):
    token = os.environ.get("DCA_READER_TOKEN")
    authorization = (event.get("headers") or {}).get("authorization", "")
    if not token or not hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
        return response(401, {"error": "Unauthorized"})
    if event.get("requestContext", {}).get("http", {}).get("method") != "GET":
        return response(405, {"error": "Method not allowed"})

    query = event.get("queryStringParameters") or {}
    asset = query.get("asset", "")
    try:
        since = EPOCH + timedelta(milliseconds=int(query.get("from", "0")))
        until = EPOCH + timedelta(milliseconds=int(query.get("to", "")))
    except (TypeError, ValueError, OverflowError):
        return response(400, {"error": "Invalid date range"})
    if not ASSET.fullmatch(asset) or not EPOCH <= since <= until:
        return response(400, {"error": "Invalid asset or date range"})

    try:
        return response(200, {"activity": read_activity(database(), f"{asset}_THB", since, until)})
    except Exception:
        return response(503, {"error": "Bot data is unavailable"})
