CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL CHECK (exchange IN ('bitkub', 'binance')),
  label TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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

CREATE INDEX IF NOT EXISTS trades_account_executed_idx
  ON trades(account_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS crypto_transfers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  asset TEXT NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  tx_hash TEXT,
  executed_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS crypto_transfers_account_executed_idx
  ON crypto_transfers(account_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS fiat_transfers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  executed_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS fiat_transfers_account_executed_idx
  ON fiat_transfers(account_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS price_cache (
  asset TEXT NOT NULL,
  quote TEXT NOT NULL,
  price REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset, quote)
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  data_type TEXT NOT NULL,
  last_synced_at INTEGER NOT NULL,
  cursor TEXT,
  PRIMARY KEY (account_id, data_type)
);
