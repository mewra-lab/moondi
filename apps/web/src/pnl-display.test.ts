import { describe, expect, it } from 'vitest'
import { filterPnlAssets, summarizePnlAssets } from './pnl-display'

const assets = [
  { asset: 'ALPHA', averageCost: null, costBasis: 0, currentValue: 0, pnlPercent: 16.856, quantity: 0, realizedCostBasis: 1_000, realizedPnl: 168.56, status: 'ready' as const, totalPnl: 168.56, unrealizedPnl: 0 },
  { asset: 'BTC', averageCost: 1_000_000, costBasis: 1_000_000, currentValue: 2_000_000, pnlPercent: 100, quantity: 1, realizedCostBasis: 0, realizedPnl: 0, status: 'ready' as const, totalPnl: 1_000_000, unrealizedPnl: 1_000_000 },
  { asset: 'IOST', averageCost: null, costBasis: null, currentValue: null, pnlPercent: null, quantity: 10, realizedCostBasis: null, realizedPnl: null, status: 'missing_cost_basis' as const, totalPnl: null, unrealizedPnl: null },
  { asset: 'ZIL', averageCost: null, costBasis: 0, currentValue: 0, pnlPercent: -21.9987, quantity: 0, realizedCostBasis: 10_000, realizedPnl: -2_199.87, status: 'ready' as const, totalPnl: -2_199.87, unrealizedPnl: 0 },
]

describe('P&L display scope', () => {
  it('defaults to held assets and keeps closed positions available on demand', () => {
    expect(filterPnlAssets(assets, 'holdings', []).map((asset) => asset.asset)).toEqual(['BTC', 'IOST'])
    expect(filterPnlAssets(assets, 'closed', []).map((asset) => asset.asset)).toEqual(['ALPHA', 'ZIL'])
  })

  it('allows multiple asset selections without another request', () => {
    expect(filterPnlAssets(assets, 'all', ['BTC', 'ZIL']).map((asset) => asset.asset)).toEqual(['BTC', 'ZIL'])
  })

  it('can exclude an asset locally without changing the selected P&L scope', () => {
    expect(filterPnlAssets(assets, 'holdings', [], ['IOST']).map((asset) => asset.asset)).toEqual(['BTC'])
  })

  it('shows a verified selected scope without claiming it is the whole portfolio P&L', () => {
    const scope = summarizePnlAssets(filterPnlAssets(assets, 'closed', []))

    expect(scope).toMatchObject({ complete: true, costBasis: 11_000, openCostBasis: 0, realizedCostBasis: 11_000, realizedPnl: -2_031.31, totalPnl: -2_031.31, unrealizedPnl: 0 })
    expect(scope.pnlPercent).toBeCloseTo(-18.46645, 4)
  })

  it('withholds only the selected scope when it includes an unresolved asset', () => {
    const scope = summarizePnlAssets(filterPnlAssets(assets, 'holdings', []))

    expect(scope).toEqual({ complete: false, costBasis: null, openCostBasis: null, pnlPercent: null, realizedCostBasis: null, realizedPnl: null, totalPnl: null, unrealizedPnl: null })
  })
})
