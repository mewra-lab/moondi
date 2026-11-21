import { describe, expect, it } from 'vitest'
import { buildRouteUrl, parseRoute } from './routes'

describe('dashboard routes', () => {
  it('round-trips the canonical routes and handles the existing activity alias', () => {
    for (const view of ['overview', 'transactions', 'history', 'sync'] as const) {
      expect(parseRoute(buildRouteUrl(view))).toEqual({ view, selectedAsset: null })
    }
    expect(parseRoute('/transactions/')).toEqual({ view: 'transactions', selectedAsset: null })
  })

  it('opens normalized asset URLs and falls back for malformed paths', () => {
    expect(parseRoute(buildRouteUrl('overview', 'BTC'))).toEqual({ view: 'overview', selectedAsset: 'BTC' })
    expect(parseRoute('/asset/%62tc/')).toEqual({ view: 'overview', selectedAsset: 'BTC' })
    for (const path of ['/asset/%', '/asset/%2f', '/asset/BTC/ETH', '/missing']) {
      expect(parseRoute(path)).toEqual({ view: 'overview', selectedAsset: null })
    }
  })
})
