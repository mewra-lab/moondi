DELETE FROM sync_state
WHERE data_type = 'trades'
  AND account_id IN (SELECT id FROM accounts WHERE exchange = 'bitkub');
