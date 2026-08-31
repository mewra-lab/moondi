<p align="center">
  <img src="docs/assets/logo.svg" width="96" alt="Moondi logo" />
</p>

<h1 align="center">moondi.</h1>

<p align="center">A quiet, self-hosted view of a crypto portfolio.</p>

Moondi is a read-only crypto portfolio dashboard for Bitkub accounts. It keeps
exchange credentials in the owner's Cloudflare account, periodically records
balances and prices, and presents holdings, activity, portfolio-value history,
and optional browser push notifications.

> [!WARNING]
> Moondi is a portfolio viewer, not an exchange. It must only be used with a
> **read-only** API key. It has no code path for placing trades or withdrawals,
> and it is not financial, investment, or tax advice.

## Why self-hosted?

Your exchange API credentials, balances, transaction activity, and push
subscriptions are sensitive. In a Moondi installation, they remain in **your**
Cloudflare account. The project does not receive, proxy, or store anyone else's
API key.

## What it does today

| Capability | Status | Notes |
| --- | --- | --- |
| Bitkub balance snapshots | Available | Uses a read-only API key in the sync Worker. |
| Current THB valuation | Available | Holdings × latest available THB price, including THB cash. |
| Portfolio-value history | Available | Historical balance snapshots valued with matching recorded prices. Incomplete points are excluded rather than shown incorrectly. |
| Per-asset price trend | Available | Uses collected Bitkub prices; it starts after the installation has collected data. |
| Activity ledger | Available when the exchange endpoint is authorized | Normalized trade and transfer data; check Sync health for endpoint status. |
| PWA push notifications | Available | Per-device controls for synchronized activity, price-target alerts, and sync issues, where supported by the browser. |
| Manual refresh | Available | Starts a read-only sync through an internal Worker binding; global cooldown prevents repeated exchange calls. |
| Account scope, watchlist, allocation targets, target comparison, overview visibility | Available | Reads normalized values and stores personal browser preferences only; target comparison cannot trade or instruct trades. |
| Multiple Bitkub accounts | Available | Each local account has its own read-only Worker-secret credential mapping; scopes can show one account or the combined view. |
| JSON backup | Available | Downloads a bounded, normalized one-year export; it excludes credentials and raw exchange payloads. |
| Cost basis / realized or unrealized P&L | Not implemented | Requires complete, reliable trade and fiat-transfer history. |
| Buying, selling, or withdrawals | Intentionally unsupported | Moondi is read-only by design. |
| Binance | Planned | The adapter seam exists; no production adapter is included. |

Read the full [feature status](docs/feature-status.md) before relying on a
number for financial decisions.

## Architecture

```text
Browser PWA ── Cloudflare Access ── Pages (React)
                    │
                    └────────────── API Worker (Hono) ── D1 + KV
                                             ▲
                                             │
                                      Sync Worker (Cron) ── Bitkub
```

The browser only receives normalized portfolio data. Bitkub signing and secrets
remain inside the sync Worker. Details: [architecture](docs/architecture.md).

## Quick start

Prerequisites: a Cloudflare account, Node.js/npm, Wrangler authenticated to
your account, and a Bitkub **read-only** API key.

```bash
git clone https://github.com/mewra-lab/moondi.git
cd moondi
npm install

npm run setup
```

The guided installer creates an independent D1 database, KV namespace, ignored
Worker configuration, first account row, and deployments in the installer's own
Cloudflare account. Bitkub credentials are entered only into Wrangler's hidden
secret prompt. It intentionally leaves Cloudflare Access as a final manual
security checklist.

For a manual or existing installation, create local-only configuration from the
tracked examples instead:

```bash

cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc
cp apps/sync-worker/wrangler.example.jsonc apps/sync-worker/wrangler.jsonc
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/sync-worker/.dev.vars.example apps/sync-worker/.dev.vars
cp apps/web/.env.example apps/web/.env

npm run check
npm test
npm run build
```

Follow [Quick start](docs/quickstart.md) for the safe, complete setup and the
manual alternative: resources, database migrations, secrets, account record,
deployment, Access, and verification.

To add another Bitkub account to an existing deployment, use the repeatable
interactive setup path. It creates only a non-secret D1 account row and passes
the full credential map directly to Wrangler's protected prompt:

```bash
npm run setup:bitkub-account
```

The wizard requires the account's own read-only key, which it neither writes to
the repository nor sends through the browser.

## Documentation

- [Quick start](docs/quickstart.md) — first self-hosted installation
- [Deployment](docs/deployment.md) — resources, configs, migrations, deploys
- [Bitkub setup](docs/bitkub.md) — read-only key, IP allow-list, sync limits
- [Architecture](docs/architecture.md) — components and data flow
- [Security](docs/security.md) — threat model and secret-handling rules
- [Operations](docs/operations.md) — monitoring, backups, updates, rollback
- [Troubleshooting](docs/troubleshooting.md) — Access, sync, price, PWA issues
- [Feature status](docs/feature-status.md) — what each number does and does not mean
- [Distribution model](docs/distribution.md) — why Moondi is self-hosted today

## Development

```bash
npm run dev:web
npm run dev:api
npm run dev:sync
```

Run quality checks before opening a pull request:

```bash
npm run check
npm test
npm run build
```

See [Contributing](CONTRIBUTING.md) for project conventions.

## Security and privacy

- Never commit `.dev.vars`, `.env`, generated Worker types, or deployment
  configuration for a real Cloudflare account.
- Set deployed secrets interactively with `wrangler secret put`; do not put
  them in `wrangler.jsonc`.
- Restrict the dashboard and API with Cloudflare Access and an explicit email
  allow-list.
- Treat API keys and push-subscription endpoints as credentials.
- Use only a Bitkub key with no trade or withdrawal permission.

Report a vulnerability privately; see [SECURITY.md](SECURITY.md).

## License

Licensed under [Apache-2.0](LICENSE). The license does not remove the
responsibility to use read-only credentials or protect your own financial data.
