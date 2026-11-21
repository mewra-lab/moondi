import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { createSqliteD1 } from './sqlite-d1.mjs'

type SavedBody = { overrides: { account_id: string; amount: number; asset: string; executed_at: number; total_cost_thb: number; transfer_id: string; updated_at: number }[] }

const setup = () => {
  const { d1, database } = createSqliteD1()
  database.exec(`
    INSERT INTO accounts (id, exchange, label, owner_email, created_at, archived_at) VALUES
      ('main', 'bitkub', 'Main', 'owner@example.test', 1, NULL),
      ('second', 'bitkub', 'Second', 'owner@example.test', 1, NULL),
      ('old', 'bitkub', 'Old', 'owner@example.test', 1, 99);
    INSERT INTO crypto_transfers (id, account_id, external_id, direction, asset, amount, fee, tx_hash, executed_at, raw_json) VALUES
      ('in-1', 'main', 'in-1', 'deposit', 'XAAA', 10, 0, NULL, 300, '{}'),
      ('in-2', 'main', 'in-2', 'deposit', 'XBBB', 5, 0, NULL, 100, '{}'),
      ('in-3', 'second', 'in-3', 'deposit', 'XAAA', 7, 0, NULL, 200, '{}'),
      ('in-4', 'old', 'in-4', 'deposit', 'XAAA', 9, 0, NULL, 400, '{}'),
      ('in-5', 'main', 'in-5', 'deposit', 'XCCC', 3, 0, NULL, 500, '{}'),
      ('out-1', 'main', 'out-1', 'withdraw', 'XAAA', 1, 0, NULL, 600, '{}');
    INSERT INTO crypto_transfer_cost_basis (transfer_id, total_cost_thb, updated_at) VALUES
      ('in-1', 12.5, 1000), ('in-2', 0, 1001), ('in-3', 80, 1002), ('in-4', 99, 1003), ('out-1', 5, 1004);
  `)
  const request = (path: string, init?: RequestInit) => app.request(path, init, { ALLOWED_ORIGIN: 'https://portfolio.example', CACHE: {} as KVNamespace, DB: d1 })
  return { database, request }
}

describe('saved cost bases', () => {
  it('lists saved deposit cost bases with the transfer they belong to, oldest transfer first', async () => {
    const { request } = setup()
    const body = (await (await request('/api/cost-basis-overrides')).json()) as SavedBody

    expect(body.overrides.map((row) => [row.transfer_id, row.asset, row.amount, row.executed_at, row.total_cost_thb])).toEqual([
      ['in-2', 'XBBB', 5, 100, 0],
      ['in-3', 'XAAA', 7, 200, 80],
      ['in-1', 'XAAA', 10, 300, 12.5],
    ])
  })

  it('leaves out archived accounts and withdrawals, and can be scoped to one account', async () => {
    const { request } = setup()
    const all = (await (await request('/api/cost-basis-overrides')).json()) as SavedBody
    const scoped = (await (await request('/api/cost-basis-overrides?account=second')).json()) as SavedBody

    expect(all.overrides.map((row) => row.transfer_id)).not.toContain('in-4')
    expect(all.overrides.map((row) => row.transfer_id)).not.toContain('out-1')
    expect(scoped.overrides.map((row) => row.transfer_id)).toEqual(['in-3'])
  })

  it('shows a value saved through the API and stops listing it once removed', async () => {
    const { request } = setup()
    const headers = { 'Content-Type': 'application/json', Origin: 'https://portfolio.example' }
    expect((await request('/api/cost-basis-overrides/in-5', { body: JSON.stringify({ totalCostThb: 41.25 }), headers, method: 'PUT' })).status).toBe(200)
    const saved = (await (await request('/api/cost-basis-overrides')).json()) as SavedBody
    expect(saved.overrides.find((row) => row.transfer_id === 'in-5')?.total_cost_thb).toBe(41.25)

    expect((await request('/api/cost-basis-overrides/in-5', { headers: { Origin: 'https://portfolio.example' }, method: 'DELETE' })).status).toBe(200)
    const after = (await (await request('/api/cost-basis-overrides')).json()) as SavedBody
    expect(after.overrides.map((row) => row.transfer_id)).not.toContain('in-5')
    expect(after.overrides).toHaveLength(3)
  })

  it('changes nothing else when one saved cost basis is removed', async () => {
    const { database, request } = setup()
    const before = database.prepare('SELECT transfer_id, total_cost_thb, updated_at FROM crypto_transfer_cost_basis WHERE transfer_id <> ? ORDER BY transfer_id').all('in-1')
    await request('/api/cost-basis-overrides/in-1', { headers: { Origin: 'https://portfolio.example' }, method: 'DELETE' })
    const after = database.prepare('SELECT transfer_id, total_cost_thb, updated_at FROM crypto_transfer_cost_basis ORDER BY transfer_id').all()

    expect(after).toEqual(before)
    expect(database.prepare('SELECT COUNT(*) AS n FROM crypto_transfers').get()).toEqual({ n: 6 })
  })
})
