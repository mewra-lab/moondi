# Crypto Portfolio Tracker — Design Document

## 1. Summary

A private web app that shows crypto wallet balances, transaction history,
invested capital, and realized/unrealized P&L, pulled from exchange APIs
(Bitkub first, Binance later). Deployed entirely on Cloudflare's free tier.
Primary viewers (you + partner) sign in with Google.

**Non-goals:** placing trades, withdrawing funds, tax filing/export (can be a
future phase), multi-tenant SaaS (this is a personal app for a handful of
people).

### 1.1 Distribution model

Moondi is distributed as a **self-hosted template**, not a hosted service. An
installer owns their Git repository, Cloudflare account, D1/KV resources, and
read-only exchange key. The project never receives or brokers another user's
exchange credential.

The public repository contains configuration examples only. Actual Wrangler
configurations, Cloudflare resource IDs, domains, and secrets are local to each
installation and ignored by Git. The repeatable local `npm run setup` installer
creates D1/KV resources only after confirmation, writes ignored Worker
configuration, applies migrations, deploys the application, and invokes
Wrangler's hidden prompts for a first read-only Bitkub key pair. A separate
wizard can create a non-secret additional Bitkub account row through the
installer's authenticated Wrangler session and set the credential map through a
hidden Wrangler prompt. Neither path may send secrets to a Moondi-operated
server.

Cloudflare's deploy-button flow is not the primary distribution mechanism for
the current architecture because it does not deploy a Pages application and a
multi-Worker monorepo as one application. Revisit that option only if the
architecture is deliberately consolidated.

The private dashboard has three primary views: an overview of holdings, a
filterable transaction ledger, and a portfolio-history view. The history view
uses the snapshots already stored in D1, supports 24-hour, 7-day, 30-day,
90-day, and 1-year presets plus a custom date range, and lets the viewer
inspect the value and timestamp of each recorded point without making an
additional exchange request.

The dashboard can also register a browser for PWA push notifications about
newly synchronized trades, transfers, and sync issues. Per-device preferences
choose which categories are delivered. A subscription is refreshed when its
browser opens Moondi, removed when the browser unsubscribes or push delivery
reports it gone, and pruned after 180 days without a refresh.

The settings dialog offers a separate, rate-limited delivery check that sends a
fixed test message only to the current subscription. The API invokes the Sync
Worker through an internal service binding; the VAPID private key remains in
the Sync Worker and the browser never receives it.

The overview's sync-health summary may link to a bounded sync-activity view.
It reads normalized event metadata already retained in D1, never triggers an
exchange request, and does not expose raw provider payloads or credentials.

---

## 2. High-Level Architecture

```
                       ┌─────────────────────────┐
                       │   Cloudflare Access      │  ← Google OAuth gate
                       │   (protects the whole app)│   (allow-list of emails)
                       └────────────┬─────────────┘
                                    │
   Browser (React SPA) ────────────┤
                                    │
                       ┌────────────▼─────────────┐
                       │   Cloudflare Pages        │  static assets (SPA)
                       └────────────┬─────────────┘
                                    │ fetch /api/*
                       ┌────────────▼─────────────┐
                       │   Cloudflare Worker (API) │  Hono router
                       │  - /api/portfolio         │
                       │  - /api/transactions      │
                       └───┬────────────┬─────────┘
                            │            │
                  ┌─────────▼──┐   ┌─────▼──────┐
                  │  D1 (SQLite)│   │  KV Store  │  price cache,
                  │  balances,  │   │  cache /    │  transient state
                  │  txns, cost │   │  rate-limit │
                  │  basis      │   └────────────┘
                  └─────────────┘
                            ▲
                            │ writes
                  ┌─────────┴──────────┐
                  │ Cron Trigger Worker │  runs every N minutes
                  │  - Bitkub adapter   │  fetches balances + trade/
                  │  - Binance adapter  │  deposit/withdraw history,
                  │  (later)            │  upserts into D1
                  └─────────────────────┘
```

All Cloudflare products used here (Pages, Workers, D1, KV, Cron Triggers,
Access) have a free tier sufficient for 2–5 users and infrequent polling.
Verify current limits at build time (they change); the agent build plan
tells you where to check.

---

## 3. Cloudflare Component Choices

