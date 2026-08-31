import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createFactory } from 'hono/factory'

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
    WITH latest AS (
      SELECT account_id, MAX(snapshot_at) AS snapshot_at
      FROM balance_snapshots
      ${accountId ? 'WHERE account_id = ?1' : ''}
      GROUP BY account_id
    )
    SELECT
      balances.account_id,
      accounts.label AS account_label,
      balances.asset,
      balances.available,
      balances.reserved,
      COALESCE(prices.price, CASE balances.asset WHEN 'THB' THEN 1 ELSE 0 END) AS price,
      latest.snapshot_at AS updated_at
    FROM latest
    JOIN balance_snapshots AS balances
      ON balances.account_id = latest.account_id
      AND balances.snapshot_at = latest.snapshot_at
    JOIN accounts ON accounts.id = balances.account_id AND accounts.archived_at IS NULL
    LEFT JOIN price_cache AS prices ON prices.asset = balances.asset AND prices.quote = 'THB'
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
    interval_account_snapshots AS (
      SELECT
        account_id,
        snapshot_at / 1800000 AS interval,
        MAX(snapshot_at) AS snapshot_at
      FROM balance_snapshots
      WHERE snapshot_at >= ?1 AND snapshot_at <= ?2
        AND account_id IN (SELECT id FROM scoped_accounts)
      GROUP BY account_id, interval
    ),
    interval_account_values AS (
      SELECT
        snapshots.interval,
        snapshots.account_id,
        snapshots.snapshot_at,
        SUM((balances.available + balances.reserved) * COALESCE(prices.price, CASE balances.asset WHEN 'THB' THEN 1 ELSE 0 END)) AS total_value,
        SUM(CASE
          WHEN balances.asset != 'THB'
            AND balances.available + balances.reserved > 0
            AND prices.price IS NULL
          THEN 1
          ELSE 0
        END) AS unpriced_assets
      FROM interval_account_snapshots AS snapshots
      JOIN balance_snapshots AS balances
        ON balances.account_id = snapshots.account_id
        AND balances.snapshot_at = snapshots.snapshot_at
      LEFT JOIN price_snapshots AS prices
        ON prices.asset = balances.asset
        AND prices.quote = 'THB'
        AND prices.snapshot_at = snapshots.snapshot_at
      GROUP BY snapshots.interval, snapshots.account_id, snapshots.snapshot_at
    ),
    interval_portfolio_values AS (
      SELECT
        interval,
        MAX(snapshot_at) AS snapshot_at,
        SUM(total_value) AS total_value,
        SUM(unpriced_assets) AS unpriced_assets,
        COUNT(DISTINCT account_id) AS account_count
      FROM interval_account_values
      GROUP BY interval
    )
    SELECT snapshot_at, total_value
    FROM interval_portfolio_values AS portfolio
    WHERE unpriced_assets = 0
      AND account_count = (
        SELECT COUNT(*) FROM scoped_accounts
        WHERE created_at <= portfolio.snapshot_at
      )
    ORDER BY snapshot_at
  `
  const result = await (accountId ? db.prepare(query).bind(from, to, accountId) : db.prepare(query).bind(from, to)).all<ValueHistoryRow>()
  return result.results
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
  const result = await db.prepare(`
    WITH intervals AS (
      SELECT
        asset,
        snapshot_at / ? AS interval,
        MAX(snapshot_at) AS snapshot_at
      FROM price_snapshots
      WHERE asset IN (${placeholders}) AND quote = 'THB' AND snapshot_at >= ? AND snapshot_at <= ?
      GROUP BY asset, interval
    )
    SELECT prices.asset, prices.snapshot_at, prices.price
    FROM intervals
    JOIN price_snapshots AS prices
      ON prices.asset = intervals.asset
      AND prices.quote = 'THB'
      AND prices.snapshot_at = intervals.snapshot_at
    ORDER BY prices.asset, prices.snapshot_at
  `).bind(interval, ...assets, from, to).all<AssetPriceHistoryRow>()
  return result.results.reduce<Record<string, PriceHistoryRow[]>>((histories, point) => {
    const points = histories[point.asset] ?? []
    points.push({ price: point.price, snapshot_at: point.snapshot_at })
    histories[point.asset] = points
    return histories
  }, {})
}

const getPriceHistory = async (db: D1Database, asset: string, from: number, to: number): Promise<PriceHistoryRow[]> => {
  const histories = await getPriceHistories(db, [asset], from, to)
  return histories[asset] ?? []
}

const historyBounds = (fromQuery: string | undefined, toQuery: string | undefined, daysQuery: string | undefined): { from: number; to: number } => {
  const now = Date.now()
  const defaultFrom = now - normalizeDays(daysQuery) * 24 * 60 * 60 * 1_000
  const from = normalizeTimestamp(fromQuery) ?? defaultFrom
  const rawTo = normalizeTimestamp(toQuery)
  const dateOnly = typeof toQuery === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toQuery)
  const to = rawTo === undefined ? now : rawTo + (dateOnly ? 24 * 60 * 60 * 1_000 - 1 : 0)

  return from <= to ? { from, to } : { from: to, to: from }
}

const normalizeAsset = (value: string): string | undefined => {
  const asset = value.trim().toUpperCase()
  return /^[A-Z0-9_-]{1,20}$/.test(asset) ? asset : undefined
}

const normalizeAssets = (value: string | undefined): string[] => {
  if (!value) return []
  const assets = value.split(',').map(normalizeAsset)
  if (assets.some((asset) => asset === undefined)) return []
  return [...new Set(assets)].slice(0, 100) as string[]
}

const getSyncStatus = async (db: D1Database, accountId?: string): Promise<SyncStatusRow[]> => {
  const query = `
    WITH data_types(data_type) AS (
      VALUES ('balances'), ('trades'), ('crypto_transfers'), ('fiat_transfers'), ('prices')
    ),
    latest AS (
      SELECT account_id, data_type, MAX(id) AS id
      FROM sync_events
      GROUP BY account_id, data_type
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
    LEFT JOIN latest
      ON latest.account_id = accounts.id
      AND latest.data_type = data_types.data_type
    LEFT JOIN sync_events ON sync_events.id = latest.id
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
  const [accounts, balances, prices, trades, cryptoTransfers, fiatTransfers, events] = await Promise.all([
    accountId ? db.prepare('SELECT id, exchange, label, created_at FROM accounts WHERE id = ? AND archived_at IS NULL').bind(accountId).all() : db.prepare('SELECT id, exchange, label, created_at FROM accounts WHERE archived_at IS NULL ORDER BY label').all(),
    bindHistory(db.prepare(`SELECT account_id, asset, available, reserved, snapshot_at FROM balance_snapshots WHERE snapshot_at >= ? AND snapshot_at <= ?${accountCondition} ORDER BY snapshot_at LIMIT ${backupLimit}`)).all(),
    db.prepare(`SELECT asset, quote, price, snapshot_at FROM price_snapshots WHERE snapshot_at >= ? AND snapshot_at <= ? ORDER BY snapshot_at LIMIT ${backupLimit}`).bind(from, to).all(),
    bindHistory(db.prepare(`SELECT id, account_id, side, base_asset, quote_asset, price, amount, fee, fee_asset, executed_at FROM trades WHERE executed_at >= ? AND executed_at <= ?${accountCondition} ORDER BY executed_at LIMIT ${backupLimit}`)).all(),
    bindHistory(db.prepare(`SELECT id, account_id, direction, asset, amount, fee, tx_hash, executed_at FROM crypto_transfers WHERE executed_at >= ? AND executed_at <= ?${accountCondition} ORDER BY executed_at LIMIT ${backupLimit}`)).all(),
    bindHistory(db.prepare(`SELECT id, account_id, direction, currency, amount, fee, executed_at FROM fiat_transfers WHERE executed_at >= ? AND executed_at <= ?${accountCondition} ORDER BY executed_at LIMIT ${backupLimit}`)).all(),
    bindHistory(db.prepare(`SELECT id, account_id, data_type, status, detail, occurred_at FROM sync_events WHERE occurred_at >= ? AND occurred_at <= ?${accountCondition} ORDER BY occurred_at LIMIT ${backupLimit}`)).all(),
  ])
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
    return c.json({ points: await getValueHistory(c.env.DB, from, to, c.req.query('account')) })
  })
  .get('/history/price/:asset', async (c) => {
    const asset = normalizeAsset(c.req.param('asset'))
    if (!asset) return c.json({ error: 'Invalid asset' }, 400)
    const { from, to } = historyBounds(c.req.query('from'), c.req.query('to'), c.req.query('days'))
    return c.json({ asset, points: await getPriceHistory(c.env.DB, asset, from, to) })
  })
  .get('/history/prices', async (c) => {
    const assets = normalizeAssets(c.req.query('assets'))
    if (assets.length === 0) return c.json({ error: 'At least one valid asset is required' }, 400)
    const { from, to } = historyBounds(c.req.query('from'), c.req.query('to'), c.req.query('days'))
    return c.json({ series: await getPriceHistories(c.env.DB, assets, from, to) })
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
    const conditions = ['1 = 1']
    const bindings: Array<string | number> = []

    if (accountId) {
      conditions.push('records.account_id = ?')
      bindings.push(accountId)
    }

    if (transactionType && ['trade', 'crypto_transfer', 'fiat_transfer'].includes(transactionType)) {
      conditions.push('records.category = ?')
      bindings.push(transactionType)
    }

    if (from !== undefined) {
      conditions.push('records.executed_at >= ?')
      bindings.push(from)
    }

    if (to !== undefined) {
      conditions.push('records.executed_at <= ?')
      bindings.push(to)
    }

    if (cursor) {
      conditions.push('(records.executed_at < ? OR (records.executed_at = ? AND records.id < ?))')
      bindings.push(cursor.executedAt, cursor.executedAt, cursor.id)
    }

    bindings.push(limit)
    const query = `
      SELECT records.* FROM (
        SELECT id, account_id, 'trade' AS category, side AS direction, base_asset AS asset, amount, quote_asset, price, fee, executed_at FROM trades
        UNION ALL
        SELECT id, account_id, 'crypto_transfer' AS category, direction, asset, amount, NULL AS quote_asset, NULL AS price, fee, executed_at FROM crypto_transfers
        UNION ALL
        SELECT id, account_id, 'fiat_transfer' AS category, direction, currency AS asset, amount, currency AS quote_asset, NULL AS price, fee, executed_at FROM fiat_transfers
      ) AS records
      JOIN accounts ON accounts.id = records.account_id AND accounts.archived_at IS NULL
      WHERE ${conditions.join(' AND ')}
      ORDER BY records.executed_at DESC, records.id DESC
      LIMIT ?
    `
    const result = await c.env.DB.prepare(query).bind(...bindings).all<TransactionRow>()
    const last = result.results.at(-1)
    return c.json({ nextCursor: result.results.length === limit && last ? encodeCursor(last) : null, transactions: result.results })
  })

const app = factory
  .createApp()
  .use('*', async (c, next) => {
    const allowedOrigin = readString(c.env, 'ALLOWED_ORIGIN') ?? 'http://localhost:5173'
    const requestOrigin = c.req.header('Origin')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && requestOrigin && requestOrigin !== allowedOrigin) {
      return c.json({ error: 'Origin not allowed' }, 403)
    }
    return cors({ allowHeaders: ['Content-Type'], allowMethods: ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'], credentials: true, origin: allowedOrigin })(c, next)
  })
  .get('/health', (c) => c.json({ status: 'ok' }))
  .route('/api', api)
  .notFound((c) => c.json({ error: 'Not found' }, 404))
  .onError((error, c) => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), path: c.req.path }))
    return c.json({ error: 'Internal server error' }, 500)
  })

export type AppType = typeof app

export default app
