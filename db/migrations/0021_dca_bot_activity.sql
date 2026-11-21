-- Normalized DCA bot buys and signal state, delivered by a scheduled AWS Lambda
-- through the signed ingestion endpoint. Page loads read these tables only.
CREATE TABLE IF NOT EXISTS dca_bot_buys (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  id TEXT NOT NULL,
  asset TEXT NOT NULL,
  executed_at INTEGER NOT NULL,
  amount REAL CHECK (amount IS NULL OR amount >= 0),
  price REAL CHECK (price IS NULL OR price >= 0),
  thb_amount REAL CHECK (thb_amount IS NULL OR thb_amount >= 0),
  fee REAL CHECK (fee IS NULL OR fee >= 0),
  reason TEXT,
  PRIMARY KEY (account_id, id)
);

CREATE INDEX IF NOT EXISTS dca_bot_buys_account_asset_executed_idx
  ON dca_bot_buys(account_id, asset, executed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS dca_bot_signals (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  active INTEGER CHECK (active IS NULL OR active IN (0, 1)),
  levels_json TEXT NOT NULL,
  has_error INTEGER NOT NULL CHECK (has_error IN (0, 1)),
  PRIMARY KEY (account_id, asset)
);
