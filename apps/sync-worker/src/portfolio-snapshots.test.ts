import { describe, expect, it, vi } from 'vitest'
import { savePortfolioValueSnapshot } from './portfolio-snapshots'

describe('portfolio value materialization', () => {
  it('writes against the balance snapshot time when prices arrive later', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ asset: 'BTC', available: 1, reserved: 0, snapshot_at: 1_700_000_000_000 }] })
    const bound: unknown[][] = []
    const prepare = vi.fn((query: string) => {
      if (query.includes('SELECT asset')) return { bind: vi.fn().mockReturnValue({ all }) }
      if (query.includes('SELECT snapshot_at FROM portfolio_value_snapshots')) {
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }
      }
      return { bind: vi.fn((...values: unknown[]) => { bound.push(values); return { query } }) }
    })
    const batch = vi.fn().mockResolvedValue([])

    await savePortfolioValueSnapshot(
      { batch, prepare } as unknown as D1Database,
      'bitkub-main',
      [{ asset: 'BTC', price: 2_000_000, quote: 'THB', updatedAt: 1_700_000_060_000 }],
    )

    expect(bound).toContainEqual(['bitkub-main', Math.floor(1_700_000_000_000 / 1_800_000), 1_700_000_000_000, 2_000_000])
    expect(bound).toContainEqual(['bitkub-main', 'BTC', Math.floor(1_700_000_000_000 / 1_800_000), 1_700_000_000_000, 1, 2_000_000])
    expect(batch).toHaveBeenCalledOnce()
  })

  it('does not materialize a value from stale prices', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ asset: 'BTC', available: 1, reserved: 0, snapshot_at: 1_700_000_000_000 }] })
    const batch = vi.fn()
    const prepare = vi.fn((query: string) => query.includes('SELECT asset')
      ? { bind: vi.fn().mockReturnValue({ all }) }
      : { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) })

    await savePortfolioValueSnapshot(
      { batch, prepare } as unknown as D1Database,
      'bitkub-main',
      [{ asset: 'BTC', price: 2_000_000, quote: 'THB', updatedAt: 1_700_003_000_001 }],
    )

    expect(batch).not.toHaveBeenCalled()
  })

  it('does not rewrite an interval already materialized for the same balance snapshot', async () => {
    const snapshotAt = 1_700_000_000_000
    const all = vi.fn().mockResolvedValue({ results: [{ asset: 'THB', available: 100, reserved: 0, snapshot_at: snapshotAt }] })
    const first = vi.fn().mockResolvedValue({ snapshot_at: snapshotAt })
    const batch = vi.fn()
    const prepare = vi.fn((query: string) => query.includes('SELECT asset')
      ? { bind: vi.fn().mockReturnValue({ all }) }
      : { bind: vi.fn().mockReturnValue({ first }) })

    await savePortfolioValueSnapshot(
      { batch, prepare } as unknown as D1Database,
      'bitkub-main',
      [],
    )

    expect(batch).not.toHaveBeenCalled()
  })
})
