-- Exchange record IDs must be unique per connected account, not globally.
-- Existing rows used the old database ID as their source identifier.

ALTER TABLE trades ADD COLUMN external_id TEXT;
UPDATE trades SET external_id = id WHERE external_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trades_account_external_id_idx
  ON trades(account_id, external_id);

ALTER TABLE crypto_transfers ADD COLUMN external_id TEXT;
UPDATE crypto_transfers SET external_id = id WHERE external_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crypto_transfers_account_external_id_idx
  ON crypto_transfers(account_id, external_id);

ALTER TABLE fiat_transfers ADD COLUMN external_id TEXT;
UPDATE fiat_transfers SET external_id = id WHERE external_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fiat_transfers_account_external_id_idx
  ON fiat_transfers(account_id, external_id);
