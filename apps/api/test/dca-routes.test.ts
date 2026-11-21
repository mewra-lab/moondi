import { describe, expect, it, vi } from 'vitest'
import { createDcaRoutes } from '../src/dca-routes'

const reader = { url: 'https://reader.example.test/', token: 'synthetic-token' }
const fixture = { activity: { buys: [], signal: null, truncated: false } }

describe('DCA activity', () => {
  it('uses the sole Bitkub account and relays only an authenticated HTTPS request', async () => {
    const fetchReader = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture))
    const app = createDcaRoutes({
      getAccounts: async () => [{ id: 'bot', archived_at: null }],
      getSettings: () => reader,
      fetchReader,
    })
    const result = await app.request('/BTC?account=bot&from=123')
    expect(result.status).toBe(200)
    expect(result.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await result.json()).toEqual(fixture)
    const [requestUrl, options] = fetchReader.mock.calls[0]!
    expect(String(requestUrl)).toMatch(/^https:\/\/reader\.example\.test\/\?asset=BTC&from=123&to=\d+$/)
    expect(options).toMatchObject({ headers: { Authorization: 'Bearer synthetic-token' }, redirect: 'manual' })
  })

  it('requires an explicit account mapping once another Bitkub account exists', async () => {
    const getAccounts = async () => [{ id: 'bot', archived_at: null }, { id: 'other', archived_at: 123 }]
    const fetchReader = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture))
    const ambiguous = createDcaRoutes({ getAccounts, getSettings: () => reader, fetchReader })
    const mapped = createDcaRoutes({ getAccounts, getSettings: () => ({ ...reader, accountId: 'bot' }), fetchReader })
    const archived = createDcaRoutes({ getAccounts, getSettings: () => ({ ...reader, accountId: 'other' }), fetchReader })

    for (const [app, path] of [[ambiguous, '/BTC'], [mapped, '/BTC?account=other'], [archived, '/BTC']] as const) {
      expect(await (await app.request(path)).json()).toEqual({ activity: null })
    }
    expect(fetchReader).not.toHaveBeenCalled()
    expect(await (await mapped.request('/BTC')).json()).toEqual(fixture)
  })

  it('rejects invalid inputs and hides details of upstream failures', async () => {
    const fetchReader = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'private database detail' }, { status: 503 }))
    const app = createDcaRoutes({
      getAccounts: async () => [{ id: 'bot', archived_at: null }],
      getSettings: () => reader,
      fetchReader,
    })
    expect((await app.request('/BTC?from=-1')).status).toBe(400)
    expect(fetchReader).not.toHaveBeenCalled()
    const result = await app.request('/BTC')
    expect(result.status).toBe(502)
    expect(await result.json()).toEqual({ error: 'DCA reader is unavailable' })
  })

  it('returns only the normalized buy and signal fields', async () => {
    const buy = { id: 'buy-1', executedAt: 123, amount: 0.01, price: 500, thbAmount: 5, fee: null, reason: 'Signal' }
    const signal = { lastSeenAt: 456, active: true, levels: ['0.69'], hasError: false }
    const fetchReader = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      activity: { buys: [{ ...buy, upstream: 'discarded' }], signal: { ...signal, metadata: 'discarded' }, truncated: false },
      diagnostics: 'discarded',
    }))
    const app = createDcaRoutes({
      getAccounts: async () => [{ id: 'bot', archived_at: null }],
      getSettings: () => reader,
      fetchReader,
    })
    const result = await app.request('/BTC?from=123')
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ activity: { buys: [buy], signal, truncated: false } })
  })

  it('treats malformed and oversized successful reads as an unavailable feed', async () => {
    const fetchReader = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ activity: { buys: null, signal: null, truncated: false } }))
      .mockResolvedValueOnce(Response.json({ ...fixture, padding: 'x'.repeat(128 * 1024) }))
    const app = createDcaRoutes({
      getAccounts: async () => [{ id: 'bot', archived_at: null }],
      getSettings: () => reader,
      fetchReader,
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await app.request('/BTC')
      expect(result.status).toBe(502)
      expect(await result.json()).toEqual({ error: 'DCA reader is unavailable' })
    }
  })
})
