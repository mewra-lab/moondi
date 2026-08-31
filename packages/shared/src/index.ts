export type ExchangeId = 'bitkub' | 'binance'

export type NormalizedBalance = {
  asset: string
  available: number
  reserved: number
}

export type NormalizedTrade = {
  id: string
  side: 'buy' | 'sell'
  baseAsset: string
  quoteAsset: string
  price: number
  amount: number
  fee: number
  feeAsset?: string
  executedAt: number
  raw: unknown
}

export type NormalizedTransfer = {
  id: string
  direction: 'deposit' | 'withdraw'
  asset: string
  amount: number
  fee: number
  txHash?: string
  executedAt: number
  raw: unknown
}

export type NormalizedFiatTransfer = {
  id: string
  direction: 'deposit' | 'withdraw'
  currency: string
  amount: number
  fee: number
  executedAt: number
  raw: unknown
}

export type PriceQuote = {
  asset: string
  quote: string
  price: number
  updatedAt: number
}

export type ExchangeAdapter = {
  readonly id: ExchangeId
  fetchBalances(): Promise<NormalizedBalance[]>
  fetchTrades(sinceTimestamp?: number, assets?: string[]): Promise<NormalizedTrade[]>
  fetchDeposits(sinceTimestamp?: number): Promise<NormalizedTransfer[]>
  fetchWithdrawals(sinceTimestamp?: number): Promise<NormalizedTransfer[]>
  fetchFiatDeposits?(sinceTimestamp?: number): Promise<NormalizedFiatTransfer[]>
  fetchFiatWithdrawals?(sinceTimestamp?: number): Promise<NormalizedFiatTransfer[]>
  fetchPrices(): Promise<PriceQuote[]>
}

export const asNumber = (value: string | number | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : Number(value)

  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a finite numeric value, received ${String(value)}`)
  }

  return parsed
}

export const toMilliseconds = (value: string | number): number => {
  const timestamp = asNumber(value)
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
}
