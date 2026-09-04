import { describe, expect, it } from 'vitest'
import { portfolioValueAt } from './index'

describe('portfolioValueAt', () => {
  const snapshotAt = 1_800_000_000_000

  it('values THB and assets with a nearby THB quote', () => {
    expect(portfolioValueAt(
      [
        { asset: 'THB', available: 1_000, reserved: 0 },
        { asset: 'BTC', available: 0.01, reserved: 0.01 },
      ],
      [{ asset: 'BTC', quote: 'THB', price: 2_000_000, updatedAt: snapshotAt - 10 * 60_000 }],
      snapshotAt,
      35 * 60_000,
    )).toBe(41_000)
  })

  it('rejects a positive holding with a missing or stale quote', () => {
    const balances = [{ asset: 'BTC', available: 0.01, reserved: 0 }]
    expect(portfolioValueAt(balances, [], snapshotAt, 35 * 60_000)).toBeUndefined()
    expect(portfolioValueAt(
      balances,
      [{ asset: 'BTC', quote: 'THB', price: 2_000_000, updatedAt: snapshotAt - 36 * 60_000 }],
      snapshotAt,
      35 * 60_000,
    )).toBeUndefined()
    expect(portfolioValueAt(
      balances,
      [{ asset: 'BTC', quote: 'THB', price: 0, updatedAt: snapshotAt }],
      snapshotAt,
      35 * 60_000,
    )).toBeUndefined()
  })

  it('does not require a quote for a zero balance', () => {
    expect(portfolioValueAt(
      [{ asset: 'BTC', available: 0, reserved: 0 }],
      [],
      snapshotAt,
      35 * 60_000,
    )).toBe(0)
  })
})
