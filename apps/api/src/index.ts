import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createFactory } from 'hono/factory'
import { portfolioValueAt, type PriceQuote } from '@moondi/shared'
import { createAwsBitkubRoutes } from './aws-bitkub-routes'

type HonoEnv = {
  Bindings: Env
}

type AccountRow = {
  id: string
  exchange: string
  label: string
  created_at: number
}

type HoldingRow = {
  account_id: string
  account_label: string
  asset: string
  available: number
  reserved: number
  price: number
  updated_at: number | null
}

type TransactionRow = {
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

type ValueHistoryRow = {
  snapshot_at: number
  total_value: number
}

type PriceHistoryRow = {
  snapshot_at: number
  price: number
}

type AssetPriceHistoryRow = PriceHistoryRow & {
  asset: string
}

type SyncStatusRow = {
  account_id: string
  account_label: string
  data_type: 'balances' | 'trades' | 'crypto_transfers' | 'fiat_transfers' | 'prices'
  status: 'success' | 'deferred' | 'failure' | 'pending'
  detail: string | null
  occurred_at: number | null
}

type SyncEventRow = Omit<SyncStatusRow, 'occurred_at' | 'status'> & {
  id: number
  occurred_at: number
  status: 'success' | 'deferred' | 'failure'
}

type PushSubscriptionInput = {
  endpoint: string
  keys: {
    auth: string
    p256dh: string
  }
}

type StoredPushSubscription = {
  auth: string
  endpoint: string
  p256dh: string
}

type PushNotificationPreferences = {
  cryptoTransfers: boolean
  fiatTransfers: boolean
  priceAlerts: boolean
  syncIssues: boolean
  trades: boolean
}

type PushPreferencesRow = {
  notify_crypto_transfers: number
  notify_fiat_transfers: number
  notify_price_alerts: number
  notify_sync_issues: number
  notify_trades: number
}

type WatchlistRow = {
  asset: string
  created_at: number
  price: number | null
  updated_at: number | null
}

type PriceAlertRow = {
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

type AllocationTargetRow = {
  asset: string
  target_percent: number
  updated_at: number
}

type AwsBalanceIngestion = {
  accountId: string
  balances: Array<{
    asset: string
    available: number
    reserved: number
  }>
  snapshotAt: number
}

type AwsHistoryDataType = 'trades' | 'crypto_transfers' | 'fiat_transfers'

type AwsHistoryIngestion = {
  accountId: string
  complete: boolean
  dataType: AwsHistoryDataType
  records: Array<Record<string, unknown>>
  syncAt: number
}

type AwsAuthenticatedIngestion = {
  body: string
  nonce: string
  timestamp: number
}

type PriceCacheRow = {
  asset: string
  price: number
  updated_at: number
}

const portfolioHistoryPriceToleranceMs = 35 * 60 * 1_000
const valueHistoryCacheSeconds = 5 * 60
const priceHistoryCacheSeconds = 5 * 60

const defaultPushNotificationPreferences: PushNotificationPreferences = {
  cryptoTransfers: true,
  fiatTransfers: true,
  priceAlerts: false,
  syncIssues: true,
  trades: true,
}

const factory = createFactory<HonoEnv>()

const readString = (env: unknown, name: string): string | undefined => {
  if (typeof env !== 'object' || env === null) return undefined
  const value = Reflect.get(env, name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const normalizeLimit = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50
}

const normalizeDays = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 365 * 5 + 2) : 30
}

const normalizeTimestamp = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const decodeCursor = (value: string | undefined): { executedAt: number; id: string } | undefined => {
  if (!value) return undefined

  try {
    const parsed: unknown = JSON.parse(atob(value))
    const executedAt = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'executedAt') : undefined
    const id = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'id') : undefined
    if (
      typeof executedAt === 'number'
      && Number.isFinite(executedAt)
      && typeof id === 'string'
      && id.length > 0
      && id.length <= 500
    ) {
      return { executedAt, id }
    }
  } catch {
    return undefined
  }

  return undefined
}

const encodeCursor = (transaction: TransactionRow): string => btoa(JSON.stringify({ executedAt: transaction.executed_at, id: transaction.id }))

const getAccounts = async (db: D1Database): Promise<AccountRow[]> => {
  const result = await db.prepare('SELECT id, exchange, label, created_at FROM accounts WHERE archived_at IS NULL ORDER BY label').all<AccountRow>()
  return result.results
}

const getArchivedAccounts = async (db: D1Database): Promise<AccountRow[]> => {
  const result = await db.prepare('SELECT id, exchange, label, created_at FROM accounts WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, label').all<AccountRow>()
  return result.results
}

const getHoldings = async (db: D1Database, accountId?: string): Promise<HoldingRow[]> => {
  const query = `
    SELECT
      balances.account_id,
      accounts.label AS account_label,
      balances.asset,
      balances.available,
      balances.reserved,
      COALESCE(prices.price, CASE balances.asset WHEN 'THB' THEN 1 ELSE 0 END) AS price,
      balances.snapshot_at AS updated_at
    FROM accounts
    CROSS JOIN balance_snapshots AS balances
      ON balances.account_id = accounts.id
      AND balances.snapshot_at = (
        SELECT MAX(candidate.snapshot_at)
        FROM balance_snapshots AS candidate
        WHERE candidate.account_id = accounts.id
      )
    LEFT JOIN price_cache AS prices ON prices.asset = balances.asset AND prices.quote = 'THB'
    WHERE accounts.archived_at IS NULL ${accountId ? 'AND accounts.id = ?1' : ''}
    ORDER BY account_label, balances.asset
  `
  const statement = accountId ? db.prepare(query).bind(accountId) : db.prepare(query)
  const result = await statement.all<HoldingRow>()
  return result.results
}

const getValueHistory = async (db: D1Database, from: number, to: number, accountId?: string): Promise<ValueHistoryRow[]> => {
  const query = `
    WITH scoped_accounts AS (
      SELECT id, created_at
      FROM accounts
      WHERE archived_at IS NULL ${accountId ? 'AND id = ?3' : ''}
    ),
    interval_portfolio_values AS (
      SELECT
        values_by_account.interval,
        MAX(values_by_account.snapshot_at) AS snapshot_at,
        SUM(values_by_account.total_value) AS total_value,
        COUNT(*) AS account_count
      FROM portfolio_value_snapshots AS values_by_account
      JOIN scoped_accounts ON scoped_accounts.id = values_by_account.account_id
      WHERE values_by_account.snapshot_at >= ?1 AND values_by_account.snapshot_at <= ?2
      GROUP BY values_by_account.interval
    )
    SELECT snapshot_at, total_value
    FROM interval_portfolio_values AS portfolio
    WHERE account_count = (
      SELECT COUNT(*) FROM scoped_accounts
      WHERE created_at <= portfolio.snapshot_at
    )
    ORDER BY snapshot_at
  `
  const result = await (accountId ? db.prepare(query).bind(from, to, accountId) : db.prepare(query).bind(from, to)).all<ValueHistoryRow>()
  return result.results
}

