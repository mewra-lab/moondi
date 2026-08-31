# Agent Build Plan — Crypto Portfolio Tracker

Read `DESIGN.md` first for full context and rationale. This file is the
actionable checklist. Work phase by phase; don't jump ahead. After each
phase, the app should be deployable and demonstrably working before moving
on.

**Before writing any exchange-integration code:** fetch the current, official
API docs for the exchange you're implementing (Bitkub:
`https://github.com/bitkub/bitkub-official-api-docs`, Binance:
`https://binance-docs.github.io/apidocs/spot/en/`) and the current Cloudflare
docs for Workers / D1 / KV / Cron Triggers / Access
(`https://developers.cloudflare.com/`). Endpoints, field names, rate limits,
and free-tier limits all change over time — do not rely on prior training
knowledge for exact paths, params, or limits.

---

## Current work — Public-release foundations

The repository may be published as a self-hosted template only after its public
configuration and documentation are demonstrably safe. This is not a change to
the product boundary: it remains a read-only, single-owner installation rather
than a multi-tenant service.

1. Audit current files and all reachable Git history for secrets and personal
   infrastructure data. Rotate anything found before publication.
2. Track only `wrangler.example.jsonc`; keep real `wrangler.jsonc`, resource
   IDs, domains, `.dev.vars`, and `.env` files ignored.
3. Maintain an accurate README plus deployment, Bitkub, architecture, security,
   operations, troubleshooting, and feature-status documentation.
4. Explain unambiguously that valuation is not P&L and that the app cannot
   trade or withdraw.
5. Verify documentation commands and run all repository checks before release.
6. Provide a repeatable local first-install wizard that creates only the
   installer's Cloudflare resources, writes ignored configuration, and passes
   exchange credentials only to interactive Wrangler secret prompts. It must
   leave Access policy decisions to an explicit manual checklist.

**Acceptance:** a new owner can create an independent Cloudflare installation
from the guided local installer or tracked examples without receiving the
original owner's resource IDs or secrets, and public docs do not overstate
exchange-history/P&L capability.

---

---

## Repo Structure (suggested)

```
/apps
  /web            React + Vite + TS SPA (Cloudflare Pages)
  /api            Cloudflare Worker (Hono) — user-facing API
  /sync-worker    Cloudflare Worker with Cron Trigger — exchange polling
/packages
  /shared         Shared TS types: NormalizedBalance, NormalizedTrade,
                  NormalizedTransfer, ExchangeAdapter interface
  /exchanges
    /bitkub       Bitkub adapter implementation
    /binance      Binance adapter implementation (Phase 4)
/db
  schema.sql      D1 schema (from DESIGN.md §6)
  migrations/     Incremental migrations if schema evolves
```

`/apps/api` and `/apps/sync-worker` can share the same D1 binding and the
`/packages/shared` + `/packages/exchanges` code.

---

## Environment / Secrets Checklist

Set via `wrangler secret put <NAME>` per Worker (never commit these):

- `BITKUB_API_KEY`, `BITKUB_API_SECRET` (read-only key, no trade/withdraw scope)
- `BINANCE_API_KEY`, `BINANCE_API_SECRET` (Phase 4, read-only)
- `ALLOWED_EMAILS` (comma-separated, the two Google accounts allowed — used
  only as a secondary check if you verify the `Cf-Access-Jwt-Assertion`
  yourself; primary enforcement is the Access policy itself)

Bindings (in `wrangler.toml`):
- D1 database binding, e.g. `DB`
- KV namespace binding, e.g. `CACHE`
- Cron Trigger schedule on `sync-worker` (e.g. `*/30 * * * *` — confirm
  current minimum interval allowed on the free plan before finalizing)

---

## Phase 1 — Bitkub MVP

**Goal:** see real Bitkub balances and transaction history in a web UI,
gated by Cloudflare Access.

1. Scaffold the monorepo (structure above). Init `apps/api` as a Hono
   Worker, `apps/web` as a Vite React TS app, `apps/sync-worker` as a
   plain Worker with a scheduled handler.
2. Create the D1 database and apply `db/schema.sql` (tables: `accounts`,
   `balance_snapshots`, `trades`, `crypto_transfers`, `fiat_transfers`,
   `price_cache`, `sync_state`).
