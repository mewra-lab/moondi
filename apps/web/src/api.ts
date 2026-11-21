import type { DcaActivity } from '@moondi/shared'

export type Holding = {
  account_id: string
  account_exchange: string
  account_label: string
  asset: string
  available: number
  reserved: number
  price: number
  updated_at: number | null
}

export type Account = {
  id: string
  exchange: string
  label: string
  created_at: number
}

export type Portfolio = {
  holdings: Holding[]
  pnl: PnlSummary
  totalValue: number
  updatedAt: number | null
}

export type PnlAsset = {
  asset: string
  averageCost: number | null
  costBasis: number | null
  currentValue: number | null
  pnlPercent: number | null
  quantity: number
  realizedCostBasis: number | null
  realizedPnl: number | null
  status: 'ready' | 'missing_cost_basis' | 'unsupported_quote' | 'quantity_mismatch' | 'missing_price' | 'missing_history'
  totalPnl: number | null
  unrealizedPnl: number | null
}

export type MissingCostBasis = {
  amount: number
  asset: string
  executedAt: number
  suggestedCostThb?: number
  suggestedMatchedQuantity?: number
  transferId: string
}

export type CostMethod = 'average' | 'lots'

export type PnlSummary = {
  assets: PnlAsset[]
  complete: boolean
  costMethod?: CostMethod
  historyComplete: boolean
  investedAmount: number | null
  missingCostBasis: MissingCostBasis[]
  missingHistoryAccounts: string[]
  realizedPnl: number | null
  totalPnl: number | null
  unrealizedPnl: number | null
}

export type Transaction = {
  id: string
  account_id: string
  category: 'trade' | 'crypto_transfer' | 'fiat_transfer'
  direction: string
  asset: string
  amount: number
  quote_asset: string | null
  quote_amount: number | null
  price: number | null
  fee: number
  executed_at: number
}

export type ValueHistoryPoint = {
  invested_value: number | null
  selected_value: number | null
  snapshot_at: number
  total_value: number
}

export type PriceHistoryPoint = {
  average_cost?: number | null
  snapshot_at: number
  price: number
}

export type AssetPriceHistoryOptions = {
  accountId?: string | undefined
  averageCost?: boolean
  costMethod?: CostMethod
  days?: number
  from?: number
}

export type SyncStatus = {
  account_id: string
  account_label: string
  data_type: 'balances' | 'trades' | 'crypto_transfers' | 'fiat_transfers' | 'prices'
  status: 'success' | 'deferred' | 'failure' | 'pending'
  detail: string | null
  occurred_at: number | null
}

export type SyncEvent = Omit<SyncStatus, 'occurred_at' | 'status'> & {
  id: number
  occurred_at: number
  status: 'success' | 'deferred' | 'failure'
}

export type PushNotificationPreferences = {
  cryptoTransfers: boolean
  fiatTransfers: boolean
  priceAlerts: boolean
  syncIssues: boolean
  trades: boolean
}

export type WatchlistAsset = {
  asset: string
  created_at: number
  price: number | null
  updated_at: number | null
}

export type PriceAlert = {
  active: number
  asset: string
  created_at: number
  direction: 'above' | 'below'
  id: string
  is_triggered: number
  last_triggered_at: number | null
  target_price: number
  updated_at: number
}

export type AllocationTarget = {
  asset: string
  target_percent: number
  updated_at: number
}

