# Deployment

This guide describes a production deployment into one owner's Cloudflare
account. It assumes the repository has been copied and local configuration has
been created from the tracked examples.

## Resources

Create these resources in the target Cloudflare account:

| Resource | Used by | Notes |
| --- | --- | --- |
| D1 database | API + sync Worker | Stores normalized balances, prices, activity, sync events, and push subscriptions. |
| KV namespace | API + sync Worker | Cache/transient application state. |
| API Worker | Browser API + AWS ingestion | Receives normalized dashboard requests and AWS-originated Bitkub snapshots and activity. |
| Sync Worker | Cron | Refreshes public Bitkub prices; it can optionally own signed Bitkub syncs during the legacy mode. |
| AWS Lambda + EventBridge Scheduler | Private Bitkub sync | Optional secure egress for signed Bitkub balance requests when Bitkub rejects Cloudflare egress. |
| Pages project | Browser PWA | Hosts the static React application. |
| Cloudflare Access apps | Pages + API | Private Google-gated access. |

Use resource names unique to your account. IDs belong only in the ignored
`apps/*/wrangler.jsonc` copies, not in a public commit.

## Configure Workers

Copy both `wrangler.example.jsonc` files and replace only the clearly marked
placeholders. Keep these details aligned between the two Workers:

- same D1 database ID for binding `DB`;
- same KV namespace ID for binding `CACHE`; and
- a compatible `compatibility_date` and flags.

The Sync Worker template is private: keep `workers_dev` and `preview_urls`
disabled because API-to-Sync calls use the Service binding and cron does not
need an HTTP hostname. The API template temporarily enables `workers_dev` for
bootstrap but disables preview URLs. Protect that exact API hostname with
Cloudflare Access before adding exchange credentials. After moving the API to
a protected custom domain, set `workers_dev` to `false` as well. Update
`ALLOWED_ORIGIN` to the exact Pages/custom-domain origin (scheme and hostname,
no trailing path).

## Apply migrations

Migrations are incremental. Apply them once to the target D1 database before
deploying a Worker version that depends on them:

```bash
npx wrangler d1 migrations apply <your-database-name> --remote --config apps/api/wrangler.jsonc
```

Use `--remote` only after checking that the database name is your own. Do not
point a cloned repository at somebody else's D1 database ID.

## Configure secrets

Set production secrets interactively. The precise command must specify the
correct Worker/config in your installation.

| Secret | Worker | Purpose |
| --- | --- | --- |
| `BITKUB_API_KEY` | Sync | Bitkub read-only public identifier. |
| `BITKUB_API_SECRET` | Sync | Bitkub signing secret. |
| `BITKUB_ACCOUNTS_JSON` | Sync | Required for two or more Bitkub accounts; maps each local `accounts.id` to its own read-only `apiKey`/`apiSecret` pair and replaces the legacy pair. |
| `VAPID_PUBLIC_KEY` | API and Sync as required | Browser push public key. |
| `VAPID_PRIVATE_KEY` | Sync | Browser push signing secret. |
| `VAPID_SUBJECT` | Sync | Contact URI for Web Push. |
| `INTERNAL_PUSH_TEST_TOKEN` | API and Sync | Same random value in both Workers; authenticates private Worker-to-Worker push tests and manual-sync requests. |
| `AWS_SYNC_INGESTION_SECRET` | API | Shared only with the AWS sync Lambda; signs normalized Bitkub ingestion. |

Example pattern:

```bash
npx wrangler secret put BITKUB_API_KEY --config apps/sync-worker/wrangler.jsonc
```

Paste the value only at the interactive prompt. Do not append it to the command,
save it in a shell script, or put it in a CI log. Cloudflare recommends Worker
secrets rather than `vars` for sensitive values.

For more than one Bitkub account, run `wrangler secret put
BITKUB_ACCOUNTS_JSON` interactively and paste one JSON object keyed by the
exact IDs in D1's `accounts` table. Do not leave a second `accounts` row using
the legacy two-secret setup: the Worker intentionally skips it and records a
sync-health failure instead of copying balances from another account.

For a repeatable and safer account-addition path, run
`npm run setup:bitkub-account` from the repository root. The wizard reads the
current non-secret account IDs first, then accepts the complete replacement
credential map as hidden terminal input. It validates that the map contains
exactly every stored Bitkub account (including disconnected accounts) plus the
proposed new account before changing anything. Wrangler stores the secret map
first; only after that
succeeds does the wizard create the new active D1 row. This ordering prevents a
cancelled or invalid setup from interrupting the existing account. The map is
never saved to a file.

## AWS Bitkub secure sync

Use this path only when direct signed Bitkub requests from the Cloudflare Sync
Worker are rejected but the same read-only key succeeds from AWS. It moves the
private exchange request—not the database or browser API—to Lambda:

`EventBridge Scheduler → private Lambda → Bitkub → Cloudflare Access → API Worker → D1`.