const valueHistoryCacheKey = (from: number, to: number, accountId?: string): string => (
  `value-history:v3:${accountId ?? 'all'}:${from}:${to}`
)

const getCachedValueHistory = async (env: Env, from: number, to: number, accountId?: string): Promise<ValueHistoryRow[]> => {
  const key = valueHistoryCacheKey(from, to, accountId)
  if (typeof env.CACHE.get === 'function') {
    const cached = await env.CACHE.get<ValueHistoryRow[]>(key, 'json')
    if (Array.isArray(cached)) return cached
  }

  const points = await getValueHistory(env.DB, from, to, accountId)
  if (typeof env.CACHE.put === 'function') {
    await env.CACHE.put(key, JSON.stringify(points), { expirationTtl: valueHistoryCacheSeconds })
  }
  return points
}

const priceHistoryInterval = (from: number, to: number): number => {
  const range = to - from
  return range <= 30 * 24 * 60 * 60 * 1_000
    ? 30 * 60 * 1_000
    : range <= 366 * 24 * 60 * 60 * 1_000
      ? 6 * 60 * 60 * 1_000
      : 24 * 60 * 60 * 1_000
}

const getPriceHistories = async (db: D1Database, assets: string[], from: number, to: number): Promise<Record<string, PriceHistoryRow[]>> => {
  const interval = priceHistoryInterval(from, to)
  const placeholders = assets.map(() => '?').join(', ')
  const recentRange = interval === 30 * 60 * 1_000
  const query = recentRange
    ? `
      SELECT asset, snapshot_at, price
      FROM price_snapshots
      WHERE asset IN (${placeholders}) AND quote = 'THB' AND snapshot_at >= ? AND snapshot_at <= ?
      ORDER BY asset, snapshot_at
    `
    : `
      SELECT asset, snapshot_at, price
      FROM (
        SELECT
          asset,
          snapshot_at,
          price,
          ROW_NUMBER() OVER (
            PARTITION BY asset, snapshot_at / ?
            ORDER BY snapshot_at DESC
          ) AS sample_rank
        FROM price_snapshots
        WHERE asset IN (${placeholders}) AND quote = 'THB' AND snapshot_at >= ? AND snapshot_at <= ?
      )
      WHERE sample_rank = 1
      ORDER BY asset, snapshot_at
    `
  const bindings = recentRange ? [...assets, from, to] : [interval, ...assets, from, to]
  const result = await db.prepare(query).bind(...bindings).all<AssetPriceHistoryRow>()
  return result.results.reduce<Record<string, PriceHistoryRow[]>>((histories, point) => {
    const points = histories[point.asset] ?? []
    points.push({ price: point.price, snapshot_at: point.snapshot_at })
    histories[point.asset] = points
    return histories
  }, {})
}

const sha256Hex = async (value: string): Promise<string> => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('')

const priceHistoryCacheKey = async (assets: string[], from: number, to: number): Promise<string> => {
  const digest = await sha256Hex(`${[...assets].sort().join(',')}:${from}:${to}`)
  return `price-history:v3:${digest}:${priceHistoryInterval(from, to)}`
}

const getCachedPriceHistories = async (env: Env, assets: string[], from: number, to: number): Promise<Record<string, PriceHistoryRow[]>> => {
  const key = await priceHistoryCacheKey(assets, from, to)
  if (typeof env.CACHE.get === 'function') {
    const cached = await env.CACHE.get<Record<string, PriceHistoryRow[]>>(key, 'json')
    if (cached && typeof cached === 'object') return cached
  }

  const histories = await getPriceHistories(env.DB, assets, from, to)
  if (typeof env.CACHE.put === 'function') {
    await env.CACHE.put(key, JSON.stringify(histories), { expirationTtl: priceHistoryCacheSeconds })
  }
  return histories
}

const historyBounds = (fromQuery: string | undefined, toQuery: string | undefined, daysQuery: string | undefined): { from: number; to: number } => {
  const currentIntervalEnd = Math.floor(Date.now() / 1_800_000) * 1_800_000 + 1_800_000 - 1
  const defaultFrom = currentIntervalEnd - normalizeDays(daysQuery) * 24 * 60 * 60 * 1_000 + 1
  const from = normalizeTimestamp(fromQuery) ?? defaultFrom
  const rawTo = normalizeTimestamp(toQuery)
  const dateOnly = typeof toQuery === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toQuery)
  const to = rawTo === undefined ? currentIntervalEnd : rawTo + (dateOnly ? 24 * 60 * 60 * 1_000 - 1 : 0)

  return from <= to ? { from, to } : { from: to, to: from }
}

const normalizeAsset = (value: string): string | undefined => {
  const asset = value.trim().toUpperCase()
  return /^[A-Z0-9_-]{1,20}$/.test(asset) ? asset : undefined
}

const awsIngestionMaxAgeMs = 5 * 60 * 1_000
const awsIngestionMaxBodyBytes = 512 * 1_024
const awsIngestionMaxHistoryRecords = 250
const maxAssetsPerQuery = 96

const verifyAwsIngestion = async (secret: string, timestamp: string, nonce: string, body: string, signature: string): Promise<boolean> => {
  const signatureBytes = Uint8Array.from(signature.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(`${timestamp}\n${nonce}\n${body}`))
}

const readBoundedBody = async (request: Request, maxBytes: number): Promise<{ body?: string; tooLarge: boolean }> => {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > maxBytes) return { tooLarge: true }
  if (!request.body) return { body: '', tooLarge: false }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return { tooLarge: true }
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { body: new TextDecoder('utf-8', { fatal: true }).decode(bytes), tooLarge: false }
  } catch {
    return { tooLarge: false }
  }
}

const parseAwsBalanceIngestion = (value: unknown): AwsBalanceIngestion | undefined => {
  if (typeof value !== 'object' || value === null) return undefined

  const accountId = Reflect.get(value, 'accountId')
  const snapshotAt = Reflect.get(value, 'snapshotAt')
  const balances = Reflect.get(value, 'balances')
  if (
    typeof accountId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
    || !Number.isSafeInteger(snapshotAt)
    || !Array.isArray(balances)
    || balances.length === 0
    || balances.length > 250
  ) return undefined

  const normalizedBalances: AwsBalanceIngestion['balances'] = []
  for (const balance of balances) {
    if (typeof balance !== 'object' || balance === null) return undefined
    const asset = Reflect.get(balance, 'asset')
    const available = Reflect.get(balance, 'available')
    const reserved = Reflect.get(balance, 'reserved')
    if (
      typeof asset !== 'string'
      || normalizeAsset(asset) !== asset
      || typeof available !== 'number'
      || !Number.isFinite(available)
      || available < 0
      || typeof reserved !== 'number'
      || !Number.isFinite(reserved)
      || reserved < 0
    ) return undefined
    normalizedBalances.push({ asset, available, reserved })
  }

  return { accountId, balances: normalizedBalances, snapshotAt }
}

