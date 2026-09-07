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
  quoteAmount?: number
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

export type PortfolioAssetValue = {
  asset: string
  quantity: number
  value: number
}

export const portfolioAssetValuesAt = (
  balances: NormalizedBalance[],
  prices: PriceQuote[],
  snapshotAt: number,
  priceToleranceMs: number,
): PortfolioAssetValue[] | undefined => {
  const thbPrices = new Map(
    prices
      .filter((price) => price.quote === 'THB' && Math.abs(price.updatedAt - snapshotAt) <= priceToleranceMs)
      .map((price) => [price.asset, price.price]),
  )
  const values: PortfolioAssetValue[] = []
  for (const balance of balances) {
    const quantity = balance.available + balance.reserved
    if (quantity <= 0) continue
    const price = balance.asset === 'THB' ? 1 : thbPrices.get(balance.asset)
    if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined
    const value = quantity * price
    if (!Number.isFinite(value) || value < 0) return undefined
    values.push({ asset: balance.asset, quantity, value })
  }
  return values
}

export const portfolioValueAt = (
  balances: NormalizedBalance[],
  prices: PriceQuote[],
  snapshotAt: number,
  priceToleranceMs: number,
): number | undefined => {
  const values = portfolioAssetValuesAt(balances, prices, snapshotAt, priceToleranceMs)
  if (values === undefined) return undefined
  const total = values.reduce((sum, asset) => sum + asset.value, 0)
  return Number.isFinite(total) && total >= 0 ? total : undefined
}

export type PnlTrade = Omit<NormalizedTrade, 'raw'> & { accountId?: string }

export type PnlCryptoTransfer = Omit<NormalizedTransfer, 'raw'> & { accountId?: string }

export type PnlHolding = {
  accountId?: string
  asset: string
  amount: number
  price: number
}

export type CostBasisOverride = {
  transferId: string
  totalCostThb: number
}

export type PnlAssetStatus =
  | 'ready'
  | 'missing_cost_basis'
  | 'unsupported_quote'
  | 'quantity_mismatch'
  | 'missing_price'
  | 'missing_history'

export type PnlAsset = {
  asset: string
  averageCost: number | null
  costBasis: number | null
  currentValue: number | null
  pnlPercent: number | null
  quantity: number
  realizedCostBasis: number | null
  realizedPnl: number | null
  status: PnlAssetStatus
  totalPnl: number | null
  unrealizedPnl: number | null
}

export type MissingCostBasis = {
  amount: number
  asset: string
  executedAt: number
  transferId: string
}

export type PnlResult = {
  assets: PnlAsset[]
  complete: boolean
  historyComplete: boolean
  investedAmount: number | null
  missingHistoryAccounts: string[]
  missingCostBasis: MissingCostBasis[]
  realizedPnl: number | null
  totalPnl: number | null
  unrealizedPnl: number | null
}

type PnlPosition = {
  accountId: string
  asset: string
  cost: number
  quantity: number
  realizedCostBasis: number
  realizedPnl: number
  reasons: Set<Exclude<PnlAssetStatus, 'ready'>>
}

type PnlEvent =
  | { kind: 'trade'; record: PnlTrade }
  | { kind: 'crypto_transfer'; record: PnlCryptoTransfer }

const pnlQuantityTolerance = 1e-7

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0

const pnlStatus = (reasons: Set<Exclude<PnlAssetStatus, 'ready'>>): PnlAssetStatus => {
  if (reasons.has('missing_history')) return 'missing_history'
  if (reasons.has('missing_cost_basis')) return 'missing_cost_basis'
  if (reasons.has('unsupported_quote')) return 'unsupported_quote'
  if (reasons.has('quantity_mismatch')) return 'quantity_mismatch'
  if (reasons.has('missing_price')) return 'missing_price'
  return 'ready'
}

const pnlPositionKey = (accountId: string | undefined, asset: string): string => `${accountId ?? ''}\u0000${asset}`

