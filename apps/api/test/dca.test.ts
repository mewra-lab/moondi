import { describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { createSqliteD1 } from './sqlite-d1.mjs'

const secret = 'test-ingestion-secret'
const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

const sign = async (timestamp: string, nonce: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${nonce}\n${body}`)))
}

let nonceCounter = 0
const signedRequest = async (path: string, payload: unknown, options: { nonce?: string; signature?: string } = {}): Promise<Request> => {
  const body = JSON.stringify(payload)
  const timestamp = String(Date.now())
  const nonce = options.nonce ?? `nonce-for-dca-test-${(nonceCounter += 1).toString().padStart(6, '0')}`
  return new Request(`https://api.example/internal/aws-sync/dca/${path}`, {
    body,
    headers: {
      'content-type': 'application/json',
      'x-moond-ingest-nonce': nonce,
      'x-moond-ingest-signature': options.signature ?? await sign(timestamp, nonce, body),
      'x-moond-ingest-timestamp': timestamp,
    },
    method: 'POST',
  })
}

const setup = (options: { pushToken?: string | undefined } = { pushToken: 'push-token' }) => {
  const { d1, database } = createSqliteD1()
  database.exec(`
    INSERT INTO accounts (id, exchange, label, owner_email, created_at) VALUES
      ('bot', 'bitkub', 'Bot', 'owner@example.test', 1),
      ('other', 'bitkub', 'Other', 'owner@example.test', 1);
  `)
  const pending: Promise<unknown>[] = []
  const push = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
  const env = {
    AWS_SYNC_INGESTION_SECRET: secret,
    CACHE: {} as KVNamespace,
    DB: d1,
    INTERNAL_PUSH_TEST_TOKEN: options.pushToken,
    SYNC: { fetch: push } as unknown as Fetcher,
  }
  const executionCtx = { passThroughOnException: () => undefined, waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } } as unknown as ExecutionContext
  return {
    database,
    get: (path: string) => app.request(path, undefined, env, executionCtx),
    post: async (request: Request) => {
      const response = await app.request(request, undefined, env, executionCtx)
      await Promise.all(pending)
      return response
    },
    push,
  }
}

const buy = (id: string, overrides: Record<string, unknown> = {}) => ({
  amount: 0.01, asset: 'BTC', executedAt: Date.now() - 60_000, fee: 0.5, id, price: 1_000_000, reason: 'Fibo 0.618', thbAmount: 10_000, ...overrides,
})
const signal = (overrides: Record<string, unknown> = {}) => ({ active: true, asset: 'BTC', hasError: false, lastSeenAt: Date.now() - 1_000, levels: ['0.618'], ...overrides })
const activity = (overrides: Record<string, unknown> = {}) => ({ accountId: 'bot', buys: [buy('buy-1')], signals: [signal()], syncAt: Date.now() - 1_000, ...overrides })

const rows = (database: ReturnType<typeof setup>['database'], table: string): Record<string, unknown>[] => database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all() as Record<string, unknown>[]

