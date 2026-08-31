# Feature status

This document distinguishes what Moondi currently records from what it can
reliably calculate. It is intentionally conservative: a missing or partially
authorized exchange endpoint must not be presented as a financial result.

## Available now

### Balances and current portfolio value

The sync Worker stores balance snapshots. The dashboard's **Portfolio value**
is an estimate in THB:

```text
sum((available + reserved) × latest THB price) + THB cash
```

It is not principal, invested capital, profit, or a guaranteed liquidation
value. It moves with market prices even if the quantity of every asset stays
unchanged.

The **Portfolio allocation** donut is also calculated from those current
estimated values, including THB cash. It is a composition view only; it does
not represent invested capital, cost basis, or profit.

You may set **allocation targets** totaling at most 100%. They are personal
comparison targets against the current composition, not recommendations or an
automatic rebalancing instruction. Moondi cannot trade or rebalance anything.

The **Compare with targets** section calculates each configured asset's current
share and estimated THB difference from its target. The above/below label is a
description of the current composition; it is not a buy/sell amount, financial
advice, or an action Moondi can perform.

The Settings dialog can show or hide optional Overview sections on the current
browser. This is a presentation preference only: it does not delete data,
change sync behavior, or affect another device.

### Multiple Bitkub accounts

Moondi can combine more than one Bitkub account or scope the dashboard to one
account. Each configured account has its own read-only API key/secret pair in a
Sync Worker secret map keyed by its local account ID. The browser, API, D1, and
backup exports never receive that map or the secrets themselves.

The prior `BITKUB_API_KEY` / `BITKUB_API_SECRET` pair remains compatible only
when exactly one Bitkub account exists. After adding a second account, configure
`BITKUB_ACCOUNTS_JSON` before the next sync. Moondi records a sync-health
failure rather than risking one account's data being stored under another.

The committed `npm run setup:bitkub-account` helper is the supported way to add
a later Bitkub account. It validates and stores the full credential map through
an interactive Wrangler prompt before creating the non-secret D1 row; account
credentials are never accepted by the dashboard. The map retains credentials
for disconnected accounts so they can be reconnected later.

An account can be **disconnected** from Settings. This archives the local row:
Moondi stops syncing it and excludes it from account scopes and aggregate views,
but retains its normalized history. The same row can be **reconnected** from
Settings later, which resumes sync using its existing Worker-side credential.
Neither action deletes or reveals the Bitkub credential. If you revoked the
key in Bitkub, replace that account's entry in the complete Worker-side
`BITKUB_ACCOUNTS_JSON` secret before reconnecting.

### Portfolio-value history

The history chart values each recorded balance snapshot with a price snapshot
from the same sync. If a non-THB asset has no matching price, Moondi excludes
that chart point. Showing only the THB portion would falsely look like a loss.

Consequences:

- a fresh installation has no history until syncs have collected both balances
  and prices;
- a temporary price-sync failure can create a gap rather than an invented
  value; and
- the chart is a valuation series, not a P&L chart.

### Per-asset 24-hour trends

Holding rows display a small chart from stored price snapshots. It measures
market-price movement, not a change in the amount held. The label says
`Collecting prices` until at least two snapshots exist.

### Activity and notifications

When Bitkub authorizes the required history endpoints, Moondi stores normalized
trades and transfers and can show them in the Activity view. Push notifications
are generated from newly synchronized records, price-target crossings, and
sync-state changes; duplicate events are suppressed by the stored sync state.
Notification preferences are stored per subscribed browser for trades, crypto
transfers, THB transfers, price alerts, and sync issues. Price alerts are
checked only when the normal read-only sync records a fresh THB price; they do
not create live market-data connections. The device-display test checks local
permission only. A separate,
rate-limited Worker-delivery test sends a fixed message to the current
subscription, verifying Worker → push service → device without waiting for a
Bitkub event.

Trade polling covers assets held now or observed in an earlier positive balance
snapshot, so selling an observed position to zero does not stop its later
history updates. Bitkub requires an individual symbol for each order-history
request and retains only a bounded history window; a position bought and fully
sold between snapshots or activity older than the provider window may still be
unavailable. This is one reason cost basis and P&L remain disabled.

### Manual sync, account scopes, and backup

**Sync now** sends a request from the API Worker to the Sync Worker through a
private service binding. It is not a browser-to-Bitkub request. A 15-minute
global cooldown and a D1 execution lock prevent repeated or overlapping syncs,
including overlap with the cron schedule.

The account selector scopes holdings, activity, value history, and sync health
to one connected account when more than one exists. Watchlist assets, price
alerts, and allocation targets are app preferences; they do not alter exchange
data.

**Download backup** creates a local JSON file of normalized records for the
previous 365 days, capped at 5,000 records per collection. It deliberately
excludes API keys, push endpoints, and raw exchange payloads. Use a D1 backup
for a complete operational recovery backup.

## Deliberately unavailable

### Cost basis and P&L

Moondi does not yet calculate principal, average cost, realized P&L, unrealized
P&L, or tax figures. These require complete trade history plus reliable THB
deposit/withdrawal history. External crypto deposits also need an explicit
cost-basis method. Until all of that is available, showing a number would be
misleading.

### Trading and withdrawals

No trade, order-placement, withdrawal, or credential-management endpoint is
implemented. Keep the Bitkub key read-only. This is an architectural safety
boundary, not merely a UI restriction.

### Portfolio-card sharing

Portfolio cards are static PNG images generated after an explicit action on
the authenticated device. They do not create a public share link, anonymous
route, or server-side copy of the card. The default template is
allocation-only and hides absolute values, quantities, account labels, and
transactions. You can explicitly choose a template that includes the current
estimated value. Copying, sharing, and downloading use browser APIs; where an
API is unavailable, Moondi falls back to downloading the PNG.

The card never represents profit/loss. A P&L template remains unavailable
until complete, verified trade history and cost-basis data exist.

## Sync-health meanings

| State | Meaning | What to do |
| --- | --- | --- |
| Latest sync succeeded | The data type completed during the latest scheduled run. | No action needed. |
| Awaiting authorization | The external endpoint rejected the Worker or needs an account-side change. | See [Bitkub setup](bitkub.md). |
| Deferred | Moondi intentionally retained prior data after an external failure. | Read the displayed detail and retry after fixing the provider setting. |
| Failure | The last sync attempt failed unexpectedly. | Inspect Worker logs; do not assume the dashboard is current. |
| Awaiting sync | No result has been recorded yet. | Confirm the cron trigger and account row. |

Moondi marks a successful source as potentially stale when its latest event is
older than two hours (four expected 30-minute sync windows). The dashboard can
expand a source to show the stored sync note and open **Sync activity**, which
lists at most the 100 most recent normalized sync events. That view reads only
records already stored in D1; it does not trigger Bitkub requests. Neither view
exposes raw exchange payloads, API keys, or secrets.

## Roadmap guardrails

P&L work begins only after history endpoints have been independently verified
with sanitized fixtures and a real read-only smoke test. A future feature must
not weaken the rule that exchange credentials stay server-side and are never
returned to the browser.