const pnlPosition = (positions: Map<string, PnlPosition>, accountId: string | undefined, asset: string): PnlPosition => {
  const key = pnlPositionKey(accountId, asset)
  const current = positions.get(key)
  if (current) return current
  const created: PnlPosition = { accountId: accountId ?? '', asset, cost: 0, quantity: 0, realizedCostBasis: 0, realizedPnl: 0, reasons: new Set() }
  positions.set(key, created)
  return created
}

const closePosition = (position: PnlPosition, amount: number): number | undefined => {
  if (!finiteNonNegative(amount) || position.quantity + pnlQuantityTolerance < amount) {
    position.reasons.add('quantity_mismatch')
    return undefined
  }
  if (position.quantity <= pnlQuantityTolerance) return 0
  const cost = position.cost * amount / position.quantity
  position.quantity -= amount
  position.cost -= cost
  if (position.quantity <= pnlQuantityTolerance) {
    position.quantity = 0
    position.cost = 0
  }
  return cost
}

const sortedPnlEvents = (trades: PnlTrade[], cryptoTransfers: PnlCryptoTransfer[]): PnlEvent[] => [
  ...trades.map((record): PnlEvent => ({ kind: 'trade', record })),
  ...cryptoTransfers.map((record): PnlEvent => ({ kind: 'crypto_transfer', record })),
].sort((left, right) => {
  const leftTime = left.record.executedAt
  const rightTime = right.record.executedAt
  if (leftTime !== rightTime) return leftTime - rightTime
  if (left.kind !== right.kind) return left.kind.localeCompare(right.kind)
  return left.record.id.localeCompare(right.record.id)
})

const applyCostBasisEvent = (positions: Map<string, PnlPosition>, event: PnlEvent, overridesByTransfer: ReadonlyMap<string, number>): void => {
  if (event.kind === 'crypto_transfer') {
    const transfer = event.record
    const position = pnlPosition(positions, transfer.accountId, transfer.asset)
    if (!finiteNonNegative(transfer.amount)) {
      position.reasons.add('quantity_mismatch')
      return
    }
    if (transfer.direction === 'deposit') {
      position.quantity += transfer.amount
      const override = overridesByTransfer.get(transfer.id)
      if (override === undefined) {
        position.reasons.add('missing_cost_basis')
      } else {
        position.cost += override
      }
      return
    }
    closePosition(position, transfer.amount + transfer.fee)
    return
  }

  const trade = event.record
  const position = pnlPosition(positions, trade.accountId, trade.baseAsset)
  const quoteAmount = trade.quoteAmount ?? trade.amount * trade.price
  const feeIsThb = trade.fee === 0 || trade.feeAsset === 'THB'
  if (
    trade.quoteAsset !== 'THB'
    || !feeIsThb
    || !finiteNonNegative(trade.amount)
    || !finiteNonNegative(trade.fee)
    || !Number.isFinite(quoteAmount)
    || quoteAmount <= 0
  ) {
    position.reasons.add('unsupported_quote')
    return
  }
  if (trade.side === 'buy') {
    position.quantity += trade.amount
    position.cost += quoteAmount + trade.fee
    return
  }
  const soldCost = closePosition(position, trade.amount)
  if (soldCost !== undefined) {
    position.realizedCostBasis += soldCost
    position.realizedPnl += quoteAmount - trade.fee - soldCost
  }
}

