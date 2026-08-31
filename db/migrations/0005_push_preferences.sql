ALTER TABLE push_subscriptions ADD COLUMN notify_trades INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN notify_crypto_transfers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN notify_fiat_transfers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN notify_sync_issues INTEGER NOT NULL DEFAULT 1;
