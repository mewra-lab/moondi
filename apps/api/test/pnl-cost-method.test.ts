import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { createSqliteD1 } from './sqlite-d1.mjs'

type PnlBody = { pnl: { assets: { asset: string; costBasis: number | null; status: string }[]; costMethod: string } }

const at = (day: number, hour = 3) => Date.UTC(2026, 0, day, hour)

const memoryKv = () => {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: string) => {
      const value = values.get(key)
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => { values.set(key, value) },
  } as unknown as KVNamespace
}

const setup = () => {
  const { d1, database } = createSqliteD1()
  const now = Math.floor(Date.now() / 1_800_000) * 1_800_000
  database.exec(`
    INSERT INTO accounts (id, exchange, label, owner_email, created_at, archived_at) VALUES ('main', 'bitkub', 'Main', 'owner@example.test', 1, NULL);
    INSERT INTO bitkub_pnl_archive_imports (account_id, archive_before, source_record_count, verified_at) VALUES ('main', 100, 1, 1);
    INSERT INTO sync_state (account_id, data_type, last_synced_at, covered_from) VALUES
      ('main', 'trades', ${now}, 100), ('main', 'crypto_transfers', ${now}, 100), ('main', 'fiat_transfers', ${now}, 100);
    INSERT INTO trades (id, account_id, external_id, side, base_asset, quote_asset, price, amount, quote_amount, fee, fee_asset, executed_at, raw_json) VALUES
      ('buy-old', 'main', 'buy-old', 'buy', 'XAAA', 'THB', 1, 100, 100, 0, 'THB', ${at(1)}, '{}'),
      ('buy-new', 'main', 'buy-new', 'buy', 'XAAA', 'THB', 0.1, 100, 10, 0, 'THB', ${at(5, 2)}, '{}');
    INSERT INTO crypto_transfers (id, account_id, external_id, direction, asset, amount, fee, tx_hash, executed_at, raw_json) VALUES
      ('out', 'main', 'out', 'withdraw', 'XAAA', 100, 0, NULL, ${at(5, 9)}, '{}');
    INSERT INTO balance_snapshots (account_id, asset, available, reserved, snapshot_at) VALUES ('main', 'XAAA', 100, 0, ${now});
    INSERT INTO price_cache (asset, quote, price, updated_at) VALUES ('XAAA', 'THB', 1, ${now});
    INSERT INTO price_snapshots (asset, quote, price, snapshot_at) VALUES ('XAAA', 'THB', 1, ${now});
  `)
  const cache = memoryKv()
  const get = async (path: string) => app.request(path, undefined, { CACHE: cache, DB: d1 })
  return { get }
}

const xaaa = (body: PnlBody) => body.pnl.assets.find((asset) => asset.asset === 'XAAA')

describe('P&L cost method', () => {
  it('keeps average cost as the default', async () => {
    const { get } = setup()
    const body = (await (await get('/api/portfolio')).json()) as PnlBody

    expect(body.pnl.costMethod).toBe('average')
    expect(xaaa(body)).toMatchObject({ costBasis: 55, status: 'ready' })
  })

  it('computes the lots method on request, per account route too', async () => {
    const { get } = setup()
    const all = (await (await get('/api/portfolio?costMethod=lots')).json()) as PnlBody
    const one = (await (await get('/api/portfolio/main?costMethod=lots')).json()) as PnlBody

    expect(all.pnl.costMethod).toBe('lots')
    expect(xaaa(all)).toMatchObject({ costBasis: 100, status: 'ready' })
    expect(xaaa(one)).toMatchObject({ costBasis: 100, status: 'ready' })
  })

  it('never serves a cached result computed with the other method', async () => {
    const { get } = setup()
    for (const [query, expected] of [['', 55], ['?costMethod=lots', 100], ['', 55], ['?costMethod=lots', 100]] as const) {
      const body = (await (await get(`/api/portfolio${query}`)).json()) as PnlBody
      expect(xaaa(body)?.costBasis).toBe(expected)
    }
  })

  it('rejects an unknown cost method instead of silently using the default', async () => {
    const { get } = setup()
    for (const path of ['/api/portfolio?costMethod=fifo', '/api/portfolio/main?costMethod=x', '/api/history/value?assets=XAAA&costMethod=x', '/api/history/price/XAAA?averageCost=1&costMethod=x']) {
      const response = await get(path)
      expect(response.status, path).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid cost method' })
    }
  })

  it('draws the historical average-cost line with the requested method', async () => {
    const { get } = setup()
    const line = async (query: string) => {
      const body = (await (await get(`/api/history/price/XAAA?averageCost=1&days=30${query}`)).json()) as { averageCostAvailable: boolean; points: { average_cost: number | null }[] }
      return { available: body.averageCostAvailable, costs: body.points.map((point) => point.average_cost) }
    }

    expect(await line('')).toEqual({ available: true, costs: [0.55] })
    expect(await line('&costMethod=lots')).toEqual({ available: true, costs: [1] })
  })
})
