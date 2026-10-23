-- Buys were stored as (order amount - fee) / price at full precision, but Bitkub credits the
-- wallet truncated to 8 decimals. Over many small buys the overstatement exceeded the P&L
-- quantity tolerance and withheld the asset as "quantity mismatch". quote_amount (THB spent
-- net of fee) is already exact and is left unchanged so cost basis does not move.
UPDATE trades
SET amount = CAST(amount * 1e8 AS INTEGER) / 1e8
WHERE side = 'buy'
  AND quote_asset = 'THB'
  AND quote_amount IS NOT NULL
  AND ABS(amount * 1e8 - ROUND(amount * 1e8)) > MAX(1e-3, amount * 1e8 * 1e-14);
