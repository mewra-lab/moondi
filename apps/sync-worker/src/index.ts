import { BitkubAdapter } from '@moondi/exchanges/bitkub'
import type { NormalizedBalance, NormalizedFiatTransfer, NormalizedTrade, NormalizedTransfer, PriceQuote } from '@moondi/shared'
import { sendPushBatch, sendPushNotification } from '@mmmike/web-push/send'
import { credentialIssue, parseBitkubCredentialSource, resolveBitkubCredentials, scopedExchangeRecordId, type BitkubCredentials } from './account-credentials'
import { mergeTradeAssets } from './sync-selection'

declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean
  }
}

type Account = {
  id: string
  exchange: 'bitkub' | 'binance'
  label: string
}

type SyncState = {
  last_synced_at: number
}

type PushSubscriptionRow = {
  endpoint: string
  p256dh: string
  auth: string
  notify_crypto_transfers: number
  notify_fiat_transfers: number
  notify_price_alerts: number
  notify_sync_issues: number
  notify_trades: number
}

type PushNotificationType = 'cryptoTransfers' | 'fiatTransfers' | 'priceAlerts' | 'syncIssues' | 'trades'

const pushPreferenceColumn: Record<PushNotificationType, keyof PushSubscriptionRow> = {
  cryptoTransfers: 'notify_crypto_transfers',
  fiatTransfers: 'notify_fiat_transfers',
  priceAlerts: 'notify_price_alerts',
  syncIssues: 'notify_sync_issues',
  trades: 'notify_trades',
}

type PushStateRow = {
  detail: string | null
  status: 'deferred' | 'failure'
}

