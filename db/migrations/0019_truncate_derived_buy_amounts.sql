UPDATE trades
SET amount = CAST(amount * 1e8 AS INTEGER) / 1e8
WHERE side = 'buy'
  AND quote_asset = 'THB'
  AND quote_amount IS NOT NULL
  AND ABS(amount * 1e8 - ROUND(amount * 1e8)) > MAX(1e-3, amount * 1e8 * 1e-14);
