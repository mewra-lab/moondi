# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the checked-in working agreement and applies here too: read `DESIGN.md` before product/architecture decisions, and `AGENT_BUILD_PLAN.md` before implementation (complete phases in order; later-phase features stay out until the current phase is demonstrably working). Fetch current official Bitkub and Cloudflare docs before touching exchange or Workers code — do not rely on memory for endpoints, signing, limits, or Wrangler syntax.

## What this is

Moondi is a read-only, self-hosted Bitkub portfolio dashboard. Each installation lives in the owner's own Cloudflare account. There is deliberately no trade/order/withdrawal code path; do not add one.

## Commands

npm workspaces monorepo (`apps/*`, `packages/*`). Run from the repo root:

```bash
npm ci
npm run check            # tsc -p in every workspace
npm test                 # node --test scripts/*.test.mjs, then vitest run per workspace
npm run build            # tsc + vite build for apps/web
npm run dev:web | dev:api | dev:sync
npm run setup            # guided first-install wizard (scripts/setup-self-hosted.sh)
```

Single test:

```bash
npx vitest run packages/shared/src/pnl.test.ts                  # one file (vitest 4)
npx vitest run -t "name fragment" --root packages/shared        # by test name
node --test scripts/db-schema.test.mjs                          # installer/schema tests use node:test
```

Worker type generation is required before `check` works in `apps/api` and `apps/sync-worker`: `worker-configuration.d.ts` and the real `wrangler.jsonc` are **gitignored** (only `wrangler.example.jsonc` is tracked). CI generates types from the example config:

```bash
npm run types --workspace @moondi/api -- --config wrangler.example.jsonc
npm run types --workspace @moondi/sync-worker -- --config wrangler.example.jsonc
```

After changing Wrangler config also run `npm run deploy:dry --workspace <pkg>`. CI additionally runs `npm audit` and `npm audit signatures`.

## Architecture

Three deployables plus two shared packages (see `docs/architecture.md` for the diagram and trust-boundary table):

- **`apps/web`** — React/Vite PWA on Cloudflare Pages. One large `src/app.tsx`; small pure helpers (`pnl-display`, `portfolio-card-layout`, `transaction-display`) have colocated tests. `src/api.ts` holds the hand-written response types for the API.
- **`apps/api`** — Hono Worker, essentially all in `src/index.ts`. Handlers are built with `createFactory<HonoEnv>()` and chained so `AppType` can be exported. Public routes are under `/api`; AWS ingestion is mounted at `/internal/aws-sync/bitkub` via `aws-bitkub-routes.ts`. Tests use `app.request`/`new Request` against the default export (`apps/api/test/app.test.ts`).
- **`apps/sync-worker`** — cron-triggered Worker (`scheduled`) that syncs balances and public prices into D1; also exposes `/internal/sync/trigger` and `/internal/push/test`, reachable only via the API's service binding (`SYNC`) and guarded by `hasInternalAccess`. A `sync_locks` row in D1 prevents overlapping runs. Also delivers Web Push.
- **`packages/exchanges`** — Bitkub signing and response mapping behind the `ExchangeAdapter` seam. Raw Bitkub shapes must not escape this package.
- **`packages/shared`** — normalized domain types (`NormalizedTrade`, `PriceQuote`, …), `ExchangeAdapter`, portfolio valuation helpers, and the pure P&L engine (`calculateAverageCostPnl` etc.), kept free of HTTP/D1 effects so it is deterministically testable.

### Two Bitkub ingestion paths

Bitkub rejects secure calls from some Cloudflare egress. Depending on `BITKUB_SECURE_SYNC_MODE` (`worker` vs `aws-ingest`), secure history comes either from the sync Worker directly, or from an AWS Lambda (`infra/aws-bitkub-sync/`, Python) that fetches and normalizes data, then POSTs bounded payloads to the API's `/internal/aws-sync/bitkub/*`. Those requests require **both** a Cloudflare Access service token and an app-level HMAC with fresh timestamp and single-use nonce (recorded in D1, table from migration 0009). The Lambda reads per-data-type checkpoints/coverage starts from `/state`; only a final complete chunk advances the monotonic checkpoint and keeps the original coverage start.

### Data model rules that span files

- D1 holds sparse balance snapshots (positive assets + THB), prices only for held/watched/alerted assets, and precomputed per-30-minute portfolio/per-asset value summaries. Page loads read those summaries — never recompute from raw history or call an exchange.
- A historical portfolio-value point is emitted only if every non-THB asset has a price at that snapshot; otherwise it is omitted. Balance and price jobs can finish in either order and each tries to materialize the latest complete snapshot.
- P&L is withheld (not guessed) for unsupported pairs, missing history, or quantity mismatches (tolerance `2e-7`). Cost basis is average cost per Bitkub account for THB-quoted trades; external crypto deposits need a manual THB cost basis. Valuation is not P&L — keep docs and UI wording consistent with `docs/feature-status.md`.
- Accounts are multi-account: each account maps to its own Worker-secret credentials and never falls back to another account's (`account-credentials.ts`).

### Database

`db/migrations/` is append-only (applied via the API's `migrations_dir`). `db/schema.sql` must stay equal to the result of applying all migrations in order — `scripts/db-schema.test.mjs` enforces this and also checks the history-coverage migrations (0017/0018). Update both when changing schema.

## Security conventions worth remembering

- Secrets only in ignored `.dev.vars` locally and `wrangler secret put` when deployed; never in args, logs, fixtures, or config. `.dev.vars.example` / `wrangler.example.jsonc` are shape-only.
- Cloudflare Access is the auth layer for UI/API; CORS is not authentication. Only the exact public share-route prefix may bypass Access, and the Worker still authorizes and filters those responses.
- Exchange tests use saved, sanitized fixtures; live exchange calls are smoke tests with read-only keys only.
- `/history/` (local Bitkub history exports, consumed by `scripts/import-bitkub-history.mjs`) is gitignored — never commit it.
- UI changes must keep Thai and English copy, responsive layout, keyboard focus, and value-concealment behavior (`CONTRIBUTING.md`).