| Need | Component | Why |
|---|---|---|
| Static frontend hosting | **Cloudflare Pages** | Free, git-connected CI deploys |
| API / business logic | **Cloudflare Workers** (Hono framework) | Free tier req/day is generous; runs at the edge; can call exchange APIs server-side so secrets never reach the browser |
| Database | **Cloudflare D1** | Free SQLite-compatible, good enough for personal-scale transaction history |
| Cache / ephemeral state | **Cloudflare KV** | Cache last-known prices and short-lived application state |
| Scheduled sync | **Cloudflare Cron Triggers** on a Worker | Pull exchange data on a schedule without a user request |
| Auth for the main app | **Cloudflare Access** (Zero Trust) with Google as identity provider | Free up to 50 users; blocks the entire app at Cloudflare's edge *before* any request reaches your Worker/Pages — no auth code to write |
| Secrets (API keys) | **Wrangler secrets** (`wrangler secret put`) | Never stored in D1/KV in plaintext, never sent to the browser |

---

## 4. Authentication Model

Two independent layers:

### 4.1 Primary users (you + partner) — Cloudflare Access
- Put the whole app (Pages project + Worker API routes) behind a Cloudflare
  Access application.
- Identity provider: Google (OAuth), configured in Cloudflare Zero Trust
  dashboard.
- Access policy: allow only your two email addresses (an explicit allow-list,
  not "any Google account").
- Result: no login code, no session cookies to manage yourself, no password
  storage. Cloudflare handles the OAuth dance and issues a signed JWT
  (`Cf-Access-Jwt-Assertion`) that your Worker can optionally verify if it
  needs to know *which* of the two users is logged in (e.g. to show
  per-person "my invested amount").

---

## 5. Exchange Adapter Abstraction

To support Bitkub now and Binance later without rewriting core logic, define
a common interface every exchange adapter implements:

```ts
interface ExchangeAdapter {
  id: 'bitkub' | 'binance';
  fetchBalances(): Promise<NormalizedBalance[]>;
  fetchTrades(sinceTimestamp?: number): Promise<NormalizedTrade[]>;
  fetchDeposits(sinceTimestamp?: number): Promise<NormalizedTransfer[]>;
  fetchWithdrawals(sinceTimestamp?: number): Promise<NormalizedTransfer[]>;
  fetchFiatDeposits?(sinceTimestamp?: number): Promise<NormalizedFiatTx[]>;
  fetchFiatWithdrawals?(sinceTimestamp?: number): Promise<NormalizedFiatTx[]>;
}
```

All adapters normalize into the **same shape** before writing to D1, tagged
with an `exchange` column. The rest of the app (P&L engine, UI) never talks
to a specific exchange — only to the normalized tables.

### 5.1 Bitkub specifics
- REST API, base URL per Bitkub's official docs
  (`bitkub/bitkub-official-api-docs` on GitHub — always re-check before
  implementing, endpoints get deprecated/versioned, e.g. Fiat v3 → v4
  migration).
- Secure endpoints require HMAC-SHA256 signing of the request (API key,
  timestamp, method, path, body) with your API secret — **must happen
  server-side in the Worker**, never in the browser.
- Endpoints of interest (confirm exact current paths in the official docs
  before coding):
  - Wallet balances (available + reserved) per asset.
  - My order history (buy/sell trades) — note: paginated, and history older
    than ~90 days may be archived, so first sync should paginate fully and
    later syncs only need "since last sync".
  - Crypto deposit/withdrawal history.
  - Fiat (THB) deposit/withdrawal history (v4 endpoints) — this is the main
    signal for "money invested" if you fund the account with THB and buy
    crypto on-exchange.
- Create a **read-only** Bitkub API key (no trade/withdraw permission) for
  this app — defense in depth in case a secret leaks.

### 5.2 Binance specifics (future phase)
- Same adapter interface. Binance uses HMAC-SHA256 signed query strings with
  an API key header.
- Relevant endpoints: account balances (spot), trade history (`myTrades`
  per symbol, or account statement API), deposit history, withdraw history.
- Use a read-only API key with IP allow-listing if possible (note: Workers
  don't have a single fixed outbound IP by default — check Cloudflare's
  current options, e.g. Workers static outbound IPs / IP allow-listing docs,
  before relying on IP restriction).

---

## 6. Data Model (D1 / SQLite)

