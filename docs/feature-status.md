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

### Portfolio-value and invested-value history

The history chart values each recorded balance snapshot with prices no more
than 35 minutes from that balance. Balance and public-price jobs may arrive in
either order; each attempts to materialize the latest complete snapshot. If a
non-THB asset has no matching price, Moondi excludes that chart point. Showing
only the THB portion would falsely look like a loss.

For assets included in this browser’s P&L Settings and marked **Ready**, the
chart also draws **invested value**: their remaining average-cost basis at each
value snapshot. It includes only the selected position cost; it excludes THB
cash, ignored assets, closed cost basis, and any asset whose history or cost
cannot be verified. This is not a realized-P&L line or an all-portfolio result
when the viewer has excluded assets.

The selected current-value series comes from per-asset values materialized at
ingestion. D1 stores positive balance rows plus THB as the complete-snapshot
marker, and persists price history only for assets that are held, watched, or
used by an active alert. This avoids rewriting every zero-balance asset and
every Bitkub ticker on each scheduled run.

Consequences:

- a fresh installation has no history until syncs have collected both balances
  and prices;
- a temporary price-sync failure can create a gap rather than an invented
  value; and
- the chart is a valuation and selected-position-cost series, not a P&L chart.

### Per-asset 24-hour trends

Holding rows display a small chart from stored price snapshots. It measures
market-price movement, not a change in the amount held. The label says
`Collecting prices` until at least two snapshots exist.

### Activity and notifications

The AWS secure-sync path has verified the required Bitkub history endpoints and
stores normalized trades and transfers for the Activity view. It scans every
active exchange symbol, including non-THB pairs, follows all available pages,
and checkpoints only after the final ingestion chunk. Push notifications
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

Bitkub requires an individual symbol for each order-history request and retains
only a bounded history window. The secure sync therefore polls every active
exchange symbol rather than inferring symbols from current holdings. For an
account with a complete user-verified archive, the local archive normalizer can
import the older normalized records before the retained window without storing
the raw source payload or its bank/address fields.

### Account scopes and backup

The dashboard has no manual-sync control. Scheduled refresh ownership remains
unambiguous: EventBridge runs private Bitkub ingestion in AWS mode and the Sync
Worker cron records public prices. The internal default-mode trigger retains a
cooldown and execution lock for controlled operational use, but is not exposed
as a UI feature.

The account selector scopes holdings, activity, value history, and sync health
to one connected account when more than one exists. Watchlist assets, price
alerts, and allocation targets are app preferences; they do not alter exchange
data.

**Download backup** creates a local JSON file of normalized records for the
previous 365 days, capped at 5,000 records per collection. It deliberately
excludes API keys, push endpoints, and raw exchange payloads. Use a D1 backup
for a complete operational recovery backup.

## Conditional financial calculation

### Bitkub cost basis and P&L

Moondi calculates verified asset acquisition cost, average cost, realized P&L, and
unrealized P&L only after that Bitkub account has a verified local archive
whose cutoff exactly meets all three live-history coverage boundaries, and
every relevant asset can be reconciled to the latest balance
snapshot. It accepts THB-quoted trades only. A non-THB pair is not converted
using a current exchange rate, because that would invent a historical cost
basis. The short-lived P&L cache prevents repeated dashboard reads from
rescanning lifetime ledger rows; balance, history, and cost-basis updates
invalidate it.

The API field `investedAmount` is this verified acquisition cost: remaining
open cost plus cost allocated to units already sold. It is not THB deposits
minus withdrawals; fiat transfers remain account cash-flow history only.

An incoming crypto transfer from outside Bitkub remains excluded until you set
its **total THB cost basis**. Withdrawals carry cost out of Bitkub and do not
create realized P&L. If a required cost basis, quote conversion, or balance
reconciliation is missing, Moondi withholds aggregate P&L and explains the
affected asset. A positive balance without normalized history is also withheld.
These values are personal accounting estimates, not tax or investment advice.

The Bitkub P&L panel is shown on Overview by default and can be hidden in
Settings. It opens on assets still held, while closed positions stay available
on demand because their realized P&L remains useful. The panel can scope the
view to held assets, closed positions, items requiring review, all assets, or
a selected set of assets. A number shown for a selected view covers only that
view; it is not labelled as portfolio-wide P&L if another asset remains
unresolved. Ready rows show remaining cost basis, average buy price, current value, realized and
unrealized P&L, total P&L, and **return on cost**. Return on cost divides total
P&L by the cost represented by the selected position (including the cost of a
position already sold); it is not a 24-hour price move or leveraged return.
External deposit cost-basis fields are collapsed until opened because each
transfer needs its own historical THB cost.

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
estimated value. For any one asset whose cost and quantity are verified, you
can instead choose a P&L card and select whether it shows the THB P&L, return
on cost percentage, or both. The dialog always renders a local preview before
copying, sharing, or downloading. Copying, sharing, and downloading use browser
APIs; where an API is unavailable, Moondi falls back to downloading the PNG.

A P&L card is deliberately per asset and is not offered for assets with missing
cost basis, missing history, an unsupported quote, or a balance mismatch.

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

P&L depends on a user-verified complete archive, sanitized-fixture tests, and
a real read-only smoke test. A future feature must not weaken the rule that
exchange credentials stay server-side and are never returned to the browser.