const readOptionalSecret = (env: Env, name: string): string | undefined => {
  const value = Reflect.get(env, name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const hasInternalAccess = (request: Request, env: Env): boolean => {
  const expected = readOptionalSecret(env, 'INTERNAL_PUSH_TEST_TOKEN')
  const provided = request.headers.get('x-moond-internal-token')
  if (!expected || !provided) return false
  const expectedBytes = new TextEncoder().encode(expected)
  const providedBytes = new TextEncoder().encode(provided)
  return expectedBytes.byteLength === providedBytes.byteLength
    && crypto.subtle.timingSafeEqual(expectedBytes, providedBytes)
}

const isPushEndpoint = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const readLastSyncedAt = async (db: D1Database, accountId: string, dataType: string): Promise<number | undefined> => {
  const result = await db.prepare('SELECT last_synced_at FROM sync_state WHERE account_id = ? AND data_type = ?').bind(accountId, dataType).first<SyncState>()
  return result?.last_synced_at
}

const readPreviouslyHeldAssets = async (db: D1Database, accountId: string): Promise<string[]> => {
  const result = await db.prepare(`
    SELECT DISTINCT asset FROM balance_snapshots
    WHERE account_id = ? AND asset != 'THB' AND (available > 0 OR reserved > 0)
  `).bind(accountId).all<{ asset: string }>()
  return result.results.map((row) => row.asset)
}

const saveState = async (db: D1Database, accountId: string, dataType: string, timestamp: number): Promise<void> => {
  await db
    .prepare(`
      INSERT INTO sync_state (account_id, data_type, last_synced_at)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id, data_type)
      DO UPDATE SET last_synced_at = excluded.last_synced_at
    `)
    .bind(accountId, dataType, timestamp)
    .run()
}

const saveBalances = async (db: D1Database, accountId: string, balances: NormalizedBalance[], timestamp: number): Promise<void> => {
  if (balances.length === 0) return
  await db.batch(
    balances.map((balance) =>
      db
        .prepare('INSERT INTO balance_snapshots (account_id, asset, available, reserved, snapshot_at) VALUES (?, ?, ?, ?, ?)')
        .bind(accountId, balance.asset, balance.available, balance.reserved, timestamp),
    ),
  )
}

const saveTrades = async (db: D1Database, accountId: string, trades: NormalizedTrade[]): Promise<NormalizedTrade[]> => {
  if (trades.length === 0) return []
  const results = await db.batch(
    trades.map((trade) =>
      db
        .prepare(`
          INSERT INTO trades (id, account_id, external_id, side, base_asset, quote_asset, price, amount, fee, fee_asset, executed_at, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, external_id) DO NOTHING
        `)
        .bind(scopedExchangeRecordId(accountId, trade.id), accountId, trade.id, trade.side, trade.baseAsset, trade.quoteAsset, trade.price, trade.amount, trade.fee, trade.feeAsset ?? null, trade.executedAt, JSON.stringify(trade.raw)),
    ),
  )
  return trades.filter((_trade, index) => (results[index]?.meta.changes ?? 0) > 0)
}

const saveCryptoTransfers = async (db: D1Database, accountId: string, transfers: NormalizedTransfer[]): Promise<NormalizedTransfer[]> => {
  if (transfers.length === 0) return []
  const results = await db.batch(
    transfers.map((transfer) =>
      db
        .prepare(`
          INSERT INTO crypto_transfers (id, account_id, external_id, direction, asset, amount, fee, tx_hash, executed_at, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, external_id) DO NOTHING
        `)
        .bind(scopedExchangeRecordId(accountId, transfer.id), accountId, transfer.id, transfer.direction, transfer.asset, transfer.amount, transfer.fee, transfer.txHash ?? null, transfer.executedAt, JSON.stringify(transfer.raw)),
    ),
  )
  return transfers.filter((_transfer, index) => (results[index]?.meta.changes ?? 0) > 0)
}

const saveFiatTransfers = async (db: D1Database, accountId: string, transfers: NormalizedFiatTransfer[]): Promise<NormalizedFiatTransfer[]> => {
  if (transfers.length === 0) return []
  const results = await db.batch(
    transfers.map((transfer) =>
      db
        .prepare(`
          INSERT INTO fiat_transfers (id, account_id, external_id, direction, currency, amount, fee, executed_at, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, external_id) DO NOTHING
        `)
        .bind(scopedExchangeRecordId(accountId, transfer.id), accountId, transfer.id, transfer.direction, transfer.currency, transfer.amount, transfer.fee, transfer.executedAt, JSON.stringify(transfer.raw)),
    ),
  )
  return transfers.filter((_transfer, index) => (results[index]?.meta.changes ?? 0) > 0)
}

const savePrices = async (db: D1Database, prices: PriceQuote[], timestamp: number): Promise<void> => {
  if (prices.length === 0) return
  await db.batch(
    prices.flatMap((price) => [
      db
        .prepare(`
          INSERT INTO price_cache (asset, quote, price, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(asset, quote)
          DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at
        `)
        .bind(price.asset, price.quote, price.price, price.updatedAt),
      db
        .prepare('INSERT INTO price_snapshots (asset, quote, price, snapshot_at) VALUES (?, ?, ?, ?)')
        .bind(price.asset, price.quote, price.price, timestamp),
    ]),
  )
}

const saveSyncEvent = async (db: D1Database, accountId: string, dataType: string, status: 'success' | 'deferred' | 'failure', detail: string | null, timestamp: number): Promise<void> => {
  await db
    .prepare('INSERT INTO sync_events (account_id, data_type, status, detail, occurred_at) VALUES (?, ?, ?, ?, ?)')
    .bind(accountId, dataType, status, detail, timestamp)
    .run()
}

const updatePushState = async (db: D1Database, accountId: string, dataType: string, status: 'success' | 'deferred' | 'failure', detail: string | null): Promise<boolean> => {
  if (status === 'success') {
    await db.prepare('DELETE FROM sync_push_state WHERE account_id = ? AND data_type = ?').bind(accountId, dataType).run()
    return false
  }

  const previous = await db.prepare('SELECT status, detail FROM sync_push_state WHERE account_id = ? AND data_type = ?').bind(accountId, dataType).first<PushStateRow>()
  await db.prepare(`
    INSERT INTO sync_push_state (account_id, data_type, status, detail)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, data_type) DO UPDATE SET status = excluded.status, detail = excluded.detail
  `).bind(accountId, dataType, status, detail).run()
  return previous?.status !== status || previous.detail !== detail
}

const notificationLabel: Record<string, string> = {
  balances: 'ยอดคงเหลือ',
  crypto_transfers: 'โอนคริปโต',
  fiat_transfers: 'ฝาก/ถอน THB',
  prices: 'ราคา',
  trades: 'ประวัติซื้อ/ขาย',
}

const quantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 })
const currency = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const pushSubscriptionRetentionMs = 180 * 24 * 60 * 60 * 1_000

