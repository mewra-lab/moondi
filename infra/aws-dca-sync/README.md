# AWS DCA bot sync Lambda

This optional Lambda copies the DCA bot's Bitkub spot buys and signal state from
MongoDB (`devme_trading.Transaction` and `devme_trading.BotHeartbeat`, bot
`DCA_BITKUB`) into Moondi's D1 database. The dashboard then reads D1 only: a page
load never opens a MongoDB connection and no component exposes a public URL for
the bot's data.

```text
EventBridge Scheduler → Lambda → MongoDB (read-only user)
                          │ Cloudflare Access service token
                          │ + HMAC, timestamp, single-use nonce
                          ▼
                 API Worker /internal/aws-sync/dca/* → D1
```

The function has no function URL, no VPC, and no inbound trigger other than the
schedule. Every secret stays in SSM Parameter Store; the function environment
holds parameter *names* and non-secret settings only.

## What it sends

Each run asks the API for the newest stored bot buy (`POST …/state`), reads buys
from one day before it (everything on the first run) in ascending pages of 200,
and posts them as bounded chunks (`POST …/activity`). The final chunk also carries
the latest signal state per `<ASSET>_THB` symbol. Only these fields leave the
function: id, asset, execution time, amount, fill price, THB amount, fee, and a
reason that matches `Signal`, `DCA`, or `Fibo <level>`; plus per-asset
`active`, `levels`, `hasError`, and `lastSeenAt`. Documents for other quote
currencies, ids outside `[A-Za-z0-9_-]{1,64}`, and times in the future are skipped.
Raw documents, error text, and connection details are never forwarded or logged.

Re-sending a buy is harmless: the API stores it once and only refreshes the fill
values. A newly stored buy executed within the last 24 hours triggers one Web Push
notification (at most three, plus a summary) that names the reason, quantity,
and THB amount. It uses the existing **trades** notification preference. The
notification is best effort: it is sent once when the buy is first stored, and a
brief outage of the push service at that moment is not retried. One installation
supports one bot account (`MOONDI_ACCOUNT_ID`).

## Set up

Follow [the deployment guide](../../docs/deployment.md#optional-dca-bot-feed) in
order. In short:

1. Create a MongoDB user that can only read those two collections, and allow the
   Lambda's network on the MongoDB side.
2. Store the connection string as the SecureString parameter
   `/moondi/aws-sync/dca/mongodb-uri` (use the console so it never appears in
   shell history).
3. Create a role limited to those parameters plus the Cloudflare Access service
   token and ingestion secret the Bitkub sync already uses.
4. Package with `requirements.txt` for the Lambda runtime and architecture, create
   the function (handler `lambda_function.lambda_handler`, 60 s, 256 MB, reserved
   concurrency 1 where your quota allows), run it once manually, then schedule
   it with bounded retries.

Environment variables (non-secret): `MONGODB_URI_PARAMETER`,
`CF_ACCESS_CLIENT_ID_PARAMETER`, `CF_ACCESS_CLIENT_SECRET_PARAMETER`,
`AWS_INGESTION_SECRET_PARAMETER`, `MOONDI_ACCOUNT_ID` (the Moondi account the bot
trades on), and `MOONDI_API_ORIGIN` (`https://<your-api-host>`, no path).

Run the tests with `python3 -m unittest` from this directory; they use fakes and
need neither MongoDB nor AWS.