const parseAwsHistoryIngestion = (value: unknown): AwsHistoryIngestion | undefined => {
  if (typeof value !== 'object' || value === null) return undefined

  const accountId = Reflect.get(value, 'accountId')
  const complete = Reflect.get(value, 'complete')
  const dataType = Reflect.get(value, 'dataType')
  const records = Reflect.get(value, 'records')
  const syncAt = Reflect.get(value, 'syncAt')
  if (
    typeof accountId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
    || typeof complete !== 'boolean'
    || (dataType !== 'trades' && dataType !== 'crypto_transfers' && dataType !== 'fiat_transfers')
    || !Array.isArray(records)
    || records.length > awsIngestionMaxHistoryRecords
    || (!complete && records.length === 0)
    || !Number.isSafeInteger(syncAt)
    || syncAt <= 0
  ) return undefined

  const normalizedRecords: Array<Record<string, unknown>> = []
  for (const record of records) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined
    normalizedRecords.push(record as Record<string, unknown>)
  }
  return { accountId, complete, dataType, records: normalizedRecords, syncAt }
}

const authenticatedAwsIngestion = async (c: Context<HonoEnv>): Promise<AwsAuthenticatedIngestion | Response> => {
  const secret = readString(c.env, 'AWS_SYNC_INGESTION_SECRET')
  const timestampHeader = c.req.header('x-moond-ingest-timestamp')
  const nonce = c.req.header('x-moond-ingest-nonce')
  const providedSignature = c.req.header('x-moond-ingest-signature')
  if (!secret || !timestampHeader || !nonce || !providedSignature) return c.json({ error: 'Not found' }, 404)
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'Not found' }, 404)
  if (!/^\d{13}$/.test(timestampHeader) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(providedSignature)) {
    return c.json({ error: 'Not found' }, 404)
  }

  const timestamp = Number(timestampHeader)
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > awsIngestionMaxAgeMs) return c.json({ error: 'Not found' }, 404)

  const boundedBody = await readBoundedBody(c.req.raw, awsIngestionMaxBodyBytes)
  if (boundedBody.tooLarge) return c.json({ error: 'Payload too large' }, 413)
  if (boundedBody.body === undefined) return c.json({ error: 'Invalid ingestion payload' }, 400)
  const body = boundedBody.body
  if (!await verifyAwsIngestion(secret, timestampHeader, nonce, body, providedSignature)) return c.json({ error: 'Not found' }, 404)

  return { body, nonce, timestamp }
}

const claimAwsIngestionNonce = async (db: D1Database, nonce: string, timestamp: number): Promise<boolean> => {
  const now = Date.now()
  await db.prepare('DELETE FROM aws_ingestion_nonces WHERE expires_at < ?').bind(now).run()
  const claim = await db.prepare(`
    INSERT INTO aws_ingestion_nonces (nonce, expires_at) VALUES (?, ?)
    ON CONFLICT(nonce) DO NOTHING
  `).bind(nonce, timestamp + awsIngestionMaxAgeMs).run()
  return (claim.meta.changes ?? 0) === 1
}

const getActiveBitkubAccount = async (db: D1Database, accountId: string): Promise<{ id: string } | null> => (
  db.prepare("SELECT id FROM accounts WHERE id = ? AND exchange = 'bitkub' AND archived_at IS NULL")
    .bind(accountId)
    .first<{ id: string }>()
)