```sql
-- One row per exchange account connected (lets you add more later)
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,           -- uuid
  exchange TEXT NOT NULL,        -- 'bitkub' | 'binance'
  label TEXT NOT NULL,           -- e.g. "Bitkub - Main"
  owner_email TEXT NOT NULL,     -- which of you two it belongs to
  created_at INTEGER NOT NULL
);

-- Credential pairs are resolved from a Sync Worker secret map by this local ID.

-- Point-in-time balance snapshots (cheap to store, powers history charts)
CREATE TABLE balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset TEXT NOT NULL,           -- 'BTC', 'ETH', 'THB', ...
  available REAL NOT NULL,
  reserved REAL NOT NULL,
  snapshot_at INTEGER NOT NULL
);

-- Normalized trades (buy/sell of crypto against fiat or another crypto)
CREATE TABLE trades (
  id TEXT PRIMARY KEY,           -- exchange's own trade/order id (dedupe key)
  account_id TEXT NOT NULL REFERENCES accounts(id),
  side TEXT NOT NULL,            -- 'buy' | 'sell'
  base_asset TEXT NOT NULL,      -- e.g. BTC
  quote_asset TEXT NOT NULL,     -- e.g. THB
  price REAL NOT NULL,
  amount REAL NOT NULL,          -- base asset amount
  fee REAL NOT NULL DEFAULT 0,
  fee_asset TEXT,
  executed_at INTEGER NOT NULL,
  raw_json TEXT                  -- original payload, for debugging
);

-- Deposits/withdrawals of crypto (on-chain transfers in/out of the exchange)
CREATE TABLE crypto_transfers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL,       -- 'deposit' | 'withdraw'
  asset TEXT NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  tx_hash TEXT,
  executed_at INTEGER NOT NULL,
  raw_json TEXT
);

-- Fiat (THB) deposits/withdrawals — the primary "capital invested" signal
CREATE TABLE fiat_transfers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL,       -- 'deposit' | 'withdraw'
  currency TEXT NOT NULL,        -- 'THB'
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  executed_at INTEGER NOT NULL,
  raw_json TEXT
);

-- Cached latest prices (refreshed by the cron worker, read by API)
CREATE TABLE price_cache (
  asset TEXT NOT NULL,
  quote TEXT NOT NULL,           -- usually 'THB'
  price REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset, quote)
);

-- Sync bookkeeping (per account, per data type — for incremental pulls)
CREATE TABLE sync_state (
  account_id TEXT NOT NULL,
  data_type TEXT NOT NULL,       -- 'trades' | 'crypto_transfers' | ...
  last_synced_at INTEGER NOT NULL,
  cursor TEXT,                   -- exchange pagination cursor, if any
  PRIMARY KEY (account_id, data_type)
);
```

---

## 7. P&L / Cost Basis Methodology

Keep it simple and correct rather than clever:

1. **Capital invested** = sum of fiat deposits − sum of fiat withdrawals
   (per account and combined). This answers "how much money have I actually
   put in, net."
2. **Cost basis per asset** — use **average cost method** (simpler than FIFO,
   good enough for a personal dashboard; note this choice explicitly in the
   UI since it affects displayed numbers):
   - On each buy: `new_avg_cost = (old_qty * old_avg_cost + buy_qty * buy_price) / (old_qty + buy_qty)`.
   - On each sell: reduce quantity, **realized P&L** += `sell_qty * (sell_price − avg_cost_at_time_of_sale)`.
   - Crypto deposits from outside the exchange (e.g. moved in from a
     hardware wallet) need a manual cost-basis entry, since the exchange has
     no idea what you paid — expose a simple "edit cost basis" UI field for
     these, defaulting to "unknown / exclude from P&L" if not provided.
3. **Unrealized P&L** = `current_holdings_qty * (current_price − avg_cost)`,
   summed across assets, using `price_cache`.
4. **Total P&L** = realized + unrealized.
5. **Portfolio value** = `sum(holdings_qty * current_price)` + THB cash
   balance.

Compute this in the Worker (not in the browser) on request, from the raw
`trades`/`transfers` tables — don't try to store running P&L in the DB, it's
cheap enough to recompute per account (a few hundred/thousand rows) and
avoids drift bugs.

---

## 8. API Design (Worker routes)

