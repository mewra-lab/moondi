# Architecture

Moondi is intentionally a self-hosted, read-only system. Each installation is
owned by one Cloudflare account; the project does not run a shared service that
collects other people's exchange credentials.

```text
                              ┌─────────────────────┐
                              │  Cloudflare Access   │
                              │ Google + allow-list  │
                              └──────────┬──────────┘
                                         │
                  ┌──────────────────────▼──────────────────────┐
                  │       Cloudflare Pages: React/Vite PWA       │
                  │  locale, theme, value concealment, charts    │
                  └──────────────────────┬──────────────────────┘
                                         │ normalized HTTPS API
                  ┌──────────────────────▼──────────────────────┐
                  │            API Worker: Hono routes          │
                  │ portfolio, history, activity, push subscribe │
                  └───────────────┬───────────────┬──────────────┘
                                  │               │
                            ┌─────▼─────┐   ┌─────▼─────┐
                            │ D1 SQLite │   │     KV    │
                            │ durable   │   │ cache /   │
                            │ portfolio │   │ transient │
                            │ records   │   │ state     │
                            └─────▲─────┘   └───────────┘
                                  │
                  ┌───────────────┴──────────────────────────────┐
                  │ Sync Worker: public prices / supported sync   │
                  └───────────────────────────────────────────────┘

          EventBridge Scheduler → AWS Lambda → Bitkub secure API
                                      │ Cloudflare Access service token
                                      │ + HMAC, timestamp, nonce
                                      ▼
                            API Worker → D1 SQLite
```

## Trust boundaries

| Boundary | Allowed through it | Never allowed through it |
| --- | --- | --- |
| Browser → API | Normalized balances, prices, history, and activity | Bitkub API key/secret, raw exchange payloads |
| Sync Worker → Bitkub | Signed read-only requests | Browser-originated trading instructions |
| AWS Lambda → API ingestion | Bounded normalized records with a fresh HMAC, nonce, timestamp, and Cloudflare Access service token | Bitkub API key/secret, raw exchange response, browser traffic, arbitrary SQL |
| Wrangler config → Cloudflare | Public binding names and resource IDs for that installation | Secret values |
| D1 → UI | Fields needed by the selected private view | API secrets, VAPID private key, raw debugging JSON |

## Packages and applications

| Path | Responsibility |
| --- | --- |
| `apps/web` | Static React PWA, responsive UI, localized presentation, service worker registration |
| `apps/api` | Hono API, D1 query layer, CORS, history endpoints, push subscription lifecycle |
| `apps/sync-worker` | Scheduled exchange pulls, persistence, sync health, push delivery |
| `packages/exchanges` | Exchange-specific signing and response mapping behind the adapter seam |
| `packages/shared` | Normalized exchange/domain types shared by the Workers |
| `db/migrations` | Append-only D1 schema changes for installations already in use |

## Data flow

1. Where Bitkub accepts the Cloudflare egress path, a scheduled Worker may
   read an account with its own read-only credential pair. Bitkub secure calls
   rejected from that egress are instead made by a dedicated AWS Lambda.
2. The Lambda keeps Bitkub credentials in AWS Parameter Store SecureString,
   reads per-data-type D1 checkpoints through a protected API endpoint, fetches
   only documented read-only data, normalizes it, and posts bounded balance,
   trade, crypto-transfer, and fiat-transfer payloads back to that endpoint.
   The endpoint requires a separate shared HMAC secret, a fresh timestamp, and
   a single-use nonce recorded in D1 before it writes data or advances a
   checkpoint. History may arrive in multiple idempotent chunks; only a final
   complete chunk advances the monotonic checkpoint.
3. The API Worker stores balance snapshots, price snapshots, normalized
   activity, sync-health events, and a complete per-account value for each
   30-minute interval in D1. It never accepts raw Bitkub payloads or direct D1
   credentials from AWS.
4. The API Worker reads the latest indexed snapshot for current holdings and the
   compact value-summary table for the portfolio chart. Asset-price history uses
   indexed time ranges and KV caching. Page visits never call an exchange or
   recompute portfolio values across raw history.
5. The PWA requests API data only after Cloudflare Access has authenticated the
   viewer. It stores only user-interface preferences locally.
6. When enabled, the sync Worker sends a Web Push message to subscriptions
   stored in D1. Invalid or inactive subscriptions are removed/pruned.

## Important invariants

- Bitkub-specific payloads do not cross the exchange adapter boundary.
- Every number shown as historical portfolio value must have prices for all
  non-THB assets at that snapshot; otherwise the point is omitted.
- Balance and public-price jobs may finish in either order; both attempt to
  materialize the latest complete balance snapshot once matching prices exist.
- The app remains read-only even if a user accidentally creates a broader
  exchange key. The required operational control is still a read-only key.
- A Bitkub account never falls back to another account's credentials. If a
  multi-account secret map has no entry for an account ID, the Worker records a
  sync-health failure and skips that account.
- Cloudflare Access is the primary authentication control. CORS is not an
  authentication mechanism.
- An AWS ingestion request must pass both Cloudflare Access service-token
  authentication and application-level HMAC verification. Its nonce is
  single-use and its timestamp is bounded; either control alone is insufficient.
- A future P&L engine must consume normalized records and remain separate from
  HTTP and database effects so it can be tested deterministically.