const ingestAwsBalances = async (c: Context<HonoEnv>) => {
  const authenticated = await authenticatedAwsIngestion(c)
  if (authenticated instanceof Response) return authenticated

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(authenticated.body) as unknown
  } catch {
    return c.json({ error: 'Invalid ingestion payload' }, 400)
  }
  const payload = parseAwsBalanceIngestion(parsedBody)
  if (!payload || Math.abs(payload.snapshotAt - authenticated.timestamp) > awsIngestionMaxAgeMs) return c.json({ error: 'Invalid ingestion payload' }, 400)

  const account = await getActiveBitkubAccount(c.env.DB, payload.accountId)
  if (!account) return c.json({ error: 'Not found' }, 404)
  if (!await claimAwsIngestionNonce(c.env.DB, authenticated.nonce, authenticated.timestamp)) return c.json({ error: 'Replay rejected' }, 409)

  const pricedAssets = [...new Set(payload.balances
    .filter((balance) => balance.asset !== 'THB' && balance.available + balance.reserved > 0)
    .map((balance) => balance.asset))]
  const priceRows: PriceCacheRow[] = []
  for (let offset = 0; offset < pricedAssets.length; offset += maxAssetsPerQuery) {
    const assets = pricedAssets.slice(offset, offset + maxAssetsPerQuery)
    const result = await c.env.DB.prepare(`
      SELECT asset, price, updated_at
      FROM price_cache
      WHERE quote = 'THB' AND asset IN (${assets.map(() => '?').join(', ')})
    `).bind(...assets).all<PriceCacheRow>()
    priceRows.push(...result.results)
  }
  const totalValue = portfolioValueAt(
    payload.balances,
    priceRows.map<PriceQuote>((price) => ({ asset: price.asset, price: price.price, quote: 'THB', updatedAt: price.updated_at })),
    payload.snapshotAt,
    portfolioHistoryPriceToleranceMs,
  )

  await c.env.DB.batch([
    ...payload.balances.map((balance) => c.env.DB.prepare(
      'INSERT INTO balance_snapshots (account_id, asset, available, reserved, snapshot_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(payload.accountId, balance.asset, balance.available, balance.reserved, payload.snapshotAt)),
    c.env.DB.prepare('INSERT INTO sync_events (account_id, data_type, status, detail, occurred_at) VALUES (?, ?, ?, ?, ?)')
      .bind(payload.accountId, 'balances', 'success', 'AWS Bitkub ingestion', payload.snapshotAt),
    ...(totalValue === undefined ? [] : [c.env.DB.prepare(`
      INSERT INTO portfolio_value_snapshots (account_id, interval, snapshot_at, total_value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, interval) DO UPDATE SET
        snapshot_at = excluded.snapshot_at,
        total_value = excluded.total_value
    `).bind(payload.accountId, Math.floor(payload.snapshotAt / 1_800_000), payload.snapshotAt, totalValue)]),
  ])

  return c.json({ ingested: true, snapshotAt: payload.snapshotAt })
}

const awsHistoryRecordId = (accountId: string, externalId: string): string => `${accountId.length}:${accountId}:${externalId}`

const requiredHistoryId = (record: Record<string, unknown>): string | undefined => {
  const id = record.id
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(id) ? id : undefined
}

const isNonNegativeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

const isPositiveTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const insertAwsHistoryRecord = (db: D1Database, accountId: string, dataType: AwsHistoryDataType, record: Record<string, unknown>): D1PreparedStatement | undefined => {
  const externalId = requiredHistoryId(record)
  const executedAt = record.executedAt
  if (!externalId || !isPositiveTimestamp(executedAt)) return undefined
  const storedRawJson = '{}'

  if (dataType === 'trades') {
    const side = record.side
    const baseAsset = record.baseAsset
    const quoteAsset = record.quoteAsset
    const price = record.price
    const quoteAmount = record.quoteAmount
    const amount = record.amount
    const fee = record.fee
    const feeAsset = record.feeAsset
    if (
      (side !== 'buy' && side !== 'sell')
      || typeof baseAsset !== 'string' || normalizeAsset(baseAsset) !== baseAsset
      || typeof quoteAsset !== 'string' || normalizeAsset(quoteAsset) !== quoteAsset
      || typeof price !== 'number' || !Number.isFinite(price) || price <= 0
      || (quoteAmount !== undefined && (!isNonNegativeNumber(quoteAmount) || quoteAmount === 0))
      || !isNonNegativeNumber(amount) || !isNonNegativeNumber(fee)
      || (feeAsset !== undefined && (typeof feeAsset !== 'string' || normalizeAsset(feeAsset) !== feeAsset))
    ) return undefined
    return db.prepare(`
      INSERT INTO trades (id, account_id, external_id, side, base_asset, quote_asset, price, amount, quote_amount, fee, fee_asset, executed_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO UPDATE SET
        quote_amount = COALESCE(excluded.quote_amount, trades.quote_amount)
      WHERE trades.quote_amount IS NULL AND excluded.quote_amount IS NOT NULL
    `).bind(awsHistoryRecordId(accountId, externalId), accountId, externalId, side, baseAsset, quoteAsset, price, amount, quoteAmount ?? null, fee, feeAsset ?? null, executedAt, storedRawJson)
  }

  const direction = record.direction
  const asset = dataType === 'fiat_transfers' ? record.currency : record.asset
  const amount = record.amount
  const fee = record.fee
  if (
    (direction !== 'deposit' && direction !== 'withdraw')
    || typeof asset !== 'string' || normalizeAsset(asset) !== asset
    || !isNonNegativeNumber(amount) || !isNonNegativeNumber(fee)
  ) return undefined

  if (dataType === 'crypto_transfers') {
    const txHash = record.txHash
    if (txHash !== undefined && (typeof txHash !== 'string' || txHash.length > 512 || !/^[\x20-\x7E]+$/.test(txHash))) return undefined
    return db.prepare(`
      INSERT INTO crypto_transfers (id, account_id, external_id, direction, asset, amount, fee, tx_hash, executed_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, external_id) DO NOTHING
    `).bind(awsHistoryRecordId(accountId, externalId), accountId, externalId, direction, asset, amount, fee, txHash ?? null, executedAt, storedRawJson)
  }

  return db.prepare(`
    INSERT INTO fiat_transfers (id, account_id, external_id, direction, currency, amount, fee, executed_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, external_id) DO NOTHING
  `).bind(awsHistoryRecordId(accountId, externalId), accountId, externalId, direction, asset, amount, fee, executedAt, storedRawJson)
}

const getAwsSyncState = async (c: Context<HonoEnv>) => {
  const authenticated = await authenticatedAwsIngestion(c)
  if (authenticated instanceof Response) return authenticated
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(authenticated.body) as unknown
  } catch {
    return c.json({ error: 'Invalid ingestion payload' }, 400)
  }
  const accountId = typeof parsedBody === 'object' && parsedBody !== null ? Reflect.get(parsedBody, 'accountId') : undefined
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) return c.json({ error: 'Invalid ingestion payload' }, 400)
  if (!await getActiveBitkubAccount(c.env.DB, accountId)) return c.json({ error: 'Not found' }, 404)
  if (!await claimAwsIngestionNonce(c.env.DB, authenticated.nonce, authenticated.timestamp)) return c.json({ error: 'Replay rejected' }, 409)

  const checkpoints = await c.env.DB.prepare(
    `SELECT data_type, last_synced_at FROM sync_state WHERE account_id = ? AND data_type IN ('trades', 'crypto_transfers', 'fiat_transfers')`,
  ).bind(accountId).all<{ data_type: AwsHistoryDataType, last_synced_at: number }>()
  const byType = new Map(checkpoints.results.map((row) => [row.data_type, row.last_synced_at]))
  return c.json({
    cryptoTransfersSince: byType.get('crypto_transfers') ?? null,
    fiatTransfersSince: byType.get('fiat_transfers') ?? null,
    tradesSince: byType.get('trades') ?? null,
  })
}

const ingestAwsHistory = async (c: Context<HonoEnv>) => {
  const authenticated = await authenticatedAwsIngestion(c)
  if (authenticated instanceof Response) return authenticated
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(authenticated.body) as unknown
  } catch {
    return c.json({ error: 'Invalid ingestion payload' }, 400)
  }
  const payload = parseAwsHistoryIngestion(parsedBody)
  if (!payload || payload.syncAt > authenticated.timestamp || authenticated.timestamp - payload.syncAt > 30 * 60 * 1_000) {
    return c.json({ error: 'Invalid ingestion payload' }, 400)
  }
  if (!await getActiveBitkubAccount(c.env.DB, payload.accountId)) return c.json({ error: 'Not found' }, 404)
  if (!await claimAwsIngestionNonce(c.env.DB, authenticated.nonce, authenticated.timestamp)) return c.json({ error: 'Replay rejected' }, 409)

  const inserts = payload.records.map((record) => insertAwsHistoryRecord(c.env.DB, payload.accountId, payload.dataType, record))
  if (inserts.some((statement) => statement === undefined)) return c.json({ error: 'Invalid ingestion payload' }, 400)
  const completionStatements = payload.complete ? [
    c.env.DB.prepare(`
      INSERT INTO sync_state (account_id, data_type, last_synced_at, cursor)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(account_id, data_type) DO UPDATE SET
        last_synced_at = MAX(sync_state.last_synced_at, excluded.last_synced_at),
        cursor = NULL
    `).bind(payload.accountId, payload.dataType, payload.syncAt),
    c.env.DB.prepare('INSERT INTO sync_events (account_id, data_type, status, detail, occurred_at) VALUES (?, ?, ?, ?, ?)')
      .bind(payload.accountId, payload.dataType, 'success', 'AWS Bitkub ingestion', payload.syncAt),
  ] : []
  await c.env.DB.batch([...(inserts as D1PreparedStatement[]), ...completionStatements])
  return c.json({ complete: payload.complete, dataType: payload.dataType, ingested: true, recordCount: payload.records.length, syncAt: payload.syncAt })
}

const normalizeAssets = (value: string | undefined): string[] => {
  if (!value) return []
  const assets = value.split(',').map(normalizeAsset)
  if (assets.some((asset) => asset === undefined)) return []
  return [...new Set(assets)].slice(0, maxAssetsPerQuery) as string[]
}

