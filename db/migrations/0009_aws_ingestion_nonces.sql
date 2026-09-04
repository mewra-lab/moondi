-- The AWS Bitkub egress Lambda signs each bounded ingestion payload. A nonce is
-- consumed before records are written so captured requests cannot be replayed.
CREATE TABLE IF NOT EXISTS aws_ingestion_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS aws_ingestion_nonces_expires_at_idx
  ON aws_ingestion_nonces(expires_at);
