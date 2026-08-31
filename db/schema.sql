CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL CHECK (exchange IN ('bitkub', 'binance')),
  label TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS accounts_active_exchange_label_idx
  ON accounts(exchange, archived_at, label);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset TEXT NOT NULL,
  available REAL NOT NULL,
  reserved REAL NOT NULL,
  snapshot_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS balance_snapshots_account_time_idx
  ON balance_snapshots(account_id, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  external_id TEXT,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  price REAL NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  fee_asset TEXT,
  executed_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS trades_account_external_id_idx
  ON trades(account_id, external_id);

CREATE INDEX IF NOT EXISTS trades_account_executed_idx
  ON trades(account_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS crypto_transfers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  external_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  asset TEXT NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  tx_hash TEXT,
  executed_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS crypto_transfers_account_external_id_idx
  ON crypto_transfers(account_id, external_id);

CREATE INDEX IF NOT EXISTS crypto_transfers_account_executed_idx
  ON crypto_transfers(account_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS fiat_transfers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  external_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  executed_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS fiat_transfers_account_external_id_idx
  ON fiat_transfers(account_id, external_id);

CREATE INDEX IF NOT EXISTS fiat_transfers_account_executed_idx
  ON fiat_transfers(account_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS price_cache (
  asset TEXT NOT NULL,
  quote TEXT NOT NULL,
  price REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset, quote)
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  asset TEXT NOT NULL,
  quote TEXT NOT NULL,
  price REAL NOT NULL,
  snapshot_at INTEGER NOT NULL,
  PRIMARY KEY (asset, quote, snapshot_at)
);

CREATE INDEX IF NOT EXISTS price_snapshots_quote_time_idx
  ON price_snapshots(quote, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  data_type TEXT NOT NULL,
  last_synced_at INTEGER NOT NULL,
  cursor TEXT,
  PRIMARY KEY (account_id, data_type)
);

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

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notify_trades INTEGER NOT NULL DEFAULT 1,
  notify_crypto_transfers INTEGER NOT NULL DEFAULT 1,
  notify_fiat_transfers INTEGER NOT NULL DEFAULT 1,
  notify_sync_issues INTEGER NOT NULL DEFAULT 1,
  notify_price_alerts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_updated_at_idx
  ON push_subscriptions(updated_at);

CREATE TABLE IF NOT EXISTS sync_push_state (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  data_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('deferred', 'failure')),
  detail TEXT,
  PRIMARY KEY (account_id, data_type)
);

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
