export type { DcaActivity, DcaBuy } from './dca-activity'

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

export type PnlCostMethod = 'average' | 'lots'

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

export type CarriedCostSuggestion = {
  costThb: number
  matchedQuantity: number
}

export type MissingCostBasis = {
  amount: number
  asset: string
  executedAt: number
  suggestedCostThb?: number
  suggestedMatchedQuantity?: number
  transferId: string
}

export type PnlResult = {
  assets: PnlAsset[]
  complete: boolean
  costMethod: PnlCostMethod
  historyComplete: boolean
  investedAmount: number | null
  missingHistoryAccounts: string[]
  missingCostBasis: MissingCostBasis[]
  realizedPnl: number | null
  totalPnl: number | null
  unrealizedPnl: number | null
}

type PnlLot = {
  cost: number
  day: number
  quantity: number
}

type PnlPosition = {
  accountId: string
  asset: string
  cost: number
  lots: PnlLot[]
  quantity: number
  quantityUncertainty: number
  realizedCostBasis: number
  realizedPnl: number
  reasons: Set<Exclude<PnlAssetStatus, 'ready'>>
}

type PnlEvent =
  | { kind: 'trade'; record: PnlTrade }
  | { kind: 'crypto_transfer'; record: PnlCryptoTransfer }

const pnlQuantityTolerance = 2e-7

const pnlBuyRoundingThb = 0.01

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
  const created: PnlPosition = { accountId: accountId ?? '', asset, cost: 0, lots: [], quantity: 0, quantityUncertainty: 0, realizedCostBasis: 0, realizedPnl: 0, reasons: new Set() }
  positions.set(key, created)
  return created
}

const thailandOffsetMs = 7 * 3_600_000

const pnlLotDay = (executedAt: number): number => Math.floor((executedAt + thailandOffsetMs) / 86_400_000)

const consumeLots = (position: PnlPosition, amount: number, withdrawalDay: number | undefined): number => {
  const lots = position.lots
  const order = withdrawalDay === undefined
    ? [...lots].reverse()
    : [...lots.filter((lot) => lot.day === withdrawalDay).reverse(), ...lots.filter((lot) => lot.day !== withdrawalDay)]
  let remaining = amount
  let cost = 0
  for (const lot of order) {
    if (remaining <= 0) break
    if (lot.quantity <= remaining) {
      remaining -= lot.quantity
      cost += lot.cost
      lot.quantity = 0
      lot.cost = 0
    } else {
      const taken = lot.cost * remaining / lot.quantity
      lot.quantity -= remaining
      lot.cost -= taken
      cost += taken
      remaining = 0
    }
  }
  position.lots = lots.filter((lot) => lot.quantity > 1e-12)
  return cost
}

type LotRule = { withdrawalDay?: number }

const closePosition = (position: PnlPosition, amount: number, lotRule?: LotRule): number | undefined => {
  const slack = pnlQuantityTolerance + position.quantityUncertainty
  if (!finiteNonNegative(amount) || position.quantity + slack < amount) {
    position.reasons.add('quantity_mismatch')
    return undefined
  }
  if (position.quantity <= pnlQuantityTolerance) return 0
  const closedAmount = position.quantity - amount <= slack ? position.quantity : amount
  const cost = lotRule ? consumeLots(position, closedAmount, lotRule.withdrawalDay) : position.cost * closedAmount / position.quantity
  position.quantity -= closedAmount
  position.cost -= cost
  if (position.quantity <= pnlQuantityTolerance) {
    position.quantity = 0
    position.cost = 0
    position.lots = []
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

const applyCostBasisEvent = (positions: Map<string, PnlPosition>, event: PnlEvent, overridesByTransfer: ReadonlyMap<string, number>, method: PnlCostMethod): void => {
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
      if (method === 'lots') position.lots.push({ cost: override ?? 0, day: pnlLotDay(transfer.executedAt), quantity: transfer.amount })
      return
    }
    closePosition(position, transfer.amount + transfer.fee, method === 'lots' ? { withdrawalDay: pnlLotDay(transfer.executedAt) } : undefined)
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
    if (trade.price > 0 && Number.isFinite(trade.price)) position.quantityUncertainty += pnlBuyRoundingThb / trade.price
    position.cost += quoteAmount + trade.fee
    if (method === 'lots') position.lots.push({ cost: quoteAmount + trade.fee, day: pnlLotDay(trade.executedAt), quantity: trade.amount })
    return
  }
  const soldCost = closePosition(position, trade.amount, method === 'lots' ? {} : undefined)
  if (soldCost !== undefined) {
    position.realizedCostBasis += soldCost
    position.realizedPnl += quoteAmount - trade.fee - soldCost
  }
}

type TransitPool = { cost: number, quantity: number }

