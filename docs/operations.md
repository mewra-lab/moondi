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

For D1 quota monitoring, inspect query insights sorted by rows read. The normal
portfolio-history path should read `portfolio_value_snapshots`; a query that
joins `balance_snapshots` to `price_snapshots` on every page view indicates an
outdated API deployment. Current holdings should use an indexed lookup of the
latest timestamp per active account. Run `EXPLAIN QUERY PLAN` after changing
either query and confirm that historical tables are searched through indexes.
The Free-plan `5M` meter counts rows read, not HTTP requests. Migration `0012`
adds account/time/id cursor indexes, while `0013` clears only history
checkpoints so the corrected all-symbol pagination can replay the provider's
available window without deleting normalized rows. Transaction filters are
pushed into each table before the union, portfolio values are materialized, and
bounded multi-asset price-history responses use hashed KV keys. These controls
reduce rows scanned, but Query Insights remains the source of truth after
deployment.

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

## Updating Moondi

1. Read the release notes and migration list.
2. Back up D1.
3. Pull the release into your own repository.
4. Run `npm run check`, `npm test`, and `npm run build`.
5. Apply migrations once, before Workers depending on them.
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
