CREATE TABLE IF NOT EXISTS crypto_transfer_cost_basis (
  transfer_id TEXT PRIMARY KEY REFERENCES crypto_transfers(id),
  total_cost_thb REAL NOT NULL CHECK(total_cost_thb >= 0),
  updated_at INTEGER NOT NULL
);