export const suggestCarriedCostBasis = ({
  costMethod = 'average',
  cryptoTransfers,
  overrides,
  trades,
}: {
  costMethod?: PnlCostMethod
  cryptoTransfers: PnlCryptoTransfer[]
  overrides: CostBasisOverride[]
  trades: PnlTrade[]
}): Map<string, CarriedCostSuggestion> => {
  const overridesByTransfer = new Map(overrides
    .filter((override) => finiteNonNegative(override.totalCostThb))
    .map((override) => [override.transferId, override.totalCostThb]))
  const positions = new Map<string, PnlPosition>()
  const pools = new Map<string, TransitPool>()
  const transit = new Map<string, TransitPool[]>()
  const suggestions = new Map<string, CarriedCostSuggestion>()

  for (const event of sortedPnlEvents(trades, cryptoTransfers)) {
    if (event.kind !== 'crypto_transfer') {
      applyCostBasisEvent(positions, event, overridesByTransfer, costMethod)
      continue
    }

    const transfer = event.record
    const key = pnlPositionKey(transfer.accountId, transfer.asset)
    if (transfer.direction === 'withdraw') {
      const position = pnlPosition(positions, transfer.accountId, transfer.asset)
      const quantityBefore = position.quantity
      const costBefore = position.cost
      const trusted = position.reasons.size === 0
      applyCostBasisEvent(positions, event, overridesByTransfer, costMethod)
      const closedQuantity = quantityBefore - position.quantity
      if (!trusted || position.reasons.size > 0 || !finiteNonNegative(transfer.amount) || transfer.amount <= pnlQuantityTolerance || closedQuantity <= pnlQuantityTolerance) continue
      const carriedQuantity = Math.min(transfer.amount, closedQuantity)
      const carriedCost = (costBefore - position.cost) * carriedQuantity / closedQuantity
      if (costMethod === 'lots') {
        const segments = transit.get(key) ?? []
        segments.push({ cost: carriedCost, quantity: carriedQuantity })
        transit.set(key, segments)
        continue
      }
      const pool = pools.get(key) ?? { cost: 0, quantity: 0 }
      pool.cost += carriedCost
      pool.quantity += carriedQuantity
      pools.set(key, pool)
      continue
    }

    applyCostBasisEvent(positions, event, overridesByTransfer, costMethod)
    if (costMethod === 'lots') {
      const segments = transit.get(key)
      if (!segments || !finiteNonNegative(transfer.amount) || transfer.amount <= pnlQuantityTolerance) continue
      let remaining = transfer.amount
      let matchedQuantity = 0
      let costThb = 0
      while (remaining > pnlQuantityTolerance && segments.length > 0) {
        const segment = segments[segments.length - 1]!
        const taken = Math.min(remaining, segment.quantity)
        const takenCost = segment.cost * taken / segment.quantity
        segment.quantity -= taken
        segment.cost -= takenCost
        matchedQuantity += taken
        costThb += takenCost
        remaining -= taken
        if (segment.quantity <= pnlQuantityTolerance) segments.pop()
      }
      if (overridesByTransfer.get(transfer.id) === undefined && matchedQuantity > pnlQuantityTolerance && Number.isFinite(costThb)) {
        suggestions.set(transfer.id, { costThb, matchedQuantity })
      }
      continue
    }
    const pool = pools.get(key)
    if (!pool || !finiteNonNegative(transfer.amount) || transfer.amount <= pnlQuantityTolerance || pool.quantity <= pnlQuantityTolerance) continue
    const matchedQuantity = Math.min(transfer.amount, pool.quantity)
    const costThb = pool.cost * matchedQuantity / pool.quantity
    pool.quantity -= matchedQuantity
    pool.cost -= costThb
    if (pool.quantity <= pnlQuantityTolerance) {
      pool.quantity = 0
      pool.cost = 0
    }
    if (overridesByTransfer.get(transfer.id) === undefined && matchedQuantity > pnlQuantityTolerance && Number.isFinite(costThb)) {
      suggestions.set(transfer.id, { costThb, matchedQuantity })
    }
  }
  return suggestions
}

export const calculateOpenCostBasisHistory = ({
  assets,
  costMethod = 'average',
  cryptoTransfers,
  overrides,
  snapshots,
  trades,
}: {
  assets: readonly string[]
  costMethod?: PnlCostMethod
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
      applyCostBasisEvent(positions, events[eventIndex]!, overridesByTransfer, costMethod)
      eventIndex += 1
    }
    const matching = [...positions.values()].filter((position) => selectedAssets.has(position.asset))
    if (matching.some((position) => position.reasons.size > 0)) return null
    return matching.reduce((total, position) => total + position.cost, 0)
  })
}

export const calculateAverageCostHistory = ({
  asset,
  costMethod = 'average',
  cryptoTransfers,
  overrides,
  snapshots,
  trades,
}: {
  asset: string
  costMethod?: PnlCostMethod
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
      applyCostBasisEvent(positions, events[eventIndex]!, overridesByTransfer, costMethod)
      eventIndex += 1
    }
    const matching = [...positions.values()].filter((position) => position.asset === asset)
    if (matching.some((position) => position.reasons.size > 0)) return null
    const quantity = matching.reduce((total, position) => total + position.quantity, 0)
    return quantity > pnlQuantityTolerance ? matching.reduce((total, position) => total + position.cost, 0) / quantity : null
  })
}

export const calculateAverageCostPnl = ({
  costMethod = 'average',
  cryptoTransfers,
  holdings,
  overrides,
  trades,
}: {
  costMethod?: PnlCostMethod
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
  const suggestions = suggestCarriedCostBasis({ costMethod, cryptoTransfers, overrides, trades })
  const events = sortedPnlEvents(trades, cryptoTransfers)
  for (const event of events) {
    if (event.kind === 'crypto_transfer' && event.record.direction === 'deposit' && finiteNonNegative(event.record.amount) && overridesByTransfer.get(event.record.id) === undefined) {
      const suggestion = suggestions.get(event.record.id)
      missingCostBasis.push({
        amount: event.record.amount,
        asset: event.record.asset,
        executedAt: event.record.executedAt,
        ...(suggestion === undefined ? {} : { suggestedCostThb: suggestion.costThb, suggestedMatchedQuantity: suggestion.matchedQuantity }),
        transferId: event.record.id,
      })
    }
    applyCostBasisEvent(positions, event, overridesByTransfer, costMethod)
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
    if (Math.abs(position.quantity - holdingAmount) > tolerance + position.quantityUncertainty) position.reasons.add('quantity_mismatch')
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
    costMethod,
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
