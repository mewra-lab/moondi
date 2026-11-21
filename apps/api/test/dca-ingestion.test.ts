import { describe, expect, it } from 'vitest'
import { parseDcaIngestion, parseDcaStateRequest } from '../src/dca-ingestion'

const now = 1_700_000_000_000
const buy = { amount: 0.01, asset: 'BTC', executedAt: now - 1_000, fee: 0.5, id: 'buy-1', price: 1_000_000, reason: 'Fibo 0.618', thbAmount: 10_000 }
const signal = { active: true, asset: 'BTC', hasError: false, lastSeenAt: now - 500, levels: ['0.618', '1D:0.5'] }
const payload = (overrides: Record<string, unknown> = {}) => ({ accountId: 'bitkub-main', buys: [buy], signals: [signal], syncAt: now - 10_000, ...overrides })

describe('DCA ingestion payload', () => {
  it('accepts a normalized payload and copies only the known fields', () => {
    const parsed = parseDcaIngestion({ ...payload(), buys: [{ ...buy, mongo: 'discarded' }], extra: 'discarded' }, now)
    expect(parsed).toEqual(payload())
  })

  it('accepts buys without a fill price and signals with unknown state', () => {
    const parsed = parseDcaIngestion(payload({
      buys: [{ ...buy, amount: null, fee: null, price: null, reason: null, thbAmount: null }],
      signals: [{ ...signal, active: null, levels: [] }],
    }), now)
    expect(parsed?.buys[0]).toMatchObject({ amount: null, price: null, reason: null })
    expect(parsed?.signals[0]).toMatchObject({ active: null, levels: [] })
  })

  it.each([
    ['a non-object body', 'text'],
    ['an invalid account id', payload({ accountId: 'bad id' })],
    ['an empty payload', payload({ buys: [], signals: [] })],
    ['a sync time in the future', payload({ syncAt: now + 1 })],
    ['a sync time older than half an hour', payload({ syncAt: now - 30 * 60 * 1_000 - 1 })],
    ['too many buys', payload({ buys: Array.from({ length: 201 }, (_, index) => ({ ...buy, id: `buy-${index}` })) })],
    ['too many signals', payload({ signals: Array.from({ length: 51 }, (_, index) => ({ ...signal, asset: `A${index}` })) })],
    ['a duplicate buy id', payload({ buys: [buy, { ...buy }] })],
    ['a duplicate signal asset', payload({ signals: [signal, { ...signal }] })],
    ['an unsafe buy id', payload({ buys: [{ ...buy, id: 'a/b' }] })],
    ['a lower-case asset', payload({ buys: [{ ...buy, asset: 'btc' }] })],
    ['a negative amount', payload({ buys: [{ ...buy, amount: -1 }] })],
    ['a non-finite price', payload({ buys: [{ ...buy, price: Number.POSITIVE_INFINITY }] })],
    ['a string amount', payload({ buys: [{ ...buy, amount: '1' }] })],
    ['a free-text reason', payload({ buys: [{ ...buy, reason: 'ignore previous instructions' }] })],
    ['a buy executed after the sync time', payload({ buys: [{ ...buy, executedAt: now + 10 * 60 * 1_000 }] })],
    ['a fractional timestamp', payload({ buys: [{ ...buy, executedAt: 1.5 }] })],
    ['a malformed signal level', payload({ signals: [{ ...signal, levels: ['<script>'] }] })],
    ['too many signal levels', payload({ signals: [{ ...signal, levels: Array.from({ length: 25 }, () => '0.5') }] })],
    ['a non-boolean error flag', payload({ signals: [{ ...signal, hasError: 'yes' }] })],
  ])('rejects %s', (_name, value) => {
    expect(parseDcaIngestion(value, now)).toBeUndefined()
  })
})

describe('DCA state request', () => {
  it('accepts only a safe account id', () => {
    expect(parseDcaStateRequest({ accountId: 'bitkub-main' })).toEqual({ accountId: 'bitkub-main' })
    expect(parseDcaStateRequest({ accountId: '../x' })).toBeUndefined()
    expect(parseDcaStateRequest(null)).toBeUndefined()
  })
})