The Lambda source is [infra/aws-bitkub-sync/lambda_function.py](../infra/aws-bitkub-sync/lambda_function.py). It fetches balances, trade history, crypto transfers, and fiat transfers. Before each run it reads D1 checkpoints through an authenticated internal API route; it sends only normalized records back to the API and never sends raw Bitkub payloads or direct D1 credentials. Trade records include the base quantity, quote asset, unit price, fee, and quote amount. Bitkub reports `amount` in quote units for buys and base units for sells, so the adapter normalizes those cases before ingestion.

Order-history discovery scans every active `source=exchange` symbol returned by
Bitkub, including non-THB pairs such as `BTC_USDT`, and follows keyset cursors to
completion. History is sent in chunks of at most 250 records and below the API
body limit. Only the final chunk advances the checkpoint, so a failed partial
delivery is safe to retry. Keep the 120-second Lambda timeout and review the
first complete CloudWatch result before relying on the schedule.

For an existing AWS deployment, pause the EventBridge schedule during this
protocol upgrade. Apply migrations, deploy the API Worker that understands the
`complete` marker, update the Lambda, run one manual test, and only then resume
the schedule. Never run the chunking Lambda against the older API because that
API could advance a checkpoint after an intermediate chunk.

### 1. Prepare Cloudflare

1. Apply every pending migration through `0013_rescan_exchange_history.sql`
   using the migration command above.
2. Set an `AWS_SYNC_INGESTION_SECRET` secret on the **API Worker**. Generate one
   random value in a password manager, paste the same value into AWS Parameter
   Store in the next section, then clear the clipboard. Never commit, log, or
   place it in `wrangler.jsonc`.
3. In the Cloudflare Access application for the exact API hostname, create a
   **Service token** named for this Lambda. Copy its client ID and one-time
   client secret directly into AWS SecureString parameters. Add an Access policy
   with action **Service Auth** that includes only that token. Keep the existing
   email allow-list policy for browser users.
4. Confirm the API route is protected by Access. Do not create an Access bypass
   for `/internal/aws-sync/` and do not create a public Lambda Function URL.

### 2. Create AWS parameters and execution role

In `ap-southeast-1`, create these **Standard SecureString** parameters (all
encrypted with your chosen KMS key):

| Parameter name | Value source |
| --- | --- |
| `/moondi/aws-sync/bitkub/api-key` | existing read-only Bitkub API key |
| `/moondi/aws-sync/bitkub/api-secret` | matching Bitkub secret |
| `/moondi/aws-sync/cloudflare/access-client-id` | Cloudflare service-token client ID |
| `/moondi/aws-sync/cloudflare/access-client-secret` | Cloudflare service-token client secret |
| `/moondi/aws-sync/ingestion-secret` | exact same value as API `AWS_SYNC_INGESTION_SECRET` |

Give a new Lambda execution role `AWSLambdaBasicExecutionRole` plus an inline
least-privilege policy. Replace the account ID and KMS key ARN, but keep the
parameter names exact:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": [
        "arn:aws:ssm:ap-southeast-1:<account-id>:parameter/moondi/aws-sync/bitkub/api-key",
        "arn:aws:ssm:ap-southeast-1:<account-id>:parameter/moondi/aws-sync/bitkub/api-secret",
        "arn:aws:ssm:ap-southeast-1:<account-id>:parameter/moondi/aws-sync/cloudflare/access-client-id",
        "arn:aws:ssm:ap-southeast-1:<account-id>:parameter/moondi/aws-sync/cloudflare/access-client-secret",
        "arn:aws:ssm:ap-southeast-1:<account-id>:parameter/moondi/aws-sync/ingestion-secret"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "<your-kms-key-arn>",
      "Condition": {
        "StringEquals": { "kms:ViaService": "ssm.ap-southeast-1.amazonaws.com" }
      }
    }
  ]
}
```

If the parameters use the AWS-managed `alias/aws/ssm` key, follow your
account's SSM access model instead of adding a customer-key ARN that does not
match. Do not give this role D1, Cloudflare, IAM, or general SSM permissions.

### 3. Deploy and prove the Lambda before scheduling it

Create a separate Lambda named `moondi-bitkub-sync` with Python 3.14, arm64 or
x86_64, 128 MB memory, 120-second timeout, **no VPC**, no function URL, and the
execution role above. Paste the tracked `lambda_function.py` source and set its
handler to `lambda_function.lambda_handler`.

Set these non-secret environment variables:

| Name | Value |
| --- | --- |
| `BITKUB_API_KEY_PARAMETER` | `/moondi/aws-sync/bitkub/api-key` |
| `BITKUB_API_SECRET_PARAMETER` | `/moondi/aws-sync/bitkub/api-secret` |
| `CF_ACCESS_CLIENT_ID_PARAMETER` | `/moondi/aws-sync/cloudflare/access-client-id` |
| `CF_ACCESS_CLIENT_SECRET_PARAMETER` | `/moondi/aws-sync/cloudflare/access-client-secret` |
| `AWS_INGESTION_SECRET_PARAMETER` | `/moondi/aws-sync/ingestion-secret` |
| `MOONDI_ACCOUNT_ID` | the exact active D1 account ID, for example `bitkub-main` |
| `MOONDI_INGESTION_URL` | `https://<your-api-host>/internal/aws-sync/bitkub/balances` |