All routes below sit behind Cloudflare Access.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/accounts` | List connected exchange accounts |
| GET | `/api/portfolio` | Aggregated balances, value, invested, P&L across accounts |
| GET | `/api/portfolio/:accountId` | Same, scoped to one account |
| GET | `/api/transactions?account=&type=&from=&to=&cursor=` | Paginated, filterable transaction feed (trades + transfers, unioned) |
| GET | `/api/history/value?range=30d` | Time series of portfolio value for a chart (from `balance_snapshots` + historical prices) |

Cron Worker (not user-facing, triggered by Cron Trigger):

| Trigger | Action |
|---|---|
| every 15 min (tune based on free-tier limits) | For each account: fetch balances → upsert `balance_snapshots`; fetch new trades/transfers since `sync_state.last_synced_at` → insert; refresh `price_cache` |

---

## 9. Frontend

- Stack suggestion: **React + Vite + TypeScript + Tailwind**, deployed as a
  static SPA to Cloudflare Pages (Pages Functions not required if the API is
  a separate Worker — simpler to reason about, but co-locating as Pages
  Functions is also fine if preferred).
- Pages:
  - **Dashboard** — total value, total invested, total P&L (realized +
    unrealized), asset allocation chart, per-account breakdown.
  - **Transactions** — filterable/searchable table (by exchange, asset,
    type, date range), paginated.
  - **Asset detail** — a single coin's holdings, avg cost, P&L, trade
    history for that asset.
  - **Portfolio card export** — generate a static, user-approved image on
    the device for saving, copying, or sharing; it creates no public route.
- Currency/locale: default to THB, format numbers Thai-friendly, but keep
  currency as a config value since Binance balances may be more naturally
  viewed in USDT — decide a base display currency (suggest THB throughout,
  convert USDT/BUSD holdings via a THB rate) to keep totals comparable.

---

## 10. Security Notes

- API keys/secrets: stored only via `wrangler secret put`, read via
  `env.BITKUB_API_KEY` etc. in the Worker; never returned in any API
  response; never logged.
- Use **read-only** exchange API keys (no trade/withdraw scope) wherever the
  exchange supports scoping keys.
- Cloudflare Access protects every dashboard and API route.
- Rate-limit the sync cron to avoid hitting exchange API limits (Bitkub and
  Binance both enforce per-key/per-IP limits —
  check current limits in their docs before setting the cron interval).
- CORS: API should only accept requests from your Pages domain.
- Never expose raw exchange payloads (`raw_json`) in browser responses.

---

## 11. Rollout Phases

1. **Phase 1 — Bitkub MVP**: Bitkub adapter, D1 schema, cron sync, dashboard
   + transactions UI, Cloudflare Access login for the two of you.
2. **Phase 2 — P&L engine**: invested/realized/unrealized P&L, asset
   allocation chart, portfolio value history chart.
3. **Phase 3 — Portfolio card export**: client-side image generation with
   explicit privacy choices; no public URLs, storage, or anonymous routes.
4. **Phase 4 — Binance adapter**: implement `ExchangeAdapter` for Binance,
   add account, verify normalized data merges correctly into existing
   dashboard/P&L views.
5. **Phase 5 (optional)**: CSV/PDF export, tax-lot (FIFO) toggle, multi-
   currency display, price alerts, and PWA push notifications for newly
   synchronized trades and transfers.

---

## 12. Open Decisions for You

- Average cost vs FIFO for realized P&L — doc assumes average cost for
  simplicity; switch to FIFO in Phase 5 if you want it to match Thai tax
  reporting conventions more closely.
- Sync frequency (affects free-tier request budget on both Cloudflare and
  exchange side) — start conservative (e.g. every 30–60 min) and tighten
  later if needed.
- Whether exported portfolio cards should hide amounts by default and require
  an explicit opt-in before including value or future P&L fields.

## 13. Current implementation boundaries

- The current dashboard has balances, current valuation, a current-value asset
  allocation chart, optional allocation targets, recorded value/price history,
  account-scoped inspection, activity when the exchange endpoint is available,
  sync health, bounded normalized JSON/CSV export, watchlist/price alerts, and
  opt-in PWA push subscriptions. Each browser may choose which optional
  Overview sections are visible; this local presentation preference never
  changes stored portfolio data or sync behavior. The allocation chart is a
  composition of current estimated value, not invested capital or P&L.
- Portfolio-value history is a valuation series from balance snapshots and
  matching price snapshots. Incomplete valuation points are excluded; the chart
  is not invested capital or P&L.
- Cost basis and P&L remain intentionally unimplemented until trade and fiat
  history are complete and independently verified.
- Bitkub API usage is read-only. No API/UI path for trade or withdrawal action
  is permitted.
- A manual sync request is an explicit read-only action routed through an
  internal API-to-Sync Worker binding. A global cooldown and database lock
  prevent it from creating overlapping exchange calls or bypassing the cron
  budget. Price alerts are evaluated only during a recorded price sync.
- The Rebalance check is a local comparison of existing allocation targets with
  current estimated holdings values. It may state the estimated THB and
  percentage difference above or below a target, but it never proposes or
  executes a buy, sale, transfer, schedule, or automatic rebalance.
- Multiple Bitkub accounts use one distinct read-only credential pair per local
  account ID. The Worker refuses to use a legacy single-account key once more
  than one Bitkub account exists, preventing one account's balances from being
  written into another account's data set.
- Disconnecting an account archives its local account row. Archived accounts
  are excluded from sync and all normal dashboard/API views while their
  normalized history remains retained. Settings can reconnect that same local
  account by clearing the archive state; this only resumes use of the existing
  Worker-side credential and never exposes, creates, edits, or deletes a key.
  If the key was revoked at Bitkub, configure a replacement through the local
  setup wizard before reconnecting. The dashboard cannot manage exchange
  credentials.
