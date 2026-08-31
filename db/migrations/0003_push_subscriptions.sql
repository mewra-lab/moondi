CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_push_state (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  data_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('deferred', 'failure')),
  detail TEXT,
  PRIMARY KEY (account_id, data_type)
);
