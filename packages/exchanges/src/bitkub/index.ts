import { asNumber, toMilliseconds } from '@moondi/shared'
import type { ExchangeAdapter, NormalizedBalance, NormalizedFiatTransfer, NormalizedTrade, NormalizedTransfer, PriceQuote } from '@moondi/shared'

const baseUrl = 'https://api.bitkub.com'

type Fetcher = typeof fetch

type BitkubCredentials = {
  apiKey: string
  apiSecret: string
}

type BitkubAdapterOptions = BitkubCredentials & {
  fetcher?: Fetcher
  now?: () => number
}

type BitkubEnvelope<T> = {
  code?: string | number
  error?: number
  message?: string
  result?: T
  data?: T
}

type BitkubErrorPayload = {
  code?: string | number
  message?: string
}

type BitkubBalance = {
  currency: string
  available: string | number
  reserved: string | number
}

type BitkubOrder = {
  txn_id: string
  side: 'buy' | 'sell'
  rate: string | number
  fee: string | number
  credit?: string | number
  amount: string | number
  receive?: string | number
  ts: string | number
}

type BitkubOrderHistoryEnvelope = BitkubEnvelope<BitkubOrder[]> & {
  pagination?: {
    cursor?: string
    has_next?: boolean
  }
}

type BitkubCryptoTransfer = {
  txn_id?: string
  hash: string | null
  symbol: string
  amount: string | number
  fee?: string | number
  created_at: string
  completed_at?: string
}

type BitkubFiatTransfer = {
  txn_id: string
  currency: string
  amount: string | number
  fee?: string | number
  time: string | number
}

type BitkubPage<T> = {
  page: number
  total_page: number
  items: T[]
}

type BitkubSymbol = {
  source?: string
  symbol: string
}

type BitkubTicker = {
  symbol: string
  last?: string | number
}[]

const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('')

const encodeQuery = (query: URLSearchParams): string => {
  const encoded = query.toString()
  return encoded.length === 0 ? '' : `?${encoded}`
}

