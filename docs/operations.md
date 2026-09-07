# Operations

## Normal operation

The sync Worker runs on its configured cron schedule (30 minutes in the public
example). In the default mode, a healthy run records balances, price snapshots,
relevant activity, and sync events. The API reads stored data; opening the
dashboard should not cause a burst of private Bitkub requests.

When `BITKUB_SECURE_SYNC_MODE=aws-ingest`, EventBridge invokes the private AWS
Lambda for every signed Bitkub request: balances, order history, crypto
transfers, and fiat transfers. The Sync Worker continues to refresh only public
prices. The Lambda first reads per-data-type checkpoints from D1 through the
protected API, then sends bounded normalized records back through that same
ingestion boundary. Check both the EventBridge/Lambda result and the dashboard
freshness for balances and activity.

History is transferred in bounded chunks. Intermediate chunks are idempotent
and do not advance the checkpoint; the final `complete` chunk records success
and advances it monotonically. A failed run can therefore replay its current
window without skipping records.

In AWS secure-sync mode the dashboard has no manual-sync control: private
Bitkub work is owned exclusively by EventBridge. Wait for the EventBridge
schedule, or manually invoke the private Lambda only during controlled
diagnosis.

## Monitoring

Use three signals together:

1. **Dashboard Sync health** — user-facing state by data type.
2. **Worker and Lambda logs** — inspect scheduled runs and provider errors.
   Redact logs before sharing them; never include request headers, raw bodies,
   API keys, HMAC values, Cloudflare service-token credentials, or SSM values.
3. **D1 data freshness** — compare the latest snapshot timestamp with the
   expected cron cadence.