export const calculateOpenCostBasisHistory = ({
  assets,
  cryptoTransfers,
  overrides,
  snapshots,
  trades,
}: {
  assets: readonly string[]
  cryptoTransfers: PnlCryptoTransfer[]
  overrides: CostBasisOverride[]
  snapshots: readonly number[]
  trades: PnlTrade[]
}): Array<number | null> => {
  const selectedAssets = new Set(assets)
  const overridesByTransfer = new Map(overrides
    .filter((override) => finiteNonNegative(override.totalCostThb))
    .map((override) => [override.transferId, override.totalCostThb]))
  const events = sortedPnlEvents(
    trades.filter((trade) => selectedAssets.has(trade.baseAsset)),
    cryptoTransfers.filter((transfer) => selectedAssets.has(transfer.asset)),
  )
  const positions = new Map<string, PnlPosition>()
  let eventIndex = 0

  return snapshots.map((snapshotAt) => {
    while (eventIndex < events.length && events[eventIndex]!.record.executedAt <= snapshotAt) {
      applyCostBasisEvent(positions, events[eventIndex]!, overridesByTransfer)
      eventIndex += 1
    }
    const matching = [...positions.values()].filter((position) => selectedAssets.has(position.asset))
    if (matching.some((position) => position.reasons.size > 0)) return null
    return matching.reduce((total, position) => total + position.cost, 0)
  })
}

export const calculateAverageCostHistory = ({
  asset,
  cryptoTransfers,
  overrides,
  snapshots,
  trades,
}: {
  asset: string
  cryptoTransfers: PnlCryptoTransfer[]
  overrides: CostBasisOverride[]
  snapshots: readonly number[]
  trades: PnlTrade[]
}): Array<number | null> => {
  const overridesByTransfer = new Map(overrides.filter((override) => finiteNonNegative(override.totalCostThb)).map((override) => [override.transferId, override.totalCostThb]))
  const events = sortedPnlEvents(trades.filter((trade) => trade.baseAsset === asset), cryptoTransfers.filter((transfer) => transfer.asset === asset))
  const positions = new Map<string, PnlPosition>()
  let eventIndex = 0
  return snapshots.map((snapshotAt) => {
    while (eventIndex < events.length && events[eventIndex]!.record.executedAt <= snapshotAt) {
      applyCostBasisEvent(positions, events[eventIndex]!, overridesByTransfer)
      eventIndex += 1
    }
    const matching = [...positions.values()].filter((position) => position.asset === asset)
    if (matching.some((position) => position.reasons.size > 0)) return null
    const quantity = matching.reduce((total, position) => total + position.quantity, 0)
    return quantity > pnlQuantityTolerance ? matching.reduce((total, position) => total + position.cost, 0) / quantity : null
  })
}

