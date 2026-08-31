# Operations

## Normal operation

The sync Worker runs on its configured cron schedule (30 minutes in the public
example). A healthy run records balances, price snapshots, relevant activity,
and sync events. The API reads stored data; opening the dashboard should not
cause a burst of private Bitkub requests.

**Sync now** is the one intentional on-demand refresh. It travels API Worker →
private service binding → Sync Worker, has a 15-minute global cooldown, and
shares a D1 lock with cron runs so there is never more than one portfolio sync
at once. It remains read-only and may still be deferred by Bitkub.

## Monitoring

Use three signals together:

1. **Dashboard Sync health** — user-facing state by data type.
2. **Worker logs** — inspect scheduled runs and provider errors. Redact logs
   before sharing them.
3. **D1 data freshness** — compare the latest snapshot timestamp with the
   expected cron cadence.

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
6. Deploy API, sync Worker, then Pages (the provided web deploy script targets
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
5. If balances are fresh but price history has a gap, the chart may omit
   incomplete points by design. See [Feature status](feature-status.md).
