-- Disconnecting an account retains normalized historical records while
-- preventing it from being selected, displayed, or synced again.

ALTER TABLE accounts ADD COLUMN archived_at INTEGER;

CREATE INDEX IF NOT EXISTS accounts_active_exchange_label_idx
  ON accounts(exchange, archived_at, label);
