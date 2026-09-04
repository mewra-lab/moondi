# Troubleshooting

## Dashboard briefly appears before Cloudflare Access redirects

Pages is a static app while Access evaluates authentication at the edge. Keep
the app's loading/auth state visible until its protected API request resolves;
do not rely on a flash of rendered client UI as proof of authorization. Confirm
both the Pages hostname and API hostname are covered by Access.

## API shows `{ "status": "ok" }` or `{ "error": "Not found" }`

`/health` is intentionally a machine-readable health endpoint. Visiting the API
root is not the dashboard and returns `404`. Use the Pages URL for the UI.

## A dashboard action says API access needs confirmation while the portfolio loads

The Pages application and API Worker have separate Cloudflare Access sessions.
Open the API confirmation URL from the dashboard once, then return to the app.
If the problem occurs only when saving a watchlist, allocation target, or price
alert, make sure the deployed web bundle is current: those controls use a
form-encoded `POST` specifically to avoid an Access-blocked CORS preflight.

## `403: Invalid X-BTK-IP`

The Bitkub key's source-IP policy rejected the Worker request. Check the key's
allow-list and the provider's current support guidance for Cloudflare-hosted
read-only clients. Do not use `0.0.0.0/0` as a casual workaround. See
[Bitkub setup](bitkub.md).

## Cloudflare Bitkub sync returns `401 A1000-MK`, while the AWS probe succeeds

This is a provider-side authorization result whose `-MK` suffix is not defined
in Bitkub's public error table. It does not prove an HMAC implementation bug,
and it is distinct from `403 Invalid X-BTK-IP`. Compare the same read-only key
from Bruno or the isolated Lambda probe without disclosing credentials. If the
AWS probe succeeds repeatedly while Cloudflare fails, use the AWS secure-sync
path in [Deployment](deployment.md#aws-bitkub-secure-sync), or contact Bitkub
support with the endpoint, timestamp, HTTP status, and error code only.

## AWS Lambda returns `401`, `403`, or `404` while posting a snapshot

Do not create an Access bypass. Confirm all of the following instead:

- `MOONDI_INGESTION_URL` is the exact protected API hostname and route;
- the Access application's **Service Auth** policy includes the Lambda's exact
  service token;
- the Lambda SSM client ID and client secret are the matching pair; and
- the API Worker secret and `/moondi/aws-sync/ingestion-secret` are the same
  random value.

The ingestion endpoint deliberately returns `404` for unsigned or invalid
authentication attempts. A `409 Replay rejected` means a request nonce was
seen already; invoke Lambda again so it creates a new timestamp and nonce.

## Activity endpoint is deferred but balances work

Bitkub authorizes endpoints independently. This means balance/prices can be
healthy while trade or THB history is unavailable. The UI retains prior data
and reports the affected type as deferred. It does not mean your balance was
lost.

## Portfolio-history line appears to drop sharply

If a historical balance snapshot lacks a price for any held crypto, its THB
cash alone must not be shown as the whole portfolio. Moondi excludes incomplete
points. A real change in portfolio value can still occur from market prices even
when asset quantities do not change.

If the latest balance time advances but the line stops, confirm that the public
price job is still succeeding. Either the balance job or the next price job can
materialize the point, so execution order should not leave the chart stuck. A
missing or more-than-35-minute-away price intentionally leaves a gap.

## A price mini-chart says `Collecting prices`

At least two stored price points are required. Keep the sync Worker healthy and
wait for subsequent scheduled runs. A newly deployed installation cannot show
historical price data it has not collected.

## Push notification cannot be enabled

Check all of these:

- use HTTPS and a browser that supports Web Push;
- confirm browser/site notification permission is not blocked;
- confirm the PWA service worker is active;
- ensure VAPID public/private key configuration is valid and deployed; and
- after changing browser permission, reload the app and subscribe again.

Use **Test Worker delivery** in Settings after the local display test succeeds.
If it fails with “not configured”, set the same
`INTERNAL_PUSH_TEST_TOKEN` secret on both API and Sync Workers, then deploy
both Workers. If it succeeds but no banner appears, the push service accepted
the message; check the operating-system and browser notification settings.

Subscriptions can expire or be removed by the browser/provider. That is normal;
the app refreshes an active subscription when it opens.

## A private refresh does not start

The dashboard intentionally has no manual-sync button. In AWS mode, inspect the
EventBridge target and Lambda result for balances/activity, and inspect the Sync
Worker cron for prices. The internal default-mode trigger is an operational
endpoint only; it requires the same `INTERNAL_PUSH_TEST_TOKEN` on both Workers
and is rate limited to prevent overlapping jobs.

## Production does not show a new web deployment

Pages preview deployments and production deployments are distinct. This
repository deploys direct uploads to the `production` branch; forks must update
that branch name if their Pages project uses another production branch. A service
worker can also hold an older asset bundle briefly; use a hard reload after
confirming the production deployment is complete.

## Database migration prompts for confirmation

Remote D1 migrations can briefly make the database unavailable. Verify the
database name and backup first, then approve only the intended migration.