export const calculateAverageCostPnl = ({
  cryptoTransfers,
  holdings,
  overrides,
  trades,
}: {
  cryptoTransfers: PnlCryptoTransfer[]
  holdings: PnlHolding[]
  overrides: CostBasisOverride[]
  trades: PnlTrade[]
}): PnlResult => {
  const overridesByTransfer = new Map(overrides
    .filter((override) => finiteNonNegative(override.totalCostThb))
    .map((override) => [override.transferId, override.totalCostThb]))
  const positions = new Map<string, PnlPosition>()
  const missingCostBasis: MissingCostBasis[] = []
  const events = sortedPnlEvents(trades, cryptoTransfers)
  for (const event of events) {
    if (event.kind === 'crypto_transfer' && event.record.direction === 'deposit' && finiteNonNegative(event.record.amount) && overridesByTransfer.get(event.record.id) === undefined) {
      missingCostBasis.push({ amount: event.record.amount, asset: event.record.asset, executedAt: event.record.executedAt, transferId: event.record.id })
    }
    applyCostBasisEvent(positions, event, overridesByTransfer)
  }

  const holdingsByPosition = new Map<string, PnlHolding>()
  for (const holding of holdings) {
    if (holding.asset === 'THB' || !finiteNonNegative(holding.amount) || !finiteNonNegative(holding.price)) continue
    const key = pnlPositionKey(holding.accountId, holding.asset)
    const existing = holdingsByPosition.get(key)
    holdingsByPosition.set(key, {
      amount: (existing?.amount ?? 0) + holding.amount,
      ...(holding.accountId === undefined ? {} : { accountId: holding.accountId }),
      asset: holding.asset,
      price: holding.price > 0 ? holding.price : (existing?.price ?? 0),
    })
  }

  for (const [key, holding] of holdingsByPosition) {
    if (holding.amount > pnlQuantityTolerance && !positions.has(key)) {
      pnlPosition(positions, holding.accountId, holding.asset).reasons.add('missing_history')
    }
  }

  const byAsset = new Map<string, {
    cost: number
    currentValue: number
    quantity: number
    reasons: Set<Exclude<PnlAssetStatus, 'ready'>>
    realizedCostBasis: number
    realizedPnl: number
  }>()
  for (const position of positions.values()) {
    const holding = holdingsByPosition.get(pnlPositionKey(position.accountId, position.asset))
    const holdingAmount = holding?.amount ?? 0
    const tolerance = Math.max(pnlQuantityTolerance, Math.max(position.quantity, holdingAmount) * 1e-8)
    if (Math.abs(position.quantity - holdingAmount) > tolerance) position.reasons.add('quantity_mismatch')
    if (holdingAmount > tolerance && (!holding || holding.price <= 0)) position.reasons.add('missing_price')
    const aggregate = byAsset.get(position.asset) ?? {
      cost: 0,
      currentValue: 0,
      quantity: 0,
      reasons: new Set<Exclude<PnlAssetStatus, 'ready'>>(),
      realizedCostBasis: 0,
      realizedPnl: 0,
    }
    aggregate.cost += position.cost
    aggregate.currentValue += holding ? holding.amount * holding.price : 0
    aggregate.quantity += holdingAmount
    aggregate.realizedCostBasis += position.realizedCostBasis
    aggregate.realizedPnl += position.realizedPnl
    for (const reason of position.reasons) aggregate.reasons.add(reason)
    byAsset.set(position.asset, aggregate)
  }

  const assets = [...byAsset.entries()].map(([asset, aggregate]): PnlAsset => {
    const status = pnlStatus(aggregate.reasons)
    const unrealizedPnl = aggregate.currentValue - aggregate.cost
    const totalPnl = aggregate.realizedPnl + unrealizedPnl
    const totalCostBasis = aggregate.cost + aggregate.realizedCostBasis
    return {
      asset,
      averageCost: status === 'ready' && aggregate.quantity > pnlQuantityTolerance ? aggregate.cost / aggregate.quantity : null,
      costBasis: status === 'ready' ? aggregate.cost : null,
      currentValue: status === 'ready' ? aggregate.currentValue : null,
      pnlPercent: status === 'ready' && totalCostBasis > pnlQuantityTolerance ? totalPnl / totalCostBasis * 100 : null,
      quantity: aggregate.quantity,
      realizedCostBasis: status === 'ready' ? aggregate.realizedCostBasis : null,
      realizedPnl: status === 'ready' ? aggregate.realizedPnl : null,
      status,
      totalPnl: status === 'ready' ? totalPnl : null,
      unrealizedPnl: status === 'ready' ? unrealizedPnl : null,
    }
  }).sort((left, right) => left.asset.localeCompare(right.asset))

  const complete = assets.every((asset) => asset.status === 'ready')
  const investedAmount = complete
    ? assets.reduce((total, asset) => total + (asset.costBasis ?? 0) + (asset.realizedCostBasis ?? 0), 0)
    : null
  return {
    assets,
    complete,
    historyComplete: true,
    investedAmount,
    missingHistoryAccounts: [],
    missingCostBasis: missingCostBasis.sort((left, right) => left.executedAt - right.executedAt || left.transferId.localeCompare(right.transferId)),
    realizedPnl: complete ? assets.reduce((total, asset) => total + (asset.realizedPnl ?? 0), 0) : null,
    totalPnl: complete ? assets.reduce((total, asset) => total + (asset.totalPnl ?? 0), 0) : null,
    unrealizedPnl: complete ? assets.reduce((total, asset) => total + (asset.unrealizedPnl ?? 0), 0) : null,
  }
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