export type Dashboard = {
  portfolio: Portfolio
  transactions: Transaction[]
  nextTransactionCursor: string | null
  history: ValueHistoryPoint[]
  syncStatus: SyncStatus[]
  watchlist: WatchlistAsset[]
  priceAlerts: PriceAlert[]
  targets: AllocationTarget[]
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export const apiAccessUrl = `${baseUrl}/api/access/complete`
export const apiAccessRequired = 'API_ACCESS_REQUIRED'

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response

  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, credentials: 'include', headers: { Accept: 'application/json', ...init?.headers } })
  } catch {
    if (init?.signal?.aborted) throw init.signal.reason
    throw new Error(apiAccessRequired)
  }

  if (response.status === 401 || response.status === 403) throw new Error(apiAccessRequired)
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined
    throw new Error(typeof message === 'string' ? message : `Request failed with ${response.status}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (response.redirected || response.url.includes('.cloudflareaccess.com')) throw new Error(apiAccessRequired)
    throw new Error('API returned an unexpected response')
  }
  return await response.json() as T
}

export const loadPushPublicKey = async (): Promise<string> => (await request<{ publicKey: string }>('/api/push/public-key')).publicKey

export const savePushSubscription = async (subscription: PushSubscriptionJSON, preferences: PushNotificationPreferences): Promise<PushNotificationPreferences> => {
  const response = await request<{ ok: true; preferences: PushNotificationPreferences }>('/api/push/subscriptions', {
    body: new URLSearchParams({ preferences: JSON.stringify(preferences), subscription: JSON.stringify(subscription) }),
    method: 'POST',
  })
  return response.preferences
}

export const removePushSubscription = async (endpoint: string): Promise<void> => {
  await request<{ ok: true }>('/api/push/subscriptions/remove', {
    body: new URLSearchParams({ endpoint }),
    method: 'POST',
  })
}

export const testPushDelivery = async (endpoint: string): Promise<void> => {
  await request<{ ok: true }>('/api/push/test', {
    body: new URLSearchParams({ endpoint }),
    method: 'POST',
  })
}

const scopedQuery = (accountId?: string): string => accountId ? `&account=${encodeURIComponent(accountId)}` : ''

export const loadDcaActivity = async (asset: string, from: number, accountId?: string): Promise<DcaActivity | null> => {
  const { activity } = await request<{ activity: DcaActivity | null }>(`/api/dca/activity/${encodeURIComponent(asset)}?from=${from}${scopedQuery(accountId)}`)
  return activity
}

export type TradeMarker = { amount: number; executed_at: number; id: string; price: number; side: 'buy' | 'sell' }

export const loadAssetTrades = async (asset: string, from: number, accountId?: string): Promise<TradeMarker[]> =>
  (await request<{ trades: TradeMarker[] }>(`/api/history/trades/${encodeURIComponent(asset)}?from=${from}${scopedQuery(accountId)}`)).trades

export type TradeSummarySide = { count: number; firstAt: number; lastAt: number; quantity: number; thb: number }

export type TradeSummary = { asset: string; buys: TradeSummarySide | null; sells: TradeSummarySide | null }

export const loadAssetTradeSummary = async (asset: string, accountId?: string): Promise<TradeSummary> =>
  request<TradeSummary>(`/api/history/trades/${encodeURIComponent(asset)}/summary${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`)

export const loadAccounts = async (): Promise<Account[]> => (await request<{ accounts: Account[] }>('/api/accounts')).accounts

export const loadArchivedAccounts = async (): Promise<Account[]> => (await request<{ accounts: Account[] }>('/api/accounts/archived')).accounts

export const archiveAccount = async (accountId: string): Promise<void> => {
  await request<{ ok: true }>(`/api/accounts/${encodeURIComponent(accountId)}/archive`, { method: 'POST' })
}

export const restoreAccount = async (accountId: string): Promise<void> => {
  await request<{ ok: true }>(`/api/accounts/${encodeURIComponent(accountId)}/restore`, { method: 'POST' })
}

export type SavedCostBasis = {
  account_id: string
  account_label: string
  amount: number
  asset: string
  executed_at: number
  total_cost_thb: number
  transfer_id: string
  updated_at: number
}

export const loadSavedCostBases = async (accountId?: string): Promise<{ overrides: SavedCostBasis[]; truncated: boolean }> => (
  await request<{ overrides: SavedCostBasis[]; truncated: boolean }>(`/api/cost-basis-overrides${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`)
)

export const removeCryptoTransferCostBasis = async (transferId: string): Promise<void> => {
  await request<{ ok: true }>(`/api/cost-basis-overrides/${encodeURIComponent(transferId)}`, { method: 'DELETE' })
}

export const saveCryptoTransferCostBasis = async (transferId: string, totalCostThb: number): Promise<void> => {
  await request<{ costBasis: { totalCostThb: number; transferId: string; updatedAt: number } }>(`/api/cost-basis-overrides/${encodeURIComponent(transferId)}`, {
    body: JSON.stringify({ totalCostThb }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
}

export const loadDashboard = async (accountId?: string, costMethod: CostMethod = 'average'): Promise<Dashboard> => {
  const scope = scopedQuery(accountId)
  const portfolioQuery = [scope.slice(1), costMethod === 'lots' ? 'costMethod=lots' : ''].filter(Boolean).join('&')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  const options = { signal: controller.signal }
  try {
    const [portfolio, transactions, history, syncStatus, watchlist, priceAlerts, targets] = await Promise.all([
      request<Portfolio>(`/api/portfolio?${portfolioQuery}`, options),
      request<{ nextCursor: string | null; transactions: Transaction[] }>(`/api/transactions?limit=100${scope}`, options),
      request<{ points: ValueHistoryPoint[] }>(`/api/history/value?days=30${scope}`, options),
      request<{ statuses: SyncStatus[] }>(`/api/sync-status?${scope.slice(1)}`, options),
      request<{ assets: WatchlistAsset[] }>('/api/watchlist', options),
      request<{ alerts: PriceAlert[] }>('/api/price-alerts', options),
      request<{ targets: AllocationTarget[] }>('/api/allocation-targets', options),
    ])
    return {
      history: history.points,
      nextTransactionCursor: transactions.nextCursor,
      priceAlerts: priceAlerts.alerts,
      portfolio,
      syncStatus: syncStatus.statuses,
      targets: targets.targets,
      transactions: transactions.transactions,
      watchlist: watchlist.assets,
    }
  } finally {
    window.clearTimeout(timeout)
  }
}

export const loadValueHistory = async ({ accountId, assets, costMethod, days, from, to }: { accountId?: string | undefined; assets?: readonly string[]; costMethod?: CostMethod; days?: number; from?: number; to?: number }): Promise<ValueHistoryPoint[]> => {
  const query = new URLSearchParams()
  if (days !== undefined) query.set('days', String(days))
  if (from !== undefined) query.set('from', String(from))
  if (to !== undefined) query.set('to', String(to))
  if (accountId) query.set('account', accountId)
  if (assets && assets.length > 0) {
    query.set('assets', [...new Set(assets)].join(','))
    if (costMethod === 'lots') query.set('costMethod', 'lots')
  }
  const history = await request<{ points: ValueHistoryPoint[] }>(`/api/history/value?${query.toString()}`)
  return history.points
}

export const loadSyncEvents = async (limit = 100, accountId?: string): Promise<SyncEvent[]> => (
  (await request<{ events: SyncEvent[] }>(`/api/sync-events?limit=${Math.min(Math.max(Math.trunc(limit), 1), 100)}${scopedQuery(accountId)}`)).events
)

export const loadAssetPriceHistory = async (asset: string, options: AssetPriceHistoryOptions): Promise<PriceHistoryPoint[]> => {
  const { accountId, averageCost, costMethod, days, from } = options
  const query = new URLSearchParams()
  if (accountId) query.set('account', accountId)
  if (averageCost) {
    query.set('averageCost', '1')
    if (costMethod === 'lots') query.set('costMethod', 'lots')
  }
  if (days !== undefined) query.set('days', String(days))
  if (from !== undefined) query.set('from', String(from))
  const history = await request<{ points: PriceHistoryPoint[] }>(`/api/history/price/${encodeURIComponent(asset)}?${query.toString()}`)
  return history.points
}

export const loadAssetPriceHistories = async (assets: string[], days: number): Promise<Record<string, PriceHistoryPoint[]>> => {
  if (assets.length === 0) return {}
  const history = await request<{ series: Record<string, PriceHistoryPoint[]> }>(`/api/history/prices?assets=${encodeURIComponent(assets.join(','))}&days=${days}`)
  return history.series
}

export const loadTransactions = async (cursor: string, accountId?: string): Promise<{ nextCursor: string | null; transactions: Transaction[] }> => (
  await request<{ nextCursor: string | null; transactions: Transaction[] }>(`/api/transactions?limit=100&cursor=${encodeURIComponent(cursor)}${scopedQuery(accountId)}`)
)

export const loadBackup = async ({ accountId, days = 365 }: { accountId?: string | undefined; days?: number } = {}): Promise<Record<string, unknown>> => (
  await request<Record<string, unknown>>(`/api/backup?days=${days}${scopedQuery(accountId)}`)
)

export const addWatchlistAsset = async (asset: string): Promise<{ asset: string; created: boolean }> => (
  await request<{ asset: string; created: boolean }>('/api/watchlist', { body: new URLSearchParams({ asset }), method: 'POST' })
)

export const removeWatchlistAsset = async (asset: string): Promise<void> => {
  await request<{ ok: true }>(`/api/watchlist/${encodeURIComponent(asset)}/remove`, { method: 'POST' })
}

export const addPriceAlert = async (asset: string, direction: 'above' | 'below', targetPrice: number): Promise<PriceAlert> => (
  await request<{ alert: PriceAlert }>('/api/price-alerts', { body: new URLSearchParams({ asset, direction, targetPrice: String(targetPrice) }), method: 'POST' })
).alert

export const removePriceAlert = async (id: string): Promise<void> => {
  await request<{ ok: true }>(`/api/price-alerts/${encodeURIComponent(id)}/remove`, { method: 'POST' })
}

export const saveAllocationTarget = async (asset: string, targetPercent: number): Promise<AllocationTarget> => (
  await request<{ target: AllocationTarget }>(`/api/allocation-targets/${encodeURIComponent(asset)}`, { body: new URLSearchParams({ targetPercent: String(targetPercent) }), method: 'POST' })
).target

export const removeAllocationTarget = async (asset: string): Promise<void> => {
  await request<{ ok: true }>(`/api/allocation-targets/${encodeURIComponent(asset)}/remove`, { method: 'POST' })
}
