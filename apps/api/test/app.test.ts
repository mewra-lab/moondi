import { describe, expect, it, vi } from 'vitest'
import app from '../src/index'

const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

const signAwsIngestion = async (secret: string, timestamp: string, nonce: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${nonce}\n${body}`)))
}

const awsIngestionRequest = async (
  body: string,
  path = '/internal/aws-sync/bitkub/balances',
  secret = 'test-ingestion-secret',
  nonce = 'nonce-for-test-1234',
): Promise<Request> => {
  const timestamp = String(Date.now())
  return new Request(`https://api.example${path}`, {
    body,
    headers: {
      'content-type': 'application/json',
      'x-moond-ingest-nonce': nonce,
      'x-moond-ingest-signature': await signAwsIngestion(secret, timestamp, nonce, body),
      'x-moond-ingest-timestamp': timestamp,
    },
    method: 'POST',
  })
}

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

  it('rejects cross-origin state changes even when they use simple form requests', async () => {
    const prepare = vi.fn()
    const response = await app.request(
      '/api/watchlist',
      { body: new URLSearchParams({ asset: 'BTC' }), headers: { Origin: 'https://attacker.example' }, method: 'POST' },
      { ALLOWED_ORIGIN: 'https://portfolio.example', CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Origin not allowed' })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects cross-site state changes when the browser omits Origin', async () => {
    const prepare = vi.fn()
    const response = await app.request(
      '/api/watchlist',
      { body: new URLSearchParams({ asset: 'BTC' }), headers: { 'Sec-Fetch-Site': 'cross-site' }, method: 'POST' },
      { ALLOWED_ORIGIN: 'https://portfolio.example', CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('ingests a bounded, signed AWS balance snapshot without exposing credentials', async () => {
    const snapshotAt = Date.now()
    const accountFirst = vi.fn().mockResolvedValue({ id: 'bitkub-main' })
    const cleanupRun = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const claimRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const batch = vi.fn().mockResolvedValue([])
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT id FROM accounts')) return { bind: vi.fn(() => ({ first: accountFirst })) }
      if (query.includes('DELETE FROM aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: cleanupRun })) }
      if (query.includes('INSERT INTO aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: claimRun })) }
      if (query.includes('FROM price_cache')) return { bind: vi.fn(() => ({ all: vi.fn().mockResolvedValue({ results: [{ asset: 'BTC', price: 2_000_000, updated_at: snapshotAt }] }) })) }
      return { bind: vi.fn(() => ({ run: vi.fn() })) }
    })
    const body = JSON.stringify({
      accountId: 'bitkub-main',
      balances: [{ asset: 'BTC', available: 1.25, reserved: 0 }],
      snapshotAt,
    })
    const request = await awsIngestionRequest(body)

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ingested: true, snapshotAt: expect.any(Number) })
    expect(batch).toHaveBeenCalledOnce()
    expect(claimRun).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO portfolio_value_snapshots'))
  })

  it('rejects an unsigned AWS ingestion request before touching D1', async () => {
    const prepare = vi.fn()
    const response = await app.request(
      '/internal/aws-sync/bitkub/balances',
      { body: JSON.stringify({}), method: 'POST' },
      { AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret', CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(404)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects an oversized signed ingestion body before buffering it', async () => {
    const body = JSON.stringify({ padding: 'x'.repeat(512 * 1_024) })
    const request = await awsIngestionRequest(body)
    const prepare = vi.fn()

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: {} as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(413)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('does not persist a portfolio value when a positive holding has no fresh price', async () => {
    const snapshotAt = Date.now()
    const batch = vi.fn().mockResolvedValue([])
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT id FROM accounts')) return { bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue({ id: 'bitkub-main' }) })) }
      if (query.includes('DELETE FROM aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }) })) }
      if (query.includes('INSERT INTO aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) })) }
      if (query.includes('FROM price_cache')) return { bind: vi.fn(() => ({ all: vi.fn().mockResolvedValue({ results: [] }) })) }
      return { bind: vi.fn(() => ({ run: vi.fn() })) }
    })
    const request = await awsIngestionRequest(JSON.stringify({
      accountId: 'bitkub-main',
      balances: [{ asset: 'BTC', available: 1, reserved: 0 }],
      snapshotAt,
    }))

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO portfolio_value_snapshots'))
  })

  it('rejects an already-consumed AWS ingestion nonce', async () => {
    const accountFirst = vi.fn().mockResolvedValue({ id: 'bitkub-main' })
    const cleanupRun = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const claimRun = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const batch = vi.fn()
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT id FROM accounts')) return { bind: vi.fn(() => ({ first: accountFirst })) }
      if (query.includes('DELETE FROM aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: cleanupRun })) }
      if (query.includes('INSERT INTO aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: claimRun })) }
      return { bind: vi.fn() }
    })
    const body = JSON.stringify({
      accountId: 'bitkub-main',
      balances: [{ asset: 'THB', available: 100, reserved: 0 }],
      snapshotAt: Date.now(),
    })
    const request = await awsIngestionRequest(body, '/internal/aws-sync/bitkub/balances', 'test-ingestion-secret', 'replayed-nonce-1234')

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Replay rejected' })
    expect(batch).not.toHaveBeenCalled()
  })

  it('returns incremental AWS checkpoints with one indexed state query', async () => {
    const accountFirst = vi.fn().mockResolvedValue({ id: 'bitkub-main' })
    const cleanupRun = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const claimRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT id FROM accounts')) return { bind: vi.fn(() => ({ first: accountFirst })) }
      if (query.includes('DELETE FROM aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: cleanupRun })) }
      if (query.includes('INSERT INTO aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: claimRun })) }
      if (query.includes('SELECT data_type, last_synced_at FROM sync_state')) {
        return { bind: vi.fn(() => ({ all: vi.fn().mockResolvedValue({ results: [{ data_type: 'trades', last_synced_at: 123 }] }) })) }
      }
      return { bind: vi.fn(() => ({ run: vi.fn() })) }
    })
    const request = await awsIngestionRequest(
      JSON.stringify({ accountId: 'bitkub-main' }),
      '/internal/aws-sync/bitkub/state',
    )

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: {} as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      cryptoTransfersSince: null,
      fiatTransfersSince: null,
      tradesSince: 123,
    })
    expect(prepare.mock.calls.filter(([query]) => String(query).includes('sync_state'))).toHaveLength(1)
    expect(prepare.mock.calls.some(([query]) => String(query).includes('balance_snapshots'))).toBe(false)
    expect(prepare.mock.calls.some(([query]) => String(query).includes('FROM trades'))).toBe(false)
  })

  it('persists normalized AWS trade history and advances only its checkpoint', async () => {
    const accountFirst = vi.fn().mockResolvedValue({ id: 'bitkub-main' })
    const cleanupRun = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const claimRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const batch = vi.fn().mockResolvedValue([])
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT id FROM accounts')) return { bind: vi.fn(() => ({ first: accountFirst })) }
      if (query.includes('DELETE FROM aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: cleanupRun })) }
      if (query.includes('INSERT INTO aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: claimRun })) }
      return { bind: vi.fn(() => ({ run: vi.fn() })) }
    })
    const syncAt = Date.now()
    const request = await awsIngestionRequest(
      JSON.stringify({
        accountId: 'bitkub-main',
        complete: true,
        dataType: 'trades',
        records: [{ amount: 0.1, baseAsset: 'BTC', executedAt: syncAt - 1_000, fee: 1, feeAsset: 'THB', id: 'BTCBUY1', price: 1_000_000, quoteAmount: 100_000, quoteAsset: 'THB', side: 'buy' }],
        syncAt,
      }),
      '/internal/aws-sync/bitkub/history',
    )

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ complete: true, dataType: 'trades', ingested: true, recordCount: 1, syncAt })
    expect(batch).toHaveBeenCalledOnce()
    expect(claimRun).toHaveBeenCalledOnce()
  })

  it('does not advance an AWS history checkpoint before the final chunk', async () => {
    const batch = vi.fn().mockResolvedValue([])
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT id FROM accounts')) return { bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue({ id: 'bitkub-main' }) })) }
      if (query.includes('DELETE FROM aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }) })) }
      if (query.includes('INSERT INTO aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) })) }
      return { bind: vi.fn(() => ({ run: vi.fn() })) }
    })
    const syncAt = Date.now()
    const request = await awsIngestionRequest(
      JSON.stringify({
        accountId: 'bitkub-main',
        complete: false,
        dataType: 'trades',
        records: [{ amount: 0.1, baseAsset: 'BTC', executedAt: syncAt - 1_000, fee: 1, feeAsset: 'THB', id: 'BTCBUY1', price: 1_000_000, quoteAmount: 100_000, quoteAsset: 'THB', side: 'buy' }],
        syncAt,
      }),
      '/internal/aws-sync/bitkub/history',
    )

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ complete: false, dataType: 'trades', ingested: true, recordCount: 1, syncAt })
    expect(prepare.mock.calls.some(([query]) => String(query).includes('INSERT INTO sync_state'))).toBe(false)
    expect(prepare.mock.calls.some(([query]) => String(query).includes('INSERT INTO sync_events'))).toBe(false)
  })

  it('caches the expensive value-history aggregation in KV', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all })) }))
    const get = vi.fn().mockResolvedValue(null)
    const put = vi.fn().mockResolvedValue(undefined)

    const response = await app.request('/api/history/value?days=30', undefined, {
      CACHE: { get, put } as unknown as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ points: [] })
    expect(get).toHaveBeenCalledOnce()
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^value-history:v3:all:/), '[]', { expirationTtl: 300 })
    expect(all).toHaveBeenCalledOnce()
  })

  it('includes the current half-hour in default history bounds', async () => {
    const now = Date.UTC(2026, 8, 3, 4, 9)
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    const all = vi.fn().mockResolvedValue({ results: [] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })

    try {
      const response = await app.request('/api/history/value?days=1', undefined, {
        CACHE: {} as KVNamespace,
        DB: { prepare } as unknown as D1Database,
      })
      expect(response.status).toBe(200)
      expect(bind.mock.calls[0]?.[1]).toBe(now - (now % 1_800_000) + 1_800_000 - 1)
    } finally {
      dateNow.mockRestore()
    }
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

  it('rejects malformed or oversized push subscription fields before writing to D1', async () => {
    const prepare = vi.fn()
    const response = await app.request(
      '/api/push/subscriptions',
      {
        body: new URLSearchParams({ subscription: JSON.stringify({ endpoint: 'https://[invalid', keys: { auth: 'auth', p256dh: 'key' } }) }),
        method: 'POST',
      },
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid push subscription' })
    expect(prepare).not.toHaveBeenCalled()
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

  it('does not send a manual private Bitkub request from Cloudflare in AWS ingestion mode', async () => {
    const fetch = vi.fn()
    const response = await app.request(
      '/api/sync/trigger',
      { method: 'POST' },
      {
        BITKUB_SECURE_SYNC_MODE: 'aws-ingest',
        CACHE: {} as KVNamespace,
        DB: {} as D1Database,
        INTERNAL_PUSH_TEST_TOKEN: 'sync-token',
        SYNC: { fetch } as unknown as Fetcher,
      },
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'Manual secure sync runs on the AWS schedule' })
    expect(fetch).not.toHaveBeenCalled()
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
    const query = prepare.mock.calls[0]?.[0] as string
    expect(query).toContain('price_snapshots')
    expect(query).not.toContain('GROUP BY')
    expect(query).not.toContain('ROW_NUMBER()')
    expect(bind).toHaveBeenCalledWith('BTC', expect.any(Number), expect.any(Number))
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

  it('reads portfolio history from precomputed values and omits incomplete account intervals', async () => {
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
    const query = prepare.mock.calls[0]?.[0] as string
    expect(query).toContain('FROM portfolio_value_snapshots')
    expect(query).not.toContain('FROM balance_snapshots')
    expect(query).not.toContain('FROM price_snapshots')
    expect(query).toContain('COUNT(*) AS account_count')
    expect(query).toContain('SELECT COUNT(*) FROM scoped_accounts')
  })

  it('builds current holdings from one complete latest account snapshot', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const prepare = vi.fn().mockReturnValue({ all })
    const response = await app.request(
      '/api/portfolio',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    const query = prepare.mock.calls[0]?.[0] as string
    expect(query).toContain('WHERE candidate.account_id = accounts.id')
    expect(query).toContain('balances.snapshot_at AS updated_at')
    expect(query).not.toContain('GROUP BY')
  })

  it('uses the cursor id as the deterministic transaction tie breaker', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/transactions?limit=50',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    const query = String(prepare.mock.calls[0]?.[0])
    expect(query).toContain('ORDER BY records.executed_at DESC, records.id DESC')
    expect(query.match(/ORDER BY source\.executed_at DESC, source\.id DESC/g)).toHaveLength(3)
    expect(bind).toHaveBeenCalledWith(50, 50, 50, 50)
  })

  it('queries only the selected transaction table', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const prepare = vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all }) })

    const response = await app.request('/api/transactions?type=trade&limit=50', undefined, {
      CACHE: {} as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    const query = String(prepare.mock.calls[0]?.[0])
    expect(query).toContain('FROM trades AS source')
    expect(query).not.toContain('FROM crypto_transfers AS source')
    expect(query).not.toContain('FROM fiat_transfers AS source')
  })

  it('rejects a malformed transaction cursor instead of silently restarting pagination', async () => {
    const prepare = vi.fn()
    const response = await app.request(
      '/api/transactions?cursor=not-base64',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid transaction cursor' })
    expect(prepare).not.toHaveBeenCalled()
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
    expect(bind).toHaveBeenCalledWith('BTC', 'SOL', expect.any(Number), expect.any(Number))
  })

  it('hashes large price-history cache identities into a bounded KV key', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all })) }))
    const get = vi.fn().mockResolvedValue(null)
    const put = vi.fn().mockResolvedValue(undefined)
    const assets = Array.from({ length: 96 }, (_value, index) => `TOKEN${String(index).padStart(3, '0')}`).join(',')

    const response = await app.request(`/api/history/prices?assets=${assets}&days=1`, undefined, {
      CACHE: { get, put } as unknown as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    const key = String(get.mock.calls[0]?.[0])
    expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(512)
    expect(key).toMatch(/^price-history:v3:[a-f0-9]{64}:/)
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
