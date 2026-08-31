import { describe, expect, it, vi } from 'vitest'
import app from '../src/index'

describe('API worker', () => {
  it('returns health without a binding dependency', async () => {
    const response = await app.request('/health')
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('allows credentialed local development requests', async () => {
    const response = await app.request('/health', { headers: { Origin: 'http://localhost:5173' } })
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('returns to the web app after API Access authentication', async () => {
    const response = await app.request('/api/access/complete')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://localhost:5173')
  })

  it('accepts a form-encoded push subscription without requiring a CORS preflight', async () => {
    const run = vi.fn().mockResolvedValue({})
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/push/subscriptions',
      {
        body: new URLSearchParams({ subscription: JSON.stringify({ endpoint: 'https://push.example/subscription', keys: { auth: 'auth', p256dh: 'key' } }) }),
        headers: { Origin: 'http://localhost:5173' },
        method: 'POST',
      },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database, ALLOWED_ORIGIN: 'http://localhost:5173' },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      preferences: { cryptoTransfers: true, fiatTransfers: true, priceAlerts: false, syncIssues: true, trades: true },
    })
    expect(bind).toHaveBeenCalledWith(
      'https://push.example/subscription',
      'key',
      'auth',
      expect.any(Number),
      expect.any(Number),
      1,
      1,
      1,
      0,
      1,
    )
  })

  it('stores explicit push notification preferences', async () => {
    const run = vi.fn().mockResolvedValue({})
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/push/subscriptions',
      {
        body: new URLSearchParams({
          preferences: JSON.stringify({ cryptoTransfers: false, fiatTransfers: true, priceAlerts: false, syncIssues: false, trades: false }),
          subscription: JSON.stringify({ endpoint: 'https://push.example/subscription', keys: { auth: 'auth', p256dh: 'key' } }),
        }),
        method: 'POST',
      },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    await expect(response.json()).resolves.toEqual({
      ok: true,
      preferences: { cryptoTransfers: false, fiatTransfers: true, priceAlerts: false, syncIssues: false, trades: false },
    })
    expect(bind).toHaveBeenCalledWith(
      'https://push.example/subscription',
      'key',
      'auth',
      expect.any(Number),
      expect.any(Number),
      0,
      0,
      1,
      0,
      0,
    )
  })

  it('delegates a real push test to the internal sync Worker and rate-limits the device', async () => {
    const first = vi.fn().mockResolvedValue({ auth: 'auth', endpoint: 'https://push.example/subscription', p256dh: 'key' })
    const bind = vi.fn().mockReturnValue({ first })
    const prepare = vi.fn().mockReturnValue({ bind })
    const get = vi.fn().mockResolvedValue(null)
    const put = vi.fn().mockResolvedValue(undefined)
    const fetch = vi.fn().mockResolvedValue(Response.json({ delivered: true }))
    const response = await app.request(
      '/api/push/test',
      {
        body: new URLSearchParams({ endpoint: 'https://push.example/subscription' }),
        method: 'POST',
      },
      {
        CACHE: { get, put } as unknown as KVNamespace,
        DB: { prepare } as unknown as D1Database,
        INTERNAL_PUSH_TEST_TOKEN: 'test-token',
        SYNC: { fetch } as unknown as Fetcher,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledOnce()
    const request = fetch.mock.calls[0]?.[0] as Request
    expect(request.method).toBe('POST')
    expect(request.headers.get('x-moond-internal-token')).toBe('test-token')
    await expect(request.json()).resolves.toEqual({ endpoint: 'https://push.example/subscription' })
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^push-test:[a-f0-9]{64}$/), '1', { expirationTtl: 60 })
  })

  it('starts manual sync only through the internal service and records a cooldown', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const put = vi.fn().mockResolvedValue(undefined)
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'content-type': 'application/json' } }))
    const response = await app.request(
      '/api/sync/trigger',
      { method: 'POST' },
      {
        CACHE: { get, put } as unknown as KVNamespace,
        DB: {} as D1Database,
        INTERNAL_PUSH_TEST_TOKEN: 'sync-token',
        SYNC: { fetch } as unknown as Fetcher,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ accepted: true, retryAt: expect.any(Number) })
    const request = fetch.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('https://moondi.internal/internal/sync/trigger')
    expect(request.headers.get('x-moond-internal-token')).toBe('sync-token')
    expect(put).toHaveBeenCalledWith('manual-sync:cooldown', expect.any(String), { expirationTtl: 900 })
  })

  it('archives an active account without deleting its normalized history', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/accounts/bitkub-main/archive',
      { method: 'POST' },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE accounts SET archived_at'))
    expect(bind).toHaveBeenCalledWith(expect.any(Number), 'bitkub-main')
  })

  it('does not archive an account that is already disconnected', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/accounts/bitkub-main/archive',
      { method: 'POST' },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Active account not found' })
  })

  it('restores a disconnected account without changing its credential', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/accounts/bitkub-main/restore',
      { method: 'POST' },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE accounts SET archived_at = NULL'))
    expect(bind).toHaveBeenCalledWith('bitkub-main')
  })

  it('does not restore an account that is already connected', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/accounts/bitkub-main/restore',
      { method: 'POST' },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Disconnected account not found' })
  })

  it('rejects an invalid price alert without writing to D1', async () => {
    const prepare = vi.fn()
    const response = await app.request(
      '/api/price-alerts',
      { body: JSON.stringify({ asset: 'btc', direction: 'sideways', targetPrice: 0 }), headers: { 'content-type': 'application/json' }, method: 'POST' },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid price alert' })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('adds a valid 1INCH watchlist asset and reports whether it was newly created', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/watchlist',
      { body: JSON.stringify({ asset: '1inch' }), headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' }, method: 'POST' },
      { ALLOWED_ORIGIN: 'http://localhost:5173', CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    await expect(response.json()).resolves.toEqual({ asset: '1INCH', created: true })
    expect(bind).toHaveBeenCalledWith('1INCH', expect.any(Number))
  })

  it('accepts a simple form watchlist request so an Access-protected browser does not need a preflight', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/watchlist',
      { body: new URLSearchParams({ asset: 'btc' }), headers: { Origin: 'http://localhost:5173' }, method: 'POST' },
      { ALLOWED_ORIGIN: 'http://localhost:5173', CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ asset: 'BTC', created: true })
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('saves an allocation target from a simple form request', async () => {
    const first = vi.fn().mockResolvedValue({ total: 0 })
    const run = vi.fn().mockResolvedValue({})
    const bind = vi.fn().mockReturnValue({ first, run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/allocation-targets/btc',
      { body: new URLSearchParams({ targetPercent: '44.5' }), headers: { Origin: 'http://localhost:5173' }, method: 'POST' },
      { ALLOWED_ORIGIN: 'http://localhost:5173', CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ target: { asset: 'BTC', target_percent: 44.5 } })
    expect(bind).toHaveBeenCalledWith('BTC')
    expect(bind).toHaveBeenCalledWith('BTC', 44.5, expect.any(Number))
  })

  it('returns stored THB price snapshots for an asset', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ asset: 'BTC', price: 2500000, snapshot_at: 1_780_000_000_000 }] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/history/price/btc?days=7',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ asset: 'BTC', points: [{ price: 2500000, snapshot_at: 1_780_000_000_000 }] })
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('price_snapshots'))
    expect(bind).toHaveBeenCalledWith(1_800_000, 'BTC', expect.any(Number), expect.any(Number))
  })

  it('keeps five-year price-history requests instead of clamping them to one year', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })
    await app.request(
      '/api/history/price/btc?days=1827',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(bind.mock.calls[0]?.[1]).toBe('BTC')
    expect(bind.mock.calls[0]?.[2]).toBeLessThan(Date.now() - 1_800 * 24 * 60 * 60 * 1_000)
  })

  it('omits incomplete portfolio history intervals instead of valuing unpriced crypto at zero', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ snapshot_at: 1_780_000_000_000, total_value: 50000 }] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/history/value?days=1',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ points: [{ snapshot_at: 1_780_000_000_000, total_value: 50000 }] })
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('HAVING SUM(unpriced_assets) = 0'))
  })

  it('returns multiple price histories in one request for holding sparklines', async () => {
    const all = vi.fn().mockResolvedValue({ results: [
      { asset: 'BTC', price: 2500000, snapshot_at: 1_780_000_000_000 },
      { asset: 'SOL', price: 5000, snapshot_at: 1_780_000_000_000 },
    ] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/history/prices?assets=btc,sol&days=1',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ series: {
      BTC: [{ price: 2500000, snapshot_at: 1_780_000_000_000 }],
      SOL: [{ price: 5000, snapshot_at: 1_780_000_000_000 }],
    } })
    expect(bind).toHaveBeenCalledWith(1_800_000, 'BTC', 'SOL', expect.any(Number), expect.any(Number))
  })

  it('returns bounded normalized sync activity from stored events', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{
      account_id: 'bitkub-main',
      account_label: 'Bitkub Main',
      data_type: 'balances',
      detail: null,
      id: 42,
      occurred_at: 1_780_000_000_000,
      status: 'success',
    }] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/sync-events?limit=999',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ events: [{
      account_id: 'bitkub-main',
      account_label: 'Bitkub Main',
      data_type: 'balances',
      detail: null,
      id: 42,
      occurred_at: 1_780_000_000_000,
      status: 'success',
    }] })
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('FROM sync_events'))
    expect(bind).toHaveBeenCalledWith(100)
  })

  it('rejects an invalid asset price-history path', async () => {
    const response = await app.request('/api/history/price/BTC%2FTHB')
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid asset' })
  })
})
