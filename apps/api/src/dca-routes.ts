import type { DcaActivity, DcaBuy } from '@moondi/shared'
import { createFactory } from 'hono/factory'
import { dcaMaxSignalLevels } from './dca-ingestion'

const maximumBuysPerResponse = 200

type BuyRow = {
  amount: number | null
  executed_at: number
  fee: number | null
  id: string
  price: number | null
  reason: string | null
  thb_amount: number | null
}

type SignalRow = {
  active: 0 | 1 | null
  has_error: 0 | 1
  last_seen_at: number
  levels_json: string
}

const levelPattern = /^(?:1D:)?[0-9]{1,3}(?:\.[0-9]{1,6})?$/

const readLevels = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed)
      ? parsed.filter((level): level is string => typeof level === 'string' && levelPattern.test(level)).slice(0, dcaMaxSignalLevels)
      : []
  } catch {
    return []
  }
}

const toBuy = (row: BuyRow): DcaBuy => ({
  amount: row.amount,
  executedAt: row.executed_at,
  fee: row.fee,
  id: row.id,
  price: row.price,
  reason: row.reason,
  thbAmount: row.thb_amount,
})

const toSignal = (row: SignalRow | undefined): DcaActivity['signal'] => row === undefined
  ? null
  : { active: row.active === null ? null : row.active === 1, hasError: row.has_error === 1, lastSeenAt: row.last_seen_at, levels: readLevels(row.levels_json) }

export const createDcaRoutes = () => createFactory<{ Bindings: Env }>()
  .createApp()
  .get('/:asset', async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const asset = c.req.param('asset')
    const accountId = c.req.query('account')
    const rawFrom = c.req.query('from') ?? '0'
    const from = Number(rawFrom)
    const now = Date.now()
    if (!/^[A-Z0-9_-]{1,20}$/.test(asset) || !/^\d+$/.test(rawFrom) || !Number.isSafeInteger(from) || from > now) {
      return c.json({ error: 'Invalid asset or date range' }, 400)
    }
    if (accountId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) return c.json({ error: 'Invalid asset or date range' }, 400)

    const candidates = await c.env.DB.prepare(`
      SELECT accounts.id
      FROM accounts
      WHERE accounts.exchange = 'bitkub'
        AND accounts.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM dca_bot_signals WHERE dca_bot_signals.account_id = accounts.id)
          OR EXISTS (SELECT 1 FROM dca_bot_buys WHERE dca_bot_buys.account_id = accounts.id)
        )
        ${accountId === undefined ? '' : 'AND accounts.id = ?'}
      ORDER BY accounts.id
      LIMIT 2
    `).bind(...(accountId === undefined ? [] : [accountId])).all<{ id: string }>()
    const botAccount = candidates.results.length === 1 ? candidates.results[0] : undefined
    if (!botAccount) return c.json({ activity: null })

    const [buys, signal] = await c.env.DB.batch([
      c.env.DB.prepare(`
        SELECT id, executed_at, amount, price, thb_amount, fee, reason
        FROM dca_bot_buys
        WHERE account_id = ? AND asset = ? AND executed_at >= ? AND executed_at <= ?
        ORDER BY executed_at DESC, id DESC
        LIMIT ?
      `).bind(botAccount.id, asset, from, now, maximumBuysPerResponse + 1),
      c.env.DB.prepare('SELECT last_seen_at, active, levels_json, has_error FROM dca_bot_signals WHERE account_id = ? AND asset = ?')
        .bind(botAccount.id, asset),
    ]) as [D1Result<BuyRow>, D1Result<SignalRow>]
    const activity: DcaActivity = {
      buys: buys.results.slice(0, maximumBuysPerResponse).map(toBuy),
      signal: toSignal(signal.results[0]),
      truncated: buys.results.length > maximumBuysPerResponse,
    }
    return c.json({ activity })
  })
