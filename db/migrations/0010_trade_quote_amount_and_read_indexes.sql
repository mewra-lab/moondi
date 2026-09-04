ALTER TABLE trades ADD COLUMN quote_amount REAL;

-- Cover the bounded ledger/history reads without scanning every row.
CREATE INDEX IF NOT EXISTS balance_snapshots_account_time_asset_idx
  ON balance_snapshots(account_id, snapshot_at DESC, asset);
CREATE INDEX IF NOT EXISTS trades_executed_id_idx
  ON trades(executed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crypto_transfers_executed_id_idx
  ON crypto_transfers(executed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS fiat_transfers_executed_id_idx
  ON fiat_transfers(executed_at DESC, id DESC);