const getSyncStatus = async (db: D1Database, accountId?: string): Promise<SyncStatusRow[]> => {
  const query = `
    WITH data_types(data_type) AS (
      VALUES ('balances'), ('trades'), ('crypto_transfers'), ('fiat_transfers'), ('prices')
    )
    SELECT
      accounts.id AS account_id,
      accounts.label AS account_label,
      data_types.data_type,
      COALESCE(sync_events.status, 'pending') AS status,
      sync_events.detail,
      sync_events.occurred_at
    FROM accounts
    CROSS JOIN data_types
    LEFT JOIN sync_events ON sync_events.id = (
      SELECT latest.id
      FROM sync_events AS latest
      WHERE latest.account_id = accounts.id
        AND latest.data_type = data_types.data_type
      ORDER BY latest.occurred_at DESC, latest.id DESC
      LIMIT 1
    )
    WHERE accounts.archived_at IS NULL ${accountId ? 'AND accounts.id = ?' : ''}
    ORDER BY accounts.label, data_types.data_type
  `
  const result = await (accountId ? db.prepare(query).bind(accountId) : db.prepare(query)).all<SyncStatusRow>()
  return result.results
}

const getSyncEvents = async (db: D1Database, limit: number, accountId?: string): Promise<SyncEventRow[]> => {
  const query = `
    SELECT
      sync_events.id,
      sync_events.account_id,
      accounts.label AS account_label,
      sync_events.data_type,
      sync_events.status,
      sync_events.detail,
      sync_events.occurred_at
    FROM sync_events
    JOIN accounts ON accounts.id = sync_events.account_id
    WHERE accounts.archived_at IS NULL ${accountId ? 'AND sync_events.account_id = ?' : ''}
    ORDER BY sync_events.occurred_at DESC, sync_events.id DESC
    LIMIT ?
  `
  const result = await (accountId ? db.prepare(query).bind(accountId, limit) : db.prepare(query).bind(limit)).all<SyncEventRow>()
  return result.results
}

const getWatchlist = async (db: D1Database): Promise<WatchlistRow[]> => {
  const result = await db.prepare(`
    SELECT watchlist.asset, watchlist.created_at, prices.price, prices.updated_at
    FROM asset_watchlist AS watchlist
    LEFT JOIN price_cache AS prices ON prices.asset = watchlist.asset AND prices.quote = 'THB'
    ORDER BY watchlist.created_at DESC, watchlist.asset
  `).all<WatchlistRow>()
  return result.results
}

const getPriceAlerts = async (db: D1Database): Promise<PriceAlertRow[]> => {
  const result = await db.prepare(`
    SELECT id, asset, direction, target_price, active, is_triggered, last_triggered_at, created_at, updated_at
    FROM price_alerts ORDER BY created_at DESC
  `).all<PriceAlertRow>()
  return result.results
}

const getAllocationTargets = async (db: D1Database): Promise<AllocationTargetRow[]> => {
  const result = await db.prepare('SELECT asset, target_percent, updated_at FROM allocation_targets ORDER BY asset').all<AllocationTargetRow>()
  return result.results
}

const backupLimit = 5_000

const getBackup = async (db: D1Database, from: number, to: number, accountId?: string): Promise<Record<string, unknown>> => {
  const accountCondition = ` AND account_id IN (SELECT id FROM accounts WHERE archived_at IS NULL)${accountId ? ' AND account_id = ?' : ''}`
  const bindHistory = (statement: D1PreparedStatement): D1PreparedStatement => accountId ? statement.bind(from, to, accountId) : statement.bind(from, to)
  const results = await db.batch([
    accountId ? db.prepare('SELECT id, exchange, label, created_at FROM accounts WHERE id = ? AND archived_at IS NULL').bind(accountId) : db.prepare('SELECT id, exchange, label, created_at FROM accounts WHERE archived_at IS NULL ORDER BY label'),
    bindHistory(db.prepare(`SELECT account_id, asset, available, reserved, snapshot_at FROM balance_snapshots WHERE snapshot_at >= ? AND snapshot_at <= ?${accountCondition} ORDER BY snapshot_at LIMIT ${backupLimit}`)),
    db.prepare(`SELECT asset, quote, price, snapshot_at FROM price_snapshots WHERE snapshot_at >= ? AND snapshot_at <= ? ORDER BY snapshot_at LIMIT ${backupLimit}`).bind(from, to),
    bindHistory(db.prepare(`SELECT id, account_id, side, base_asset, quote_asset, price, amount, quote_amount, fee, fee_asset, executed_at FROM trades WHERE executed_at >= ? AND executed_at <= ?${accountCondition} ORDER BY executed_at LIMIT ${backupLimit}`)),
    bindHistory(db.prepare(`SELECT id, account_id, direction, asset, amount, fee, tx_hash, executed_at FROM crypto_transfers WHERE executed_at >= ? AND executed_at <= ?${accountCondition} ORDER BY executed_at LIMIT ${backupLimit}`)),
    bindHistory(db.prepare(`SELECT id, account_id, direction, currency, amount, fee, executed_at FROM fiat_transfers WHERE executed_at >= ? AND executed_at <= ?${accountCondition} ORDER BY executed_at LIMIT ${backupLimit}`)),
    bindHistory(db.prepare(`SELECT id, account_id, data_type, status, detail, occurred_at FROM sync_events WHERE occurred_at >= ? AND occurred_at <= ?${accountCondition} ORDER BY occurred_at LIMIT ${backupLimit}`)),
  ])
  if (results.length !== 7) throw new Error('D1 returned an incomplete backup batch')
  const [accounts, balances, prices, trades, cryptoTransfers, fiatTransfers, events] = results as [D1Result, D1Result, D1Result, D1Result, D1Result, D1Result, D1Result]
  return {
    accountId: accountId ?? null,
    generatedAt: Date.now(),
    range: { from, to },
    note: 'Normalized Moondi data only. Raw exchange payloads and credentials are excluded.',
    limitPerCollection: backupLimit,
    accounts: accounts.results,
    balanceSnapshots: balances.results,
    priceSnapshots: prices.results,
    trades: trades.results,
    cryptoTransfers: cryptoTransfers.results,
    fiatTransfers: fiatTransfers.results,
    syncEvents: events.results,
  }
}

const isPushSubscriptionInput = (value: unknown): value is PushSubscriptionInput => {
  if (typeof value !== 'object' || value === null) return false
  const endpoint = Reflect.get(value, 'endpoint')
  const keys = Reflect.get(value, 'keys')
  const p256dh = typeof keys === 'object' && keys !== null ? Reflect.get(keys, 'p256dh') : undefined
  const auth = typeof keys === 'object' && keys !== null ? Reflect.get(keys, 'auth') : undefined
  if (
    typeof endpoint !== 'string'
    || endpoint.length > 2_048
    || typeof p256dh !== 'string'
    || p256dh.length === 0
    || p256dh.length > 512
    || typeof auth !== 'string'
    || auth.length === 0
    || auth.length > 512
  ) return false

  try {
    return new URL(endpoint).protocol === 'https:'
  } catch {
    return false
  }
}

