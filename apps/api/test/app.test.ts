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
      balances: [{ asset: 'BTC', available: 1.25, reserved: 0 }, { asset: 'THB', available: 0, reserved: 0 }],
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
      balances: [{ asset: 'BTC', available: 1, reserved: 0 }, { asset: 'THB', available: 0, reserved: 0 }],
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
      if (query.includes('SELECT data_type, last_synced_at, covered_from FROM sync_state')) {
        return { bind: vi.fn(() => ({ all: vi.fn().mockResolvedValue({ results: [
          { covered_from: 100, data_type: 'trades', last_synced_at: 123 },
          { covered_from: 120, data_type: 'crypto_transfers', last_synced_at: 130 },
        ] }) })) }
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
      cryptoTransfersCoveredFrom: 120,
      cryptoTransfersSince: 130,
      fiatTransfersCoveredFrom: null,
      fiatTransfersSince: null,
      historyCoverageAnchor: 100,
      tradesCoveredFrom: 100,
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
        coveredFrom: syncAt - 90 * 24 * 60 * 60 * 1_000,
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
    expect(prepare.mock.calls.some(([query]) => String(query).includes('fee = excluded.fee'))).toBe(true)
    expect(prepare.mock.calls.some(([query]) => String(query).includes('quote_amount = excluded.quote_amount'))).toBe(true)
  })

  it('uses a unique P&L revision for each completed history mutation in the same sync cycle', async () => {
    const batch = vi.fn().mockResolvedValue([])
    const put = vi.fn().mockResolvedValue(undefined)
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT id FROM accounts')) return { bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue({ id: 'bitkub-main' }) })) }
      if (query.includes('DELETE FROM aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }) })) }
      if (query.includes('INSERT INTO aws_ingestion_nonces')) return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) })) }
      return { bind: vi.fn(() => ({ run: vi.fn() })) }
    })
    const syncAt = Date.now()
    const env = {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: { put } as unknown as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    }
    const requestFor = (dataType: 'trades' | 'crypto_transfers', nonce: string) => awsIngestionRequest(
      JSON.stringify({ accountId: 'bitkub-main', complete: true, coveredFrom: syncAt - 1, dataType, records: [], syncAt }),
      '/internal/aws-sync/bitkub/history',
      'test-ingestion-secret',
      nonce,
    )

    expect((await app.request(await requestFor('trades', 'same-cycle-trades'), undefined, env)).status).toBe(200)
    expect((await app.request(await requestFor('crypto_transfers', 'same-cycle-crypto'), undefined, env)).status).toBe(200)

    const revisions = put.mock.calls
      .filter(([key]) => key === 'bitkub-pnl:revision:v1:bitkub-main')
      .map(([, value]) => value)
    expect(revisions).toHaveLength(2)
    expect(new Set(revisions).size).toBe(2)
    expect(revisions.every((value) => String(value).startsWith(`${syncAt}:`))).toBe(true)
  })

  it('does not advance an AWS history checkpoint before the final chunk', async () => {
    const batch = vi.fn().mockResolvedValue([])
    const put = vi.fn().mockResolvedValue(undefined)
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
        coveredFrom: syncAt - 90 * 24 * 60 * 60 * 1_000,
        dataType: 'trades',
        records: [{ amount: 0.1, baseAsset: 'BTC', executedAt: syncAt - 1_000, fee: 1, feeAsset: 'THB', id: 'BTCBUY1', price: 1_000_000, quoteAmount: 100_000, quoteAsset: 'THB', side: 'buy' }],
        syncAt,
      }),
      '/internal/aws-sync/bitkub/history',
    )

    const response = await app.request(request, undefined, {
      AWS_SYNC_INGESTION_SECRET: 'test-ingestion-secret',
      CACHE: { put } as unknown as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ complete: false, dataType: 'trades', ingested: true, recordCount: 1, syncAt })
    expect(prepare.mock.calls.some(([query]) => String(query).includes('INSERT INTO sync_state'))).toBe(false)
    expect(prepare.mock.calls.some(([query]) => String(query).includes('INSERT INTO sync_events'))).toBe(false)
    expect(put).not.toHaveBeenCalled()
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
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^value-history:v8:/), '[]', { expirationTtl: 300 })
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

  it('derives an asset price chart’s historical average cost from the completed Bitkub ledger only when requested', async () => {
    const trade = { account_id: 'bitkub-main', amount: 1, base_asset: 'BTC', executed_at: 50, fee: 0, fee_asset: 'THB', id: 'buy-btc', price: 100, quote_amount: 100, quote_asset: 'THB', side: 'buy' }
    const prepare = vi.fn((query: string) => {
      const results = query.includes('FROM price_snapshots')
        ? [{ asset: 'BTC', price: 150, snapshot_at: 100 }]
        : query.includes('bitkub_pnl_archive_imports')
          ? [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 1, history_coverage_count: 3, latest_history_coverage_start: 1, verified_at: 1 }]
          : query.includes('CROSS JOIN balance_snapshots')
            ? [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 150, updated_at: 100 }]
            : []
      const all = vi.fn().mockResolvedValue({ results })
      return { all, bind: vi.fn(() => ({ all })) }
    })
    const batch = vi.fn(async (statements: unknown[]) => statements.length === 3
      ? [{ results: [trade] }, { results: [] }, { results: [] }]
      : [{ results: [trade] }, { results: [] }])
    const response = await app.request(
      '/api/history/price/btc?days=1&averageCost=1',
      undefined,
      { CACHE: {} as KVNamespace, DB: { batch, prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ asset: 'BTC', averageCostAvailable: true, points: [{ average_cost: 100, price: 150, snapshot_at: 100 }] })
    expect(batch).toHaveBeenCalledTimes(2)
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
    const all = vi.fn().mockResolvedValue({ results: [{ invested_value: null, snapshot_at: 1_780_000_000_000, total_value: 50000 }] })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })
    const response = await app.request(
      '/api/history/value?days=1',
      undefined,
      { CACHE: {} as KVNamespace, DB: { prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ points: [{ invested_value: null, selected_value: null, snapshot_at: 1_780_000_000_000, total_value: 50000 }] })
    const query = prepare.mock.calls[0]?.[0] as string
    expect(query).toContain('FROM portfolio_value_snapshots')
    expect(query).not.toContain('FROM balance_snapshots')
    expect(query).not.toContain('FROM price_snapshots')
    expect(query).toContain('COUNT(*) AS account_count')
    expect(query).toContain('SELECT COUNT(*) FROM scoped_accounts')
    expect(query).not.toContain('fiat_transfers')
    expect(query).not.toMatch(/\),\s*SELECT snapshot_at, total_value, NULL AS invested_value/)
  })

  it('derives the selected assets’ remaining average-cost basis without an extra query per snapshot', async () => {
    const trade = { account_id: 'bitkub-main', amount: 1, base_asset: 'BTC', executed_at: 50, fee: 0, fee_asset: 'THB', id: 'buy-btc', price: 100, quote_amount: 100, quote_asset: 'THB', side: 'buy' }
    const prepare = vi.fn((query: string) => {
      const results = query.includes('portfolio_asset_value_snapshots')
        ? [{ interval: 0, selected_value: 125 }]
        : query.includes('bitkub_pnl_archive_imports')
          ? [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 1, history_coverage_count: 3, latest_history_coverage_start: 1, verified_at: 1 }]
          : query.includes('CROSS JOIN balance_snapshots')
            ? [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 125, updated_at: 100 }]
            : query.includes('portfolio_value_snapshots')
              ? [{ invested_value: null, snapshot_at: 100, total_value: 500 }]
              : []
      const all = vi.fn().mockResolvedValue({ results })
      return { all, bind: vi.fn(() => ({ all })) }
    })
    const batch = vi.fn(async (statements: unknown[]) => statements.length === 3
      ? [{ results: [trade] }, { results: [] }, { results: [] }]
      : [{ results: [trade] }, { results: [] }])

    const response = await app.request(
      '/api/history/value?days=1&assets=BTC',
      undefined,
      { CACHE: {} as KVNamespace, DB: { batch, prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ points: [{ invested_value: 100, selected_value: 125, snapshot_at: 100, total_value: 500 }] })
    expect(batch).toHaveBeenCalledTimes(2)
    expect(prepare.mock.calls.some(([query]) => String(query).includes('portfolio_asset_value_snapshots'))).toBe(true)
  })

  it('withholds historical cost basis when the Bitkub archive is not verified', async () => {
    const prepare = vi.fn((query: string) => {
      const results = query.includes('bitkub_pnl_archive_imports')
        ? [{ account_id: 'bitkub-main', archive_before: null, history_coverage_boundary_count: 1, history_coverage_count: 3, latest_history_coverage_start: 1, verified_at: null }]
        : query.includes('CROSS JOIN balance_snapshots')
          ? [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 125, updated_at: 100 }]
          : query.includes('portfolio_asset_value_snapshots')
            ? [{ interval: 0, selected_value: 125 }]
            : query.includes('portfolio_value_snapshots')
              ? [{ invested_value: null, snapshot_at: 100, total_value: 500 }]
              : []
      const all = vi.fn().mockResolvedValue({ results })
      return { all, bind: vi.fn(() => ({ all })) }
    })
    const batch = vi.fn()

    const response = await app.request('/api/history/value?days=1&assets=BTC', undefined, {
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ points: [{ invested_value: null, selected_value: 125, snapshot_at: 100, total_value: 500 }] })
    expect(batch).not.toHaveBeenCalled()
  })

  it('withholds an asset price chart’s average cost when history coverage is incomplete', async () => {
    const prepare = vi.fn((query: string) => {
      const results = query.includes('FROM price_snapshots')
        ? [{ asset: 'BTC', price: 150, snapshot_at: 100 }]
        : query.includes('bitkub_pnl_archive_imports')
          ? [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 1, history_coverage_count: 2, latest_history_coverage_start: 1, verified_at: 1 }]
          : query.includes('CROSS JOIN balance_snapshots')
            ? [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 150, updated_at: 100 }]
            : []
      const all = vi.fn().mockResolvedValue({ results })
      return { all, bind: vi.fn(() => ({ all })) }
    })
    const batch = vi.fn()

    const response = await app.request('/api/history/price/BTC?days=1&averageCost=1', undefined, {
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ asset: 'BTC', averageCostAvailable: false, points: [{ average_cost: null, price: 150, snapshot_at: 100 }] })
    expect(batch).not.toHaveBeenCalled()
  })

  it('changes the value-history cache key when P&L inputs are invalidated', async () => {
    const trade = { account_id: 'bitkub-main', amount: 1, base_asset: 'BTC', executed_at: 50, fee: 0, fee_asset: 'THB', id: 'buy-btc', price: 100, quote_amount: 100, quote_asset: 'THB', side: 'buy' }
    const prepare = vi.fn((query: string) => {
      const results = query.includes('bitkub_pnl_archive_imports')
        ? [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 1, history_coverage_count: 3, latest_history_coverage_start: 1, verified_at: 1 }]
        : query.includes('CROSS JOIN balance_snapshots')
          ? [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 125, updated_at: 100 }]
          : query.includes('portfolio_asset_value_snapshots')
            ? [{ interval: 0, selected_value: 125 }]
            : query.includes('portfolio_value_snapshots')
              ? [{ invested_value: null, snapshot_at: 100, total_value: 500 }]
              : []
      const all = vi.fn().mockResolvedValue({ results })
      return { all, bind: vi.fn(() => ({ all })) }
    })
    const batch = vi.fn(async () => [{ results: [trade] }, { results: [] }])
    let revision = 'before-override'
    const get = vi.fn(async (key: string) => key.startsWith('bitkub-pnl:revision:') ? revision : null)
    const put = vi.fn().mockResolvedValue(undefined)
    const env = { CACHE: { get, put } as unknown as KVNamespace, DB: { batch, prepare } as unknown as D1Database }

    expect((await app.request('/api/history/value?days=1&assets=BTC', undefined, env)).status).toBe(200)
    revision = 'after-override'
    expect((await app.request('/api/history/value?days=1&assets=BTC', undefined, env)).status).toBe(200)

    const historyKeys = put.mock.calls.map(([key]) => String(key)).filter((key) => key.startsWith('value-history:v8:'))
    expect(historyKeys).toHaveLength(2)
    expect(new Set(historyKeys).size).toBe(2)
  })

  it('builds current holdings from one complete latest account snapshot', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const prepare = vi.fn().mockReturnValue({ all })
    const batch = vi.fn().mockResolvedValue([{ results: [] }, { results: [] }, { results: [] }])
    const response = await app.request(
      '/api/portfolio',
      undefined,
      { CACHE: {} as KVNamespace, DB: { batch, prepare } as unknown as D1Database },
    )

    expect(response.status).toBe(200)
    const query = prepare.mock.calls[0]?.[0] as string
    expect(query).toContain('WHERE candidate.account_id = accounts.id')
    expect(query).toContain('balances.snapshot_at AS updated_at')
    expect(query).not.toContain('GROUP BY')
  })

  it('reads verified Bitkub P&L in two indexed asset-ledger queries', async () => {
    const holdings = vi.fn().mockResolvedValue({ results: [
      { account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 200, updated_at: 1 },
      { account_id: 'binance-main', account_exchange: 'binance', account_label: 'Binance Main', asset: 'BTC', available: 9, reserved: 0, price: 200, updated_at: 1 },
    ] })
    const batch = vi.fn().mockResolvedValue([
      { results: [{ account_id: 'bitkub-main', id: 'buy', side: 'buy', base_asset: 'BTC', quote_asset: 'THB', price: 100, amount: 1, quote_amount: 100, fee: 0, fee_asset: 'THB', executed_at: 1 }] },
      { results: [] },
    ])
    const archiveScope = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 1, history_coverage_count: 3, latest_history_coverage_start: 1, verified_at: 1 }] })
    const prepare = vi.fn((query: string) => {
      const all = query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings
      return { all, bind: vi.fn(() => ({ all })) }
    })

    const response = await app.request('/api/portfolio', undefined, {
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      pnl: { complete: true, investedAmount: 100, totalPnl: 100, unrealizedPnl: 100 },
    })
    expect(batch).toHaveBeenCalledOnce()
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2)
    const pnlQueries = prepare.mock.calls.map(([query]) => String(query)).filter((query) => query.includes('WITH scoped_accounts'))
    expect(pnlQueries).toHaveLength(2)
    expect(pnlQueries.every((query) => query.includes('JOIN sync_state AS completed'))).toBe(true)
    expect(pnlQueries.every((query) => query.includes('source.executed_at <= completed.last_synced_at'))).toBe(true)
    expect(pnlQueries.some((query) => query.includes('fiat_transfers AS source'))).toBe(false)
    expect(prepare.mock.calls.some(([query]) => String(query).includes('raw_json'))).toBe(false)
  })

  it('withholds P&L before a verified Bitkub archive import without scanning ledger history', async () => {
    const holdings = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 200, updated_at: 1 }] })
    const archiveScope = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', archive_before: null, history_coverage_boundary_count: 1, history_coverage_count: 3, latest_history_coverage_start: 1, verified_at: null }] })
    const batch = vi.fn()
    const prepare = vi.fn((query: string) => ({
      all: query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings,
      bind: vi.fn(() => ({ all: query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings })),
    }))

    const response = await app.request('/api/portfolio', undefined, {
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      pnl: { complete: false, historyComplete: false, missingHistoryAccounts: ['bitkub-main'], totalPnl: null },
    })
    expect(batch).not.toHaveBeenCalled()
  })

  it('withholds P&L until all three current Bitkub history streams complete', async () => {
    const holdings = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 200, updated_at: 1 }] })
    const archiveScope = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 1, history_coverage_count: 2, latest_history_coverage_start: 1, verified_at: 1 }] })
    const batch = vi.fn()
    const prepare = vi.fn((query: string) => ({
      all: query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings,
      bind: vi.fn(() => ({ all: query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings })),
    }))

    const response = await app.request('/api/portfolio', undefined, {
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      pnl: { complete: false, historyComplete: false, missingHistoryAccounts: ['bitkub-main'], totalPnl: null },
    })
    expect(batch).not.toHaveBeenCalled()
  })

  it('withholds P&L when current Bitkub history streams use different coverage boundaries', async () => {
    const holdings = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 200, updated_at: 1 }] })
    const archiveScope = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 2, history_coverage_count: 3, latest_history_coverage_start: 2, verified_at: 1 }] })
    const batch = vi.fn()
    const prepare = vi.fn((query: string) => ({
      all: query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings,
      bind: vi.fn(() => ({ all: query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings })),
    }))

    const response = await app.request('/api/portfolio', undefined, {
      CACHE: {} as KVNamespace,
      DB: { batch, prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      pnl: { complete: false, historyComplete: false, missingHistoryAccounts: ['bitkub-main'], totalPnl: null },
    })
    expect(batch).not.toHaveBeenCalled()
  })

  it('uses the KV P&L result on repeat reads instead of re-reading the ledger', async () => {
    const cache = new Map<string, string>()
    const holdings = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', account_exchange: 'bitkub', account_label: 'Bitkub Main', asset: 'BTC', available: 1, reserved: 0, price: 200, updated_at: 1 }] })
    const archiveScope = vi.fn().mockResolvedValue({ results: [{ account_id: 'bitkub-main', archive_before: 1, history_coverage_boundary_count: 1, history_coverage_count: 3, latest_history_coverage_start: 1, verified_at: 1 }] })
    const batch = vi.fn().mockResolvedValue([
      { results: [{ account_id: 'bitkub-main', id: 'buy', side: 'buy', base_asset: 'BTC', quote_asset: 'THB', price: 100, amount: 1, quote_amount: 100, fee: 0, fee_asset: 'THB', executed_at: 1 }] },
      { results: [] },
      { results: [] },
    ])
    const prepare = vi.fn((query: string) => {
      const all = query.includes('bitkub_pnl_archive_imports') ? archiveScope : holdings
      return { all, bind: vi.fn(() => ({ all })) }
    })
    const CACHE = {
      get: vi.fn(async (key: string, type?: string) => {
        const value = cache.get(key)
        return type === 'json' && value ? JSON.parse(value) : value ?? null
      }),
      put: vi.fn(async (key: string, value: string) => { cache.set(key, value) }),
    } as unknown as KVNamespace
    const env = { CACHE, DB: { batch, prepare } as unknown as D1Database }

    expect((await app.request('/api/portfolio', undefined, env)).status).toBe(200)
    expect((await app.request('/api/portfolio', undefined, env)).status).toBe(200)
    expect(batch).toHaveBeenCalledOnce()
  })

  it('writes a cost-basis override only for an incoming Bitkub transfer and invalidates P&L', async () => {
    const transfer = vi.fn().mockResolvedValue({ account_id: 'bitkub-main', id: 'incoming-transfer' })
    const write = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({ first: query.includes('FROM crypto_transfers') ? transfer : undefined, run: write })),
    }))
    const put = vi.fn().mockResolvedValue(undefined)

    const response = await app.request('/api/cost-basis-overrides/incoming-transfer', {
      body: JSON.stringify({ totalCostThb: 1_500 }),
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' },
      method: 'PUT',
    }, {
      ALLOWED_ORIGIN: 'http://localhost:5173',
      CACHE: { put } as unknown as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ costBasis: { totalCostThb: 1_500, transferId: 'incoming-transfer' } })
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO crypto_transfer_cost_basis (transfer_id, total_cost_thb, updated_at)'))
    expect(put).toHaveBeenCalledWith('bitkub-pnl:revision:v1:bitkub-main', expect.any(String))
  })

  it('rejects cost-basis writes that do not name a known incoming Bitkub transfer', async () => {
    const first = vi.fn().mockResolvedValue(null)
    const prepare = vi.fn().mockReturnValue({ bind: vi.fn(() => ({ first })) })

    const response = await app.request('/api/cost-basis-overrides/not-found', {
      body: JSON.stringify({ totalCostThb: 1_000 }),
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' },
      method: 'PUT',
    }, {
      ALLOWED_ORIGIN: 'http://localhost:5173',
      CACHE: {} as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Incoming Bitkub transfer not found' })
  })

  it('rejects a null cost basis instead of coercing it to zero', async () => {
    const prepare = vi.fn()
    const response = await app.request('/api/cost-basis-overrides/incoming-transfer', {
      body: JSON.stringify({ totalCostThb: null }),
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' },
      method: 'PUT',
    }, {
      ALLOWED_ORIGIN: 'http://localhost:5173',
      CACHE: {} as KVNamespace,
      DB: { prepare } as unknown as D1Database,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid cost basis' })
    expect(prepare).not.toHaveBeenCalled()
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