const pruneInactivePushSubscriptions = async (db: D1Database): Promise<void> => {
  await db.prepare('DELETE FROM push_subscriptions WHERE updated_at < ?').bind(Date.now() - pushSubscriptionRetentionMs).run()
}

const sendPush = async (env: Env, notificationType: PushNotificationType, payload: { body: string; tag: string; title: string }): Promise<void> => {
  const publicKey = readOptionalSecret(env, 'VAPID_PUBLIC_KEY')
  const privateKey = readOptionalSecret(env, 'VAPID_PRIVATE_KEY')
  const subject = readOptionalSecret(env, 'VAPID_SUBJECT')

  if (!publicKey || !privateKey || !subject) return

  try {
    const preferenceColumn = pushPreferenceColumn[notificationType]
    const subscriptions = await env.DB.prepare(`
      SELECT endpoint, p256dh, auth, notify_trades, notify_crypto_transfers, notify_fiat_transfers, notify_price_alerts, notify_sync_issues
      FROM push_subscriptions WHERE ${preferenceColumn} = 1
    `).all<PushSubscriptionRow>()
    if (subscriptions.results.length === 0) return
    const result = await sendPushBatch(
      subscriptions.results.map((subscription) => ({ endpoint: subscription.endpoint, keys: { auth: subscription.auth, p256dh: subscription.p256dh } })),
      { ...payload, url: '/' },
      { privateKey, publicKey, subject },
      { concurrency: 5, ttl: 60 * 60 },
    )
    if (result.gone.length > 0) await env.DB.batch(result.gone.map((endpoint) => env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint)))
    if (result.failed.length > 0) console.warn(JSON.stringify({ failedPushCount: result.failed.length, message: 'Push notification delivery failed' }))
  } catch (error) {
    console.warn(JSON.stringify({ error: readError(error), message: 'Push notification delivery failed' }))
  }
}

const notifyPriceAlerts = async (env: Env, prices: PriceQuote[], timestamp: number): Promise<void> => {
  const priceByAsset = new Map(prices.filter((price) => price.quote === 'THB').map((price) => [price.asset, price.price]))
  if (priceByAsset.size === 0) return

  const alerts = await env.DB.prepare(`
    SELECT id, asset, direction, target_price
    FROM price_alerts WHERE active = 1
  `).all<{ id: string; asset: string; direction: 'above' | 'below'; target_price: number }>()
  const checked = alerts.results.flatMap((alert) => {
    const price = priceByAsset.get(alert.asset)
    if (price === undefined) return []
    const meetsTarget = alert.direction === 'above' ? price >= alert.target_price : price <= alert.target_price
    return [{ ...alert, meetsTarget, price }]
  })
  if (checked.length === 0) return

  const updates = await env.DB.batch(checked.map((alert) => alert.meetsTarget
    ? env.DB.prepare(`
      UPDATE price_alerts SET is_triggered = 1, last_triggered_at = ?, updated_at = ?
      WHERE id = ? AND is_triggered = 0
    `).bind(timestamp, timestamp, alert.id)
    : env.DB.prepare(`
      UPDATE price_alerts SET is_triggered = 0, updated_at = ?
      WHERE id = ? AND is_triggered = 1
    `).bind(timestamp, alert.id)))

  await Promise.all(checked.filter((alert, index) => alert.meetsTarget && (updates[index]?.meta.changes ?? 0) > 0).map((alert) => sendPush(env, 'priceAlerts', {
    body: `${alert.asset} ${alert.direction === 'above' ? 'ถึงหรือสูงกว่า' : 'ถึงหรือต่ำกว่า'} ${currency.format(alert.target_price)} · ล่าสุด ${currency.format(alert.price)} THB`,
    tag: `price-alert-${alert.id}`,
    title: 'Moondi price alert',
  })))
}

