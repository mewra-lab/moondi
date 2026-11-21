import { createFactory } from 'hono/factory'
import { readDcaActivity } from './dca-reader-response'

type BotAccount = { id: string; archived_at: number | null }
type ReaderSettings = { url?: string | undefined; token?: string | undefined; accountId?: string | undefined }

export const createDcaRoutes = ({
  getAccounts,
  getSettings,
  fetchReader = (input, init) => fetch(input, init),
}: {
  getAccounts: (env: Env) => Promise<BotAccount[]>
  getSettings: (env: Env) => ReaderSettings
  fetchReader?: typeof fetch
}) => createFactory<{ Bindings: Env }>()
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
    const settings = getSettings(c.env)
    if (!settings.url || !settings.token) return c.json({ activity: null })

    const accounts = await getAccounts(c.env)
    const botAccount = settings.accountId
      ? accounts.find((account) => account.id === settings.accountId)
      : accounts.length === 1 ? accounts[0] : undefined
    if (!botAccount || botAccount.archived_at !== null || (accountId && accountId !== botAccount.id)) {
      return c.json({ activity: null })
    }

    try {
      const endpoint = new URL(settings.url)
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
        return c.json({ error: 'DCA reader is unavailable' }, 502)
      }
      endpoint.search = new URLSearchParams({ asset, from: String(from), to: String(now) }).toString()
      const result = await fetchReader(endpoint, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${settings.token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(9_000),
      })
      if (result.ok && result.headers.get('content-type')?.startsWith('application/json')) {
        const activity = await readDcaActivity(result, from, now)
        if (activity !== undefined) return c.json({ activity })
      } else {
        await result.body?.cancel()
      }
    } catch {
      return c.json({ error: 'DCA reader is unavailable' }, 502)
    }
    return c.json({ error: 'DCA reader is unavailable' }, 502)
  })
