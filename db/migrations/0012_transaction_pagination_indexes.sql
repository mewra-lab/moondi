CREATE INDEX IF NOT EXISTS trades_account_executed_id_idx
  ON trades(account_id, executed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crypto_transfers_account_executed_id_idx
  ON crypto_transfers(account_id, executed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS fiat_transfers_account_executed_id_idx
  ON fiat_transfers(account_id, executed_at DESC, id DESC);

DROP INDEX IF EXISTS trades_account_executed_idx;
DROP INDEX IF EXISTS crypto_transfers_account_executed_idx;
DROP INDEX IF EXISTS fiat_transfers_account_executed_idx;
