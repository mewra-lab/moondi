import { describe, expect, it, vi } from 'vitest'
import { savePortfolioValueSnapshot } from './portfolio-snapshots'

describe('portfolio value materialization', () => {
  it('writes against the balance snapshot time when prices arrive later', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ asset: 'BTC', available: 1, reserved: 0, snapshot_at: 1_700_000_000_000 }] })
    const run = vi.fn().mockResolvedValue({})
    const insertBind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn((query: string) => query.includes('SELECT asset')
      ? { bind: vi.fn().mockReturnValue({ all }) }
      : { bind: insertBind })

    await savePortfolioValueSnapshot(
      { prepare } as unknown as D1Database,
      'bitkub-main',
      [{ asset: 'BTC', price: 2_000_000, quote: 'THB', updatedAt: 1_700_000_060_000 }],
    )

    expect(insertBind).toHaveBeenCalledWith('bitkub-main', Math.floor(1_700_000_000_000 / 1_800_000), 1_700_000_000_000, 2_000_000)
    expect(run).toHaveBeenCalledOnce()
  })

  it('does not materialize a value from stale prices', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ asset: 'BTC', available: 1, reserved: 0, snapshot_at: 1_700_000_000_000 }] })
    const run = vi.fn()
    const prepare = vi.fn((query: string) => query.includes('SELECT asset')
      ? { bind: vi.fn().mockReturnValue({ all }) }
      : { bind: vi.fn().mockReturnValue({ run }) })

    await savePortfolioValueSnapshot(
      { prepare } as unknown as D1Database,
      'bitkub-main',
      [{ asset: 'BTC', price: 2_000_000, quote: 'THB', updatedAt: 1_700_003_000_001 }],
    )

    expect(run).not.toHaveBeenCalled()
  })
})
