import { portfolioAssetValuesAt, type NormalizedBalance, type PriceQuote } from '@moondi/shared'

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

  const interval = Math.floor(snapshotAt / snapshotIntervalMs)
  const existing = await db.prepare(
    'SELECT snapshot_at FROM portfolio_value_snapshots WHERE account_id = ? AND interval = ?',
  ).bind(accountId, interval).first<{ snapshot_at: number }>()
  if (existing?.snapshot_at === snapshotAt) return

  const assetValues = portfolioAssetValuesAt(balances.results, prices, snapshotAt, priceToleranceMs)
  if (assetValues === undefined) return
  const totalValue = assetValues.reduce((total, asset) => total + asset.value, 0)
  await db.batch([
    db.prepare('DELETE FROM portfolio_asset_value_snapshots WHERE account_id = ? AND interval = ?').bind(accountId, interval),
    db.prepare(`
      INSERT INTO portfolio_value_snapshots (account_id, interval, snapshot_at, total_value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, interval) DO UPDATE SET
        snapshot_at = excluded.snapshot_at,
        total_value = excluded.total_value
    `).bind(accountId, interval, snapshotAt, totalValue),
    ...assetValues.map((asset) => db.prepare(`
      INSERT INTO portfolio_asset_value_snapshots (account_id, asset, interval, snapshot_at, quantity, value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, asset, interval) DO UPDATE SET
        snapshot_at = excluded.snapshot_at,
        quantity = excluded.quantity,
        value = excluded.value
    `).bind(accountId, asset.asset, interval, snapshotAt, asset.quantity, asset.value)),
  ])
}
