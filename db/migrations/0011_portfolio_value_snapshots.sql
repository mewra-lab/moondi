CREATE TABLE IF NOT EXISTS portfolio_value_snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  interval INTEGER NOT NULL,
  snapshot_at INTEGER NOT NULL,
  total_value REAL NOT NULL CHECK(total_value >= 0),
  PRIMARY KEY (account_id, interval)
);

CREATE INDEX IF NOT EXISTS portfolio_value_snapshots_time_account_idx
  ON portfolio_value_snapshots(snapshot_at, account_id);

CREATE INDEX IF NOT EXISTS portfolio_value_snapshots_account_time_idx
  ON portfolio_value_snapshots(account_id, snapshot_at);

CREATE INDEX IF NOT EXISTS sync_events_latest_idx
  ON sync_events(account_id, data_type, occurred_at DESC, id DESC);

INSERT OR REPLACE INTO portfolio_value_snapshots (account_id, interval, snapshot_at, total_value)
WITH interval_snapshots AS (
  SELECT account_id, snapshot_at / 1800000 AS interval, MAX(snapshot_at) AS snapshot_at
  FROM balance_snapshots
  GROUP BY account_id, interval
),
valued AS (
  SELECT
    snapshots.account_id,
    snapshots.interval,
    snapshots.snapshot_at,
    SUM(
      (balances.available + balances.reserved)
      * COALESCE(
        CASE balances.asset WHEN 'THB' THEN 1 END,
        (
          SELECT candidate.price
          FROM price_snapshots AS candidate
          WHERE candidate.asset = balances.asset
            AND candidate.quote = 'THB'
            AND candidate.snapshot_at BETWEEN snapshots.snapshot_at - 2100000 AND snapshots.snapshot_at
          ORDER BY candidate.snapshot_at DESC
          LIMIT 1
        ),
        (
          SELECT candidate.price
          FROM price_snapshots AS candidate
          WHERE candidate.asset = balances.asset
            AND candidate.quote = 'THB'
            AND candidate.snapshot_at > snapshots.snapshot_at
            AND candidate.snapshot_at <= snapshots.snapshot_at + 2100000
          ORDER BY candidate.snapshot_at
          LIMIT 1
        ),
        0
      )
    ) AS total_value,
    SUM(
      CASE
        WHEN balances.asset != 'THB'
          AND balances.available + balances.reserved > 0
          AND NOT EXISTS (
            SELECT 1
            FROM price_snapshots AS candidate
            WHERE candidate.asset = balances.asset
              AND candidate.quote = 'THB'
              AND candidate.snapshot_at BETWEEN snapshots.snapshot_at - 2100000 AND snapshots.snapshot_at + 2100000
          )
        THEN 1 ELSE 0
      END
    ) AS missing_prices
  FROM interval_snapshots AS snapshots
  JOIN balance_snapshots AS balances
    ON balances.account_id = snapshots.account_id
    AND balances.snapshot_at = snapshots.snapshot_at
  GROUP BY snapshots.account_id, snapshots.interval, snapshots.snapshot_at
)
SELECT account_id, interval, snapshot_at, total_value
FROM valued
WHERE missing_prices = 0;
