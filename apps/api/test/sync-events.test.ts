import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { createSqliteD1 } from './sqlite-d1.mjs'

const setup = () => {
  const { d1, database } = createSqliteD1()
  database.exec(`
    INSERT INTO accounts (id, exchange, label, owner_email, created_at, archived_at) VALUES
      ('main', 'bitkub', 'Main', 'owner@example.test', 1, NULL),
      ('second', 'bitkub', 'Second', 'owner@example.test', 1, NULL),
      ('old', 'bitkub', 'Old', 'owner@example.test', 1, 99);
  `)
  const insert = database.prepare('INSERT INTO sync_events (account_id, data_type, status, detail, occurred_at) VALUES (?, ?, ?, ?, ?)')
  const events: [string, string, number][] = [
    ['main', 'balances', 100], ['second', 'balances', 200], ['old', 'balances', 300], ['main', 'trades', 400],
    ['second', 'trades', 400], ['main', 'prices', 500],
  ]
  for (const [account, type, at] of events) insert.run(account, type, 'success', `${account}-${type}-${at}`, at)
  const get = async (path: string) => (await (await app.request(path, undefined, { CACHE: {} as KVNamespace, DB: d1 })).json()) as { events: { account_id: string; detail: string; occurred_at: number }[] }
  return { get }
}

describe('sync events', () => {
  it('lists the newest events first across active accounts and leaves archived accounts out', async () => {
    const { get } = setup()
    const { events } = await get('/api/sync-events?limit=100')
    expect(events.map((event) => event.detail)).toEqual(['main-prices-500', 'second-trades-400', 'main-trades-400', 'second-balances-200', 'main-balances-100'])
  })

  it('applies the limit and the account scope', async () => {
    const { get } = setup()
    expect((await get('/api/sync-events?limit=2')).events.map((event) => event.detail)).toEqual(['main-prices-500', 'second-trades-400'])
    const scoped = await get('/api/sync-events?limit=100&account=second')
    expect(scoped.events.map((event) => event.detail)).toEqual(['second-trades-400', 'second-balances-200'])
    expect((await get('/api/sync-events?account=old')).events).toEqual([])
  })
})
