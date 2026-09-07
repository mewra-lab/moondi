import type { NormalizedBalance, PriceQuote } from '@moondi/shared'

type HistoryCheckpoint = {
  covered_from: number | null
  last_synced_at: number
}

export const mergeTradeAssets = (...groups: string[][]): string[] => [
  ...new Set(groups.flat().map((asset) => asset.toUpperCase()).filter((asset) => asset !== 'THB')),
].sort()

export const balancesForSnapshot = (balances: NormalizedBalance[]): NormalizedBalance[] => (
  balances.filter((balance) => balance.asset === 'THB' || balance.available + balance.reserved > 0)
)

export const pricesForPersistence = (prices: PriceQuote[], assets: ReadonlySet<string>): PriceQuote[] => (
  prices.filter((price) => price.quote === 'THB' && assets.has(price.asset))
)

export const sharedHistoryCoverage = (defaultCoverage: number, states: Array<HistoryCheckpoint | null>): number => {
  const existing = states.flatMap((state) => state?.covered_from == null ? [] : [state.covered_from])
  return existing.length === 0 ? defaultCoverage : Math.min(...existing)
}

export const historyFetchStart = (state: HistoryCheckpoint | null, coverage: number): number => (
  state?.covered_from === coverage ? state.last_synced_at : coverage
)
