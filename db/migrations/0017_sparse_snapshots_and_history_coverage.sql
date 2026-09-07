ALTER TABLE sync_state ADD COLUMN covered_from INTEGER;

CREATE TABLE portfolio_asset_value_snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset TEXT NOT NULL,
  interval INTEGER NOT NULL,
  snapshot_at INTEGER NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0),
  value REAL NOT NULL CHECK(value >= 0),
  PRIMARY KEY (account_id, asset, interval)
);

CREATE INDEX portfolio_asset_value_snapshots_asset_interval_account_idx
  ON portfolio_asset_value_snapshots(asset, interval, account_id);

INSERT INTO portfolio_asset_value_snapshots (account_id, asset, interval, snapshot_at, quantity, value)
SELECT
  balances.account_id,
  balances.asset,
  values_by_account.interval,
  balances.snapshot_at,
  balances.available + balances.reserved,
  (balances.available + balances.reserved) * COALESCE(
    CASE balances.asset WHEN 'THB' THEN 1 END,
    (SELECT candidate.price
      FROM price_snapshots AS candidate
      WHERE candidate.asset = balances.asset
        AND candidate.quote = 'THB'
        AND candidate.snapshot_at BETWEEN balances.snapshot_at - 2100000 AND balances.snapshot_at
      ORDER BY candidate.snapshot_at DESC
      LIMIT 1),
    (SELECT candidate.price
      FROM price_snapshots AS candidate
      WHERE candidate.asset = balances.asset
        AND candidate.quote = 'THB'
        AND candidate.snapshot_at > balances.snapshot_at
        AND candidate.snapshot_at <= balances.snapshot_at + 2100000
      ORDER BY candidate.snapshot_at
      LIMIT 1)
  )
FROM portfolio_value_snapshots AS values_by_account
JOIN balance_snapshots AS balances
  ON balances.account_id = values_by_account.account_id
  AND balances.snapshot_at = values_by_account.snapshot_at
WHERE balances.available + balances.reserved > 0
  AND (
    balances.asset = 'THB'
    OR EXISTS (
      SELECT 1 FROM price_snapshots AS candidate
      WHERE candidate.asset = balances.asset
        AND candidate.quote = 'THB'
        AND candidate.snapshot_at BETWEEN balances.snapshot_at - 2100000 AND balances.snapshot_at + 2100000
    )
  );

DROP INDEX IF EXISTS balance_snapshots_account_time_idx;
DROP INDEX IF EXISTS price_snapshots_quote_time_idx;

UPDATE sync_state
SET covered_from = (
  SELECT imports.archive_before
  FROM bitkub_pnl_archive_imports AS imports
  WHERE imports.account_id = sync_state.account_id
)
WHERE data_type IN ('trades', 'crypto_transfers', 'fiat_transfers')
  AND account_id IN (SELECT id FROM accounts WHERE exchange = 'bitkub')
  AND EXISTS (
    SELECT 1
    FROM bitkub_pnl_archive_imports AS imports
    WHERE imports.account_id = sync_state.account_id
      AND imports.archive_before <= sync_state.last_synced_at
  );

DELETE FROM sync_state
WHERE data_type IN ('trades', 'crypto_transfers', 'fiat_transfers')
  AND account_id IN (SELECT id FROM accounts WHERE exchange = 'bitkub')
  AND covered_from IS NULL;
