import type { PnlAsset } from './api'

export type PnlDisplayScope = 'all' | 'closed' | 'holdings' | 'review'

export const filterPnlAssets = (assets: PnlAsset[], scope: PnlDisplayScope, selectedAssets: readonly string[], ignoredAssets: readonly string[] = []): PnlAsset[] => assets.filter((asset) => {
  if (ignoredAssets.includes(asset.asset)) return false
  if (selectedAssets.length > 0 && !selectedAssets.includes(asset.asset)) return false
  if (scope === 'holdings') return asset.quantity > 0
  if (scope === 'closed') return asset.quantity === 0
  if (scope === 'review') return asset.status !== 'ready'
  return true
})

export const summarizePnlAssets = (assets: PnlAsset[]): {
  complete: boolean
  costBasis: number | null
  openCostBasis: number | null
  pnlPercent: number | null
  realizedCostBasis: number | null
  realizedPnl: number | null
  totalPnl: number | null
  unrealizedPnl: number | null
} => {
  const complete = assets.length > 0 && assets.every((asset) => asset.status === 'ready' && asset.costBasis !== null && asset.realizedCostBasis !== null && asset.realizedPnl !== null && asset.totalPnl !== null && asset.unrealizedPnl !== null)
  if (!complete) return { complete: false, costBasis: null, openCostBasis: null, pnlPercent: null, realizedCostBasis: null, realizedPnl: null, totalPnl: null, unrealizedPnl: null }
  const openCostBasis = assets.reduce((total, asset) => total + (asset.costBasis ?? 0), 0)
  const realizedCostBasis = assets.reduce((total, asset) => total + (asset.realizedCostBasis ?? 0), 0)
  const costBasis = openCostBasis + realizedCostBasis
  const totalPnl = assets.reduce((total, asset) => total + (asset.totalPnl ?? 0), 0)
  return {
    complete: true,
    costBasis,
    openCostBasis,
    pnlPercent: costBasis > 0 ? totalPnl / costBasis * 100 : null,
    realizedCostBasis,
    realizedPnl: assets.reduce((total, asset) => total + (asset.realizedPnl ?? 0), 0),
    totalPnl,
    unrealizedPnl: assets.reduce((total, asset) => total + (asset.unrealizedPnl ?? 0), 0),
  }
}