const sendPushTest = async (env: Env, endpoint: string): Promise<boolean> => {
  const publicKey = readOptionalSecret(env, 'VAPID_PUBLIC_KEY')
  const privateKey = readOptionalSecret(env, 'VAPID_PRIVATE_KEY')
  const subject = readOptionalSecret(env, 'VAPID_SUBJECT')
  if (!publicKey || !privateKey || !subject) throw new Error('Push notifications are not configured')

  const subscription = await env.DB.prepare(`
    SELECT endpoint, p256dh, auth, notify_crypto_transfers, notify_fiat_transfers, notify_price_alerts, notify_sync_issues, notify_trades
    FROM push_subscriptions WHERE endpoint = ?
  `).bind(endpoint).first<PushSubscriptionRow>()
  if (!subscription) return false

  const delivered = await sendPushNotification(
    { endpoint: subscription.endpoint, keys: { auth: subscription.auth, p256dh: subscription.p256dh } },
    {
      body: 'Worker delivery to this device is working.',
      tag: 'moondi-worker-push-test',
      title: 'Moondi',
      url: '/',
    },
    { privateKey, publicKey, subject },
    { ttl: 60, urgency: 'high' },
  )
  if (!delivered) await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
  return delivered
}

const notifySyncStatus = async (env: Env, accountId: string, dataType: string, status: 'success' | 'deferred' | 'failure', detail: string | null): Promise<void> => {
  const changed = await updatePushState(env.DB, accountId, dataType, status, detail)
  if (!changed) return
  await sendPush(env, 'syncIssues', {
    body: `${notificationLabel[dataType] ?? dataType} ของ ${accountId} ${status === 'failure' ? 'ล้มเหลว' : 'รอการอนุญาต'}`,
    tag: `sync-${accountId}-${dataType}`,
    title: 'Moondi ต้องตรวจสอบการ sync',
  })
}

const notifyActivities = async (env: Env, notificationType: Exclude<PushNotificationType, 'priceAlerts' | 'syncIssues'>, account: Account, title: string, activities: Array<{ amount: number; asset: string; id: string }>): Promise<void> => {
  const visibleActivities = activities.slice(0, 3)
  await Promise.all(visibleActivities.map((activity) => sendPush(env, notificationType, {
    body: `${quantity.format(activity.amount)} ${activity.asset} · ${account.label}`,
    tag: `activity-${activity.id}`,
    title,
  })))
  if (activities.length > visibleActivities.length) await sendPush(env, notificationType, {
    body: `${account.label} มีรายการใหม่อีก ${activities.length - visibleActivities.length} รายการ`,
    tag: `activity-summary-${account.id}-${Date.now()}`,
    title: 'Moondi มีรายการใหม่',
  })
}

const readError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500)

const logHistoryFailure = async (env: Env, accountId: string, dataType: string, error: unknown, timestamp: number): Promise<void> => {
  const detail = readError(error)
  console.warn(JSON.stringify({
    accountId,
    dataType,
    error: detail,
    message: 'Bitkub history sync deferred',
  }))
  await saveSyncEvent(env.DB, accountId, dataType, 'deferred', detail, timestamp)
  await notifySyncStatus(env, accountId, dataType, 'deferred', detail)
}

