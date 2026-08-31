-- User-controlled, read-only portfolio features. No exchange credential or raw
-- provider payload is stored here.

CREATE TABLE IF NOT EXISTS sync_locks (
  name TEXT PRIMARY KEY,
  acquired_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_watchlist (
  asset TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('above', 'below')),
  target_price REAL NOT NULL CHECK(target_price > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  is_triggered INTEGER NOT NULL DEFAULT 0 CHECK(is_triggered IN (0, 1)),
  last_triggered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS price_alerts_asset_active_idx
  ON price_alerts(asset, active, is_triggered);

CREATE TABLE IF NOT EXISTS allocation_targets (
  asset TEXT PRIMARY KEY,
  target_percent REAL NOT NULL CHECK(target_percent > 0 AND target_percent <= 100),
  updated_at INTEGER NOT NULL
);

ALTER TABLE push_subscriptions
  ADD COLUMN notify_price_alerts INTEGER NOT NULL DEFAULT 0;
