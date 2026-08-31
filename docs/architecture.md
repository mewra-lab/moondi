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
                  │        Sync Worker: scheduled Cron run        │
                  │ signs requests, normalizes data, writes D1    │
                  └──────────────────────┬────────────────────────┘
                                         │ read-only signed API calls
                                  ┌──────▼──────┐
                                  │   Bitkub    │
                                  └─────────────┘
```

## Trust boundaries

| Boundary | Allowed through it | Never allowed through it |
| --- | --- | --- |
| Browser → API | Normalized balances, prices, history, and activity | Bitkub API key/secret, raw exchange payloads |
| Sync Worker → Bitkub | Signed read-only requests | Browser-originated trading instructions |
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

1. A scheduled sync reads each account's balances with its own Bitkub
   read-only credential pair, resolved from a Worker secret map by local
   account ID. It refreshes shared public/latest prices once per Bitkub sync.
2. The Worker stores balance snapshots, price snapshots, normalized activity,
   and a sync-health event in D1.
3. The API Worker reads the latest snapshots for the dashboard and recorded
   snapshots for charts. It does not make an exchange request for every page
   visit.
4. The PWA requests API data only after Cloudflare Access has authenticated the
   viewer. It stores only user-interface preferences locally.
5. When enabled, the sync Worker sends a Web Push message to subscriptions
   stored in D1. Invalid or inactive subscriptions are removed/pruned.

## Important invariants

- Bitkub-specific payloads do not cross the exchange adapter boundary.
- Every number shown as historical portfolio value must have prices for all
  non-THB assets at that snapshot; otherwise the point is omitted.
- The app remains read-only even if a user accidentally creates a broader
  exchange key. The required operational control is still a read-only key.
- A Bitkub account never falls back to another account's credentials. If a
  multi-account secret map has no entry for an account ID, the Worker records a
  sync-health failure and skips that account.
- Cloudflare Access is the primary authentication control. CORS is not an
  authentication mechanism.
- A future P&L engine must consume normalized records and remain separate from
  HTTP and database effects so it can be tested deterministically.