const dateToMilliseconds = (value: string): number => {
  const timestamp = Date.parse(value)

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Expected an ISO timestamp, received ${value}`)
  }

  return timestamp
}

class BitkubApplicationError extends Error {
  constructor(readonly code: string | number, message: string) {
    super(message)
  }
}

const resolveEnvelope = <T>(payload: BitkubEnvelope<T>, endpoint: string): T => {
  if (payload.error !== undefined && payload.error !== 0) {
    throw new BitkubApplicationError(payload.error, `${endpoint}: Bitkub error ${payload.error}: ${payload.message ?? 'Unknown error'}`)
  }

  if (payload.code !== undefined && String(payload.code) !== '0') {
    throw new BitkubApplicationError(payload.code, `${endpoint}: Bitkub error ${String(payload.code)}: ${payload.message ?? 'Unknown error'}`)
  }

  const value = payload.data ?? payload.result

  if (value === undefined) {
    throw new Error('Bitkub response did not contain data')
  }

  return value
}

const isEnvelope = (payload: unknown): payload is BitkubEnvelope<unknown> =>
  typeof payload === 'object'
  && payload !== null
  && ('code' in payload || 'data' in payload || 'error' in payload || 'result' in payload)

class BitkubRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const requestError = async (response: Response): Promise<never> => {
  const payload = await response.json().catch(() => undefined) as BitkubErrorPayload | undefined
  const details = [payload?.code, payload?.message].filter((value): value is string | number => value !== undefined && value !== '').join(': ')
  throw new BitkubRequestError(response.status, `Bitkub request failed: ${response.status}${details ? ` (${details})` : ''}`)
}

export const createBitkubSigner = (apiSecret: string) => async (input: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(apiSecret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input))
  return toHex(signature)
}

export const mapBitkubBalances = (balances: BitkubBalance[]): NormalizedBalance[] =>
  balances.map((balance) => ({
    asset: balance.currency,
    available: asNumber(balance.available),
    reserved: asNumber(balance.reserved),
  }))

export const mapBitkubOrder = (order: BitkubOrder, quoteAsset: string, raw: unknown): NormalizedTrade => {
  const [baseAsset] = quoteAsset.split('_')

  if (!baseAsset) {
    throw new Error(`Invalid Bitkub symbol: ${quoteAsset}`)
  }

  const price = asNumber(order.rate)
  const fee = asNumber(order.fee)
  const creditedFee = asNumber(order.credit ?? 0)
  const quoteAmount = asNumber(order.amount)
  const baseAmount = order.side === 'buy'
    ? order.receive === undefined
      ? (quoteAmount - Math.max(fee - creditedFee, 0)) / price
      : asNumber(order.receive)
    : quoteAmount

  if (!Number.isFinite(baseAmount) || baseAmount < 0 || price <= 0) {
    throw new Error(`Invalid Bitkub order quantities for ${order.txn_id}`)
  }

  return {
    id: order.txn_id,
    side: order.side,
    baseAsset,
    quoteAsset: quoteAsset.split('_')[1] ?? 'THB',
    price,
    amount: baseAmount,
    fee,
    feeAsset: 'THB',
    executedAt: toMilliseconds(order.ts),
    raw,
  }
}

export const mapBitkubTransfer = (
  transfer: BitkubCryptoTransfer,
  direction: 'deposit' | 'withdraw',
  raw: unknown,
): NormalizedTransfer => ({
  id: transfer.txn_id ?? `${direction}:${transfer.symbol}:${transfer.hash ?? transfer.created_at}`,
  direction,
  asset: transfer.symbol,
  amount: asNumber(transfer.amount),
  fee: asNumber(transfer.fee ?? 0),
  ...(transfer.hash === null ? {} : { txHash: transfer.hash }),
  executedAt: dateToMilliseconds(transfer.completed_at ?? transfer.created_at),
  raw,
})

export const mapBitkubFiatTransfers = (
  transfers: BitkubFiatTransfer[],
  direction: 'deposit' | 'withdraw',
): NormalizedFiatTransfer[] =>
  transfers.map((transfer) => ({
    id: transfer.txn_id,
    direction,
    currency: transfer.currency,
    amount: asNumber(transfer.amount),
    fee: asNumber(transfer.fee ?? 0),
    executedAt: toMilliseconds(transfer.time),
    raw: transfer,
  }))

export class BitkubAdapter implements ExchangeAdapter {
  readonly id = 'bitkub' as const
  private readonly fetcher: Fetcher
  private readonly now: () => number
  private readonly sign: (input: string) => Promise<string>
  private readonly apiKey: string

  constructor(options: BitkubAdapterOptions) {
    const suppliedFetcher = options.fetcher
    this.fetcher = suppliedFetcher
      ? (input, init) => suppliedFetcher(input, init)
      : (input, init) => globalThis.fetch(input, init)
    this.now = options.now ?? Date.now
    this.sign = createBitkubSigner(options.apiSecret)
    this.apiKey = options.apiKey
  }

  async fetchBalances(): Promise<NormalizedBalance[]> {
    const payload = await this.secureGet<BitkubBalance[]>('/api/v4/wallet/balances')
    if (payload.length === 0) throw new Error('Bitkub wallet returned no balance rows')
    return mapBitkubBalances(payload)
  }

  async fetchTrades(sinceTimestamp?: number, assets?: string[]): Promise<NormalizedTrade[]> {
    const symbols = await this.publicGet<BitkubSymbol[]>('/api/v3/market/symbols')
    const requestedAssets = assets === undefined ? undefined : new Set(assets.map((asset) => asset.toUpperCase()).filter((asset) => asset !== 'THB'))
    const tradableSymbols = symbols
      .filter((symbol) => symbol.source !== 'broker' && symbol.symbol.endsWith('_THB'))
      .filter((symbol) => requestedAssets === undefined || requestedAssets.has(symbol.symbol.split('_')[0] ?? ''))
      .map((symbol) => symbol.symbol)
    const trades: NormalizedTrade[] = []
    let unavailableSymbolCount = 0

    for (let index = 0; index < tradableSymbols.length; index += 3) {
      const batch = tradableSymbols.slice(index, index + 3)
      const results = await Promise.all(batch.map(async (symbol) => {
        try {
          return await this.fetchOrdersForSymbol(symbol, sinceTimestamp)
        } catch (error) {
          if (!(error instanceof BitkubApplicationError) || String(error.code) !== '81') throw error
          unavailableSymbolCount += 1
          return []
        }
      }))
      trades.push(...results.flat())
    }

    if (unavailableSymbolCount > 0) {
      console.warn(JSON.stringify({ message: 'Bitkub order history unavailable for symbols', unavailableSymbolCount }))
    }

    return trades
  }

  async fetchDeposits(sinceTimestamp?: number): Promise<NormalizedTransfer[]> {
    const records = await this.fetchCryptoTransfers('/api/v4/crypto/deposits', sinceTimestamp)
    return records.map((record) => mapBitkubTransfer(record, 'deposit', record))
  }

  async fetchWithdrawals(sinceTimestamp?: number): Promise<NormalizedTransfer[]> {
    const records = await this.fetchCryptoTransfers('/api/v4/crypto/withdraws', sinceTimestamp)
    return records.map((record) => mapBitkubTransfer(record, 'withdraw', record))
  }

  async fetchFiatDeposits(_sinceTimestamp?: number): Promise<NormalizedFiatTransfer[]> {
    const records = await this.fetchFiatTransfers('/api/v4/fiat/deposit/history')
    return mapBitkubFiatTransfers(records, 'deposit')
  }

  async fetchFiatWithdrawals(_sinceTimestamp?: number): Promise<NormalizedFiatTransfer[]> {
    const records = await this.fetchFiatTransfers('/api/v4/fiat/withdraw/history')
    return mapBitkubFiatTransfers(records, 'withdraw')
  }

  async fetchPrices(): Promise<PriceQuote[]> {
    const payload = await this.publicGet<BitkubTicker>('/api/v3/market/ticker')
    const updatedAt = this.now()

    return payload.flatMap((ticker) => {
      const symbol = ticker.symbol
      const [base, quote] = symbol.split('_')
      if (!base || !quote || ticker.last === undefined) {
        return []
      }

      return [{ asset: base.toUpperCase(), quote: quote.toUpperCase(), price: asNumber(ticker.last), updatedAt }]
    })
  }

  private async fetchOrdersForSymbol(symbol: string, sinceTimestamp?: number): Promise<NormalizedTrade[]> {
    return this.fetchOrdersForPair(symbol, sinceTimestamp)
  }

  private async fetchOrdersForPair(symbol: string, sinceTimestamp?: number): Promise<NormalizedTrade[]> {
    const orders: NormalizedTrade[] = []
    let cursor = 'e30='

    while (true) {
      const query = new URLSearchParams({ cursor, lmt: '100', pagination_type: 'keyset', sym: symbol })
      if (sinceTimestamp) query.set('start', String(sinceTimestamp))

      const response = await this.secureGetRaw<BitkubOrder[]>('/api/v3/market/my-order-history', query) as BitkubOrderHistoryEnvelope
      const ordersPage = resolveEnvelope(response, `/api/v3/market/my-order-history${encodeQuery(query)}`)
      orders.push(...ordersPage.map((order) => mapBitkubOrder(order, symbol, order)))
      const nextCursor = response.pagination?.cursor
      if (response.pagination?.has_next !== true || !nextCursor || nextCursor === cursor) break
      cursor = nextCursor
    }

    return orders
  }

  private async fetchCryptoTransfers(path: string, sinceTimestamp?: number): Promise<BitkubCryptoTransfer[]> {
    const records: BitkubCryptoTransfer[] = []
    let page = 1
    let totalPage = 1

    while (page <= totalPage) {
      const query = new URLSearchParams({ limit: '200', page: String(page) })
      if (sinceTimestamp) query.set('created_start', new Date(sinceTimestamp).toISOString())
      const result = await this.secureGet<BitkubPage<BitkubCryptoTransfer>>(path, query)
      records.push(...result.items)
      totalPage = result.total_page
      page += 1
    }

    return records
  }

  private async fetchFiatTransfers(path: string): Promise<BitkubFiatTransfer[]> {
    const records: BitkubFiatTransfer[] = []
    let page = 1

    while (true) {
      const query = new URLSearchParams({ limit: '100', page: String(page) })
      const response = await this.secureGetRaw<BitkubFiatTransfer[]>(path, query)
      const result = resolveEnvelope(response, `${path}${encodeQuery(query)}`)
      records.push(...result)
      if (result.length < 100) break
      page += 1
    }

    return records
  }

  private async publicGet<T>(path: string, query = new URLSearchParams()): Promise<T> {
    const response = await this.fetcher(`${baseUrl}${path}${encodeQuery(query)}`)
    if (!response.ok) await requestError(response)
    const payload = await response.json() as unknown
    return isEnvelope(payload)
      ? resolveEnvelope(payload as BitkubEnvelope<T>, `${path}${encodeQuery(query)}`)
      : payload as T
  }

  private async secureGet<T>(path: string, query = new URLSearchParams()): Promise<T> {
    return resolveEnvelope(await this.secureGetRaw<T>(path, query), `${path}${encodeQuery(query)}`)
  }

  private async secureGetRaw<T>(path: string, query = new URLSearchParams()): Promise<BitkubEnvelope<T>> {
    const timestamp = await this.fetchServerTime()
    const requestPath = `${path}${encodeQuery(query)}`
    const signature = await this.sign(`${timestamp}GET${requestPath}`)
    const response = await this.fetcher(`${baseUrl}${requestPath}`, {
      // A signed request must always reach Bitkub. Serving a cached response
      // would decouple it from the one-time server timestamp in its signature.
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-BTK-APIKEY': this.apiKey,
        'X-BTK-SIGN': signature,
        'X-BTK-TIMESTAMP': String(timestamp),
      },
    })

    if (!response.ok) await requestError(response)
    return await response.json() as BitkubEnvelope<T>
  }

  private async fetchServerTime(): Promise<number> {
    // Bitkub requires a newly obtained millisecond timestamp for every signed
    // request. Workers subrequests may otherwise interact with Cloudflare cache.
    const response = await this.fetcher(`${baseUrl}/api/v3/servertime`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Bitkub server-time request failed: ${response.status}`)

    const timestamp = Number(await response.json())
    if (!Number.isFinite(timestamp)) throw new Error('Bitkub server-time response was invalid')
    return timestamp
  }
}