const isPushNotificationPreferences = (value: unknown): value is PushNotificationPreferences => (
  typeof value === 'object'
  && value !== null
  && typeof Reflect.get(value, 'trades') === 'boolean'
  && typeof Reflect.get(value, 'cryptoTransfers') === 'boolean'
  && typeof Reflect.get(value, 'fiatTransfers') === 'boolean'
  && typeof Reflect.get(value, 'priceAlerts') === 'boolean'
  && typeof Reflect.get(value, 'syncIssues') === 'boolean'
)

const toPushNotificationPreferences = (row: PushPreferencesRow): PushNotificationPreferences => ({
  cryptoTransfers: row.notify_crypto_transfers === 1,
  fiatTransfers: row.notify_fiat_transfers === 1,
  priceAlerts: row.notify_price_alerts === 1,
  syncIssues: row.notify_sync_issues === 1,
  trades: row.notify_trades === 1,
})

const readPushSubscriptionPayload = async (request: Request): Promise<{ preferences: unknown; subscription: unknown }> => {
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body: unknown = await request.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return { preferences: undefined, subscription: null }
    return { preferences: Reflect.get(body, 'preferences'), subscription: Reflect.get(body, 'subscription') ?? body }
  }

  const form = await request.formData().catch(() => null)
  const serialized = form?.get('subscription')
  const preferences = form?.get('preferences')
  return {
    preferences: typeof preferences === 'string' ? JSON.parse(preferences) as unknown : undefined,
    subscription: typeof serialized === 'string' ? JSON.parse(serialized) as unknown : null,
  }
}

const readPushEndpoint = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body: unknown = await request.json().catch(() => null)
    return typeof body === 'object' && body !== null ? Reflect.get(body, 'endpoint') : undefined
  }

  const form = await request.formData().catch(() => null)
  return form?.get('endpoint')
}

const readRequestBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body: unknown = await request.json().catch(() => null)
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null
  }

  const form = await request.formData().catch(() => null)
  if (!form) return null
  const body: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) if (typeof value === 'string') body[key] = value
  return body
}

const addWatchlistAsset = async (c: Context<HonoEnv>) => {
  const body = await readRequestBody(c.req.raw)
  const asset = body ? normalizeAsset(String(Reflect.get(body, 'asset') ?? '')) : undefined
  if (!asset) return c.json({ error: 'Invalid asset' }, 400)
  const result = await c.env.DB.prepare('INSERT INTO asset_watchlist (asset, created_at) VALUES (?, ?) ON CONFLICT(asset) DO NOTHING').bind(asset, Date.now()).run()
  return c.json({ asset, created: result.meta.changes > 0 }, 201)
}

const removeWatchlistAsset = async (c: Context<HonoEnv>) => {
  const asset = normalizeAsset(c.req.param('asset') ?? '')
  if (!asset) return c.json({ error: 'Invalid asset' }, 400)
  await c.env.DB.prepare('DELETE FROM asset_watchlist WHERE asset = ?').bind(asset).run()
  return c.json({ ok: true })
}

const addPriceAlert = async (c: Context<HonoEnv>) => {
  const body = await readRequestBody(c.req.raw)
  const asset = body ? normalizeAsset(String(Reflect.get(body, 'asset') ?? '')) : undefined
  const direction = body ? Reflect.get(body, 'direction') : undefined
  const targetPrice = body ? Number(Reflect.get(body, 'targetPrice')) : Number.NaN
  if (!asset || (direction !== 'above' && direction !== 'below') || !Number.isFinite(targetPrice) || targetPrice <= 0) return c.json({ error: 'Invalid price alert' }, 400)
  const now = Date.now()
  const id = crypto.randomUUID()
  await c.env.DB.prepare(`
    INSERT INTO price_alerts (id, asset, direction, target_price, active, is_triggered, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 0, ?, ?)
  `).bind(id, asset, direction, targetPrice, now, now).run()
  return c.json({ alert: { active: 1, asset, direction, id, is_triggered: 0, last_triggered_at: null, target_price: targetPrice, created_at: now, updated_at: now } }, 201)
}

const removePriceAlert = async (c: Context<HonoEnv>) => {
  await c.env.DB.prepare('DELETE FROM price_alerts WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
}

const saveAllocationTarget = async (c: Context<HonoEnv>) => {
  const asset = normalizeAsset(c.req.param('asset') ?? '')
  const body = await readRequestBody(c.req.raw)
  const targetPercent = body ? Number(Reflect.get(body, 'targetPercent')) : Number.NaN
  if (!asset || !Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent > 100) return c.json({ error: 'Invalid allocation target' }, 400)
  const existing = await c.env.DB.prepare('SELECT COALESCE(SUM(target_percent), 0) AS total FROM allocation_targets WHERE asset != ?').bind(asset).first<{ total: number }>()
  if ((existing?.total ?? 0) + targetPercent > 100.000001) return c.json({ error: 'Allocation targets cannot exceed 100%' }, 400)
  const now = Date.now()
  await c.env.DB.prepare(`
    INSERT INTO allocation_targets (asset, target_percent, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(asset) DO UPDATE SET target_percent = excluded.target_percent, updated_at = excluded.updated_at
  `).bind(asset, targetPercent, now).run()
  return c.json({ target: { asset, target_percent: targetPercent, updated_at: now } })
}

const removeAllocationTarget = async (c: Context<HonoEnv>) => {
  const asset = normalizeAsset(c.req.param('asset') ?? '')
  if (!asset) return c.json({ error: 'Invalid asset' }, 400)
  await c.env.DB.prepare('DELETE FROM allocation_targets WHERE asset = ?').bind(asset).run()
  return c.json({ ok: true })
}

const archiveAccount = async (c: Context<HonoEnv>) => {
  const accountId = c.req.param('accountId')
  if (!accountId) return c.json({ error: 'Invalid account' }, 400)
  const result = await c.env.DB.prepare('UPDATE accounts SET archived_at = ? WHERE id = ? AND archived_at IS NULL').bind(Date.now(), accountId).run()
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: 'Active account not found' }, 404)
  return c.json({ ok: true })
}

const restoreAccount = async (c: Context<HonoEnv>) => {
  const accountId = c.req.param('accountId')
  if (!accountId) return c.json({ error: 'Invalid account' }, 400)
  const result = await c.env.DB.prepare('UPDATE accounts SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').bind(accountId).run()
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: 'Disconnected account not found' }, 404)
  return c.json({ ok: true })
}

const pushTestCooldownSeconds = 60
const manualSyncCooldownSeconds = 15 * 60

