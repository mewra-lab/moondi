# DCA bot activity reader

This optional Lambda reads Bitkub spot purchases from
`devme_trading.Transaction` and the latest signal/heartbeat from
`devme_trading.BotHeartbeat` for `DCA_BITKUB`. Its HTTPS response contains up to
200 buys in the requested range and the most recent signal state for that
asset. A buy without a reported fill price appears in the list only. When the
chart has a price series, Moondi plots reported fills for the selected date
range and extends the time axis to include fills outside the saved snapshots.

## Connect an installation

1. Create a MongoDB login with read access to those two collections. Provide
   its URI to this reader as `MONGODB_URI`. Set up network access for the
   reader on the MongoDB side.
2. Package the reader with `requirements.txt` for the target Lambda Python
   runtime and architecture. Create a separate function with handler
   `lambda_function.lambda_handler` and a timeout of at least 8 seconds.
   Configure a high-entropy `DCA_READER_TOKEN` in the function's environment.
3. Give the reader an HTTPS endpoint using a Lambda Function URL with
   `AuthType=NONE`. The handler verifies the bearer token before querying
   MongoDB. Leave browser CORS disabled. The reader uses a dedicated token
   and MongoDB credential for this integration.
4. In the Moondi API Worker, set `DCA_READER_URL` to that endpoint and
   `DCA_READER_TOKEN` to the same shared token using interactive Wrangler
   secret prompts. For local development, put the settings in the ignored
   `apps/api/.dev.vars` file.
5. If more than one Bitkub account exists, including archived accounts, set
   `DCA_BOT_ACCOUNT_ID` to the bot's Moondi account ID. A sole Bitkub account
   is selected automatically. The integration is also visible in the
   all-accounts view when it can identify an active bot account.

The Moondi route is `GET /api/dca/activity/:asset?from=<Unix milliseconds>`.
Keep it behind the existing Cloudflare Access policy for the API.
