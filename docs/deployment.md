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
| API Worker | Browser API | Receives normalized, authenticated dashboard requests. |
| Sync Worker | Cron | Holds Bitkub secrets and makes read-only exchange requests. |
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
- Confirm the sync Worker has a scheduled trigger.
- Inspect Worker logs after one cron run; use redacted error messages only.
- Check Sync health for balances and prices.
- Enable notifications in a supported browser. Test both device display and
  Worker delivery; the latter confirms Worker → push service → device without
  waiting for a Bitkub event.
- Use **Sync now** once. Confirm it acknowledges the request, is rate limited
  for 15 minutes, and that a new balance/price sync event appears after it finishes.
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