3. Implement `packages/shared`: the `ExchangeAdapter` interface and
   `Normalized*` types exactly as in DESIGN.md §5.
4. Implement `packages/exchanges/bitkub`:
   - HMAC-SHA256 request signing helper (timestamp + method + path + body,
     per current official docs).
   - `fetchBalances()`, `fetchTrades()`, `fetchDeposits()`,
     `fetchWithdrawals()`, `fetchFiatDeposits()`, `fetchFiatWithdrawals()` —
     map raw Bitkub responses into the normalized types.
   - Handle pagination and the documented history-archival window (fetch
     full history on first sync; incremental after that using
     `sync_state.last_synced_at`).
5. Implement `apps/sync-worker` scheduled handler:
   - For each row in `accounts` where `exchange = 'bitkub'`: call the
     adapter, upsert into `balance_snapshots`/`trades`/`crypto_transfers`/
     `fiat_transfers`, update `sync_state`.
   - Also refresh `price_cache` (Bitkub's public ticker endpoint is
     sufficient for Bitkub-only assets).
   - Add basic error handling + logging (don't let one account's failure
     block others).
6. Manually insert one row into `accounts` for your Bitkub account (via
   `wrangler d1 execute` or a temporary seed script) — account management UI
   isn't needed yet.
7. Implement `apps/api` routes: `GET /api/accounts`, `GET /api/portfolio`,
   `GET /api/portfolio/:accountId`, `GET /api/transactions` (see DESIGN.md
   §8 for shape). No P&L math yet — just raw balances + a transaction feed.
8. Implement `apps/web`: Dashboard page (balances table) and Transactions
   page (filterable table), calling `apps/api`.
9. Deploy: `apps/web` → Cloudflare Pages, `apps/api` and `apps/sync-worker`
   → Cloudflare Workers.
10. Set up Cloudflare Access: create a Zero Trust application covering the
    Pages domain + API Worker route, Google as IdP, policy allow-listing
    your two emails. Verify you're prompted to sign in with Google and
    that a third-party Google account is rejected.

**Acceptance:** you can log in with Google, see live Bitkub balances and a
transaction list, and the sync worker keeps D1 up to date on schedule.

### Current implementation note

If an exchange blocks one or more history endpoints externally, preserve the
Phase 1 acceptance work and continue only with non-exchange-dependent data
capture: record price snapshots alongside balance snapshots and expose sync
health. Read-only UX that only filters, inspects, or exports already-loaded
normalized data, including visualization of stored value snapshots, current
allocation, and sync details, may also proceed. Do not mark Phase 2 P&L or its
acceptance complete until complete trade and fiat-history data is available.

Current extension: account-scoped inspection, bounded normalized backups,
watchlists, price-target alerts, allocation targets, and a user-requested
read-only manual sync are permitted. Manual sync must use an internal binding,
be rate-limited, and share an execution lock with cron. None of these features
may imply invested capital, P&L, trading, or withdrawals.

A target-difference view may calculate current percentage and estimated THB
distance from existing allocation targets in the browser. It must remain a
read-only comparison: do not add trade amounts, transaction instructions,
exchange calls, notifications, or automated rebalancing.

Multiple Bitkub accounts may be added only through a distinct local account row
and a Sync Worker secret map keyed by that row's ID. The browser must never add,
edit, or receive credentials. Retain legacy single-account secrets only as a
one-account compatibility path; reject them when more than one Bitkub account
is configured.

Use the repeatable `npm run setup:bitkub-account` wizard for this operation.
It may write only the non-secret `accounts` row and update the Worker secret
through the installer's interactive Wrangler session; it must never persist the
credential map in a repository file or send it through a browser. Validate the
complete replacement map for every stored account before either mutation, store the secret before making
the new account active, and leave existing account sync working if setup is
cancelled or the final row insert fails.

An account-disconnect control may archive a local account row only. It must
exclude the account from scheduled sync and normal user-facing aggregate data,
but retain normalized history and leave Worker secrets outside the browser.
It may reconnect that same local row by clearing the archive state, provided it
does not create, modify, delete, or expose an exchange credential.

---

## Phase 2 — P&L Engine

1. Implement the average-cost P&L calculation (DESIGN.md §7) as a pure
   function in `packages/shared` operating on `trades` rows for one asset,
   so it's independently testable.
