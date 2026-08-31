# Quick start

This guide creates an independent installation in your own Cloudflare account.
It does not send a Bitkub key to Moondi's repository, maintainers, or a shared
web service.

## Before you begin

You need:

- Node.js and npm compatible with the repository's `packageManager` field;
- a Cloudflare account and the Wrangler CLI authenticated to that account;
- a Bitkub API key with **read-only permissions only** for each account you
  intend to connect;
- a GitHub account if you want a fork and managed deployment history; and
- a Google identity provider configured in Cloudflare Zero Trust if the
  dashboard should be private.

Do not begin with a key that can trade or withdraw.

## 1. Create your copy

Use **Use this template** on GitHub when available, or fork/clone the project.
Then install dependencies:

```bash
git clone https://github.com/<your-account>/moondi.git
cd moondi
npm install
```

### Guided installation (recommended)

Run the local installer:

```bash
npm run setup
```

It checks the installer's authenticated Wrangler account, creates a D1 database
and KV namespace after confirmation, writes ignored local Worker configuration,
applies migrations, deploys both Workers and Pages, and creates the first
non-secret Bitkub account row. It asks for the Bitkub key and secret only via
Wrangler's protected prompt; it does not save them in a file, browser, Git
history, or GitHub Actions.

The installer cannot responsibly automate the final Cloudflare Access policy or
choose a Bitkub key's permissions. Complete its explicit Access checklist and
use a key with read permission only.

### Manual installation

For an existing deployment or a custom resource layout, create local-only
configuration files yourself:

```bash

cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc
cp apps/sync-worker/wrangler.example.jsonc apps/sync-worker/wrangler.jsonc
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/sync-worker/.dev.vars.example apps/sync-worker/.dev.vars
cp apps/web/.env.example apps/web/.env
```

The copied `wrangler.jsonc` files are intentionally ignored by Git. They are
specific to your Cloudflare account and must not be committed.

## 2. Create Cloudflare resources

Create one D1 database and one KV namespace in your Cloudflare account. Put
their IDs in both copied Wrangler configuration files. Keep the same binding
names: `DB` and `CACHE`.

Choose unique Worker names. For a first deployment, leave `workers_dev` enabled
in the template. Configure custom domains only after the basic installation
works.

## 3. Configure development secrets

Fill in local values in the ignored `.dev.vars` files:

- `apps/api/.dev.vars`: local `ALLOWED_ORIGIN`, VAPID public key when testing
  push;
- `apps/sync-worker/.dev.vars`: Bitkub API key/secret and VAPID values.
- `apps/web/.env`: `VITE_API_BASE_URL`, the full origin of the API Worker.

The API key and secret must never appear in source code, issue reports,
screenshots, shell history, or commits.

## 4. Verify before deployment

```bash
npm run check
npm test
npm run build
```

Run the web, API, and scheduled Worker locally in separate terminals if you
want to inspect the installation before publishing it:

```bash
npm run dev:web
npm run dev:api
npm run dev:sync
```

## 5. Create the database and account

Apply all D1 migrations to your own database. Then create one `accounts` row
for each Bitkub account that the sync Worker will read. Use a random local ID,
the exchange value `bitkub`, a non-sensitive label, and the owner email used by
your Access policy.

Do not reuse an account ID from a screenshot, tutorial, or another deployment.

## 6. Set production secrets

Use `wrangler secret put` interactively for each Worker. For one account, the
Sync Worker can use `BITKUB_API_KEY` and `BITKUB_API_SECRET`. For two or more
Bitkub accounts, set the Sync Worker secret `BITKUB_ACCOUNTS_JSON` instead. It
is a JSON object whose keys exactly match the local `accounts.id` values:

```json
{
  "your-bitkub-main-id": { "apiKey": "read-only-key", "apiSecret": "read-only-secret" },
  "your-bitkub-secondary-id": { "apiKey": "read-only-key", "apiSecret": "read-only-secret" }
}
```

Paste the real JSON only into the interactive `wrangler secret put` prompt.
Never put it in D1, a browser form, a `wrangler.jsonc` file, a commit, or a
support ticket. Push needs the VAPID private key only in the Worker that
delivers notifications.

Never replace this with a value embedded in `wrangler.jsonc`.

### Add a further Bitkub account later

For an existing deployment, create a new Bitkub key with read access only, then
run the committed interactive helper from the repository root:

```bash
npm run setup:bitkub-account
```

It asks for a new non-secret local account ID, label, owner email, D1 database
name, and ignored Sync Worker config path. After an explicit confirmation, it
adds the D1 `accounts` row. It then asks for the **complete**
`BITKUB_ACCOUNTS_JSON` map in hidden terminal input and validates that it has
one credential pair for every active Bitkub account currently in D1 before passing it
to `wrangler secret put`. The map is never written to `.env`, D1, or the
repository. If the command stops before the secret stage, the account is safe
but unsynced; rerun the helper with the full map before the next sync.

## 7. Deploy in dependency order

1. Apply D1 migrations.
2. Deploy the API Worker.
3. Deploy the sync Worker and confirm the cron schedule.
4. Deploy the Pages web app.
5. Set the API `ALLOWED_ORIGIN` to the final Pages/custom-domain origin.

The detailed commands, config fields, and validation checklist are in
[Deployment](deployment.md).

## 8. Protect it before adding real data

Create Cloudflare Access applications for both the Pages site and API Worker,
use Google as the identity provider, and allow only explicit email addresses.
Do not use a policy that accepts every Google account.

## 9. Confirm the first sync

Open the dashboard after Access login and check **Sync health**. Balances and
prices should report success. Endpoint-specific activity may be deferred if
Bitkub has not authorized the key/IP combination; see [Bitkub setup](bitkub.md).

Price history requires at least two successful snapshots. A new installation
will therefore show `Collecting prices` before a 24-hour mini-chart exists.
