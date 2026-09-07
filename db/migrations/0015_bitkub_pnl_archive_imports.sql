CREATE TABLE IF NOT EXISTS bitkub_pnl_archive_imports (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  archive_before INTEGER NOT NULL,
  source_record_count INTEGER NOT NULL CHECK(source_record_count > 0),
  verified_at INTEGER NOT NULL
);