const pushTestKey = async (endpoint: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return `push-test:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const api = factory
  .createApp()
  .get('/accounts', async (c) => c.json({ accounts: await getAccounts(c.env.DB) }))
  .get('/accounts/archived', async (c) => c.json({ accounts: await getArchivedAccounts(c.env.DB) }))
  .get('/access/complete', (c) => c.redirect(readString(c.env, 'ALLOWED_ORIGIN') ?? 'http://localhost:5173'))
  .get('/push/public-key', (c) => {
    const publicKey = readString(c.env, 'VAPID_PUBLIC_KEY')
    return publicKey ? c.json({ publicKey }) : c.json({ error: 'Push notifications are not configured' }, 503)
  })
  .post('/push/subscriptions', async (c) => {
    const { subscription, preferences: rawPreferences } = await readPushSubscriptionPayload(c.req.raw).catch(() => ({ preferences: undefined, subscription: null }))
    if (!isPushSubscriptionInput(subscription)) return c.json({ error: 'Invalid push subscription' }, 400)
    if (rawPreferences !== undefined && !isPushNotificationPreferences(rawPreferences)) return c.json({ error: 'Invalid notification preferences' }, 400)
    const preferences = rawPreferences ?? defaultPushNotificationPreferences
    const now = Date.now()
    await c.env.DB.prepare(`
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, created_at, updated_at,
        notify_trades, notify_crypto_transfers, notify_fiat_transfers, notify_price_alerts, notify_sync_issues
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        updated_at = excluded.updated_at,
        notify_trades = excluded.notify_trades,
        notify_crypto_transfers = excluded.notify_crypto_transfers,
        notify_fiat_transfers = excluded.notify_fiat_transfers,
        notify_price_alerts = excluded.notify_price_alerts,
        notify_sync_issues = excluded.notify_sync_issues
    `).bind(
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      now,
      now,
      preferences.trades ? 1 : 0,
      preferences.cryptoTransfers ? 1 : 0,
      preferences.fiatTransfers ? 1 : 0,
      preferences.priceAlerts ? 1 : 0,
      preferences.syncIssues ? 1 : 0,
    ).run()
    return c.json({ ok: true, preferences })
  })
  .get('/push/subscriptions/preferences', async (c) => {
    const endpoint = c.req.query('endpoint')
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return c.json({ error: 'Invalid push subscription' }, 400)
    const row = await c.env.DB.prepare(`
      SELECT notify_trades, notify_crypto_transfers, notify_fiat_transfers, notify_price_alerts, notify_sync_issues
      FROM push_subscriptions WHERE endpoint = ?
    `).bind(endpoint).first<PushPreferencesRow>()
    return c.json({ preferences: row ? toPushNotificationPreferences(row) : defaultPushNotificationPreferences })
  })
  .post('/push/subscriptions/remove', async (c) => {
    const endpoint = await readPushEndpoint(c.req.raw).catch(() => null)
    if (typeof endpoint !== 'string') return c.json({ error: 'Invalid push subscription' }, 400)
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
    return c.json({ ok: true })
  })
  .delete('/push/subscriptions', async (c) => {
    const endpoint = await readPushEndpoint(c.req.raw).catch(() => null)
    if (typeof endpoint !== 'string') return c.json({ error: 'Invalid push subscription' }, 400)
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
    return c.json({ ok: true })
  })
  .post('/push/test', async (c) => {
    const endpoint = await readPushEndpoint(c.req.raw).catch(() => null)
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return c.json({ error: 'Invalid push subscription' }, 400)

    const subscription = await c.env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<StoredPushSubscription>()
    if (!subscription) return c.json({ error: 'No active push subscription' }, 404)

    const token = readString(c.env, 'INTERNAL_PUSH_TEST_TOKEN')
    if (!token) return c.json({ error: 'Push notifications are not configured' }, 503)

    const cacheKey = await pushTestKey(subscription.endpoint)
    if (await c.env.CACHE.get(cacheKey)) return c.json({ error: 'Push test is temporarily rate limited' }, 429)

    try {
      const response = await c.env.SYNC.fetch(new Request('https://moondi.internal/internal/push/test', {
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        headers: { 'content-type': 'application/json', 'x-moond-internal-token': token },
        method: 'POST',
      }))
      const result: unknown = await response.json().catch(() => null)
      const delivered = typeof result === 'object' && result !== null ? Reflect.get(result, 'delivered') : undefined
      if (!response.ok || delivered !== true) return c.json({ error: 'Push delivery failed' }, 502)
      await c.env.CACHE.put(cacheKey, '1', { expirationTtl: pushTestCooldownSeconds })
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'Push delivery failed' }, 502)
    }
  })
  .post('/sync/trigger', async (c) => {
    if (readString(c.env, 'BITKUB_SECURE_SYNC_MODE') === 'aws-ingest') {
      return c.json({ error: 'Manual secure sync runs on the AWS schedule' }, 503)
    }
    const token = readString(c.env, 'INTERNAL_PUSH_TEST_TOKEN')
    if (!token) return c.json({ error: 'Manual sync is not configured' }, 503)

    const cacheKey = 'manual-sync:cooldown'
    const existing = await c.env.CACHE.get(cacheKey)
    if (existing) {
      const retryAt = Number(existing)
      const retryAfterSeconds = Number.isFinite(retryAt) ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000)) : manualSyncCooldownSeconds
      return c.json({ error: 'Manual sync is temporarily rate limited', retryAfterSeconds }, 429)
    }

    try {
      const response = await c.env.SYNC.fetch(new Request('https://moondi.internal/internal/sync/trigger', {
        headers: { 'x-moond-internal-token': token },
        method: 'POST',
      }))
      const result: unknown = await response.json().catch(() => null)
      const accepted = typeof result === 'object' && result !== null ? Reflect.get(result, 'accepted') : undefined
      if (response.status === 409 || accepted === false) return c.json({ error: 'A sync is already running' }, 409)
      if (!response.ok || accepted !== true) return c.json({ error: 'Manual sync could not be started' }, 502)

      const retryAt = Date.now() + manualSyncCooldownSeconds * 1_000
      await c.env.CACHE.put(cacheKey, String(retryAt), { expirationTtl: manualSyncCooldownSeconds })
      return c.json({ accepted: true, retryAt })
    } catch {
      return c.json({ error: 'Manual sync could not be started' }, 502)
    }
  })
  .get('/backup', async (c) => {
    const { from, to } = historyBounds(c.req.query('from'), c.req.query('to'), c.req.query('days') ?? '365')
    return c.json(await getBackup(c.env.DB, from, to, c.req.query('account')))
  })
  .get('/watchlist', async (c) => c.json({ assets: await getWatchlist(c.env.DB) }))
  .post('/watchlist', addWatchlistAsset)
  .post('/watchlist/:asset/remove', removeWatchlistAsset)
  .delete('/watchlist/:asset', removeWatchlistAsset)
  .get('/price-alerts', async (c) => c.json({ alerts: await getPriceAlerts(c.env.DB) }))
  .post('/price-alerts', addPriceAlert)
  .patch('/price-alerts/:id', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const active = typeof body === 'object' && body !== null ? Reflect.get(body, 'active') : undefined
    if (typeof active !== 'boolean') return c.json({ error: 'Invalid price alert state' }, 400)
    await c.env.DB.prepare('UPDATE price_alerts SET active = ?, is_triggered = CASE WHEN ? = 1 THEN 0 ELSE is_triggered END, updated_at = ? WHERE id = ?').bind(active ? 1 : 0, active ? 1 : 0, Date.now(), c.req.param('id')).run()
    return c.json({ ok: true })
  })
  .post('/price-alerts/:id/remove', removePriceAlert)
  .delete('/price-alerts/:id', removePriceAlert)
  .get('/allocation-targets', async (c) => c.json({ targets: await getAllocationTargets(c.env.DB) }))
  .post('/allocation-targets/:asset', saveAllocationTarget)
  .put('/allocation-targets/:asset', saveAllocationTarget)
  .post('/allocation-targets/:asset/remove', removeAllocationTarget)
  .delete('/allocation-targets/:asset', removeAllocationTarget)
  .post('/accounts/:accountId/archive', archiveAccount)
  .post('/accounts/:accountId/restore', restoreAccount)
  .get('/portfolio', async (c) => {
    const accountId = c.req.query('account')
    const holdings = await getHoldings(c.env.DB, accountId)
    const totalValue = holdings.reduce((total, holding) => total + (holding.available + holding.reserved) * holding.price, 0)
    return c.json({ holdings, totalValue, updatedAt: holdings.reduce<number | null>((latest, holding) => Math.max(latest ?? 0, holding.updated_at ?? 0) || null, null) })
  })
  .get('/portfolio/:accountId', async (c) => {
    const accountId = c.req.param('accountId')
    const holdings = await getHoldings(c.env.DB, accountId)
    const totalValue = holdings.reduce((total, holding) => total + (holding.available + holding.reserved) * holding.price, 0)
    return c.json({ accountId, holdings, totalValue })
  })
  .get('/history/value', async (c) => {
    const { from, to } = historyBounds(c.req.query('from'), c.req.query('to'), c.req.query('days'))
    return c.json({ points: await getCachedValueHistory(c.env, from, to, c.req.query('account')) })
  })
  .get('/history/price/:asset', async (c) => {
    const asset = normalizeAsset(c.req.param('asset'))
    if (!asset) return c.json({ error: 'Invalid asset' }, 400)
    const { from, to } = historyBounds(c.req.query('from'), c.req.query('to'), c.req.query('days'))
    const histories = await getCachedPriceHistories(c.env, [asset], from, to)
    return c.json({ asset, points: histories[asset] ?? [] })
  })
  .get('/history/prices', async (c) => {
    const assets = normalizeAssets(c.req.query('assets'))
    if (assets.length === 0) return c.json({ error: 'At least one valid asset is required' }, 400)
    const { from, to } = historyBounds(c.req.query('from'), c.req.query('to'), c.req.query('days'))
    return c.json({ series: await getCachedPriceHistories(c.env, assets, from, to) })
  })
  .get('/sync-status', async (c) => c.json({ statuses: await getSyncStatus(c.env.DB, c.req.query('account')) }))
  .get('/sync-events', async (c) => c.json({ events: await getSyncEvents(c.env.DB, normalizeLimit(c.req.query('limit')), c.req.query('account')) }))
  .get('/transactions', async (c) => {
    const accountId = c.req.query('account')
    const limit = normalizeLimit(c.req.query('limit'))
    const transactionType = c.req.query('type')
    const from = normalizeTimestamp(c.req.query('from'))
    const to = normalizeTimestamp(c.req.query('to'))
    const rawCursor = c.req.query('cursor')
    const cursor = decodeCursor(rawCursor)
    if (rawCursor && !cursor) return c.json({ error: 'Invalid transaction cursor' }, 400)
    const requestedType = transactionType && ['trade', 'crypto_transfer', 'fiat_transfer'].includes(transactionType)
      ? transactionType as TransactionRow['category']
      : undefined
    const sources = [
      { category: 'trade', columns: "source.id, source.account_id, 'trade' AS category, source.side AS direction, source.base_asset AS asset, source.amount, source.quote_asset, source.quote_amount, source.price, source.fee, source.executed_at", table: 'trades' },
      { category: 'crypto_transfer', columns: "source.id, source.account_id, 'crypto_transfer' AS category, source.direction, source.asset, source.amount, NULL AS quote_asset, NULL AS quote_amount, NULL AS price, source.fee, source.executed_at", table: 'crypto_transfers' },
      { category: 'fiat_transfer', columns: "source.id, source.account_id, 'fiat_transfer' AS category, source.direction, source.currency AS asset, source.amount, source.currency AS quote_asset, source.amount AS quote_amount, NULL AS price, source.fee, source.executed_at", table: 'fiat_transfers' },
    ] as const
    const selectedSources = requestedType ? sources.filter((source) => source.category === requestedType) : sources
    const bindings: Array<string | number> = []
    const branches = selectedSources.map((source) => {
      const conditions = ['accounts.archived_at IS NULL']
      if (accountId) {
        conditions.push('source.account_id = ?')
        bindings.push(accountId)
      }
      if (from !== undefined) {
        conditions.push('source.executed_at >= ?')
        bindings.push(from)
      }
      if (to !== undefined) {
        conditions.push('source.executed_at <= ?')
        bindings.push(to)
      }
      if (cursor) {
        conditions.push('(source.executed_at < ? OR (source.executed_at = ? AND source.id < ?))')
        bindings.push(cursor.executedAt, cursor.executedAt, cursor.id)
      }
      bindings.push(limit)
      return `SELECT * FROM (
        SELECT ${source.columns}
        FROM ${source.table} AS source
        JOIN accounts ON accounts.id = source.account_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY source.executed_at DESC, source.id DESC
        LIMIT ?
      )`
    })
    bindings.push(limit)
    const query = `
      SELECT records.* FROM (${branches.join('\nUNION ALL\n')}) AS records
      ORDER BY records.executed_at DESC, records.id DESC
      LIMIT ?
    `
    const result = await c.env.DB.prepare(query).bind(...bindings).all<TransactionRow>()
    const last = result.results.at(-1)
    return c.json({ nextCursor: result.results.length === limit && last ? encodeCursor(last) : null, transactions: result.results })
  })

const awsBitkubRoutes = createAwsBitkubRoutes({
  balances: ingestAwsBalances,
  history: ingestAwsHistory,
  state: getAwsSyncState,
})

const app = factory
  .createApp()
  .use('*', async (c, next) => {
    const allowedOrigin = readString(c.env, 'ALLOWED_ORIGIN') ?? 'http://localhost:5173'
    const requestOrigin = c.req.header('Origin')
    const isCrossSite = c.req.header('Sec-Fetch-Site') === 'cross-site'
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && (isCrossSite || (requestOrigin && requestOrigin !== allowedOrigin))) {
      return c.json({ error: 'Origin not allowed' }, 403)
    }
    return cors({ allowHeaders: ['Content-Type'], allowMethods: ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'], credentials: true, origin: allowedOrigin })(c, next)
  })
  .get('/health', (c) => c.json({ status: 'ok' }))
  .route('/internal/aws-sync/bitkub', awsBitkubRoutes)
  .route('/api', api)
  .notFound((c) => c.json({ error: 'Not found' }, 404))
  .onError((error, c) => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), path: c.req.path }))
    return c.json({ error: 'Internal server error' }, 500)
  })

export type AppType = typeof app

export default app
