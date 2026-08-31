CREATE TABLE IF NOT EXISTS price_snapshots (
  asset TEXT NOT NULL,
  quote TEXT NOT NULL,
  price REAL NOT NULL,
  snapshot_at INTEGER NOT NULL,
  PRIMARY KEY (asset, quote, snapshot_at)
);

CREATE INDEX IF NOT EXISTS price_snapshots_quote_time_idx
  ON price_snapshots(quote, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  data_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'deferred', 'failure')),
  detail TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_events_account_type_time_idx
  ON sync_events(account_id, data_type, occurred_at DESC);
