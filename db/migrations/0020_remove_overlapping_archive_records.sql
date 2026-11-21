DELETE FROM crypto_transfer_cost_basis
WHERE transfer_id IN (
  SELECT archived.id
  FROM crypto_transfers AS archived
  WHERE archived.external_id LIKE 'archive:%'
    AND EXISTS (
      SELECT 1
      FROM crypto_transfers AS live
      WHERE live.account_id = archived.account_id
        AND live.id <> archived.id
        AND live.direction = archived.direction
        AND live.asset = archived.asset
        AND ABS(live.amount - archived.amount) <= MAX(1e-8, archived.amount * 1e-6)
        AND ABS(live.executed_at - archived.executed_at) <= 120000
        AND (live.external_id IS NULL OR live.external_id NOT LIKE 'archive:%')
    )
);

DELETE FROM crypto_transfers
WHERE external_id LIKE 'archive:%'
  AND EXISTS (
    SELECT 1
    FROM crypto_transfers AS live
    WHERE live.account_id = crypto_transfers.account_id
      AND live.id <> crypto_transfers.id
      AND live.direction = crypto_transfers.direction
      AND live.asset = crypto_transfers.asset
      AND ABS(live.amount - crypto_transfers.amount) <= MAX(1e-8, crypto_transfers.amount * 1e-6)
      AND ABS(live.executed_at - crypto_transfers.executed_at) <= 120000
      AND (live.external_id IS NULL OR live.external_id NOT LIKE 'archive:%')
  );

DELETE FROM fiat_transfers
WHERE external_id LIKE 'archive:%'
  AND EXISTS (
    SELECT 1
    FROM fiat_transfers AS live
    WHERE live.account_id = fiat_transfers.account_id
      AND live.id <> fiat_transfers.id
      AND live.direction = fiat_transfers.direction
      AND live.currency = fiat_transfers.currency
      AND ABS(live.amount - fiat_transfers.amount) <= MAX(1e-8, fiat_transfers.amount * 1e-6)
      AND ABS(live.executed_at - fiat_transfers.executed_at) <= 120000
      AND (live.external_id IS NULL OR live.external_id NOT LIKE 'archive:%')
  );

DELETE FROM trades
WHERE external_id LIKE 'archive:%'
  AND EXISTS (
    SELECT 1
    FROM trades AS live
    WHERE live.account_id = trades.account_id
      AND live.id <> trades.id
      AND live.side = trades.side
      AND live.base_asset = trades.base_asset
      AND live.quote_asset = trades.quote_asset
      AND ABS(live.amount - trades.amount) <= MAX(1e-8, trades.amount * 1e-6)
      AND ABS(live.price - trades.price) <= MAX(1e-8, trades.price * 1e-6)
      AND ABS(live.executed_at - trades.executed_at) <= 120000
      AND (live.external_id IS NULL OR live.external_id NOT LIKE 'archive:%')
  );