Run one manual Lambda test with `{}`. It should return `{ "ok": true }`, log
only record counts, and create new balance/activity records plus corresponding
sync events in the dashboard. A `401`, `403`, or `404` from the
ingestion URL means the Access service-token policy or shared ingestion secret
is not configured correctly; do not weaken Access to diagnose it.

Only after that test succeeds, create an EventBridge Scheduler schedule of
`rate(30 minutes)` targeting this Lambda. Disable the flexible time window and
keep retry attempts bounded. If the account concurrency quota permits it, set
the function's reserved concurrency to `1` to avoid overlapping Bitkub syncs;
otherwise retain unreserved concurrency because AWS requires at least 100
unreserved executions before it permits a reservation. Add an AWS cost budget
alert even when using a free tier.

### 4. Cut over from Cloudflare private sync

After the manual Lambda test and one scheduled run both succeed, set
`BITKUB_SECURE_SYNC_MODE` to `aws-ingest` in **both** API and Sync Worker
`vars`, then deploy those two Workers. In this mode:

- Lambda owns every signed Bitkub request (balances and activity history);
- the Sync Worker keeps only public price refreshes;
- the dashboard has no **Sync now** control because EventBridge owns the
  private refresh schedule; and
- existing Cloudflare Bitkub credentials can be removed only after verifying
  that the AWS schedule remains healthy.

Do not switch this mode before Lambda ingestion is verified: otherwise no
component will be responsible for new private balance snapshots.

## Deploy order

Before building/deploying Pages, set `VITE_API_BASE_URL` in the Pages build
environment to the full API Worker origin. This is a public URL, not a secret,
but it must be the user's own API deployment. The repository deliberately has
no fallback to the original author's API.

```bash
npm run check
npm test
npm run build

npm run deploy --workspace=@moondi/sync-worker
npm run deploy --workspace=@moondi/api
npm run deploy --workspace=@moondi/web
```

The web workspace's deploy script targets this project's `production` Pages
branch explicitly. A preview deployment is not automatically the production
site. Forks should change the script (or pass `--branch`) to match their own
Pages production branch.

## Access and CORS

1. Create a Cloudflare Access application for the API hostname before setting
   exchange credentials or allowing the first sync.
2. Create Access applications for the preferred Pages/custom-domain hostname,
   the production `PROJECT.pages.dev` hostname, and enabled
   `*.PROJECT.pages.dev` previews. Alternatively, redirect the production
   `pages.dev` hostname to the protected custom domain and still protect or
   disable previews.
3. Use Google as the identity provider and an explicit email allow-list.
4. Confirm an unauthorized Google account is rejected.
5. Confirm `ALLOWED_ORIGIN` equals the deployed web origin exactly.
6. From a cookie-free `curl` or private browser, confirm every protected
   hostname redirects to Cloudflare Access instead of returning HTML or JSON.

Cloudflare Access is the security boundary. CORS only controls which browser
origins can read responses; it does not protect an API by itself.

For browser mutations from Pages to the separately hosted API, use a
form-encoded `POST` with a safelisted content type. Cloudflare Access evaluates
requests before the Worker, so JSON requests and non-simple verbs can trigger
an unauthenticated `OPTIONS` preflight. Keep legacy JSON/`PUT`/`DELETE` routes
only for same-origin or trusted programmatic clients; the dashboard uses
form-encoded `POST` routes for watchlists, allocation targets, and price alerts.

## First-production verification

- Visit `/health` on the API Worker and verify `{ "status": "ok" }`.
- Repeat the API health check without Access cookies and verify it redirects to
  Access rather than returning JSON.
- Check the production `PROJECT.pages.dev` and an enabled preview hostname
  without Access cookies; neither may return the dashboard directly.
- Sign into the Pages app through Access with an allowed account.
- Confirm the dashboard loads and no secret appears in browser network data.
- Confirm the sync Worker has a scheduled trigger. In AWS secure-sync mode,
  also confirm the private EventBridge schedule exists and Lambda has no public
  trigger.
- Inspect Worker logs after one cron run; use redacted error messages only.
- Check Sync health for balances, prices, trades, crypto transfers, and fiat transfers.
- Enable notifications in a supported browser. Test both device display and
  Worker delivery; the latter confirms Worker → push service → device without
  waiting for a Bitkub event.
- In AWS secure-sync mode, wait for EventBridge and confirm that its next
  invocation creates fresh balance and activity data; confirm the Sync Worker
  cron independently creates fresh public prices.
- For each additional Bitkub account, confirm the account selector can show its
  own balances, sync health names the correct account, and the combined scope
  equals the sum of the account scopes.

## Continuous deployment

For a public template, prefer each adopter's own GitHub repository connected to
their Cloudflare account. Cloudflare Pages can deploy automatically on pushes
from that repository. Keep production secrets only in the Cloudflare account,
never in GitHub repository variables unless a deliberate CI deployment design
has been reviewed.

Cloudflare's current Deploy Button can provision Worker resources, but it does
not deploy Pages applications or a multi-Worker monorepo as one application.
Therefore it is not the primary installer for Moondi's current architecture.
