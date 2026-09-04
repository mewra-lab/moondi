import { portfolioValueAt, type NormalizedBalance, type PriceQuote } from '@moondi/shared'

type SnapshotBalance = NormalizedBalance & {
  snapshot_at: number
}

const priceToleranceMs = 35 * 60 * 1_000
const snapshotIntervalMs = 30 * 60 * 1_000

export const savePortfolioValueSnapshot = async (
  db: D1Database,
  accountId: string,
  prices: PriceQuote[],
): Promise<void> => {
  const balances = await db.prepare(`
    SELECT asset, available, reserved, snapshot_at
    FROM balance_snapshots
    WHERE account_id = ?
      AND snapshot_at = (SELECT MAX(snapshot_at) FROM balance_snapshots WHERE account_id = ?)
  `).bind(accountId, accountId).all<SnapshotBalance>()
  const snapshotAt = balances.results[0]?.snapshot_at
  if (snapshotAt === undefined || balances.results.some((balance) => balance.snapshot_at !== snapshotAt)) return

  const totalValue = portfolioValueAt(balances.results, prices, snapshotAt, priceToleranceMs)
  if (totalValue === undefined) return
  await db.prepare(`
    INSERT INTO portfolio_value_snapshots (account_id, interval, snapshot_at, total_value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, interval) DO UPDATE SET
      snapshot_at = excluded.snapshot_at,
      total_value = excluded.total_value
  `).bind(accountId, Math.floor(snapshotAt / snapshotIntervalMs), snapshotAt, totalValue).run()
}