const syncBitkubAccount = async (env: Env, account: Account, credentials: BitkubCredentials, timestamp: number): Promise<void> => {
  const adapter = new BitkubAdapter(credentials)
  const [tradesSince, cryptoSince, fiatSince, previouslyHeldAssets] = await Promise.all([
    readLastSyncedAt(env.DB, account.id, 'trades'),
    readLastSyncedAt(env.DB, account.id, 'crypto_transfers'),
    readLastSyncedAt(env.DB, account.id, 'fiat_transfers'),
    readPreviouslyHeldAssets(env.DB, account.id),
  ])
  let balances: NormalizedBalance[]

  try {
    balances = await adapter.fetchBalances()
  } catch (error) {
    const detail = readError(error)
    await saveSyncEvent(env.DB, account.id, 'balances', 'failure', detail, timestamp)
    await notifySyncStatus(env, account.id, 'balances', 'failure', detail)
    throw error
  }

  await saveBalances(env.DB, account.id, balances, timestamp)
  await saveSyncEvent(env.DB, account.id, 'balances', 'success', null, timestamp)
  await updatePushState(env.DB, account.id, 'balances', 'success', null)

  let trades: NormalizedTrade[] | undefined

  try {
    trades = await adapter.fetchTrades(
      tradesSince,
      mergeTradeAssets(previouslyHeldAssets, balances
        .filter((balance) => balance.available > 0 || balance.reserved > 0)
        .map((balance) => balance.asset)),
    )
  } catch (error) {
    await logHistoryFailure(env, account.id, 'trades', error, timestamp)
  }

  if (trades !== undefined) {
    const insertedTrades = await saveTrades(env.DB, account.id, trades)
    await saveState(env.DB, account.id, 'trades', timestamp)
    await saveSyncEvent(env.DB, account.id, 'trades', 'success', null, timestamp)
    await updatePushState(env.DB, account.id, 'trades', 'success', null)
    await notifyActivities(env, 'trades', account, 'Moondi มีประวัติซื้อ/ขายใหม่', insertedTrades.map((trade) => ({ amount: trade.amount, asset: trade.baseAsset, id: trade.id })))
  }

  let cryptoTransfers: NormalizedTransfer[] | undefined

  try {
    const deposits = await adapter.fetchDeposits(cryptoSince)
    const withdrawals = await adapter.fetchWithdrawals(cryptoSince)
    cryptoTransfers = [...deposits, ...withdrawals]
  } catch (error) {
    await logHistoryFailure(env, account.id, 'crypto_transfers', error, timestamp)
  }

  if (cryptoTransfers !== undefined) {
    const insertedTransfers = await saveCryptoTransfers(env.DB, account.id, cryptoTransfers)
    await saveState(env.DB, account.id, 'crypto_transfers', timestamp)
    await saveSyncEvent(env.DB, account.id, 'crypto_transfers', 'success', null, timestamp)
    await updatePushState(env.DB, account.id, 'crypto_transfers', 'success', null)
    await notifyActivities(env, 'cryptoTransfers', account, 'Moondi มีรายการโอนคริปโตใหม่', insertedTransfers.map((transfer) => ({ amount: transfer.amount, asset: transfer.asset, id: transfer.id })))
  }

  let fiatTransfers: NormalizedFiatTransfer[] | undefined

  try {
    const fiatDeposits = await adapter.fetchFiatDeposits?.(fiatSince) ?? []
    const fiatWithdrawals = await adapter.fetchFiatWithdrawals?.(fiatSince) ?? []
    fiatTransfers = [...fiatDeposits, ...fiatWithdrawals]
  } catch (error) {
    await logHistoryFailure(env, account.id, 'fiat_transfers', error, timestamp)
  }

  if (fiatTransfers !== undefined) {
    const insertedTransfers = await saveFiatTransfers(env.DB, account.id, fiatTransfers)
    await saveState(env.DB, account.id, 'fiat_transfers', timestamp)
    await saveSyncEvent(env.DB, account.id, 'fiat_transfers', 'success', null, timestamp)
    await updatePushState(env.DB, account.id, 'fiat_transfers', 'success', null)
    await notifyActivities(env, 'fiatTransfers', account, 'Moondi มีรายการฝาก/ถอน THB ใหม่', insertedTransfers.map((transfer) => ({ amount: transfer.amount, asset: transfer.currency, id: transfer.id })))
  }

}

const recordCredentialFailure = async (env: Env, account: Account, detail: string, timestamp: number): Promise<void> => {
  await saveSyncEvent(env.DB, account.id, 'balances', 'failure', detail, timestamp)
  await notifySyncStatus(env, account.id, 'balances', 'failure', detail)
}

const syncBitkubPrices = async (env: Env, accounts: Account[], credentials: BitkubCredentials, timestamp: number): Promise<void> => {
  if (accounts.length === 0) return
  const adapter = new BitkubAdapter(credentials)

  try {
    const prices = await adapter.fetchPrices()
    await savePrices(env.DB, prices, timestamp)
    await notifyPriceAlerts(env, prices, timestamp)
    await Promise.all(accounts.map(async (account) => {
      await saveSyncEvent(env.DB, account.id, 'prices', 'success', null, timestamp)
      await updatePushState(env.DB, account.id, 'prices', 'success', null)
    }))
  } catch (error) {
    const detail = readError(error)
    await Promise.all(accounts.map(async (account) => {
      await saveSyncEvent(env.DB, account.id, 'prices', 'failure', detail, timestamp)
      await notifySyncStatus(env, account.id, 'prices', 'failure', detail)
    }))
    throw error
  }
}

