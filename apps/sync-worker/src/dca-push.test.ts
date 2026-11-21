import { describe, expect, it } from 'vitest'
import { parseDcaPush } from './dca-push'

const buy = { amount: 0.0123, asset: 'BTC', id: 'buy-1', reason: 'Fibo 0.618', thbAmount: 1234.5 }

describe('DCA bot push', () => {
  it('describes a buy with its reason, quantity, and baht amount', () => {
    expect(parseDcaPush({ buys: [buy], total: 1 })).toEqual({
      category: 'trades',
      payloads: [{ body: 'Fibo 0.618 · 0.0123 BTC · ฿1,234.5', tag: 'moondi-dca-buy-buy-1', title: 'บอท DCA ซื้อ BTC', url: '/activity' }],
    })
  })

  it('leaves out values the bot did not report', () => {
    const parsed = parseDcaPush({ buys: [{ ...buy, amount: null, reason: null, thbAmount: null }], total: 1 })
    expect(parsed?.payloads[0]?.body).toBe('มีรายการซื้อใหม่')
  })

  it('adds one summary notification when more buys arrived than are listed', () => {
    const parsed = parseDcaPush({ buys: [buy, { ...buy, id: 'buy-2' }, { ...buy, id: 'buy-3' }], total: 7 })
    expect(parsed?.payloads).toHaveLength(4)
    expect(parsed?.payloads[3]).toMatchObject({ body: 'บอท DCA ซื้ออีก 4 รายการ', tag: 'moondi-dca-more-buy-1' })
  })

  it.each([
    ['a non-object body', 'x'],
    ['no buys', { buys: [], total: 0 }],
    ['more than three buys', { buys: [buy, buy, buy, buy].map((item, index) => ({ ...item, id: `b${index}` })), total: 4 }],
    ['a total below the listed buys', { buys: [buy], total: 0 }],
    ['an unsafe total', { buys: [buy], total: 1e9 }],
    ['an unsafe id', { buys: [{ ...buy, id: 'a b' }], total: 1 }],
    ['an unexpected asset', { buys: [{ ...buy, asset: 'btc<script>' }], total: 1 }],
    ['a free-text reason', { buys: [{ ...buy, reason: 'tap here' }], total: 1 }],
    ['a negative amount', { buys: [{ ...buy, amount: -1 }], total: 1 }],
    ['a string amount', { buys: [{ ...buy, amount: '1' }], total: 1 }],
  ])('rejects %s', (_name, body) => {
    expect(parseDcaPush(body)).toBeUndefined()
  })
})
