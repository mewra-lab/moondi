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
      AND (
        sync_state.covered_from IS NULL
        OR imports.archive_before != sync_state.covered_from
      )
  );