const sync = async (env: Env): Promise<void> => {
  const timestamp = Date.now()
  await pruneInactivePushSubscriptions(env.DB)
  const result = await env.DB.prepare("SELECT id, exchange, label FROM accounts WHERE exchange = 'bitkub' AND archived_at IS NULL").all<Account>()
  const accounts = result.results
  const source = parseBitkubCredentialSource(readOptionalSecret(env, 'BITKUB_ACCOUNTS_JSON'))
  const legacyApiKey = readOptionalSecret(env, 'BITKUB_API_KEY')
  const legacyApiSecret = readOptionalSecret(env, 'BITKUB_API_SECRET')
  const eligible: Array<{ account: Account; credentials: BitkubCredentials }> = []

  for (const account of accounts) {
    const credentials = resolveBitkubCredentials({
      accountCount: accounts.length,
      accountId: account.id,
      legacyApiKey,
      legacyApiSecret,
      source,
    })
    if (credentials) {
      eligible.push({ account, credentials })
    } else {
      await recordCredentialFailure(env, account, credentialIssue(source, accounts.length), timestamp)
    }
  }

  const outcomes = await Promise.allSettled(eligible.map(({ account, credentials }) => syncBitkubAccount(env, account, credentials, timestamp)))

  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      console.error(JSON.stringify({ accountId: eligible[index]?.account.id, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason), message: 'Bitkub sync failed' }))
    }
  })

  const priceCredentials = eligible[0]?.credentials
  if (!priceCredentials) return
  try {
    await syncBitkubPrices(env, eligible.map(({ account }) => account), priceCredentials, timestamp)
  } catch (error) {
    console.error(JSON.stringify({ error: readError(error), message: 'Bitkub price sync failed' }))
  }
}

const syncLockName = 'portfolio-sync'
const syncLockTtlMs = 20 * 60 * 1_000

const acquireSyncLock = async (db: D1Database, acquiredAt: number): Promise<boolean> => {
  const result = await db.prepare(`
    INSERT INTO sync_locks (name, acquired_at) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET acquired_at = excluded.acquired_at
    WHERE sync_locks.acquired_at < ?
  `).bind(syncLockName, acquiredAt, acquiredAt - syncLockTtlMs).run()
  return (result.meta.changes ?? 0) > 0
}

const startSync = async (env: Env, ctx: ExecutionContext): Promise<boolean> => {
  const acquiredAt = Date.now()
  if (!(await acquireSyncLock(env.DB, acquiredAt))) return false
  ctx.waitUntil(sync(env).finally(async () => {
    await env.DB.prepare('DELETE FROM sync_locks WHERE name = ? AND acquired_at = ?').bind(syncLockName, acquiredAt).run()
  }))
  return true
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/internal/push/test') {
      if (!hasInternalAccess(request, env)) return Response.json({ error: 'Not found' }, { status: 404 })
      const body: unknown = await request.json().catch(() => null)
      const endpoint = typeof body === 'object' && body !== null ? Reflect.get(body, 'endpoint') : undefined
      if (!isPushEndpoint(endpoint)) return Response.json({ error: 'Invalid push subscription' }, { status: 400 })

      try {
        return Response.json({ delivered: await sendPushTest(env, endpoint) })
      } catch (error) {
        console.warn(JSON.stringify({ error: readError(error), message: 'Worker push test delivery failed' }))
        return Response.json({ error: 'Push delivery failed' }, { status: 502 })
      }
    }
    if (request.method === 'POST' && url.pathname === '/internal/sync/trigger') {
      if (!hasInternalAccess(request, env)) return Response.json({ error: 'Not found' }, { status: 404 })
      const accepted = await startSync(env, ctx)
      return Response.json({ accepted }, { status: accepted ? 202 : 409 })
    }
    return Response.json({ status: 'ready' })
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    await startSync(env, ctx)
  },
} satisfies ExportedHandler<Env>