2. Wire it into `GET /api/portfolio` — add `investedAmount`,
   `realizedPnl`, `unrealizedPnl`, `totalPnl`, per-asset `avgCost`, to the
   response.
3. Add `GET /api/history/value` backed by `balance_snapshots` × historical
   `price_cache` (store a timestamped price history table if you need true
   historical pricing — Bitkub's ticker/candle endpoints can backfill this;
   otherwise approximate using price at each snapshot time going forward
   only).
4. Add a manual "cost basis override" field for crypto that arrived via
   `crypto_transfers` (direction = deposit) with no matching trade — a
   simple form + a nullable `manual_cost_basis` column keyed by transfer id,
   excluded from P&L by default until filled in.
5. Frontend: dashboard summary cards (value, invested, P&L), allocation
   pie/bar chart, portfolio value line chart, per-asset breakdown table.

**Acceptance:** dashboard shows invested capital, realized/unrealized P&L,
and a value-over-time chart that roughly matches what you'd calculate by
hand from a few known trades.

---

## Phase 3 — Portfolio Card Export

1. Create an explicit user action that renders a static portfolio card on the
   authenticated device. It must not create a public route, token, database
   record, or outbound request containing portfolio data.
2. Offer privacy presets: allocation-only, current valuation, and a future
   P&L-inclusive card only once P&L is verified. Default to hiding absolute
   values and account labels.
3. Include the selected period, currency, generation time, and an honest
   valuation/P&L label. Do not include transaction IDs or raw exchange data.
4. Use browser-native image generation/download and the Web Share API only
   where available; provide a normal download fallback.
5. Test Thai/English, light/dark, values concealed, narrow mobile width, and
   accessibility without relying on a canvas-only interaction.

Implementation note: the first card export supports allocation-only and
current-value templates, browser image copy/download/share fallbacks, and a
mobile bottom drawer. P&L remains intentionally unavailable.

**Acceptance:** an authenticated viewer can export a responsive, private
portfolio image without making a public link or transmitting new portfolio data
to a Moondi service.

---

## Phase 4 — Binance Adapter

1. Implement `packages/exchanges/binance` against the same
   `ExchangeAdapter` interface — re-check current Binance Spot API docs for
   exact endpoints/signing before coding.
2. Add a `binance` row to `accounts`, extend `sync-worker` to loop over all
   `accounts` regardless of exchange (should already work if the adapter
   interface was followed correctly in Phase 1 — this is the test of that
   abstraction).
3. Decide/implement a base-display-currency conversion if Binance balances
   are USDT-denominated and you want everything shown in THB (fetch a
   THB/USDT rate, cache in `price_cache`).
4. Verify dashboard/P&L correctly aggregates across both exchanges (per-
   account view still isolates one exchange when filtered).

**Acceptance:** both Bitkub and Binance balances/trades appear together on
one dashboard, with per-exchange filtering still available.

---

## Phase 5 — Optional Polish (only if time permits)

- CSV export of transactions.
- Switch P&L method to FIFO (behind a toggle), for closer alignment with
  tax reporting.
- Price alerts (needs an outbound notification channel — email via a
  transactional email API, or none if out of scope).
- PWA push notifications for newly synchronized trades and transfers, with
  subscriptions stored in D1 and VAPID credentials held as Worker secrets;
  refresh an active subscription on app open and prune subscriptions inactive
  for 180 days. Let each subscribed browser select trade, transfer, and sync
  issue categories; test both device notification display and a rate-limited,
  fixed-payload Worker delivery to the current subscription.
- Multi-currency display toggle (THB/USD).

---

## Testing Notes for the Agent

- Unit test the P&L function with hand-computed fixtures (a small sequence
  of buys/sells with known expected avg cost and realized P&L) — this is
  the highest-risk-of-bugs piece of logic.
- Unit test each exchange adapter's response-mapping function against a
  saved sample JSON response (don't hit the live API in tests).
- Smoke-test the sync worker locally with `wrangler dev` and a real
  read-only API key before deploying on a schedule.
- Before enabling Cloudflare Access, confirm you can still reach the app
  yourself via a direct Worker/Pages URL for debugging (Access can lock you
  out if misconfigured — keep a fallback admin path documented, e.g. via
  `wrangler tail` and dashboard access to fix policies).
