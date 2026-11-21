export type View = 'overview' | 'history' | 'sync' | 'transactions'

const viewPaths = {
  overview: '/',
  history: '/history',
  sync: '/sync',
  transactions: '/activity',
} satisfies Record<View, string>

export const parseRoute = (pathname: string): { selectedAsset: string | null; view: View } => {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/activity' || path === '/transactions') return { selectedAsset: null, view: 'transactions' }
  if (path === '/history') return { selectedAsset: null, view: 'history' }
  if (path === '/sync') return { selectedAsset: null, view: 'sync' }
  if (path.startsWith('/asset/')) {
    try {
      const symbol = decodeURIComponent(path.slice('/asset/'.length)).trim().toUpperCase()
      if (/^[A-Z0-9_-]{1,20}$/.test(symbol)) return { selectedAsset: symbol, view: 'overview' }
    } catch {
      return { selectedAsset: null, view: 'overview' }
    }
  }
  return { selectedAsset: null, view: 'overview' }
}

export const buildRouteUrl = (view: View, asset?: string | null): string =>
  asset ? `/asset/${encodeURIComponent(asset)}` : viewPaths[view]