describe('DCA bot ingestion', () => {
  it('stores buys and signals, then pushes one notification for a new recent buy', async () => {
    const { database, post, push } = setup()
    const response = await post(await signedRequest('activity', activity()))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ buyCount: 1, ingested: true, signalCount: 1 })
    expect(rows(database, 'dca_bot_buys')).toHaveLength(1)
    expect(rows(database, 'dca_bot_signals')).toMatchObject([{ active: 1, asset: 'BTC', has_error: 0, levels_json: '["0.618"]' }])
    expect(push).toHaveBeenCalledOnce()
    const [url, init] = push.mock.calls[0]!
    expect(String(url)).toBe('https://moondi.internal/internal/push/dca')
    expect(init?.headers).toMatchObject({ 'x-moond-internal-token': 'push-token' })
    expect(JSON.parse(String(init?.body))).toEqual({ buys: [{ amount: 0.01, asset: 'BTC', id: 'buy-1', reason: 'Fibo 0.618', thbAmount: 10_000 }], total: 1 })
  })

  it('is idempotent and does not push the same buy twice', async () => {
    const { database, post, push } = setup()
    await post(await signedRequest('activity', activity()))
    const again = await post(await signedRequest('activity', activity()))

    expect(again.status).toBe(200)
    expect(rows(database, 'dca_bot_buys')).toHaveLength(1)
    expect(push).toHaveBeenCalledOnce()
  })

  it('updates reported fill values of a known buy without pushing', async () => {
    const { database, post, push } = setup()
    await post(await signedRequest('activity', activity({ buys: [buy('buy-1', { amount: null, price: null })] })))
    push.mockClear()
    await post(await signedRequest('activity', activity({ buys: [buy('buy-1', { amount: 0.02, price: 900_000 })] })))

    expect(rows(database, 'dca_bot_buys')).toMatchObject([{ amount: 0.02, id: 'buy-1', price: 900_000 }])
    expect(push).not.toHaveBeenCalled()
  })

  it('does not push for a backfill of old buys', async () => {
    const { database, post, push } = setup()
    const old = Date.now() - 3 * 24 * 60 * 60 * 1_000
    await post(await signedRequest('activity', activity({ buys: [buy('old-1', { executedAt: old }), buy('old-2', { executedAt: old - 1_000 })], signals: [] })))

    expect(rows(database, 'dca_bot_buys')).toHaveLength(2)
    expect(push).not.toHaveBeenCalled()
  })

  it('limits one push burst to three buys and reports the total', async () => {
    const { post, push } = setup()
    const buys = Array.from({ length: 5 }, (_, index) => buy(`buy-${index}`, { executedAt: Date.now() - 1_000 * (index + 1) }))
    await post(await signedRequest('activity', activity({ buys, signals: [] })))

    const body = JSON.parse(String(push.mock.calls[0]![1]?.body)) as { buys: { id: string }[]; total: number }
    expect(body.total).toBe(5)
    expect(body.buys.map((item) => item.id)).toEqual(['buy-0', 'buy-1', 'buy-2'])
  })

  it('stays silent when no internal push token is configured', async () => {
    const { database, post, push } = setup({ pushToken: undefined })
    const response = await post(await signedRequest('activity', activity()))

    expect(response.status).toBe(200)
    expect(rows(database, 'dca_bot_buys')).toHaveLength(1)
    expect(push).not.toHaveBeenCalled()
  })

  it('does not let an older heartbeat overwrite a newer signal', async () => {
    const { database, post } = setup()
    await post(await signedRequest('activity', activity({ buys: [], signals: [signal({ lastSeenAt: Date.now() - 1_000, levels: ['0.5'] })] })))
    await post(await signedRequest('activity', activity({ buys: [], signals: [signal({ lastSeenAt: Date.now() - 20_000, levels: ['0.9'] })] })))

    expect(rows(database, 'dca_bot_signals')).toMatchObject([{ levels_json: '["0.5"]' }])
  })

  it('drops the signal of an asset the bot no longer reports', async () => {
    const { database, post } = setup()
    const seen = Date.now() - 20_000
    await post(await signedRequest('activity', activity({ buys: [], signals: [signal({ lastSeenAt: seen }), signal({ asset: 'ETH', lastSeenAt: seen })] })))
    await post(await signedRequest('activity', activity({ buys: [], signals: [signal({ lastSeenAt: seen + 10_000 })] })))

    expect(rows(database, 'dca_bot_signals')).toMatchObject([{ asset: 'BTC', last_seen_at: seen + 10_000 }])
  })

  it('keeps every signal of the latest heartbeat and ignores an older payload arriving late', async () => {
    const { database, post } = setup()
    const seen = Date.now() - 20_000
    await post(await signedRequest('activity', activity({ buys: [], signals: [signal({ lastSeenAt: seen }), signal({ asset: 'ETH', lastSeenAt: seen })] })))
    await post(await signedRequest('activity', activity({ buys: [], signals: [signal({ asset: 'DOGE', lastSeenAt: seen - 10_000 })] })))

    expect(rows(database, 'dca_bot_signals').map((row) => row.asset)).toEqual(['BTC', 'DOGE', 'ETH'])
  })

  it('rejects a bad signature, writes nothing, and does not consume the nonce', async () => {
    const { database, post } = setup()
    const forged = await signedRequest('activity', activity(), { nonce: 'forged-nonce-0000001', signature: 'a'.repeat(64) })
    const response = await post(forged)

    expect(response.status).toBe(404)
    expect(rows(database, 'dca_bot_buys')).toHaveLength(0)
    expect(rows(database, 'aws_ingestion_nonces')).toHaveLength(0)
  })

  it('rejects a replayed request', async () => {
    const { database, post } = setup()
    const first = await post(await signedRequest('activity', activity(), { nonce: 'replayed-nonce-000001' }))
    const second = await post(await signedRequest('activity', activity({ buys: [buy('buy-2')] }), { nonce: 'replayed-nonce-000001' }))

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(rows(database, 'dca_bot_buys')).toHaveLength(1)
  })

  it.each([
    ['an unknown account', activity({ accountId: 'nobody' }), 404],
    ['an archived account', activity(), 404],
    ['a free-text reason', activity({ buys: [buy('buy-1', { reason: 'run this' })] }), 400],
    ['a payload without any data', activity({ buys: [], signals: [] }), 400],
  ])('rejects %s without writing', async (name, payload, status) => {
    const { database, post } = setup()
    if (name === 'an archived account') database.exec("UPDATE accounts SET archived_at = 2 WHERE id = 'bot'")
    const response = await post(await signedRequest('activity', payload))

    expect(response.status).toBe(status)
    expect(rows(database, 'dca_bot_buys')).toHaveLength(0)
    expect(rows(database, 'dca_bot_signals')).toHaveLength(0)
  })

  it('reports the latest stored buy so the Lambda can resume', async () => {
    const { post } = setup()
    const empty = await post(await signedRequest('state', { accountId: 'bot' }))
    expect(await empty.json()).toEqual({ latestBuyAt: null })

    const executedAt = Date.now() - 5_000
    await post(await signedRequest('activity', activity({ buys: [buy('a', { executedAt: executedAt - 100 }), buy('b', { executedAt })], signals: [] })))
    const state = await post(await signedRequest('state', { accountId: 'bot' }))
    expect(await state.json()).toEqual({ latestBuyAt: executedAt })
  })
})

