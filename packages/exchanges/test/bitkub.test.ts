import { describe, expect, it } from 'vitest'
import { BitkubAdapter, createBitkubSigner, mapBitkubBalances, mapBitkubFiatTransfers, mapBitkubLegacyBalances, mapBitkubOrder, mapBitkubTransfer } from '../src/bitkub/index'

describe('Bitkub mapping', () => {
  it('maps wallet balances', () => {
    expect(mapBitkubBalances([{ available: '1.25', currency: 'BTC', reserved: '0.25' }])).toEqual([
      { asset: 'BTC', available: 1.25, reserved: 0.25 },
    ])
  })

  it('maps a legacy balance response', () => {
    expect(mapBitkubLegacyBalances({ BTC: { available: '0.5', reserved: '0.1' }, THB: { available: 100, reserved: 0 } })).toEqual([
      { asset: 'BTC', available: 0.5, reserved: 0.1 },
      { asset: 'THB', available: 100, reserved: 0 },
    ])
  })

  it('maps a buy order using received crypto as the base amount', () => {
    expect(mapBitkubOrder({ amount: '1000', fee: '25', rate: '100000', receive: '0.00975', side: 'buy', ts: 1_700_000_000_000, txn_id: 'trade-1' }, 'BTC_THB', { source: 'fixture' })).toMatchObject({
      amount: 0.00975,
      baseAsset: 'BTC',
      price: 100000,
      quoteAsset: 'THB',
      side: 'buy',
    })
  })

  it('maps crypto and fiat transfers', () => {
    expect(mapBitkubTransfer({ amount: '2', created_at: '2026-08-01T00:00:00.000Z', hash: 'hash-1', symbol: 'ETH' }, 'deposit', { source: 'fixture' })).toMatchObject({
      amount: 2,
      asset: 'ETH',
      direction: 'deposit',
      txHash: 'hash-1',
    })
    expect(mapBitkubFiatTransfers([{ amount: '1000', currency: 'THB', time: 1_700_000_000, txn_id: 'fiat-1' }], 'deposit')).toMatchObject([
      { amount: 1000, currency: 'THB', direction: 'deposit', id: 'fiat-1' },
    ])
  })

  it('signs Bitkub request material with HMAC-SHA256', async () => {
    const sign = createBitkubSigner('secret')
    await expect(sign('1700000000000GET/api/v4/wallet/balances')).resolves.toBe('9b3627e64d50e362f87ca6a10f341ba29838fa52df0e9ccd3a686c48d8401acd')
  })

  it('calls the configured fetcher without a receiver', async () => {
    const responses = [
      Response.json(1_700_000_000_000),
      Response.json({ result: [{ available: '1', currency: 'BTC', reserved: '0' }] }),
    ]
    const fetcher: typeof fetch = async function (this: undefined) {
      if (this !== undefined) throw new Error('fetcher received an unexpected receiver')
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return response
    }
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher })

    await expect(adapter.fetchBalances()).resolves.toEqual([{ asset: 'BTC', available: 1, reserved: 0 }])
  })

  it('reports Bitkub authentication error details without request credentials', async () => {
    const responses = [
      Response.json(1_700_000_000_000),
      Response.json({ code: 'A1000-CW', message: 'Unauthorized Access' }, { status: 401 }),
      Response.json(1_700_000_000_001),
      Response.json({ code: 'A1000-CW', message: 'Unauthorized Access' }, { status: 401 }),
    ]
    const fetcher: typeof fetch = async () => {
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return response
    }
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher })

    await expect(adapter.fetchBalances()).rejects.toThrow('Bitkub request failed: 401 (A1000-CW: Unauthorized Access)')
  })

  it('falls back to the legacy wallet endpoint when V4 rejects authentication', async () => {
    const responses = [
      Response.json(1_700_000_000_000),
      Response.json({ code: 'A1000-MK', message: 'Unauthorized' }, { status: 401 }),
      Response.json(1_700_000_000_001),
      Response.json({ error: 0, result: { BTC: { available: '0.5', reserved: '0.1' }, THB: { available: '100', reserved: '0' } } }),
    ]
    const requests: Array<{ body: string | undefined; method: string | undefined; url: string }> = []
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ body: typeof init?.body === 'string' ? init.body : undefined, method: init?.method, url: String(input) })
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return response
    }
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher })

    await expect(adapter.fetchBalances()).resolves.toEqual([
      { asset: 'BTC', available: 0.5, reserved: 0.1 },
      { asset: 'THB', available: 100, reserved: 0 },
    ])
    expect(requests.at(-1)).toMatchObject({ body: '{}', method: 'POST', url: 'https://api.bitkub.com/api/v3/market/balances' })
  })

  it('maps a direct public ticker response', async () => {
    const fetcher: typeof fetch = async () => Response.json([
      { last: '3500000', symbol: 'BTC_THB' },
    ])
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher, now: () => 1_700_000_000_000 })

    await expect(adapter.fetchPrices()).resolves.toEqual([
      { asset: 'BTC', quote: 'THB', price: 3500000, updatedAt: 1_700_000_000_000 },
    ])
  })

  it('uses documented page order-history pagination', async () => {
    const responses = [
      Response.json({ error: 0, result: [{ source: 'exchange', symbol: 'BTC_THB' }, { source: 'broker', symbol: 'BROKER_THB' }] }),
      Response.json(1_700_000_000_000),
      Response.json({ error: 0, pagination: { next: null }, result: [] }),
    ]
    const requests: string[] = []
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input))
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return response
    }
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher })

    await expect(adapter.fetchTrades()).resolves.toEqual([])
    const historyUrl = requests.find((request) => request.includes('/api/v3/market/my-order-history'))
    if (!historyUrl) throw new Error('order-history request was not sent')
    const query = new URL(historyUrl).searchParams
    expect(query.get('lmt')).toBe('100')
    expect(query.get('p')).toBe('1')
    expect(query.get('pagination_type')).toBeNull()
    expect(query.get('sym')).toBe('BTC_THB')
  })

  it('continues when Bitkub returns application error 81 for a symbol', async () => {
    const responses = [
      Response.json({ error: 0, result: [{ source: 'exchange', symbol: 'BTC_THB' }] }),
      Response.json(1_700_000_000_000),
      Response.json({ error: 81 }),
      Response.json(1_700_000_000_001),
      Response.json({ error: 81 }),
    ]
    const fetcher: typeof fetch = async () => {
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return response
    }
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher })

    await expect(adapter.fetchTrades()).resolves.toEqual([])
  })

  it('uses the documented trading symbol for order history', async () => {
    const responses = [
      Response.json({ error: 0, result: [{ source: 'exchange', symbol: 'BTC_THB' }] }),
      Response.json(1_700_000_000_000),
      Response.json({ error: 0, pagination: { next: null }, result: [] }),
    ]
    const requests: string[] = []
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input))
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return response
    }
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher })

    await expect(adapter.fetchTrades()).resolves.toEqual([])
    expect(requests.some((request) => request.includes('sym=BTC_THB'))).toBe(true)
  })

  it('sends page and limit together for fiat history', async () => {
    const responses = [
      Response.json(1_700_000_000_000),
      Response.json({ code: 0, data: [] }),
    ]
    const requests: string[] = []
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input))
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return response
    }
    const adapter = new BitkubAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher })

    await expect(adapter.fetchFiatWithdrawals()).resolves.toEqual([])
    const request = requests.at(-1)
    if (!request) throw new Error('fiat-history request was not sent')
    const query = new URL(request).searchParams
    expect(query.get('page')).toBe('1')
    expect(query.get('limit')).toBe('100')
  })
})
