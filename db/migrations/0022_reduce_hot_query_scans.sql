-- Index-only change: no table, column, or row is modified. These indexes let the
-- sync-event list stop after its LIMIT instead of sorting every event, and let the
-- per-interval asset snapshot replacement find its rows without reading every
-- snapshot of the account.
CREATE INDEX IF NOT EXISTS sync_events_recent_idx
  ON sync_events(occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS sync_events_account_recent_idx
  ON sync_events(account_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS portfolio_asset_value_snapshots_account_interval_idx
  ON portfolio_asset_value_snapshots(account_id, interval);
