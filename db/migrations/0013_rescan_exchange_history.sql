-- Earlier sync versions could advance these checkpoints after scanning only a
-- subset of symbols or records. Existing normalized rows remain intact and
-- unique indexes make the one-time full available-window replay idempotent.
DELETE FROM sync_state
WHERE data_type IN ('trades', 'crypto_transfers', 'fiat_transfers');