describe('DCA activity read route', () => {
  const seed = (database: ReturnType<typeof setup>['database']) => {
    database.exec(`
      INSERT INTO dca_bot_buys (account_id, id, asset, executed_at, amount, price, thb_amount, fee, reason) VALUES
        ('bot', 'b1', 'BTC', 1000, 0.01, 100, 1, 0.1, 'Signal'),
        ('bot', 'b2', 'BTC', 2000, NULL, NULL, 2, NULL, NULL),
        ('bot', 'e1', 'ETH', 1500, 1, 10, 10, 0, 'DCA');
      INSERT INTO dca_bot_signals (account_id, asset, last_seen_at, active, levels_json, has_error) VALUES
        ('bot', 'BTC', 3000, 1, '["0.5","1D:0.618"]', 0);
    `)
  }

  it('returns null when no account has bot data', async () => {
    const { get } = setup()
    const response = await get('/api/dca/activity/BTC')
    expect(await response.json()).toEqual({ activity: null })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns the normalized buys and signal of the bot account', async () => {
    const { database, get } = setup()
    seed(database)
    const response = await get('/api/dca/activity/BTC?from=0')

    expect(await response.json()).toEqual({
      activity: {
        buys: [
          { amount: null, executedAt: 2000, fee: null, id: 'b2', price: null, reason: null, thbAmount: 2 },
          { amount: 0.01, executedAt: 1000, fee: 0.1, id: 'b1', price: 100, reason: 'Signal', thbAmount: 1 },
        ],
        signal: { active: true, hasError: false, lastSeenAt: 3000, levels: ['0.5', '1D:0.618'] },
        truncated: false,
      },
    })
  })

  it('applies the requested start and keeps other assets out', async () => {
    const { database, get } = setup()
    seed(database)
    const body = await (await get('/api/dca/activity/BTC?from=1500')).json() as { activity: { buys: { id: string }[] } }
    expect(body.activity.buys.map((item) => item.id)).toEqual(['b2'])
    const eth = await (await get('/api/dca/activity/ETH')).json() as { activity: { buys: { id: string }[]; signal: unknown } }
    expect(eth.activity.buys.map((item) => item.id)).toEqual(['e1'])
    expect(eth.activity.signal).toBeNull()
  })

  it('flags a truncated list after 200 buys', async () => {
    const { database, get } = setup()
    const insert = database.prepare("INSERT INTO dca_bot_buys (account_id, id, asset, executed_at) VALUES ('bot', ?, 'BTC', ?)")
    for (let index = 0; index < 201; index += 1) insert.run(`buy-${index}`, 1_000 + index)
    const body = await (await get('/api/dca/activity/BTC')).json() as { activity: { buys: unknown[]; truncated: boolean } }
    expect(body.activity.buys).toHaveLength(200)
    expect(body.activity.truncated).toBe(true)
  })

  it('requires an explicit account when several accounts have bot data, and ignores archived ones', async () => {
    const { database, get } = setup()
    seed(database)
    database.exec("INSERT INTO dca_bot_buys (account_id, id, asset, executed_at) VALUES ('other', 'o1', 'BTC', 5)")

    expect(await (await get('/api/dca/activity/BTC')).json()).toEqual({ activity: null })
    const scoped = await (await get('/api/dca/activity/BTC?account=other')).json() as { activity: { buys: { id: string }[] } }
    expect(scoped.activity.buys.map((item) => item.id)).toEqual(['o1'])

    database.exec("UPDATE accounts SET archived_at = 9 WHERE id = 'other'")
    const afterArchive = await (await get('/api/dca/activity/BTC')).json() as { activity: { buys: { id: string }[] } }
    expect(afterArchive.activity.buys.map((item) => item.id)).toEqual(['b2', 'b1'])
    expect(await (await get('/api/dca/activity/BTC?account=other')).json()).toEqual({ activity: null })
  })

  it.each(['/api/dca/activity/btc', '/api/dca/activity/BTC?from=-1', '/api/dca/activity/BTC?from=abc', '/api/dca/activity/BTC?account=a%20b', '/api/dca/activity/BTC?from=99999999999999'])('rejects %s', async (path) => {
    const { get } = setup()
    expect((await get(path)).status).toBe(400)
  })
})