For D1 quota monitoring, inspect both rows read and rows written. The Free plan
meters database rows, not HTTP requests, and index maintenance also counts as
writes. A healthy 30-minute sync stores a sparse balance snapshot (positive
assets plus THB), persists public prices only for held, watched, or alerted
assets, and materializes both portfolio and per-asset values. It must not write
every Bitkub ticker or every zero balance each run. The normal history path
reads `portfolio_value_snapshots` and `portfolio_asset_value_snapshots`; a live
page query joining raw `balance_snapshots` to `price_snapshots` indicates an
outdated API deployment. Use Query Insights and `EXPLAIN QUERY PLAN` after query
changes. The exact limits and reset time are documented by Cloudflare:
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and
[index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

An endpoint may be deferred while balances/prices remain healthy. Do not treat
this as a total outage or invent missing activity from it.

## Push subscriptions

Push is opt-in and browser-specific. A browser may remove a subscription when
permissions change, site data is cleared, or its push provider invalidates an
endpoint. Moondi refreshes subscriptions when the app opens, removes invalid
deliveries, and prunes inactive subscriptions after 180 days.

If notification permission is blocked at browser level, the user must change it
in browser/site settings before Moondi can subscribe again.

The settings dialog has two different checks: **Test device display** checks
only that the browser can show a notification, while **Test Worker delivery**
sends a harmless fixed message through the Sync Worker to the current device.
Worker delivery is limited to once per device per minute and does not include
portfolio data. A push accepted by the push service can still be hidden by the
browser or operating-system notification settings.

## Backup and recovery

Before schema changes or major upgrades:

1. Export a D1 backup using your Cloudflare account's approved tooling.
2. Store it encrypted and outside the public repository.
3. Record the application commit/version and migration state.
4. Test a restore only in a separate non-production database.

Balance and price snapshots can be recreated only going forward. Activity
history depends on provider retention and access; do not assume a re-sync can
always reconstruct it.

The dashboard's **Download backup** is a convenient, normalized 365-day JSON
export for the viewer. It is bounded to 5,000 rows per collection and is not a
replacement for a D1 backup. It omits credentials, push endpoints, and raw
exchange payloads.

## Bitkub historical archive and P&L

Keep a downloaded Bitkub history archive outside version control. The ignored
`history/` directory is supported only as a local input. It can contain bank
names/numbers, addresses, and transaction metadata, so never commit it or send
it to the API.

Bitkub's documented trade, crypto-transfer, and fiat-transfer APIs retain only
the current window (about 90 days); pagination cannot retrieve the archived
part. The website may expose downloadable history and currently uses the
browser-authenticated request `/api/history/history-datatable`, but that route
is not in Bitkub's public API contract. Do not call it from Lambda/Workers,
automate a session cookie, or store its raw response in D1. Download through
Bitkub's own UI and keep the files local.

After applying migrations through `0018`, deploy the matching API and Lambda,
then let all three history streams finish once. Migration `0017` preserves the
archive cutoff as `covered_from` when a verified archive already exists and its
cutoff is not newer than the completed checkpoint. It clears only unverified
history checkpoints so a new run can record a provable boundary. Migration
`0018` repairs installations that applied the earlier `0017` behavior by
realigning all three completed streams to that verified cutoff. If a run
completes only some streams, the next run reuses the earliest established
boundary and backfills the others from there. Query that boundary from D1: all
three rows must be present and have the same value.

```sql
SELECT data_type, covered_from, last_synced_at
FROM sync_state
WHERE account_id = '<account-id>'
  AND data_type IN ('trades', 'crypto_transfers', 'fiat_transfers')
ORDER BY data_type;
```

Convert that exact millisecond value to a UTC ISO timestamp and use it as
`--before`. The archive importer keeps only records strictly before the
boundary; live sync owns records at or after it. P&L remains unavailable if the
archive marker and all three coverage boundaries do not match exactly.

Some website exports omit `symbol` on old trades. Moondi no longer assumes such
records are THB pairs, because Bitkub also has non-THB markets. Manually verify
each omitted pair, place only the confirmed source `_id` values in a local JSON
array outside version control, and pass that file with
`--confirmed-missing-symbol-ids`. Example with placeholders:

```bash
node scripts/import-bitkub-history.mjs \
  --account "replace-with-local-account-id" \
  --before "replace-with-exact-covered-from-UTC-ISO" \
  --timezone +07:00 \
  --input-dir history \
  --last-page "replace-with-confirmed-final-page" \
  --expected-records "replace-with-confirmed-total-records" \
  --confirmed-missing-symbol-ids /tmp/confirmed-thb-trade-ids.json \
  --output /tmp/moondi-bitkub-history.sql
npx wrangler d1 execute moondi --remote --config apps/api/wrangler.jsonc --file /tmp/moondi-bitkub-history.sql
```

Back up D1 first and verify the supplied ID is an active Bitkub account. The SQL
contains only normalized activity fields and is idempotent, but it is still
financial data and belongs in `/tmp`, not the repository. Reload the dashboard
afterward. P&L stays withheld for any external crypto deposit until its total
THB cost basis is entered, whenever the reconstructed quantity does not match
the latest Bitkub balance, or when a holding has no normalized history.

## Updating Moondi

1. Read the release notes and migration list.
2. Back up D1.
3. Pull the release into your own repository.
4. Run `npm run check`, `npm test`, and `npm run build`.
5. Apply migrations once, before Workers depending on them. Migration `0017`
   creates sparse per-asset value materialization, removes redundant indexes,
   and preserves verified archive coverage while resetting only unverified
   Bitkub history checkpoints. Migration `0018` repairs coverage metadata for
   installations that already applied the earlier `0017`. P&L stays withheld
   until live coverage and the verified archive meet.
6. For an existing AWS secure-sync installation, pause EventBridge, deploy the
   API, update and manually test Lambda, then resume EventBridge. Deploy the
   sync Worker and Pages afterward (the history chunk protocol must be live
   before the matching Lambda code, the API configuration binds to the sync
   Worker, and the provided web deploy script targets
   the `production` Pages branch).
7. Verify `/health`, Access, current balance freshness, and one scheduled run.

## Rollback

If a deployment fails:

- roll back the affected Worker/Pages deployment from your Cloudflare dashboard
  or deploy the known-good Git commit;
- do not roll back D1 blindly after a migration—schema/data rollback needs a
  deliberate migration or a tested restore; and
- keep the prior Worker version available until production validation succeeds.

## Runbook: stale portfolio

1. Check the dashboard's latest sync time.
2. Check the sync Worker cron trigger and recent logs.
3. Check Bitkub key status/IP restrictions without exposing the secret.
4. Confirm D1 contains fresh balance and price snapshots.
5. If balances are fresh but the chart has a gap, check that a THB price no more
   than 35 minutes from the balance timestamp existed for every positive asset.
   The next public-price run retries materializing the latest balance, so job
   order alone cannot leave it stuck. Incomplete values are omitted by design.
   See [Feature status](feature-status.md).
