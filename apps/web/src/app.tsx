import { createContext, lazy, Suspense, useCallback, useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type TouchEvent } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { Switch } from '@base-ui/react/switch'
import { AppSelect } from './app-select'
import { AssetIcon } from './asset-icon'
import { addPriceAlert, addWatchlistAsset, apiAccessRequired, apiAccessUrl, archiveAccount, loadAccounts, loadArchivedAccounts, loadAssetPriceHistories, loadAssetPriceHistory, loadAssetTradeSummary, loadAssetTrades, loadBackup, loadDashboard, loadDcaActivity, loadPushPublicKey, loadSyncEvents, loadTransactions, loadValueHistory, removeAllocationTarget, removePriceAlert, removePushSubscription, removeWatchlistAsset, restoreAccount, saveAllocationTarget, saveCryptoTransferCostBasis, savePushSubscription, testPushDelivery } from './api'
import type { Account, AllocationTarget, CostMethod, Dashboard, Holding, PnlAsset, PnlSummary as PnlSummaryData, Portfolio, PriceAlert, PriceHistoryPoint, PushNotificationPreferences, SyncEvent, SyncStatus, TradeMarker, TradeSummary, Transaction, ValueHistoryPoint, WatchlistAsset } from './api'
import type { DcaActivity, DcaBuy } from '@moondi/shared'
import { DcaActivityPanel } from './dca-activity'
import { NotificationCenter, type NotificationItem } from './notification-center'
import { getCurrentPushSubscription, isPushSupported, subscribeToPush, unsubscribeFromPush } from './push'
import { formatTransactionMoney, transactionValue } from './transaction-display'
import { filterPnlAssets, summarizePnlAssets, type PnlDisplayScope } from './pnl-display'
import { fitCanvasText } from './portfolio-card-layout'
import { ActivityIcon, ChevronRightIcon, CloseIcon, EyeIcon, EyeOffIcon, HistoryIcon, ImageCardIcon, MoonIcon, OverviewIcon, SettingsIcon, SignOutIcon, SunIcon, SyncIcon } from './icons'
import { buildRouteUrl, parseRoute, type View } from './routes'

type Theme = 'light' | 'dark'
type Language = 'th' | 'en'
type HoldingSort = 'asset' | 'quantity' | 'value'
type TransactionFilter = 'all' | Transaction['category']
type PortfolioCardPreset = 'private' | 'value' | 'pnl'
const overviewSectionIds = ['pnl', 'history', 'allocation', 'targets', 'rebalance', 'watchlist', 'syncHealth', 'holdings'] as const
type OverviewSection = (typeof overviewSectionIds)[number]
type OverviewSections = Record<OverviewSection, boolean>

const historyRanges = [
  { days: 1, label: '24 ชม.' },
  { days: 7, label: '7 วัน' },
  { days: 30, label: '30 วัน' },
  { days: 90, label: '90 วัน' },
  { days: 365, label: '1 ปี' },
] as const

type HistoryRange = (typeof historyRanges)[number]['days'] | 'custom'

const priceHistoryRanges = [
  { id: '24h', label: '24 ชม.' },
  { id: '7d', label: '7 วัน' },
  { id: '30d', label: '30 วัน' },
  { id: '6m', label: '6 เดือน' },
  { id: 'ytd', label: 'YTD' },
  { id: '1y', label: '1 ปี' },
  { id: '5y', label: '5 ปี' },
  { id: 'all', label: 'ทั้งหมด' },
] as const

type PriceHistoryRange = (typeof priceHistoryRanges)[number]['id']

const dayMs = 24 * 60 * 60 * 1_000

const priceRangeLabel = (range: PriceHistoryRange, language: Language): string => {
  const labels: Record<PriceHistoryRange, [string, string]> = {
    '24h': ['24 ชม.', '24h'],
    '7d': ['7 วัน', '7d'],
    '30d': ['30 วัน', '30d'],
    '6m': ['6 เดือน', '6m'],
    all: ['ทั้งหมด', 'All'],
    ytd: ['YTD', 'YTD'],
    '1y': ['1 ปี', '1y'],
    '5y': ['5 ปี', '5y'],
  }
  return labels[range][language === 'th' ? 0 : 1]
}

const priceHistoryStart = (range: PriceHistoryRange, now = Date.now()): number | undefined => {
  if (range === 'all') return undefined
  if (range === 'ytd') return new Date(new Date(now).getFullYear(), 0, 1).getTime()
  const days: Exclude<PriceHistoryRange, 'all' | 'ytd'> extends never ? never : Record<Exclude<PriceHistoryRange, 'all' | 'ytd'>, number> = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '6m': 183,
    '1y': 365,
    '5y': 365 * 5 + 2,
  }
  return now - days[range] * dayMs
}

const priceHistoryRequest = (range: PriceHistoryRange): { from: number } => ({ from: priceHistoryStart(range) ?? 0 })

const themeStorageKey = 'moondi.theme.v1'
const languageStorageKey = 'moondi.language.v1'
const valuesVisibleStorageKey = 'moondi.values-visible.v1'
const overviewSectionsStorageKey = 'moondi.overview-sections.v4'
const pnlIgnoredAssetsStorageKey = 'moondi.pnl-ignored-assets.v1'
const pnlViewStorageKey = 'moondi.pnl-view.v1'
const costMethodStorageKey = 'moondi.pnl-cost-method.v1'
const notificationPreferencesStorageKey = 'moondi.notification-preferences.v1'
const accessMessage = new URLSearchParams(window.location.search).get('__cf_access_message')

const restartAccess = (): void => window.location.assign('/login')

const resolveTheme = (): Theme => {
  const savedTheme = localStorage.getItem(themeStorageKey)

  if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const resolveValuesVisible = (): boolean => localStorage.getItem(valuesVisibleStorageKey) !== 'hidden'
const resolveLanguage = (): Language => localStorage.getItem(languageStorageKey) === 'en' ? 'en' : 'th'
const defaultOverviewSections: OverviewSections = { allocation: true, history: true, holdings: true, pnl: true, rebalance: false, syncHealth: false, targets: false, watchlist: false }

const resolveOverviewSections = (): OverviewSections => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(overviewSectionsStorageKey) ?? '')
    if (typeof stored !== 'object' || stored === null) return defaultOverviewSections
    const saved: Partial<OverviewSections> = {}
    for (const section of overviewSectionIds) {
      const value = Reflect.get(stored, section)
      if (typeof value === 'boolean') saved[section] = value
    }
    return { ...defaultOverviewSections, ...saved }
  } catch {
    return defaultOverviewSections
  }
}

const resolveCostMethod = (): CostMethod => localStorage.getItem(costMethodStorageKey) === 'lots' ? 'lots' : 'average'

const CostMethodContext = createContext<CostMethod>('average')

const resolveIgnoredPnlAssets = (): string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(pnlIgnoredAssetsStorageKey) ?? '')
    return Array.isArray(stored) ? [...new Set(stored.filter((asset): asset is string => typeof asset === 'string' && /^[A-Z0-9_-]{1,20}$/.test(asset)))].slice(0, 250) : []
  } catch {
    return []
  }
}

const resolvePnlView = (): { scope: PnlDisplayScope; selectedAssets: string[] } => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(pnlViewStorageKey) ?? '')
    if (typeof stored !== 'object' || stored === null) return { scope: 'holdings', selectedAssets: [] }
    const scope = Reflect.get(stored, 'scope')
    const selected = Reflect.get(stored, 'selectedAssets')
    return {
      scope: scope === 'all' || scope === 'closed' || scope === 'holdings' || scope === 'review' ? scope : 'holdings',
      selectedAssets: Array.isArray(selected) ? [...new Set(selected.filter((asset): asset is string => typeof asset === 'string' && /^[A-Z0-9_-]{1,20}$/.test(asset)))].slice(0, 250) : [],
    }
  } catch {
    return { scope: 'holdings', selectedAssets: [] }
  }
}

const parseDecimal = (value: string): number => Number(value.trim().replace(',', '.'))
const isDecimalDraft = (value: string): boolean => value === '' || /^\d*(?:[.,]\d*)?$/.test(value)
const mutationErrorMessage = (error: unknown, language: Language, fallback: string): string => {
  const message = error instanceof Error ? error.message : ''
  if (message === apiAccessRequired) return language === 'th' ? 'ต้องยืนยันสิทธิ์ API อีกครั้งก่อนบันทึก' : 'Confirm API access again before saving.'
  return message || fallback
}
const defaultNotificationPreferences: PushNotificationPreferences = { cryptoTransfers: true, fiatTransfers: true, priceAlerts: false, syncIssues: true, trades: true }

const resolveNotificationPreferences = (): PushNotificationPreferences => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(notificationPreferencesStorageKey) ?? '')
    if (typeof stored === 'object' && stored !== null && ['cryptoTransfers', 'fiatTransfers', 'syncIssues', 'trades'].every((key) => typeof Reflect.get(stored, key) === 'boolean')) {
      return { ...defaultNotificationPreferences, ...stored as Partial<PushNotificationPreferences> }
    }
  } catch { return defaultNotificationPreferences }
  return defaultNotificationPreferences
}

const quantity = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 8,
})

const currency = (language: Language) => new Intl.NumberFormat(language === 'th' ? 'th-TH' : 'en-US', {
  currency: 'THB',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
})

const dateTime = (language: Language) => new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const formatPortfolioValue = (language: Language, value: number): string => currency(language).format(value).replace(language === 'th' ? '฿' : 'THB', '').trim()

const formatDateInput = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10)

const valueOf = (available: number, reserved: number, price: number): number => (available + reserved) * price

const holdingAmount = (holding: Holding): number => holding.available + holding.reserved

const csvCell = (value: string | number | null): string => `"${String(value ?? '').replaceAll('"', '""')}"`

const downloadCsv = (fileName: string, headers: string[], rows: Array<Array<string | number | null>>): void => {
  const contents = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${contents}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')

  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

const downloadImage = (fileName: string, image: Blob): void => {
  const url = URL.createObjectURL(image)
  const link = document.createElement('a')

  link.href = url
  link.download = fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const portfolioCardFileName = (createdAt: Date): string => `moondi-portfolio-${createdAt.toISOString().slice(0, 10)}.png`

const aggregateCardAssets = (holdings: Holding[]) => {
  const assets = new Map<string, number>()

  for (const holding of holdings) {
    const value = valueOf(holding.available, holding.reserved, holding.price)
    assets.set(holding.asset, (assets.get(holding.asset) ?? 0) + value)
  }

  return [...assets.entries()]
    .map(([asset, value]) => ({ asset, value }))
    .filter(({ value }) => value > 0)
    .toSorted((left, right) => right.value - left.value)
    .slice(0, 4)
}

type AllocationSlice = {
  asset: string
  share: number
  value: number
}

const allocationColors = ['#ee9258', '#569b71', '#7fa6cf', '#c881a8', '#b6a26b', '#8a9b9f']

const aggregatePortfolioAllocation = (holdings: Holding[]): AllocationSlice[] => {
  const byAsset = new Map<string, number>()

  for (const holding of holdings) {
    const value = valueOf(holding.available, holding.reserved, holding.price)
    if (value > 0) byAsset.set(holding.asset, (byAsset.get(holding.asset) ?? 0) + value)
  }

  const assets = [...byAsset.entries()]
    .map(([asset, value]) => ({ asset, value }))
    .toSorted((left, right) => right.value - left.value)
  const total = assets.reduce((sum, asset) => sum + asset.value, 0)
  if (total === 0) return []

  const visible = assets.slice(0, 5)
  const remainingValue = assets.slice(5).reduce((sum, asset) => sum + asset.value, 0)
  if (remainingValue > 0) visible.push({ asset: 'Other', value: remainingValue })

  return visible.map(({ asset, value }) => ({ asset, share: (value / total) * 100, value }))
}

const PortfolioAllocation = ({ slices, language, valuesVisible }: { slices: AllocationSlice[]; language: Language; valuesVisible: boolean }) => {
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const selected = slices.find((slice) => slice.asset === selectedAsset)
  const th = language === 'th'
  const money = currency(language)
  const label = th ? 'สัดส่วนมูลค่าสินทรัพย์ปัจจุบันในพอร์ต' : 'Current portfolio value allocation'
  const assetLabel = (asset: string) => asset === 'Other' && th ? 'อื่น ๆ' : asset
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const compactTotal = new Intl.NumberFormat(th ? 'th-TH' : 'en-GB', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(total)
  let offset = 0

  return (
    <section aria-labelledby="allocation-title" className="portfolio-allocation">
      <div className="section-heading">
        <div>
          <h2 id="allocation-title">{th ? 'สัดส่วนสินทรัพย์' : 'Portfolio allocation'}</h2>
          <p className="allocation-note">{th ? 'ตามมูลค่าปัจจุบัน' : 'By current estimated value.'}</p>
        </div>
      </div>
      <div className="allocation-content">
        <div className="allocation-donut">
          <svg aria-label={label} role="img" viewBox="0 0 120 120">
            <circle className="allocation-track" cx="60" cy="60" fill="none" pathLength="100" r="49" strokeWidth="15" />
            {slices.map((slice, index) => {
              const gap = slices.length > 1 ? Math.min(0.9, slice.share * 0.25) : 0
              const dash = slice.share - gap
              const segment = (
                <circle
                  className="allocation-segment"
                  cx="60"
                  cy="60"
                  data-dimmed={selected && selected !== slice ? true : undefined}
                  fill="none"
                  key={slice.asset}
                  pathLength="100"
                  r="49"
                  strokeDasharray={`${dash} ${100 - dash}`}
                  strokeDashoffset={-offset}
                  strokeWidth={selected === slice ? 18 : 15}
                  style={{ stroke: allocationColors[index % allocationColors.length] }}
                />
              )
              offset += slice.share
              return segment
            })}
          </svg>
          <div className="allocation-center">
            <strong title={valuesVisible && !selected ? money.format(total) : undefined}>{selected ? `${selected.share.toFixed(1)}%` : valuesVisible ? `฿${compactTotal}` : '—'}</strong>
            <span>{selected ? assetLabel(selected.asset) : (th ? 'มูลค่าพอร์ต' : 'Portfolio value')}</span>
          </div>
        </div>
        <ul className="allocation-legend" role="list">
          {slices.map((slice, index) => (
            <li key={slice.asset}>
              <button aria-pressed={selected === slice} className="allocation-legend-row" onClick={() => setSelectedAsset((current) => current === slice.asset ? null : slice.asset)} type="button">
                <span aria-hidden="true" className="allocation-swatch" style={{ background: allocationColors[index % allocationColors.length] }} />
                <span className="allocation-asset"><strong>{assetLabel(slice.asset)}</strong><small className={valuesVisible ? undefined : 'value-concealed'}>{money.format(slice.value)}</small></span>
                <span className="allocation-share">{slice.share.toFixed(1)}%</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

const PnlAssetDetails = ({ assets, language, valuesVisible }: { assets: PnlAsset[]; language: Language; valuesVisible: boolean }) => {
  const th = language === 'th'
  const money = currency(language)
  const monetaryValue = (value: number | null) => value === null ? '—' : money.format(value)
  const profit = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${money.format(value)}`
  const concealed = valuesVisible ? undefined : 'value-concealed'
  const pnlValue = (value: number | null) => <span className={value === null || value === 0 ? undefined : value > 0 ? 'pnl-positive' : 'pnl-negative'}>{profit(value)}</span>
  const labels = {
    quantity: th ? 'จำนวน' : 'Quantity',
    current: th ? 'มูลค่าปัจจุบัน' : 'Current value',
    cost: th ? 'ต้นทุน / ราคาเฉลี่ย' : 'Cost basis / average',
    realized: th ? 'กำไรที่เกิดแล้ว' : 'Realized P&L',
    unrealized: th ? 'กำไรที่ยังไม่เกิด' : 'Unrealized P&L',
    total: th ? 'P&L รวม' : 'Total P&L',
    status: th ? 'สถานะ' : 'Status',
  }
  const statuses = {
    ready: th ? 'พร้อม' : 'Ready',
    missing_cost_basis: th ? 'ต้องระบุต้นทุน' : 'Cost basis needed',
    missing_history: th ? 'ขาดประวัติ' : 'History needed',
    unsupported_quote: th ? 'คู่ที่ยังไม่รองรับ' : 'Unsupported pair',
    missing_price: th ? 'ขาดราคา' : 'Price needed',
    quantity_mismatch: th ? 'ยอดไม่ตรงกับ Bitkub' : 'Balance mismatch',
  }
  const rows = assets.map((asset) => {
    const fields = [
      { label: labels.quantity, content: quantity.format(asset.quantity) },
      { label: labels.current, content: monetaryValue(asset.currentValue) },
      { label: labels.cost, content: asset.costBasis === null ? '—' : <>
        {money.format(asset.costBasis)}
        <small>{asset.averageCost === null ? (th ? 'ปิดสถานะแล้ว' : 'Closed') : `${th ? 'เฉลี่ย' : 'Avg'} ${money.format(asset.averageCost)}`}</small>
      </> },
      { label: labels.realized, content: pnlValue(asset.realizedPnl) },
      { label: labels.unrealized, content: pnlValue(asset.unrealizedPnl) },
    ]
    const tone = asset.totalPnl === null || asset.totalPnl === 0 ? '' : asset.totalPnl > 0 ? 'pnl-positive' : 'pnl-negative'
    const total = <span className={tone}>{profit(asset.totalPnl)}{asset.pnlPercent === null ? null : <small>{asset.pnlPercent >= 0 ? '+' : ''}{asset.pnlPercent.toFixed(2)}%</small>}</span>
    const status = <span className={`pnl-status pnl-status-${asset.status}`}>{statuses[asset.status]}</span>

    return { asset, fields, status, total }
  })
  const accessibleLabel = th ? 'รายละเอียดกำไรขาดทุนรายเหรียญ' : 'P&L by asset'

  return (
    <div className="pnl-assets" id="pnl-assets" role="region" aria-label={accessibleLabel}>
      <div className="pnl-asset-table">
        <table aria-label={accessibleLabel}>
          <thead>
            <tr>
              <th scope="col">{th ? 'เหรียญ' : 'Asset'}</th>
              {Object.values(labels).map((label) => <th key={label} scope="col">{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ asset, fields, status, total }) => <tr key={asset.asset}>
              <th scope="row">{asset.asset}</th>
              {fields.map(({ content, label }) => <td className={concealed} key={label}>{content}</td>)}
              <td className={concealed}>{total}</td>
              <td>{status}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <ul className="pnl-asset-list" role="list">
        {rows.map(({ asset, fields, status, total }) => <li key={asset.asset}>
          <details>
            <summary className="pnl-asset-summary">
              <span className="pnl-asset-identity">
                <strong className="asset-symbol"><AssetIcon asset={asset.asset} />{asset.asset}</strong>
                {asset.status === 'ready' ? <span className={concealed}>{quantity.format(asset.quantity)} {asset.asset}</span> : status}
              </span>
              <span className="pnl-asset-headline">
                <span>{labels.total}</span>
                <span className={concealed}>{total}</span>
              </span>
              <ChevronRightIcon aria-hidden="true" height={16} width={16} />
            </summary>
            <dl className="pnl-asset-fields">
              {(asset.status === 'ready' ? fields.slice(1) : fields).map(({ content, label }) => <div key={label}>
                <dt>{label}</dt><dd className={concealed}>{content}</dd>
              </div>)}
              <div><dt>{labels.status}</dt><dd>{status}</dd></div>
            </dl>
          </details>
        </li>)}
      </ul>
    </div>
  )
}

const PnlPanel = ({ costMethod, ignoredAssets, language, onCostMethodChange, onSaveCostBasis, pnl, valuesVisible }: {
  costMethod: CostMethod
  ignoredAssets: readonly string[]
  language: Language
  onCostMethodChange: (method: CostMethod) => void
  onSaveCostBasis: (transferId: string, totalCostThb: number) => Promise<void>
  pnl: PnlSummaryData
  valuesVisible: boolean
}) => {
  const [selectedAssets, setSelectedAssets] = useState(() => resolvePnlView().selectedAssets)
  const [costBasisOpen, setCostBasisOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [scope, setScope] = useState<PnlDisplayScope>(() => resolvePnlView().scope)
  const [workingTransferId, setWorkingTransferId] = useState<string | null>(null)
  const money = currency(language)
  const signedMoney = (value: number): string => `${value >= 0 ? '+' : ''}${money.format(value)}`
  const signedPercent = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
  const pnlTone = (value: number | null): string => value === null || value === 0 ? 'pnl-neutral' : value > 0 ? 'pnl-positive' : 'pnl-negative'
  const scopeAssets = useMemo(() => filterPnlAssets(pnl.assets, scope, [], ignoredAssets), [ignoredAssets, pnl.assets, scope])
  const visibleAssets = useMemo(() => filterPnlAssets(pnl.assets, scope, selectedAssets, ignoredAssets), [ignoredAssets, pnl.assets, scope, selectedAssets])
  const visiblePnl = useMemo(() => summarizePnlAssets(visibleAssets), [visibleAssets])
  const visibleAssetNames = useMemo(() => new Set(visibleAssets.map((asset) => asset.asset)), [visibleAssets])
  const missingCostBasis = useMemo(() => pnl.missingCostBasis.filter((transfer) => visibleAssetNames.has(transfer.asset)), [pnl.missingCostBasis, visibleAssetNames])
  const needsReview = visibleAssets.filter((asset) => asset.status !== 'ready')
  const costBasisLabel = scope === 'holdings'
    ? visiblePnl.realizedCostBasis && visiblePnl.realizedCostBasis > 0
      ? (language === 'th' ? 'ต้นทุนที่ใช้คิดผลตอบแทน' : 'Cost used for return')
      : (language === 'th' ? 'ต้นทุนของเหรียญที่ยังถือ' : 'Open holding cost')
    : scope === 'closed'
      ? (language === 'th' ? 'ต้นทุนของสถานะที่ปิดแล้ว' : 'Closed position cost')
      : (language === 'th' ? 'ต้นทุนที่ใช้คิดผลตอบแทน' : 'Cost used for return')
  const costBasisDescription = visiblePnl.openCostBasis === null || visiblePnl.realizedCostBasis === null
    ? `${visibleAssets.length} ${language === 'th' ? 'เหรียญในมุมมอง' : 'assets in view'}`
    : scope === 'holdings'
      ? (language === 'th' ? `ต้นทุนของจำนวนที่ยังถือ ${money.format(visiblePnl.openCostBasis)}${visiblePnl.realizedCostBasis > 0 ? ` · ต้นทุนที่ขายแล้ว ${money.format(visiblePnl.realizedCostBasis)}` : ''}` : `Cost of current quantity ${money.format(visiblePnl.openCostBasis)}${visiblePnl.realizedCostBasis > 0 ? ` · Sold cost ${money.format(visiblePnl.realizedCostBasis)}` : ''}`)
      : scope === 'closed'
        ? (language === 'th' ? `ต้นทุนของจำนวนที่ขายแล้ว ${money.format(visiblePnl.realizedCostBasis)}` : `Cost of units sold ${money.format(visiblePnl.realizedCostBasis)}`)
        : (language === 'th' ? `ยังถือ ${money.format(visiblePnl.openCostBasis)} · ปิดแล้ว ${money.format(visiblePnl.realizedCostBasis)}` : `Open ${money.format(visiblePnl.openCostBasis)} · Closed ${money.format(visiblePnl.realizedCostBasis)}`)

  useEffect(() => {
    localStorage.setItem(pnlViewStorageKey, JSON.stringify({ scope, selectedAssets }))
  }, [scope, selectedAssets])

  useEffect(() => {
    const availableAssets = new Set(pnl.assets.filter((asset) => !ignoredAssets.includes(asset.asset)).map((asset) => asset.asset))
    setSelectedAssets((current) => current.filter((asset) => availableAssets.has(asset)))
  }, [ignoredAssets, pnl.assets])
  const save = async (transferId: string) => {
    const value = parseDecimal(drafts[transferId] ?? '')
    if (!Number.isFinite(value) || value < 0) {
      setMessage(language === 'th' ? 'กรอกต้นทุนรวมเป็นเงินบาทตั้งแต่ 0 ขึ้นไป' : 'Enter a total THB cost basis of zero or more.')
      return
    }
    setWorkingTransferId(transferId)
    setMessage(null)
    try {
      await onSaveCostBasis(transferId, value)
      setDrafts((current) => {
        const next = { ...current }
        delete next[transferId]
        return next
      })
    } catch (error) {
      setMessage(mutationErrorMessage(error, language, language === 'th' ? 'บันทึกต้นทุนไม่สำเร็จ' : 'Unable to save the cost basis.'))
    } finally {
      setWorkingTransferId(null)
    }
  }

  return (
    <section aria-labelledby="pnl-title" className="pnl-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Bitkub P&amp;L</p>
          <h2 id="pnl-title">{language === 'th' ? 'กำไร / ขาดทุน' : 'Profit & loss'}</h2>
          <p className="pnl-note">{pnl.costMethod === 'lots'
            ? (language === 'th' ? 'คำนวณแบบตามล็อตจากรายการคู่ THB เท่านั้น: ขายล็อตที่ซื้อล่าสุดก่อน ส่วนการถอนเอาเหรียญที่ซื้อวันเดียวกันก่อน แล้วค่อยล็อตเก่า (วันตามเวลาไทย) เป็นการสมมติว่าเหรียญที่ขายหรือถอนคือล็อตไหน' : 'Lot-based calculation for THB-quoted Bitkub trades only: a sale takes the most recently bought lots first; a withdrawal takes coins bought the same day first (Thailand time), then the oldest lots. This assumes which coins were sold or sent.')
            : (language === 'th' ? 'คำนวณแบบต้นทุนเฉลี่ยจากรายการคู่ THB เท่านั้น' : 'Average-cost calculation for THB-quoted Bitkub trades only.')}</p>
        </div>
        <div aria-label={language === 'th' ? 'วิธีคิดต้นทุน' : 'Cost method'} className="settings-segmented" role="group">
          <button aria-pressed={costMethod === 'average'} className={costMethod === 'average' ? 'active' : undefined} onClick={() => onCostMethodChange('average')} type="button">{language === 'th' ? 'ต้นทุนเฉลี่ย' : 'Average cost'}</button>
          <button aria-pressed={costMethod === 'lots'} className={costMethod === 'lots' ? 'active' : undefined} onClick={() => onCostMethodChange('lots')} type="button">{language === 'th' ? 'ตามล็อต' : 'By lot'}</button>
        </div>
      </div>
      <div className="pnl-controls">
        <AppSelect<PnlDisplayScope>
          items={[
            { value: 'holdings', label: language === 'th' ? 'เหรียญที่ยังถือ' : 'Current holdings' },
            { value: 'closed', label: language === 'th' ? 'เหรียญที่ปิดสถานะแล้ว' : 'Closed positions' },
            { value: 'review', label: language === 'th' ? 'รายการที่ต้องตรวจสอบ' : 'Needs review' },
            { value: 'all', label: language === 'th' ? 'ทุกเหรียญ' : 'All assets' },
          ]}
          label={language === 'th' ? 'มุมมองกำไร / ขาดทุน' : 'Profit and loss view'}
          onChange={(nextScope) => {
            setScope(nextScope)
            setSelectedAssets([])
            setCostBasisOpen(false)
          }}
          value={scope}
        />
        <AppSelect
          items={[
            { value: '', label: language === 'th' ? 'เลือกเหรียญ' : 'Select assets' },
            ...scopeAssets.filter((asset) => !selectedAssets.includes(asset.asset)).map(({ asset }) => ({ value: asset, label: asset })),
          ]}
          label={language === 'th' ? 'เลือกเหรียญสำหรับคำนวณ P&L' : 'Select assets for profit and loss'}
          onChange={(asset) => {
            if (asset) setSelectedAssets((current) => current.includes(asset) ? current : [...current, asset])
          }}
          value=""
        />
      </div>
      {selectedAssets.length > 0 ? <div className="pnl-selected-assets" aria-label={language === 'th' ? 'เหรียญที่เลือก' : 'Selected assets'}>
        <span>{language === 'th' ? 'กำลังคำนวณ' : 'Calculating'}</span>
        {selectedAssets.map((asset) => <button key={asset} onClick={() => setSelectedAssets((current) => current.filter((currentAsset) => currentAsset !== asset))} type="button">{asset} <span aria-hidden="true">×</span><span className="sr-only"> {language === 'th' ? 'เอาออก' : 'Remove'}</span></button>)}
        <button className="text-button" onClick={() => setSelectedAssets([])} type="button">{language === 'th' ? 'ล้างตัวเลือก' : 'Clear selection'}</button>
      </div> : null}
      <div className="pnl-summary">
        <div><span>{costBasisLabel}</span><strong className={valuesVisible ? undefined : 'value-concealed'}>{visiblePnl.costBasis === null ? '—' : money.format(visiblePnl.costBasis)}</strong><small className={valuesVisible ? undefined : 'value-concealed'}>{costBasisDescription}</small></div>
        <div><span>{language === 'th' ? 'กำไรที่เกิดขึ้นแล้ว' : 'Realized P&L'}</span><strong className={`${pnlTone(visiblePnl.realizedPnl)}${valuesVisible ? '' : ' value-concealed'}`}>{visiblePnl.realizedPnl === null ? '—' : signedMoney(visiblePnl.realizedPnl)}</strong></div>
        <div><span>{language === 'th' ? 'กำไรที่ยังไม่เกิดขึ้น' : 'Unrealized P&L'}</span><strong className={`${pnlTone(visiblePnl.unrealizedPnl)}${valuesVisible ? '' : ' value-concealed'}`}>{visiblePnl.unrealizedPnl === null ? '—' : signedMoney(visiblePnl.unrealizedPnl)}</strong></div>
        <div><span>{language === 'th' ? 'กำไร / ขาดทุนของมุมมองนี้' : 'P&L for this view'}</span><strong className={`${pnlTone(visiblePnl.totalPnl)}${valuesVisible ? '' : ' value-concealed'}`}>{visiblePnl.totalPnl === null ? '—' : signedMoney(visiblePnl.totalPnl)}</strong><small className={`${pnlTone(visiblePnl.pnlPercent)}${valuesVisible ? '' : ' value-concealed'}`}>{visiblePnl.pnlPercent === null ? (language === 'th' ? 'ไม่มีฐานต้นทุนสำหรับ %' : 'No cost denominator') : signedPercent(visiblePnl.pnlPercent)}</small></div>
      </div>
      {ignoredAssets.length > 0 ? <p className="pnl-filter-context">{language === 'th' ? `ไม่รวมในการแสดงและสรุป P&L ของเบราว์เซอร์นี้: ${ignoredAssets.join(', ')} · ข้อมูลและยอดคงเหลือจริงยังอยู่ครบ` : `Excluded from this browser’s P&L view and summary: ${ignoredAssets.join(', ')} · Source data and holdings remain unchanged.`}</p> : null}
      {!visiblePnl.complete ? <div className="pnl-warning">
        <p>{language === 'th' ? 'ยังไม่แสดง P&L ของมุมมองนี้ เพราะมีรายการที่ต้นทุนหรือจำนวนยังตรวจสอบไม่ได้' : 'P&L for this view is withheld until every included asset has a verifiable cost and quantity.'}</p>
        {!pnl.historyComplete ? <p>{language === 'th' ? 'ต้อง sync ประวัติปัจจุบันให้ครบและ import ประวัติ Bitkub ที่ตรวจสอบแล้วก่อน จึงจะแสดง P&L ได้' : 'Complete the current history sync and import a verified Bitkub archive before P&L can be shown.'}</p> : null}
        {missingCostBasis.length > 0 ? <div className="pnl-cost-basis-list">
          <button aria-controls="pnl-cost-basis" aria-expanded={costBasisOpen} className="pnl-review-toggle" onClick={() => setCostBasisOpen((open) => !open)} type="button">{costBasisOpen ? (language === 'th' ? 'ซ่อนรายการต้นทุนที่ต้องระบุ' : 'Hide cost-basis review') : (language === 'th' ? `ตรวจสอบต้นทุนรายการโอนเข้า (${missingCostBasis.length})` : `Review external deposits (${missingCostBasis.length})`)}</button>
          {costBasisOpen ? <div id="pnl-cost-basis">
            <strong>{language === 'th' ? 'เหรียญที่โอนเข้าจากภายนอก' : 'Crypto received from outside Bitkub'}</strong>
            {missingCostBasis.map((transfer) => (
            <form key={transfer.transferId} onSubmit={(event) => { event.preventDefault(); void save(transfer.transferId) }}>
              <span>{transfer.asset} · <span className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(transfer.amount)}</span> · {dateTime(language).format(transfer.executedAt)}</span>
              <label><span className="sr-only">{language === 'th' ? 'ต้นทุนรวม THB' : 'Total THB cost basis'}</span><Input inputMode="decimal" min="0" onChange={(event) => setDrafts((current) => ({ ...current, [transfer.transferId]: event.target.value }))} placeholder={language === 'th' ? 'ต้นทุนรวม THB' : 'Total THB cost'} type="number" value={drafts[transfer.transferId] ?? ''} /></label>
              <button className="export-button" disabled={workingTransferId === transfer.transferId} type="submit">{workingTransferId === transfer.transferId ? (language === 'th' ? 'กำลังบันทึก…' : 'Saving…') : (language === 'th' ? 'บันทึก' : 'Save')}</button>
              {transfer.suggestedCostThb !== undefined && transfer.suggestedMatchedQuantity !== undefined ? <CarriedCostSuggestion costMethod={pnl.costMethod ?? 'average'}
                amount={transfer.amount}
                asset={transfer.asset}
                costThb={transfer.suggestedCostThb}
                language={language}
                matchedQuantity={transfer.suggestedMatchedQuantity}
                onUse={(value) => setDrafts((current) => ({ ...current, [transfer.transferId]: value }))}
                valuesVisible={valuesVisible}
              /> : null}
            </form>
            ))}
          </div> : null}
        </div> : null}
        {needsReview.filter((asset) => asset.status !== 'missing_cost_basis').length > 0 ? <p>{language === 'th' ? 'ตรวจสอบยอดคงเหลือหรือประวัติคู่ quote ที่ไม่ใช่ THB ของ: ' : 'Review the balance or non-THB quoted history for: '}{needsReview.filter((asset) => asset.status !== 'missing_cost_basis').map((asset) => asset.asset).join(', ')}</p> : null}
      </div> : null}
      {visibleAssets.length > 0 ? <>
        <button aria-controls="pnl-assets" aria-expanded={detailsOpen} className="pnl-details-toggle" onClick={() => setDetailsOpen((open) => !open)} type="button">{detailsOpen ? (language === 'th' ? 'ซ่อนรายละเอียดรายเหรียญ' : 'Hide asset details') : (language === 'th' ? `แสดงรายละเอียดรายเหรียญ (${visibleAssets.length})` : `Show asset details (${visibleAssets.length})`)}</button>
        {detailsOpen ? <PnlAssetDetails assets={visibleAssets} language={language} valuesVisible={valuesVisible} /> : null}
      </> : <p className="pnl-note">{language === 'th' ? 'ไม่มีเหรียญในมุมมองนี้' : 'No assets in this view.'}</p>}
      {message ? <p className="inline-status">{message}</p> : null}
    </section>
  )
}

const CarriedCostSuggestion = ({ amount, asset, costMethod, costThb, language, matchedQuantity, onUse, valuesVisible }: {
  amount: number
  asset: string
  costMethod: CostMethod
  costThb: number
  language: Language
  matchedQuantity: number
  onUse: (value: string) => void
  valuesVisible: boolean
}) => {
  const money = currency(language)
  const concealed = valuesVisible ? undefined : 'value-concealed'
  const fullyMatched = amount - matchedQuantity <= Math.max(2e-7, amount * 1e-6)
  return (
    <div className="pnl-cost-suggestion">
      <p>
        {language === 'th' ? 'ตรงกับ ' : 'Matches '}{asset} {language === 'th' ? 'ที่เคยโอนออกจาก Bitkub ' : 'previously withdrawn from Bitkub: '}
        <span className={concealed}>{quantity.format(matchedQuantity)}</span>
        {fullyMatched ? '' : (language === 'th' ? ' จาก ' : ' of ')}
        {fullyMatched ? '' : <span className={concealed}>{quantity.format(amount)}</span>}
        {language === 'th' ? ' · ต้นทุนเดิมของส่วนนี้ ' : ' · original cost of that part '}
        <span className={concealed}>{money.format(costThb)}</span>
        {fullyMatched ? '' : (language === 'th' ? ' · ส่วนที่เหลือต้องระบุเอง' : ' · the rest needs your own figure')}
      </p>
      <p>{costMethod === 'lots'
        ? (language === 'th' ? 'เป็นค่าประมาณจากต้นทุนจริงของล็อตที่โอนออกล่าสุด ไม่ได้บันทึกให้อัตโนมัติ — ตรวจสอบก่อนบันทึก' : 'Estimated from the real cost of the lots most recently withdrawn. Nothing is saved automatically — review it before saving.')
        : (language === 'th' ? 'เป็นค่าประมาณจากต้นทุนเฉลี่ยตอนโอนออก ไม่ได้บันทึกให้อัตโนมัติ — ตรวจสอบก่อนบันทึก' : 'Estimated from the average cost when the coins left. Nothing is saved automatically — review it before saving.')}</p>
      {fullyMatched ? <button className="pnl-review-toggle" onClick={() => onUse((Math.round(costThb * 100) / 100).toString())} type="button">{language === 'th' ? 'ใช้ค่าที่แนะนำ' : 'Use suggested cost'}</button> : null}
    </div>
  )
}

const AllocationTargets = ({ holdings, language, onRemove, onSave, targets }: {
  holdings: Holding[]
  language: Language
  onRemove: (asset: string) => Promise<void>
  onSave: (asset: string, targetPercent: number) => Promise<void>
  targets: AllocationTarget[]
}) => {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [workingAsset, setWorkingAsset] = useState<string | null>(null)
  const totalValue = holdings.reduce((total, holding) => total + valueOf(holding.available, holding.reserved, holding.price), 0)
  const assets = [...new Set([
    ...holdings.filter((holding) => holdingAmount(holding) > 0).map((holding) => holding.asset),
    ...targets.map((target) => target.asset),
  ])].toSorted()
  const targetByAsset = new Map(targets.map((target) => [target.asset, target.target_percent]))
  const totalTarget = targets.reduce((total, target) => total + target.target_percent, 0)

  const currentShare = (asset: string): number => totalValue === 0 ? 0 : holdings.filter((holding) => holding.asset === asset).reduce((total, holding) => total + valueOf(holding.available, holding.reserved, holding.price), 0) / totalValue * 100
  const save = async (asset: string) => {
    const target = parseDecimal(drafts[asset] ?? String(targetByAsset.get(asset) ?? 0))
    if (!Number.isFinite(target) || target <= 0 || target > 100) {
      setMessage(language === 'th' ? 'กรอกเป้าหมายเป็นเปอร์เซ็นต์ระหว่าง 0–100' : 'Enter a target between 0 and 100%.')
      return
    }
    setWorkingAsset(asset)
    setMessage(null)
    try {
      await onSave(asset, target)
      setDrafts((current) => ({ ...current, [asset]: String(target) }))
    } catch (error) {
      setMessage(mutationErrorMessage(error, language, language === 'th' ? 'บันทึกเป้าหมายไม่สำเร็จ' : 'Unable to save target.'))
    } finally {
      setWorkingAsset(null)
    }
  }

  const remove = async (asset: string) => {
    setWorkingAsset(asset)
    setMessage(null)
    try {
      await onRemove(asset)
      setDrafts((current) => {
        const { [asset]: _removedDraft, ...remainingDrafts } = current
        return remainingDrafts
      })
    } catch (error) {
      setMessage(mutationErrorMessage(error, language, language === 'th' ? 'ลบเป้าหมายไม่สำเร็จ' : 'Unable to remove target.'))
    } finally {
      setWorkingAsset(null)
    }
  }

  return (
    <section className="allocation-targets" aria-labelledby="allocation-targets-title">
      <div className="section-heading">
        <div>
          <h2 id="allocation-targets-title">{language === 'th' ? 'เป้าหมายสัดส่วนพอร์ต' : 'Allocation targets'}</h2>
          <p className="allocation-note">{language === 'th' ? `ตั้งได้รวมไม่เกิน 100% · เหลือ ${Math.max(0, 100 - totalTarget).toFixed(1)}% เป็นส่วนที่ยังไม่กำหนด` : `Targets may total up to 100% · ${Math.max(0, 100 - totalTarget).toFixed(1)}% remains unallocated.`}</p>
        </div>
      </div>
      <div className="allocation-target-list">
        {assets.map((asset) => {
          const target = targetByAsset.get(asset)
          const current = currentShare(asset)
          const draft = drafts[asset] ?? (target === undefined ? '' : String(target))
          return (
            <form className="allocation-target-row" key={asset} onSubmit={(event) => { event.preventDefault(); void save(asset) }}>
              <strong>{asset}</strong>
              <span className="allocation-current">{language === 'th' ? `ปัจจุบัน ${current.toFixed(1)}%` : `Current ${current.toFixed(1)}%`}</span>
              <label className="unit-input percent-input">
                <span className="sr-only">{language === 'th' ? `เป้าหมาย ${asset} (%)` : `${asset} target (%)`}</span>
                <Input autoComplete="off" inputMode="decimal" maxLength={6} onChange={(event) => { if (isDecimalDraft(event.target.value)) setDrafts((currentDrafts) => ({ ...currentDrafts, [asset]: event.target.value })) }} pattern="[0-9]*[.,]?[0-9]*" placeholder="0.0" type="text" value={draft} />
                <span aria-hidden="true">%</span>
              </label>
              <div className="allocation-target-actions">
                <Button className="export-button" disabled={workingAsset === asset} type="submit">{target === undefined ? (language === 'th' ? 'ตั้งเป้า' : 'Set') : (language === 'th' ? 'บันทึก' : 'Save')}</Button>
                {target !== undefined ? <Button aria-label={language === 'th' ? `ลบเป้าหมาย ${asset}` : `Remove ${asset} target`} className="export-button secondary-action" disabled={workingAsset === asset} onClick={() => void remove(asset)} type="button">{language === 'th' ? 'ลบ' : 'Remove'}</Button> : null}
              </div>
            </form>
          )
        })}
      </div>
      {message ? <p className="inline-status" role="status">{message}</p> : null}
    </section>
  )
}

type RebalanceComparison = {
  asset: string
  currentPercent: number
  differencePercent: number
  differenceValue: number
  targetPercent: number
}

const rebalanceComparisons = (holdings: Holding[], targets: AllocationTarget[]): RebalanceComparison[] => {
  const values = new Map<string, number>()

  for (const holding of holdings) {
    const value = valueOf(holding.available, holding.reserved, holding.price)
    if (value <= 0) continue
    values.set(holding.asset, (values.get(holding.asset) ?? 0) + value)
  }

  const totalValue = [...values.values()].reduce((total, value) => total + value, 0)
  if (totalValue <= 0) return []

  return targets
    .filter((target) => Number.isFinite(target.target_percent) && target.target_percent > 0)
    .map((target) => {
      const currentValue = values.get(target.asset) ?? 0
      const currentPercent = currentValue / totalValue * 100
      const targetValue = totalValue * target.target_percent / 100

      return {
        asset: target.asset,
        currentPercent,
        differencePercent: target.target_percent - currentPercent,
        differenceValue: targetValue - currentValue,
        targetPercent: target.target_percent,
      }
    })
    .toSorted((left, right) => Math.abs(right.differenceValue) - Math.abs(left.differenceValue))
}

const RebalanceAssistant = ({ holdings, language, targets, valuesVisible }: {
  holdings: Holding[]
  language: Language
  targets: AllocationTarget[]
  valuesVisible: boolean
}) => {
  const comparisons = rebalanceComparisons(holdings, targets)
  const money = currency(language)
  const threshold = 0.05

  return (
    <section aria-labelledby="rebalance-title" className="rebalance-assistant">
      <div className="section-heading">
        <div>
          <h2 id="rebalance-title">{language === 'th' ? 'เทียบสัดส่วนกับเป้าหมาย' : 'Compare with targets'}</h2>
          <p className="allocation-note">{language === 'th' ? 'คำนวณจากมูลค่าประเมินปัจจุบันและเป้าหมายที่ตั้งไว้เท่านั้น ไม่มีคำสั่งซื้อ ขาย หรือโอนสินทรัพย์' : 'A read-only comparison of current estimated value and your targets. It cannot buy, sell, or transfer assets.'}</p>
        </div>
      </div>
      {comparisons.length === 0 ? (
        <p className="rebalance-empty">{language === 'th' ? 'ตั้งเป้าหมายสัดส่วนอย่างน้อยหนึ่งรายการด้านบนเพื่อดูส่วนต่าง' : 'Set at least one allocation target above to see the comparison.'}</p>
      ) : (
        <div className="rebalance-list">
          {comparisons.map((comparison) => {
            const withinTarget = Math.abs(comparison.differencePercent) < threshold
            const isUnder = comparison.differencePercent > 0
            const state = withinTarget ? 'on-target' : (isUnder ? 'under-target' : 'over-target')
            const stateLabel = withinTarget
              ? (language === 'th' ? 'ใกล้เป้าหมาย' : 'Near target')
              : (isUnder ? (language === 'th' ? 'ต่ำกว่าเป้าหมาย' : 'Below target') : (language === 'th' ? 'สูงกว่าเป้าหมาย' : 'Above target'))
            const differenceLabel = withinTarget
              ? (language === 'th' ? 'ส่วนต่างน้อยกว่า 0.05%' : 'Difference below 0.05%')
              : money.format(Math.abs(comparison.differenceValue))

            return (
              <article className="rebalance-row" key={comparison.asset}>
                <strong>{comparison.asset}</strong>
                <div className="rebalance-measure">
                  <span>{language === 'th' ? `ปัจจุบัน ${comparison.currentPercent.toFixed(1)}%` : `Current ${comparison.currentPercent.toFixed(1)}%`}</span>
                  <span>{language === 'th' ? `เป้าหมาย ${comparison.targetPercent.toFixed(1)}%` : `Target ${comparison.targetPercent.toFixed(1)}%`}</span>
                </div>
                <div className={`rebalance-variance ${state}`}>
                  <span>{stateLabel}</span>
                  <strong className={valuesVisible ? undefined : 'value-concealed'}>{differenceLabel}</strong>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

const TrackedPrices = ({ holdings, language, onAddAlert, onAddAsset, onRemoveAlert, onRemoveAsset, priceAlerts, valuesVisible, watchlist }: {
  holdings: Holding[]
  language: Language
  onAddAlert: (asset: string, direction: 'above' | 'below', targetPrice: number) => Promise<void>
  onAddAsset: (asset: string) => Promise<{ asset: string; created: boolean }>
  onRemoveAlert: (id: string) => Promise<void>
  onRemoveAsset: (asset: string) => Promise<void>
  priceAlerts: PriceAlert[]
  valuesVisible: boolean
  watchlist: WatchlistAsset[]
}) => {
  const [asset, setAsset] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [targetPrice, setTargetPrice] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const availableAssets = [...new Set(holdings
    .filter((holding) => holding.asset !== 'THB' && holdingAmount(holding) > 0)
    .map((holding) => holding.asset))].toSorted()

  useEffect(() => {
    if (!availableAssets.includes(asset)) setAsset(availableAssets[0] ?? '')
  }, [asset, availableAssets])

  const addWatch = async () => {
    if (!asset) return
    setIsWorking(true)
    setMessage(null)
    try {
      const result = await onAddAsset(asset)
      setMessage(result.created
        ? (language === 'th' ? `เพิ่ม ${result.asset} ในรายการติดตามแล้ว` : `${result.asset} was added to the watchlist.`)
        : (language === 'th' ? `${result.asset} อยู่ในรายการติดตามแล้ว` : `${result.asset} is already on the watchlist.`))
    } catch (error) {
      setMessage(mutationErrorMessage(error, language, language === 'th' ? 'เพิ่มรายการติดตามไม่สำเร็จ' : 'Unable to add the asset to the watchlist.'))
    } finally {
      setIsWorking(false)
    }
  }

  const addAlert = async () => {
    if (!valuesVisible) return
    const price = parseDecimal(targetPrice)
    if (!asset || !Number.isFinite(price) || price <= 0) {
      setMessage(language === 'th' ? 'ระบุราคาเป้าหมายที่มากกว่า 0' : 'Enter a target price above zero.')
      return
    }
    setIsWorking(true)
    setMessage(null)
    try {
      await onAddAlert(asset, direction, price)
      setTargetPrice('')
    } catch (error) {
      setMessage(mutationErrorMessage(error, language, language === 'th' ? 'สร้างการแจ้งเตือนไม่สำเร็จ' : 'Unable to create the alert.'))
    } finally {
      setIsWorking(false)
    }
  }

  const removeWatch = async (assetToRemove: string) => {
    setIsWorking(true)
    setMessage(null)
    try {
      await onRemoveAsset(assetToRemove)
    } catch (error) {
      setMessage(mutationErrorMessage(error, language, language === 'th' ? 'ลบรายการติดตามไม่สำเร็จ' : 'Unable to remove the watchlist asset.'))
    } finally {
      setIsWorking(false)
    }
  }

  const removeAlert = async (id: string) => {
    setIsWorking(true)
    setMessage(null)
    try {
      await onRemoveAlert(id)
    } catch (error) {
      setMessage(mutationErrorMessage(error, language, language === 'th' ? 'ลบการแจ้งเตือนไม่สำเร็จ' : 'Unable to remove the alert.'))
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <section className="tracked-prices" aria-labelledby="tracked-prices-title">
      <div className="section-heading">
        <div>
          <h2 id="tracked-prices-title">{language === 'th' ? 'ติดตามราคาและตั้งแจ้งเตือน' : 'Watch prices and set alerts'}</h2>
          <p className="allocation-note">{language === 'th' ? 'แจ้งเตือนเมื่อราคา THB แตะเป้าหมายระหว่างการ sync และต้องเปิด Push ประเภท “ราคาแตะเป้าหมาย” ในการตั้งค่า' : 'Alerts are checked during sync. Enable “Price alerts” in notification settings to receive them.'}</p>
        </div>
      </div>
      {availableAssets.length > 0 ? <div className="tracked-price-controls">
        <div className="tracked-asset-picker">
          <AppSelect
            items={availableAssets.map((symbol) => ({ label: symbol, value: symbol }))}
            label={language === 'th' ? 'สินทรัพย์' : 'Asset'}
            onChange={(nextAsset) => { setAsset(nextAsset); setMessage(null) }}
            value={asset}
          />
          <Button className="export-button" disabled={isWorking || watchlist.some((item) => item.asset === asset)} onClick={() => void addWatch()} type="button">{watchlist.some((item) => item.asset === asset) ? (language === 'th' ? 'กำลังติดตามอยู่' : 'Watching') : (language === 'th' ? 'เพิ่มในรายการติดตาม' : 'Add to watchlist')}</Button>
        </div>
        <form className="alert-composer" onSubmit={(event) => { event.preventDefault(); void addAlert() }}>
          <AppSelect<'above' | 'below'>
            items={[{ label: language === 'th' ? 'ราคา ≥' : 'Price ≥', value: 'above' }, { label: language === 'th' ? 'ราคา ≤' : 'Price ≤', value: 'below' }]}
            label={language === 'th' ? 'เงื่อนไขราคา' : 'Price condition'}
            onChange={setDirection}
            value={direction}
          />
          <label className="unit-input currency-input">
            <span className="sr-only">{language === 'th' ? 'ราคาเป้าหมาย THB' : 'Target THB price'}</span>
            <Input autoComplete="off" disabled={!valuesVisible} inputMode="decimal" onChange={(event) => { if (isDecimalDraft(event.target.value)) setTargetPrice(event.target.value) }} pattern="[0-9]*[.,]?[0-9]*" placeholder={valuesVisible ? (language === 'th' ? 'ราคาเป้าหมาย' : 'Target price') : (language === 'th' ? 'ซ่อนราคาอยู่' : 'Prices hidden')} type="text" value={valuesVisible ? targetPrice : ''} />
            <span aria-hidden="true">THB</span>
          </label>
          <Button className="export-button" disabled={isWorking || !valuesVisible} type="submit">{language === 'th' ? 'สร้างแจ้งเตือน' : 'Create alert'}</Button>
        </form>
      </div> : null}
      {watchlist.length > 0 ? <div className="watchlist-grid">{watchlist.map((item) => <article className="watchlist-item" key={item.asset}><strong>{item.asset}</strong><span>{item.price === null ? (language === 'th' ? 'ยังไม่มีราคา' : 'No price yet') : valuesVisible ? currency(language).format(item.price) : '—'}</span><button className="text-button" disabled={isWorking} onClick={() => void removeWatch(item.asset)} type="button">{language === 'th' ? 'เอาออก' : 'Remove'}</button></article>)}</div> : null}
      {priceAlerts.length > 0 ? <ul className="price-alert-list">{priceAlerts.map((alert) => <li key={alert.id}><span><strong>{alert.asset}</strong> · {alert.direction === 'above' ? '≥' : '≤'} {valuesVisible ? currency(language).format(alert.target_price) : '—'} {alert.active === 1 ? '' : `· ${language === 'th' ? 'ปิดอยู่' : 'Off'}`}</span><button className="text-button" disabled={isWorking} onClick={() => void removeAlert(alert.id)} type="button">{language === 'th' ? 'ลบ' : 'Remove'}</button></li>)}</ul> : null}
      {message ? <p className="inline-status" role="status">{message}</p> : null}
    </section>
  )
}

const createPortfolioCardImage = ({ costMethod, createdAt, holdings, language, pnlAsset, pnlIsSelection, pnlLabel, preset, showPnlAmount, showPnlCostBasis, showPnlCurrentValue, showPnlPercent, totalValue }: {
  costMethod: CostMethod
  createdAt: Date
  holdings: Holding[]
  language: Language
  pnlAsset?: PnlAsset | undefined
  pnlIsSelection?: boolean
  pnlLabel?: string
  preset: PortfolioCardPreset
  showPnlAmount: boolean
  showPnlCostBasis: boolean
  showPnlCurrentValue: boolean
  showPnlPercent: boolean
  totalValue: number
}): Promise<Blob> => {
  const canvas = document.createElement('canvas')
  canvas.height = 630
  canvas.width = 1200
  const context = canvas.getContext('2d')

  if (!context) return Promise.reject(new Error('Canvas is unavailable.'))

  const assets = aggregateCardAssets(holdings)
  const isThai = language === 'th'
  const label = preset === 'pnl' && pnlAsset
    ? (pnlLabel ?? (isThai ? `กำไร / ขาดทุน ${pnlAsset.asset}` : `${pnlAsset.asset} profit & loss`))
    : (isThai ? 'สรุปพอร์ตส่วนตัว' : 'Private portfolio snapshot')
  const valueLabel = isThai ? 'มูลค่าประเมินปัจจุบัน' : 'Estimated current value'
  const allocationLabel = isThai ? 'สัดส่วนสินทรัพย์หลัก' : 'Top asset allocation'
  const privateLabel = isThai ? 'ซ่อนมูลค่าเพื่อความเป็นส่วนตัว' : 'Values hidden for privacy'
  const generatedLabel = isThai ? 'สร้างเมื่อ' : 'Generated'
  const date = dateTime(language).format(createdAt.getTime())
  const money = currency(language).format(totalValue)
  const total = totalValue || assets.reduce((sum, asset) => sum + asset.value, 0)

  context.fillStyle = '#11181d'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#0f1720'
  context.fillRect(72, 40, 50, 50)
  context.strokeStyle = '#e7a44b'
  context.lineCap = 'round'
  context.lineWidth = 6
  context.beginPath()
  context.moveTo(83, 74)
  context.quadraticCurveTo(97, 39, 112, 74)
  context.stroke()
  context.fillStyle = '#f3f0e8'
  context.beginPath()
  context.arc(97, 72, 5, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = '#f4efe7'
  context.font = '600 34px system-ui, sans-serif'
  context.fillText('moondi.', 138, 79)
  context.fillStyle = '#f29a62'
  context.fillRect(72, 108, 1056, 2)
  context.fillStyle = '#9ea7a6'
  context.font = '600 20px system-ui, sans-serif'
  context.fillText(label, 72, 166)
  context.fillStyle = '#f4efe7'
  context.font = '700 56px system-ui, sans-serif'
  if (preset === 'pnl' && pnlAsset) {
    const pnl = pnlAsset.totalPnl ?? 0
    const percentage = pnlAsset.pnlPercent
    const signedAmount = `${pnl >= 0 ? '+' : ''}${currency(language).format(pnl)}`
    const signedPercentage = percentage === null ? '—' : `${percentage >= 0 ? '+' : ''}${percentage.toFixed(2)}%`
    const hiddenValue = '••••••••'
    const headline = showPnlAmount ? signedAmount : signedPercentage
    const tone = pnl > 0 ? '#62b383' : pnl < 0 ? '#e16d5c' : '#d9ddd8'
    context.fillStyle = tone
    context.fillText(headline, 72, 240)
    context.fillStyle = '#9ea7a6'
    context.font = '500 20px system-ui, sans-serif'
    const secondary = showPnlAmount && showPnlPercent ? `${isThai ? 'ผลตอบแทนจากต้นทุน' : 'Return on cost'} · ${signedPercentage}` : (costMethod === 'lots' ? (isThai ? 'กำไร / ขาดทุนจากต้นทุนตามล็อต' : 'Lot-based profit & loss') : (isThai ? 'กำไร / ขาดทุนจากต้นทุนเฉลี่ย' : 'Average-cost profit & loss'))
    context.fillText(secondary, 74, 276)
    context.strokeStyle = '#34414a'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(72, 330)
    context.lineTo(1128, 330)
    context.stroke()
    const isClosedPosition = pnlAsset.quantity === 0
    const metrics: Array<[string, string]> = pnlIsSelection
      ? [
          [isThai ? 'ขอบเขต' : 'Scope', pnlAsset.asset],
          [isThai ? 'ต้นทุนที่ใช้คิดผลตอบแทน' : 'Cost used for return', pnlAsset.costBasis === null ? '—' : (showPnlCostBasis ? currency(language).format(pnlAsset.costBasis) : hiddenValue)],
          [isThai ? 'มูลค่าปัจจุบัน' : 'Current value', pnlAsset.currentValue === null ? '—' : (showPnlCurrentValue ? currency(language).format(pnlAsset.currentValue) : hiddenValue)],
        ]
      : isClosedPosition
      ? [
          [isThai ? 'สถานะ' : 'Position', isThai ? 'ปิดสถานะแล้ว' : 'Closed position'],
          [isThai ? 'ต้นทุนที่ปิดแล้ว' : 'Closed cost basis', pnlAsset.realizedCostBasis === null ? '—' : (showPnlCostBasis ? currency(language).format(pnlAsset.realizedCostBasis) : hiddenValue)],
          [isThai ? 'กำไร / ขาดทุนที่เกิดแล้ว' : 'Realized P&L', showPnlAmount ? signedAmount : hiddenValue],
        ]
      : [
          [isThai ? 'สินทรัพย์' : 'Asset', pnlAsset.asset],
          [isThai ? 'ต้นทุนคงเหลือ' : 'Open cost basis', pnlAsset.costBasis === null ? '—' : (showPnlCostBasis ? currency(language).format(pnlAsset.costBasis) : hiddenValue)],
          [isThai ? 'มูลค่าปัจจุบัน' : 'Current value', pnlAsset.currentValue === null ? '—' : (showPnlCurrentValue ? currency(language).format(pnlAsset.currentValue) : hiddenValue)],
        ]
    metrics.forEach(([metricLabel, value], index) => {
      const x = 72 + index * 350
      context.fillStyle = '#9ea7a6'
      context.font = '600 16px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.fillText(fitCanvasText(metricLabel, (text) => context.measureText(text).width, 320), x, 390)
      context.fillStyle = '#f4efe7'
      context.font = '600 25px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.fillText(fitCanvasText(value, (text) => context.measureText(text).width, 320), x, 432)
    })
    context.fillStyle = '#9ea7a6'
    context.font = '500 16px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.fillText(`${generatedLabel} · ${date}`, 72, 576)
    context.fillText(costMethod === 'lots' ? 'Lot-based Bitkub P&L · moondi' : 'Average-cost Bitkub P&L · moondi', 72, 604)
    return new Promise((resolve, reject) => {
      canvas.toBlob((image) => image ? resolve(image) : reject(new Error('Unable to create image.')), 'image/png')
    })
  }

  context.fillText(preset === 'value' ? money : '••••••••', 72, 240)
  context.fillStyle = '#9ea7a6'
  context.font = '500 20px system-ui, sans-serif'
  context.fillText(preset === 'value' ? valueLabel : privateLabel, 74, 276)
  context.strokeStyle = '#34414a'
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(72, 330)
  context.lineTo(1128, 330)
  context.stroke()
  context.fillStyle = '#f4efe7'
  context.font = '600 24px system-ui, sans-serif'
  context.fillText(allocationLabel, 72, 380)

  assets.forEach(({ asset, value }, index) => {
    const y = 426 + index * 42
    const percentage = total > 0 ? (value / total) * 100 : 0
    context.fillStyle = '#d9ddd8'
    context.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.fillText(asset, 72, y)
    context.fillStyle = '#27343a'
    context.fillRect(230, y - 17, 610, 13)
    context.fillStyle = index === 0 ? '#f29a62' : '#5b9f77'
    context.fillRect(230, y - 17, Math.max(8, 610 * (percentage / 100)), 13)
    context.fillStyle = '#d9ddd8'
    context.textAlign = 'right'
    context.fillText(`${percentage.toFixed(1)}%`, 920, y)
    context.textAlign = 'left'
  })

  context.fillStyle = '#9ea7a6'
  context.font = '500 16px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.fillText(`${generatedLabel} · ${date}`, 72, 576)
  context.fillText('Read-only Bitkub data · moondi', 72, 604)

  return new Promise((resolve, reject) => {
    canvas.toBlob((image) => image ? resolve(image) : reject(new Error('Unable to create image.')), 'image/png')
  })
}

const LazyAppOverlay = lazy(() => import('./app-overlay'))

const AppOverlay = (props: ComponentProps<typeof LazyAppOverlay>) => {
  const [opened, setOpened] = useState(props.open)
  if (props.open && !opened) setOpened(true)
  if (!props.open && !opened) return null

  return <Suspense fallback={null}><LazyAppOverlay {...props} /></Suspense>
}

const PortfolioCardDialog = ({ holdings, ignoredPnlAssets, language, onClose, open, pnl, totalValue }: {
  holdings: Holding[]
  ignoredPnlAssets: readonly string[]
  language: Language
  onClose: () => void
  open: boolean
  pnl: PnlSummaryData
  totalValue: number
}) => {
  const popupRef = useRef<HTMLDivElement>(null)
  const [preset, setPreset] = useState<PortfolioCardPreset>('private')
  const [pnlAssetName, setPnlAssetName] = useState('')
  const [pnlScope, setPnlScope] = useState<'asset' | 'selection'>('asset')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [showPnlAmount, setShowPnlAmount] = useState(true)
  const [showPnlCostBasis, setShowPnlCostBasis] = useState(true)
  const [showPnlCurrentValue, setShowPnlCurrentValue] = useState(true)
  const [showPnlPercent, setShowPnlPercent] = useState(true)
  const [status, setStatus] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)

  useEffect(() => {
    if (open) {
      setPreset('private')
      setPnlAssetName('')
      setPnlScope('asset')
      setPreviewUrl(null)
      setShowPnlAmount(true)
      setShowPnlCostBasis(true)
      setShowPnlCurrentValue(true)
      setShowPnlPercent(true)
      setStatus(null)
    }
  }, [open])

  const includedPnlAssets = useMemo(() => filterPnlAssets(pnl.assets, 'all', [], ignoredPnlAssets), [ignoredPnlAssets, pnl.assets])
  const includedPnl = useMemo(() => summarizePnlAssets(includedPnlAssets), [includedPnlAssets])
  const readyPnlAssets = useMemo(() => includedPnlAssets.filter((asset) => asset.status === 'ready' && asset.totalPnl !== null), [includedPnlAssets])
  const selectedPnlAsset = readyPnlAssets.find((asset) => asset.asset === pnlAssetName) ?? readyPnlAssets[0]
  const selectedPnlGroup = useMemo<PnlAsset | undefined>(() => {
    if (!includedPnl.complete || includedPnl.costBasis === null || includedPnl.realizedCostBasis === null || includedPnl.realizedPnl === null || includedPnl.totalPnl === null || includedPnl.unrealizedPnl === null) return undefined
    return {
      asset: `${includedPnlAssets.length} assets`,
      averageCost: null,
      costBasis: includedPnl.costBasis,
      currentValue: includedPnlAssets.reduce((total, asset) => total + (asset.currentValue ?? 0), 0),
      pnlPercent: includedPnl.pnlPercent,
      quantity: includedPnlAssets.some((asset) => asset.quantity > 0) ? 1 : 0,
      realizedCostBasis: includedPnl.realizedCostBasis,
      realizedPnl: includedPnl.realizedPnl,
      status: 'ready',
      totalPnl: includedPnl.totalPnl,
      unrealizedPnl: includedPnl.unrealizedPnl,
    }
  }, [includedPnl, includedPnlAssets])
  const cardPnlAsset = pnlScope === 'selection' ? selectedPnlGroup : selectedPnlAsset
  const cardPnlLabel = pnlScope === 'selection' ? (language === 'th' ? `P&L ที่เลือก (${includedPnlAssets.length})` : `Selected P&L (${includedPnlAssets.length})`) : undefined
  const imageOptions = {
    costMethod: pnl.costMethod ?? 'average',
    holdings,
    language,
    pnlAsset: preset === 'pnl' ? cardPnlAsset : undefined,
    pnlIsSelection: preset === 'pnl' && pnlScope === 'selection',
    ...(preset === 'pnl' && cardPnlLabel ? { pnlLabel: cardPnlLabel } : {}),
    preset,
    showPnlAmount,
    showPnlCostBasis,
    showPnlCurrentValue,
    showPnlPercent,
    totalValue,
  }

  useEffect(() => {
    if (!open) return
    let active = true
    let nextUrl: string | null = null
    void createPortfolioCardImage({ createdAt: new Date(), ...imageOptions })
      .then((image) => {
        if (!active) return
        nextUrl = URL.createObjectURL(image)
        setPreviewUrl(nextUrl)
      })
      .catch(() => {
        if (active) setPreviewUrl(null)
      })
    return () => {
      active = false
      if (nextUrl) URL.revokeObjectURL(nextUrl)
    }
  }, [cardPnlAsset, cardPnlLabel, holdings, language, open, pnlAssetName, pnlScope, preset, showPnlAmount, showPnlCostBasis, showPnlCurrentValue, showPnlPercent, totalValue])

  const run = async (action: (image: Blob, createdAt: Date) => Promise<void> | void) => {
    setIsWorking(true)
    setStatus(null)
    const createdAt = new Date()

    try {
      const image = await createPortfolioCardImage({ createdAt, ...imageOptions })
      await action(image, createdAt)
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setStatus(language === 'th' ? 'ดำเนินการกับรูปไม่สำเร็จ ลองอีกครั้ง' : 'Unable to complete that image action. Try again.')
      }
    } finally {
      setIsWorking(false)
    }
  }

  const copyImage = () => {
    if (!navigator.clipboard?.write || !('ClipboardItem' in window)) {
      void run((image, createdAt) => {
        downloadImage(portfolioCardFileName(createdAt), image)
        setStatus(language === 'th' ? 'เบราว์เซอร์นี้คัดลอกรูปไม่ได้ จึงบันทึกรูปให้แทน' : 'Image copy is unavailable here, so the image was downloaded instead.')
      })
      return
    }

    setIsWorking(true)
    setStatus(null)
    const image = createPortfolioCardImage({ createdAt: new Date(), ...imageOptions })

    void navigator.clipboard.write([new ClipboardItem({ 'image/png': image })])
      .then(() => setStatus(language === 'th' ? 'คัดลอกรูปแล้ว' : 'Image copied.'))
      .catch(() => setStatus(language === 'th' ? 'คัดลอกรูปไม่สำเร็จ ลองอนุญาต Clipboard แล้วลองอีกครั้ง' : 'Unable to copy the image. Allow clipboard access and try again.'))
      .finally(() => setIsWorking(false))
  }

  const shareImage = () => void run(async (image, createdAt) => {
    const file = new File([image], portfolioCardFileName(createdAt), { type: 'image/png' })
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ files: [file], title: 'Moondi portfolio snapshot' })
      return
    }
    downloadImage(file.name, image)
    setStatus(language === 'th' ? 'อุปกรณ์นี้แชร์รูปโดยตรงไม่ได้ จึงบันทึกรูปให้แทน' : 'Direct image sharing is unavailable here, so the image was downloaded instead.')
  })

  const download = () => void run((image, createdAt) => {
    downloadImage(portfolioCardFileName(createdAt), image)
    setStatus(language === 'th' ? 'บันทึกรูปแล้ว' : 'Image downloaded.')
  })

  return (
    <AppOverlay
      closeLabel={language === 'th' ? 'ปิด' : 'Close'}
      description={language === 'th' ? 'รูปถูกสร้างในเบราว์เซอร์นี้เท่านั้น และไม่มีลิงก์สาธารณะ' : 'The image is created only in this browser. No public link is made.'}
      onClose={onClose}
      open={open}
      popupRef={popupRef}
      title={language === 'th' ? 'สร้างรูปสรุปพอร์ต' : 'Create portfolio image'}
    >
      <div className="portfolio-card-content">
        <fieldset className="portfolio-card-presets">
          <legend>{language === 'th' ? 'ข้อมูลในรูป' : 'Image contents'}</legend>
          <label className={preset === 'private' ? 'portfolio-card-preset active' : 'portfolio-card-preset'}>
            <input checked={preset === 'private'} name="portfolio-card-preset" onChange={() => setPreset('private')} type="radio" />
            <span><strong>{language === 'th' ? 'ส่วนสัดส่วนเท่านั้น' : 'Allocation only'}</strong><small>{language === 'th' ? 'ซ่อนจำนวนและมูลค่า' : 'Hides quantities and values'}</small></span>
          </label>
          <label className={preset === 'value' ? 'portfolio-card-preset active' : 'portfolio-card-preset'}>
            <input checked={preset === 'value'} name="portfolio-card-preset" onChange={() => setPreset('value')} type="radio" />
            <span><strong>{language === 'th' ? 'แสดงมูลค่าปัจจุบัน' : 'Include current value'}</strong><small>{language === 'th' ? 'เป็นมูลค่าประเมิน ไม่ใช่เงินต้นหรือกำไร' : 'Estimated value, not principal or profit'}</small></span>
          </label>
          {readyPnlAssets.length > 0 ? <label className={preset === 'pnl' ? 'portfolio-card-preset active' : 'portfolio-card-preset'}>
            <input checked={preset === 'pnl'} name="portfolio-card-preset" onChange={() => { setPreset('pnl'); setPnlScope(selectedPnlGroup ? 'selection' : 'asset'); setPnlAssetName((current) => current || readyPnlAssets[0]!.asset) }} type="radio" />
            <span><strong>{language === 'th' ? 'กำไร / ขาดทุนที่ตรวจสอบแล้ว' : 'Verified P&L'}</strong><small>{selectedPnlGroup ? (language === 'th' ? 'ส่งออกได้ทั้งกลุ่มเหรียญที่เลือก หรือรายเหรียญ' : 'Export the included asset group or one asset.') : (language === 'th' ? 'เลือกส่งออก P&L รายเหรียญได้; กลุ่มที่เลือกยังมีข้อมูลต้องตรวจสอบ' : 'Export one asset; the included group still needs review.')}</small></span>
          </label> : null}
        </fieldset>
        {preset === 'pnl' && selectedPnlAsset ? <div className="portfolio-card-pnl-options">
          <div aria-label={language === 'th' ? 'ขอบเขต P&L ที่จะส่งออก' : 'P&L export scope'} className="portfolio-card-field-toggles" role="group">
            <button aria-pressed={pnlScope === 'selection'} className={pnlScope === 'selection' ? 'active' : undefined} disabled={!selectedPnlGroup} onClick={() => setPnlScope('selection')} type="button">{language === 'th' ? `เหรียญที่เลือก (${includedPnlAssets.length})` : `Included assets (${includedPnlAssets.length})`}</button>
            <button aria-pressed={pnlScope === 'asset'} className={pnlScope === 'asset' ? 'active' : undefined} onClick={() => setPnlScope('asset')} type="button">{language === 'th' ? 'รายเหรียญ' : 'One asset'}</button>
          </div>
          {pnlScope === 'asset' ? <AppSelect
            container={popupRef}
            items={readyPnlAssets.map(({ asset }) => ({ label: asset, value: asset }))}
            label={language === 'th' ? 'เหรียญ' : 'Asset'}
            onChange={setPnlAssetName}
            value={selectedPnlAsset.asset}
          /> : null}
          <div aria-label={language === 'th' ? 'สิ่งที่จะแสดงในรูป' : 'P&L fields to show'} className="portfolio-card-field-toggles" role="group">
            <button aria-pressed={showPnlAmount} className={showPnlAmount ? 'active' : undefined} onClick={() => setShowPnlAmount((visible) => showPnlPercent ? !visible : true)} type="button">{language === 'th' ? 'กำไร/ขาดทุน (THB)' : 'P&L amount (THB)'}</button>
            <button aria-pressed={showPnlPercent} className={showPnlPercent ? 'active' : undefined} onClick={() => setShowPnlPercent((visible) => showPnlAmount ? !visible : true)} type="button">{language === 'th' ? 'ผลตอบแทน (%)' : 'Return (%)'}</button>
            <button aria-pressed={showPnlCostBasis} className={showPnlCostBasis ? 'active' : undefined} onClick={() => setShowPnlCostBasis((visible) => !visible)} type="button">{language === 'th' ? 'ต้นทุน' : 'Cost basis'}</button>
            <button aria-pressed={showPnlCurrentValue} className={showPnlCurrentValue ? 'active' : undefined} onClick={() => setShowPnlCurrentValue((visible) => !visible)} type="button">{language === 'th' ? 'มูลค่าปัจจุบัน' : 'Current value'}</button>
          </div>
        </div> : null}
        <div className="portfolio-card-preview"><span>{language === 'th' ? 'ตัวอย่างภาพที่จะส่งออก' : 'Rendered export preview'}</span>{previewUrl ? <img alt={language === 'th' ? 'ตัวอย่างภาพพอร์ต' : 'Portfolio image preview'} src={previewUrl} /> : <div className="portfolio-card-preview-loading">{language === 'th' ? 'กำลังสร้างตัวอย่าง…' : 'Rendering preview…'}</div>}</div>
        <p className="portfolio-card-note">{preset === 'pnl'
          ? (pnlScope === 'selection' ? (language === 'th' ? 'P&L กลุ่มนี้รวมเฉพาะเหรียญที่ตั้งค่าให้ “รวมในการคำนวณ” และตรวจสอบต้นทุนกับจำนวนได้ครบแล้ว' : 'This group contains only assets set to Included in this browser and verified for cost and quantity.') : (pnl.costMethod === 'lots' ? (language === 'th' ? 'P&L นี้คำนวณตามล็อตของคู่ THB ใน Bitkub ไม่ใช่ผลตอบแทนราคา 24 ชั่วโมง' : 'This is lot-based P&L for Bitkub THB pairs, not a 24h price change.') : (language === 'th' ? 'P&L นี้เป็นการคำนวณต้นทุนเฉลี่ยของคู่ THB ใน Bitkub ไม่ใช่ผลตอบแทนราคา 24 ชั่วโมง' : 'This is average-cost P&L for Bitkub THB pairs, not a 24h price change.')))
          : (language === 'th' ? 'การ์ดนี้ไม่แสดงชื่อบัญชีหรือรายการธุรกรรม' : 'This card excludes account names and transaction data.')}</p>
        <div className="portfolio-card-actions">
          <button className="portfolio-card-primary" disabled={isWorking} onClick={copyImage} type="button">{language === 'th' ? 'คัดลอกรูป' : 'Copy image'}</button>
          <button className="export-button" disabled={isWorking} onClick={download} type="button">{language === 'th' ? 'บันทึกรูป' : 'Download'}</button>
          <button className="export-button" disabled={isWorking} onClick={shareImage} type="button">{language === 'th' ? 'แชร์รูป' : 'Share image'}</button>
        </div>
        <p aria-live="polite" className="portfolio-card-status">{status}</p>
      </div>
    </AppOverlay>
  )
}

const HoldingSparkline = ({ asset, language, points, valuesVisible }: { asset: string; language: Language; points: PriceHistoryPoint[]; valuesVisible: boolean }) => {
  if (points.length < 2) return <span className="holding-sparkline-empty">{language === 'th' ? 'กำลังเก็บราคา' : 'Collecting prices'}</span>

  const values = points.map((point) => point.price)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = maximum - minimum || 1
  const coordinates = values.map((value, index) => ({
    x: (index / (values.length - 1)) * 100,
    y: 94 - ((value - minimum) / range) * 82,
  }))
  const latest = values.at(-1)!
  const latestCoordinate = coordinates.at(-1)!
  const change = latest - values[0]!
  const percentage = values[0] === 0 ? null : (change / values[0]!) * 100
  const trend = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral'
  const line = coordinates.map(({ x, y }) => `${x},${y}`).join(' ')
  const area = `${line} 100,100 0,100`

  return (
    <div aria-label={language === 'th' ? `กราฟราคา ${asset} ใน 24 ชั่วโมง เปลี่ยนแปลง ${percentage?.toFixed(2) ?? '0'} เปอร์เซ็นต์` : `${asset} price over 24 hours, changed ${percentage?.toFixed(2) ?? '0'} percent`} className={`holding-sparkline ${trend}${valuesVisible ? '' : ' value-concealed'}`} role="img">
      <span>{language === 'th' ? 'กราฟ 24 ชม.' : '24h trend'} {percentage === null ? '' : `${percentage >= 0 ? '+' : ''}${percentage.toFixed(2)}%`}</span>
      <div aria-hidden="true" className="holding-sparkline-plot">
        <svg preserveAspectRatio="none" viewBox="0 0 100 100">
          <polygon className="holding-sparkline-area" points={area} />
          <polyline className="holding-sparkline-line" fill="none" points={line} vectorEffect="non-scaling-stroke" />
        </svg>
        {valuesVisible ? <span className="chart-point" style={{ left: '100%', top: `${latestCoordinate.y}%` }} /> : null}
      </div>
    </div>
  )
}

const Holdings = ({ holdings, language, onDownloadBackup, onOpenPortfolioCard, onSelectAsset, priceHistories, valuesVisible }: { holdings: Holding[]; language: Language; onDownloadBackup: () => void; onOpenPortfolioCard: () => void; onSelectAsset: (asset: string) => void; priceHistories: Record<string, PriceHistoryPoint[]>; valuesVisible: boolean }) => {
  const [query, setQuery] = useState('')
  const [showZero, setShowZero] = useState(false)
  const [sort, setSort] = useState<HoldingSort>('value')
  const deferredQuery = useDeferredValue(query)
  const money = currency(language)
  const normalizedQuery = deferredQuery.trim().toLocaleUpperCase('en-US')

  const filteredHoldings = useMemo(
    () => holdings.filter((holding) =>
      (showZero || holdingAmount(holding) > 0)
      && (normalizedQuery.length === 0 || holding.asset.toLocaleUpperCase('en-US').includes(normalizedQuery)),
    ),
    [holdings, normalizedQuery, showZero],
  )

  const exportHoldings = () => {
    downloadCsv(
      'moondi-holdings.csv',
      ['Account', 'Asset', 'Available', 'Reserved', 'Total', 'Price THB', 'Value THB'],
      sortedHoldings.map((holding) => [
        holding.account_label,
        holding.asset,
        holding.available,
        holding.reserved,
        holdingAmount(holding),
        holding.price,
        valueOf(holding.available, holding.reserved, holding.price),
      ]),
    )
  }

  const sortedHoldings = useMemo(
    () => filteredHoldings.toSorted((left, right) => {
      if (sort === 'asset') return left.asset.localeCompare(right.asset)
      if (sort === 'quantity') return holdingAmount(right) - holdingAmount(left)
      return valueOf(right.available, right.reserved, right.price) - valueOf(left.available, left.reserved, left.price)
    }),
    [filteredHoldings, sort],
  )

  return (
    <section className="holdings" aria-label="Holdings">
      <div className="section-heading">
        <div>
          <h2>{language === 'th' ? 'สินทรัพย์ในพอร์ต' : 'Portfolio holdings'}</h2>
        </div>
        <div className="section-actions">
          <span>{sortedHoldings.length} / {holdings.length} assets</span>
          <button className="export-button" onClick={onOpenPortfolioCard} type="button">{language === 'th' ? 'สร้างภาพพอร์ต' : 'Create image'}</button>
          <button className="export-button" onClick={onDownloadBackup} type="button">{language === 'th' ? 'สำรองข้อมูล JSON' : 'Download backup'}</button>
          <button className="export-button" onClick={exportHoldings} type="button">{language === 'th' ? 'ส่งออก CSV' : 'Export CSV'}</button>
        </div>
      </div>
      <div className="holding-controls">
        <label className="holding-search">
          <span className="sr-only">{language === 'th' ? 'ค้นหาสินทรัพย์' : 'Search assets'}</span>
          <Input onChange={(event) => setQuery(event.target.value)} placeholder={language === 'th' ? 'ค้นหาสินทรัพย์' : 'Search assets'} type="search" value={query} />
        </label>
        <div className="sort-control">
          <span>{language === 'th' ? 'เรียงตาม' : 'Sort by'}</span>
          <AppSelect<HoldingSort>
            items={[
              { value: 'value', label: language === 'th' ? 'มูลค่า' : 'Value' },
              { value: 'quantity', label: language === 'th' ? 'จำนวน' : 'Quantity' },
              { value: 'asset', label: language === 'th' ? 'ชื่อสินทรัพย์' : 'Asset name' },
            ]}
            label={language === 'th' ? 'เรียงสินทรัพย์ตาม' : 'Sort holdings by'}
            onChange={setSort}
            value={sort}
          />
        </div>
        <label className="zero-toggle">
          <input checked={showZero} onChange={(event) => setShowZero(event.target.checked)} type="checkbox" />
          <span>{language === 'th' ? 'แสดงยอดศูนย์' : 'Show zero balances'}</span>
        </label>
      </div>
      {sortedHoldings.length > 0 ? (
        <div className="holding-list">
          {sortedHoldings.map((holding) => (
            <button aria-label={`${language === 'th' ? 'ดูรายละเอียด' : 'View details'} ${holding.asset}`} className="holding" key={`${holding.account_id}-${holding.asset}`} onClick={() => onSelectAsset(holding.asset)} type="button">
              <div className="holding-identity">
                <AssetIcon asset={holding.asset} />
                <div>
                  <p className="asset">{holding.asset}</p>
                  <p className="account">{holding.account_label}</p>
                </div>
              </div>
              <div className="holding-quantity">
                <p className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(holdingAmount(holding))}</p>
                <span className={valuesVisible ? undefined : 'value-concealed'}>{money.format(valueOf(holding.available, holding.reserved, holding.price))}</span>
              </div>
              <HoldingSparkline asset={holding.asset} language={language} points={priceHistories[holding.asset] ?? []} valuesVisible={valuesVisible} />
              <ChevronRightIcon className="holding-chevron" height={16} width={16} />
            </button>
          ))}
        </div>
      ) : (
        <p className="no-results">{language === 'th' ? 'ไม่พบสินทรัพย์ที่ตรงกับตัวกรอง' : 'No assets match the current filters.'}</p>
      )}
    </section>
  )
}

const AssetBuySummary = ({ accountId, asset, currentPrice, language, valuesVisible }: { accountId?: string | undefined; asset: string; currentPrice: number; language: Language; valuesVisible: boolean }) => {
  const [feed, setFeed] = useState<{ key: string; summary: TradeSummary | null }>()
  const feedKey = JSON.stringify([asset, accountId])
  useEffect(() => {
    let active = true
    void loadAssetTradeSummary(asset, accountId)
      .then((summary) => {
        if (active) setFeed({ key: feedKey, summary })
      })
      .catch(() => {
        if (active) setFeed({ key: feedKey, summary: null })
      })
    return () => { active = false }
  }, [accountId, asset, feedKey])

  const summary = feed?.key === feedKey ? feed.summary : null
  if (!summary?.buys) return null
  const th = language === 'th'
  const { buys, sells } = summary
  const money = currency(language)
  const day = new Intl.DateTimeFormat(th ? 'th-TH' : 'en-GB', { dateStyle: 'medium' })
  const concealed = valuesVisible ? undefined : 'value-concealed'
  const averagePrice = buys.quantity > 0 ? buys.thb / buys.quantity : null
  const versusAverage = averagePrice !== null && averagePrice > 0 && currentPrice > 0 ? ((currentPrice - averagePrice) / averagePrice) * 100 : null

  return (
    <div className="asset-detail-section asset-buy-summary">
      <p className="eyebrow">{th ? 'สรุปการซื้อสะสม' : 'Buy summary'}</p>
      <div className="asset-detail-cost-summary">
        <div>
          <span>{th ? 'จำนวนครั้งที่ซื้อ' : 'Number of buys'}</span>
          <strong>{buys.count}</strong>
          <small>{day.format(buys.firstAt)} – {day.format(buys.lastAt)}</small>
        </div>
        <div>
          <span>{th ? 'ยอดลงทุนรวม' : 'Total invested'}</span>
          <strong className={concealed}>{money.format(buys.thb)}</strong>
        </div>
        <div>
          <span>{th ? 'จำนวนที่ซื้อได้' : 'Quantity bought'}</span>
          <strong className={concealed}>{quantity.format(buys.quantity)}</strong>
        </div>
        <div>
          <span>{th ? 'ราคาซื้อเฉลี่ย' : 'Average buy price'}</span>
          <strong className={concealed}>{averagePrice === null ? '—' : money.format(averagePrice)}</strong>
          {versusAverage !== null ? <small className={`${versusAverage >= 0 ? 'pnl-positive' : 'pnl-negative'} ${valuesVisible ? '' : 'value-concealed'}`}>{th ? 'ราคาปัจจุบัน' : 'Current price'} {versusAverage >= 0 ? '+' : ''}{versusAverage.toFixed(2)}%</small> : null}
        </div>
      </div>
      {sells ? <p className={`asset-empty ${valuesVisible ? '' : 'value-concealed'}`}>{th ? `ขายแล้ว ${sells.count} ครั้ง · ได้รับสุทธิ ${money.format(sells.thb)}` : `${sells.count} sells · ${money.format(sells.thb)} received net of fees`}</p> : null}
      <p className="asset-empty">{th ? 'คิดจากรายการซื้อคู่ THB ที่ซิงก์แล้ว รวมค่าธรรมเนียม ไม่รวมเหรียญที่โอนเข้าหรือออก และไม่ใช่กำไรขาดทุน' : 'Based on synced THB-quoted buys, including fees. Excludes transfers in or out and is not a P&L figure.'}</p>
    </div>
  )
}

const AssetDetail = ({ accountId, asset, holdings, language, onClose, pnlAsset, portfolioValue, transactions, valuesVisible }: { accountId?: string | undefined; asset: string; holdings: Holding[]; language: Language; onClose: () => void; pnlAsset: PnlAsset | undefined; portfolioValue: number; transactions: Transaction[]; valuesVisible: boolean }) => {
  const assetHoldings = holdings.filter((holding) => holding.asset === asset)
  const assetTransactions = transactions.filter((transaction) => transaction.asset === asset)
  const totalAmount = assetHoldings.reduce((total, holding) => total + holdingAmount(holding), 0)
  const totalValue = assetHoldings.reduce((total, holding) => total + valueOf(holding.available, holding.reserved, holding.price), 0)
  const currentPrice = totalAmount > 0 ? totalValue / totalAmount : 0
  const allocation = portfolioValue > 0 ? (totalValue / portfolioValue) * 100 : 0
  const money = currency(language)
  const dates = dateTime(language)
  const signedMoney = (value: number): string => `${value >= 0 ? '+' : ''}${money.format(value)}`
  const pnlTone = (value: number | null): string => value === null || value === 0 ? 'pnl-neutral' : value > 0 ? 'pnl-positive' : 'pnl-negative'
  const priceComparedWithAverage = pnlAsset?.status === 'ready' && pnlAsset.averageCost !== null && pnlAsset.averageCost > 0 && currentPrice > 0
    ? ((currentPrice - pnlAsset.averageCost) / pnlAsset.averageCost) * 100
    : null

  return (
    <section className="asset-detail" aria-label={`${language === 'th' ? 'รายละเอียด' : 'Details'} ${asset}`}>
      <button className="back-link" onClick={onClose} type="button">← {language === 'th' ? 'กลับไปภาพรวม' : 'Back to overview'}</button>
      <div className="asset-detail-heading">
        <h1 className="asset-symbol"><AssetIcon asset={asset} />{asset}</h1>
        <div className="asset-detail-total">
          <span>{language === 'th' ? 'มูลค่าปัจจุบัน' : 'Current value'}</span>
          <strong className={valuesVisible ? undefined : 'value-concealed'}>{money.format(totalValue)}</strong>
        </div>
      </div>
      <div className="asset-summary">
        <div>
          <span>{language === 'th' ? 'จำนวนรวม' : 'Total quantity'}</span>
          <strong className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(totalAmount)}</strong>
        </div>
        <div>
          <span>{language === 'th' ? 'บัญชี' : 'Accounts'}</span>
          <strong>{assetHoldings.length}</strong>
        </div>
        <div>
          <span>{language === 'th' ? 'ราคาปัจจุบัน' : 'Current price'}</span>
          <strong className={valuesVisible ? undefined : 'value-concealed'}>{money.format(currentPrice)}</strong>
        </div>
        <div>
          <span>{language === 'th' ? 'สัดส่วนในพอร์ต' : 'Portfolio allocation'}</span>
          <strong className={valuesVisible ? undefined : 'value-concealed'}>{allocation.toFixed(2)}%</strong>
        </div>
      </div>
      {priceComparedWithAverage !== null ? <div className={`asset-detail-cost-summary${valuesVisible ? '' : ' value-concealed'}`}>
        <div><span>{language === 'th' ? 'ต้นทุนเฉลี่ยของที่ถืออยู่' : 'Current average cost'}</span><strong>{money.format(pnlAsset!.averageCost!)}</strong></div>
        <div><span>{language === 'th' ? 'ราคาปัจจุบัน' : 'Current price'}</span><strong>{money.format(currentPrice)}</strong><small className={pnlTone(priceComparedWithAverage)}>{priceComparedWithAverage >= 0 ? '+' : ''}{priceComparedWithAverage.toFixed(2)}% {language === 'th' ? 'เทียบต้นทุนเฉลี่ย' : 'vs average cost'}</small></div>
      </div> : null}
      {pnlAsset ? <div className="asset-detail-section asset-pnl">
        <div className="asset-pnl-heading"><p className="eyebrow">Bitkub P&amp;L</p><span className={`pnl-status pnl-status-${pnlAsset.status}`}>{pnlAsset.status === 'ready' ? (language === 'th' ? 'พร้อม' : 'Ready') : (language === 'th' ? 'ต้องตรวจสอบข้อมูล' : 'Needs review')}</span></div>
        {pnlAsset.status === 'ready' ? <>
          <div className={`asset-pnl-summary${valuesVisible ? '' : ' value-concealed'}`}>
            <div><span>{language === 'th' ? 'ต้นทุนคงเหลือ' : 'Open cost basis'}</span><strong>{pnlAsset.costBasis === null ? '—' : money.format(pnlAsset.costBasis)}</strong></div>
            <div><span>{language === 'th' ? 'กำไร / ขาดทุนรวม' : 'Total P&L'}</span><strong className={pnlTone(pnlAsset.totalPnl)}>{pnlAsset.totalPnl === null ? '—' : signedMoney(pnlAsset.totalPnl)}</strong></div>
            <div><span>{language === 'th' ? 'ผลตอบแทนจากต้นทุน' : 'Return on cost'}</span><strong className={pnlTone(pnlAsset.pnlPercent)}>{pnlAsset.pnlPercent === null ? '—' : `${pnlAsset.pnlPercent >= 0 ? '+' : ''}${pnlAsset.pnlPercent.toFixed(2)}%`}</strong></div>
          </div>
        </> : <p className="asset-empty">{pnlAsset.status === 'missing_cost_basis'
          ? (language === 'th' ? 'มีเหรียญโอนเข้าจากภายนอกที่ยังไม่ระบุต้นทุน จึงยังคำนวณ P&L ของเหรียญนี้ไม่ได้' : 'An external crypto transfer still needs its cost basis, so this asset’s P&L is withheld.')
          : (language === 'th' ? 'ยอดคงเหลือหรือประวัติการเทรดยังตรวจสอบไม่ครบ จึงยังไม่แสดง P&L' : 'The balance or trade history is not yet verifiable, so P&L is withheld.')}</p>}
      </div> : null}
      <AssetBuySummary accountId={accountId} asset={asset} currentPrice={currentPrice} language={language} valuesVisible={valuesVisible} />
      <AssetPriceTrend accountId={accountId} asset={asset} averageCost={pnlAsset?.status === 'ready' ? pnlAsset.averageCost : null} language={language} valuesVisible={valuesVisible} />
      <div className="asset-detail-section">
        <h2 className="asset-subheading">{language === 'th' ? 'ยอดคงเหลือรายบัญชี' : 'Account balances'}</h2>
        {assetHoldings.map((holding) => (
          <div className="asset-account" key={holding.account_id}>
            <span>{holding.account_label}</span>
            <strong className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(holdingAmount(holding))}</strong>
          </div>
        ))}
      </div>
      <div className="asset-detail-section">
        <h2 className="asset-subheading">{language === 'th' ? 'ธุรกรรมล่าสุด' : 'Recent activity'}</h2>
        {assetTransactions.length > 0 ? assetTransactions.slice(0, 8).map((transaction) => (
          <div className="asset-activity" key={`${transaction.category}-${transaction.id}`}>
          <span>{dates.format(transaction.executed_at)} · {transactionLabel(transaction, language)}</span>
            <strong className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(transaction.amount)}</strong>
          </div>
        )) : <p className="asset-empty">{language === 'th' ? `ยังไม่มีรายการ ${asset} ที่บันทึกไว้` : `No recorded activity for ${asset}.`}</p>}
      </div>
    </section>
  )
}

const UpdateNotice = ({ language }: { language: Language }) => {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW: (_scriptUrl, nextRegistration) => {
      setRegistration(nextRegistration)
    },
  })

  useEffect(() => {
    if (!registration) return

    const update = () => {
      void registration.update()
    }
    const updateWhenVisible = () => {
      if (document.visibilityState === 'visible') update()
    }

    update()
    const interval = window.setInterval(update, 15 * 60 * 1000)
    window.addEventListener('visibilitychange', updateWhenVisible)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('visibilitychange', updateWhenVisible)
    }
  }, [registration])

  if (!needRefresh) return null

  return (
    <div className="update-notice" role="status">
      <span>{language === 'th' ? 'มีเวอร์ชันใหม่พร้อมใช้งาน' : 'A new version is ready.'}</span>
      <button onClick={() => void updateServiceWorker(true)}>{language === 'th' ? 'อัปเดต' : 'Update'}</button>
    </div>
  )
}

const EmptyState = ({ language }: { language: Language }) => (
  <section className="empty-state">
    <p className="eyebrow">No snapshots yet</p>
    <h2>{language === 'th' ? 'พร้อมเชื่อม Bitkub' : 'Ready to connect Bitkub'}</h2>
    <p>{language === 'th' ? 'เพิ่ม account ใน D1 และตั้งค่า read-only API key แล้ว cron worker จะเริ่มสร้างข้อมูลพอร์ตให้เอง' : 'Add an account in D1 and configure a read-only API key to start collecting portfolio data.'}</p>
  </section>
)

const syncLabel = (dataType: SyncStatus['data_type'], language: Language): string => ({
  balances: language === 'th' ? 'ยอดคงเหลือ' : 'Balances',
  crypto_transfers: language === 'th' ? 'โอนคริปโต' : 'Crypto transfers',
  fiat_transfers: language === 'th' ? 'ฝาก/ถอน THB' : 'THB deposits / withdrawals',
  prices: language === 'th' ? 'ราคา' : 'Prices',
  trades: language === 'th' ? 'ประวัติซื้อ/ขาย' : 'Trade history',
})[dataType]

const syncStatusLabel = (status: SyncStatus['status'], language: Language): string => ({
  deferred: language === 'th' ? 'เลื่อนการซิงก์' : 'Sync deferred',
  failure: language === 'th' ? 'ล้มเหลว' : 'Failed',
  pending: language === 'th' ? 'รอ sync' : 'Awaiting sync',
  success: language === 'th' ? 'sync ล่าสุดสำเร็จ' : 'Latest sync succeeded',
})[status]

const syncStaleAfterMs = 2 * 60 * 60 * 1_000

const isStaleSync = (status: SyncStatus, now = Date.now()): boolean => (
  status.status === 'success'
  && status.occurred_at !== null
  && now - status.occurred_at > syncStaleAfterMs
)

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(Math.max(value, minimum), maximum)

const historyStats = (points: ValueHistoryPoint[]) => {
  const values = points.map((point) => point.total_value)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const rawRange = maximum - minimum
  const padding = rawRange === 0 ? Math.max(maximum * 0.06, 1) : rawRange * 0.12
  const lowerBound = Math.max(0, minimum - padding)
  const upperBound = maximum + padding
  const range = upperBound - lowerBound || 1
  const coordinates = points.map((point, index) => ({
    x: points.length === 1 ? 50 : (index / (points.length - 1)) * 100,
    y: 92 - ((point.total_value - lowerBound) / range) * 84,
  }))

  return { coordinates, maximum, minimum, values }
}

const hasInvestedValueHistory = (points: ValueHistoryPoint[]): boolean => points.length > 0 && points.every((point) => point.invested_value !== null && Number.isFinite(point.invested_value))
const hasAnyInvestedValueHistory = (points: ValueHistoryPoint[]): boolean => points.some((point) => point.invested_value !== null && Number.isFinite(point.invested_value))
const hasSelectedPnlValueHistory = (points: ValueHistoryPoint[]): boolean => hasInvestedValueHistory(points) && points.every((point) => point.selected_value !== null && Number.isFinite(point.selected_value))
const selectedPnlHistory = (points: ValueHistoryPoint[]): ValueHistoryPoint[] => points.map((point) => ({ ...point, total_value: point.selected_value ?? point.total_value }))

const tradeSideLabel = (side: TradeMarker['side'], language: Language): string => side === 'buy' ? (language === 'th' ? 'ซื้อ' : 'Buy') : (language === 'th' ? 'ขาย' : 'Sell')

const chartTimeBounds = (points: ValueHistoryPoint[], events: readonly { executedAt: number }[] = []) => {
  const bounds = { from: points[0]?.snapshot_at ?? 0, to: points.at(-1)?.snapshot_at ?? 0 }
  for (const event of events) {
    bounds.from = Math.min(bounds.from, event.executedAt)
    bounds.to = Math.max(bounds.to, event.executedAt)
  }
  return bounds
}

const ValueHistoryChart = ({ buys, chartLabel, compact = false, language, points, primaryLabel, secondaryLabel, showInvestedValue = false, trades, valuesVisible }: { buys?: (DcaBuy & { price: number })[] | undefined; trades?: readonly TradeMarker[] | undefined; chartLabel?: string; compact?: boolean; language: Language; points: ValueHistoryPoint[]; primaryLabel?: string; secondaryLabel?: string; showInvestedValue?: boolean; valuesVisible: boolean }) => {
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(points.length - 1, 0))
  const [selectedBuyId, setSelectedBuyId] = useState<string | null>(null)
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null)
  const [pulseRevision, setPulseRevision] = useState(0)
  const fillId = useId()
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotVisible, setPlotVisible] = useState(false)
  const hasPlot = points.length > 1

  useEffect(() => {
    const plot = plotRef.current
    if (!hasPlot || !plot) return
    const observer = new IntersectionObserver(([entry]) => {
      setPlotVisible(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.25))
    }, { threshold: 0.25 })
    observer.observe(plot)
    return () => observer.disconnect()
  }, [hasPlot])

  useEffect(() => {
    setSelectedIndex(Math.max(points.length - 1, 0))
  }, [points])

  if (!hasPlot) return null

  const buyMarkers = valuesVisible ? buys ?? [] : []
  const tradeMarkers = valuesVisible ? trades ?? [] : []
  const { from: firstTime, to: lastTime } = chartTimeBounds(points, [...buyMarkers, ...tradeMarkers.map((trade) => ({ executedAt: trade.executed_at }))])
  const timed = lastTime > firstTime
  const selectedBuy = valuesVisible ? buyMarkers.find((buy) => buy.id === selectedBuyId) : undefined
  const selectedTrade = valuesVisible ? tradeMarkers.find((trade) => trade.id === selectedTradeId) : undefined
  const pulsingBuy = selectedBuy ?? buyMarkers.reduce<DcaBuy | undefined>(
    (latest, buy) => !latest || buy.executedAt > latest.executedAt ? buy : latest, undefined,
  )
  const hasInvestedValue = showInvestedValue && hasAnyInvestedValueHistory(points)
  const chartValues = hasInvestedValue
    ? points.flatMap((point) => point.invested_value === null ? [point.total_value] : [point.total_value, point.invested_value])
    : points.map((point) => point.total_value)
  chartValues.push(...buyMarkers.map((buy) => buy.price))
  chartValues.push(...tradeMarkers.map((trade) => trade.price))
  const minimum = Math.min(...chartValues)
  const maximum = Math.max(...chartValues)
  const rawRange = maximum - minimum
  const padding = rawRange === 0 ? Math.max(maximum * 0.06, 1) : rawRange * 0.12
  const lowerBound = Math.max(0, minimum - padding)
  const upperBound = maximum + padding
  const range = upperBound - lowerBound || 1
  const timeX = (timestamp: number) => timed ? 100 * (timestamp - firstTime) / (lastTime - firstTime) : 50
  const priceY = (price: number) => 92 - ((price - lowerBound) / range) * 84
  const coordinates = points.map((point, index) => ({
    x: timed ? timeX(point.snapshot_at) : (index / (points.length - 1)) * 100,
    y: priceY(point.total_value),
  }))
  const activeIndex = clamp(selectedIndex, 0, points.length - 1)
  const selected = points[activeIndex]!
  const selectedCoordinate = coordinates[activeIndex]!
  const money = currency(language)
  const dates = dateTime(language)
  const line = coordinates.map(({ x, y }) => `${x},${y}`).join(' ')
  let investedValueLine = ''
  let previousInvestedValueExists = false
  if (hasInvestedValue) {
    points.forEach((point, index) => {
      if (point.invested_value === null || !Number.isFinite(point.invested_value)) {
        previousInvestedValueExists = false
        return
      }
      const x = coordinates[index]!.x
      const y = priceY(point.invested_value)
      investedValueLine += `${previousInvestedValueExists ? ' L' : ' M'} ${x} ${y}`
      previousInvestedValueExists = true
    })
  }
  const selectPoint = (clientX: number, target: SVGSVGElement) => {
    if (!valuesVisible) return
    const bounds = target.getBoundingClientRect()
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1)
    if (timed) {
      const timestamp = firstTime + ratio * (lastTime - firstTime)
      const index = points.findIndex((point) => point.snapshot_at >= timestamp)
      if (index === -1) {
        setSelectedIndex(points.length - 1)
        return
      }
      const next = points[index]
      const previous = points[index - 1]
      setSelectedIndex(previous && next && timestamp - previous.snapshot_at < next.snapshot_at - timestamp ? index - 1 : Math.max(index, 0))
    } else {
      setSelectedIndex(Math.round(ratio * (points.length - 1)))
    }
  }

  return (
    <div className={`history-visual${compact ? ' history-visual-compact' : ''}${valuesVisible ? '' : ' value-concealed'}`}>
      <div className="history-chart-plot" data-chart-visible={plotVisible ? true : undefined} data-snapshot-selected={compact && activeIndex < points.length - 1 ? true : undefined} ref={plotRef}>
        <svg
          aria-label={chartLabel ?? (language === 'th' ? 'กราฟมูลค่าพอร์ตย้อนหลัง เลื่อนหรือแตะเพื่อดูข้อมูลแต่ละจุด' : 'Portfolio value history. Hover or tap to inspect each point.')}
          className="history-chart"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            setSelectedBuyId(null)
            setSelectedTradeId(null)
            setSelectedIndex((index) => {
              if (event.key === 'Home') return 0
              if (event.key === 'End') return points.length - 1
              return clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, points.length - 1)
            })
          }}
          onPointerDown={(event) => {
            if (!valuesVisible) return
            setSelectedBuyId(null)
            setSelectedTradeId(null)
            setPulseRevision((revision) => revision + 1)
            selectPoint(event.clientX, event.currentTarget)
          }}
          onPointerMove={(event) => {
            if (selectedBuyId !== null) setSelectedBuyId(null)
            if (selectedTradeId !== null) setSelectedTradeId(null)
            selectPoint(event.clientX, event.currentTarget)
          }}
          preserveAspectRatio="none"
          role="img"
          tabIndex={valuesVisible ? 0 : -1}
          viewBox="0 0 100 100"
        >
          {compact ? <>
            <defs>
              <linearGradient id={fillId} x1="0%" x2="0%" y1="0%" y2="100%">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.17" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon className="history-chart-fill" fill={`url(#${fillId})`} points={`0,100 ${line} 100,100`} />
          </> : <>
            <line className="history-grid-line" x1="0" x2="100" y1="8" y2="8" />
            <line className="history-grid-line" x1="0" x2="100" y1="50" y2="50" />
            <line className="history-grid-line" x1="0" x2="100" y1="92" y2="92" />
          </>}
          <polyline className="history-line" fill="none" points={line} vectorEffect="non-scaling-stroke" />
          {hasInvestedValue ? <path className="history-invested-value-line" d={investedValueLine} fill="none" vectorEffect="non-scaling-stroke" /> : null}
          {selectedBuy || selectedTrade ? null : <line className="history-selected-line" x1={selectedCoordinate.x} x2={selectedCoordinate.x} y1="8" y2="92" vectorEffect="non-scaling-stroke" />}
        </svg>
        {valuesVisible && !selectedBuy && !selectedTrade ? <span aria-hidden="true" className="chart-point" key={`${activeIndex}:${selected.snapshot_at}:${pulseRevision}`} style={{ left: `${selectedCoordinate.x}%`, top: `${selectedCoordinate.y}%` }} /> : null}
        {valuesVisible ? buyMarkers.map((buy) => {
          const label = `${buy.reason ?? (language === 'th' ? 'ซื้อผ่านบอท' : 'Bot buy')} · ${dates.format(buy.executedAt)} · ${money.format(buy.price)}`
          return <button
            aria-label={label}
            aria-pressed={buy.id === selectedBuyId}
            className="dca-chart-marker"
            data-pulsing={buy.id === pulsingBuy?.id ? true : undefined}
            key={buy.id}
            onClick={() => setSelectedBuyId((id) => id === buy.id ? null : buy.id)}
            style={{ left: `${timeX(buy.executedAt)}%`, top: `${priceY(buy.price)}%` }}
            title={label}
            type="button"
          />
        }) : null}
        {valuesVisible ? tradeMarkers.map((trade) => {
          const label = `${tradeSideLabel(trade.side, language)} ${quantity.format(trade.amount)} · ${dates.format(trade.executed_at)} · ${money.format(trade.price)}`
          return <button
            aria-label={label}
            aria-pressed={trade.id === selectedTradeId}
            className="trade-chart-marker"
            data-side={trade.side}
            key={trade.id}
            onClick={() => {
              setSelectedBuyId(null)
              setSelectedTradeId((id) => id === trade.id ? null : trade.id)
            }}
            style={{ left: `${timeX(trade.executed_at)}%`, top: `${priceY(trade.price)}%` }}
            title={label}
            type="button"
          />
        }) : null}
      </div>
      <div aria-live={valuesVisible ? 'polite' : 'off'} className="history-tooltip">
        {selectedTrade ? <>
          <span className="history-tooltip-value"><i className={`history-legend-swatch trade-swatch ${selectedTrade.side}`} />{tradeSideLabel(selectedTrade.side, language)} <strong>{quantity.format(selectedTrade.amount)}</strong> @ <strong>{money.format(selectedTrade.price)}</strong></span>
          <span>{dates.format(selectedTrade.executed_at)}</span>
        </> : selectedBuy ? <>
          <span className="history-tooltip-value"><i className="history-legend-swatch dca-buy-swatch" />{selectedBuy.reason ?? (language === 'th' ? 'ซื้อผ่านบอท' : 'Bot buy')} <strong>{money.format(selectedBuy.price)}</strong></span>
          <span>{dates.format(selectedBuy.executedAt)}</span>
        </> : <>
          <span className="history-tooltip-value">{compact ? (language === 'th' ? 'ย้อนหลัง' : 'Snapshot') : <><i className="history-legend-swatch portfolio-value" />{primaryLabel ?? (language === 'th' ? 'มูลค่าพอร์ต' : 'Portfolio value')}</>} <strong>{money.format(selected.total_value)}</strong></span>
          {hasInvestedValue && selected.invested_value !== null ? <span className="history-tooltip-value"><i className="history-legend-swatch invested-value" />{secondaryLabel ?? (language === 'th' ? 'ต้นทุนสินทรัพย์ที่เลือก' : 'Selected asset cost basis')} <strong>{money.format(selected.invested_value)}</strong></span> : null}
          <span>{dates.format(selected.snapshot_at)}</span>
        </>}
      </div>
    </div>
  )
}

const PortfolioValueCard = ({ history, language, onOpenHistory, totalValue, updatedAt, valuesVisible }: {
  history: ValueHistoryPoint[]
  language: Language
  onOpenHistory: () => void
  totalValue: number
  updatedAt: number | null | undefined
  valuesVisible: boolean
}) => {
  const [days, setDays] = useState(7)
  const th = language === 'th'
  const last = history.at(-1)
  const points = useMemo(() => last ? history.filter((point) => point.snapshot_at >= last.snapshot_at - days * dayMs) : [], [days, history, last])
  const first = points[0]
  const change = last && first && points.length > 1 ? last.total_value - first.total_value : null
  const returnPercent = change !== null && first && first.total_value > 0 ? 100 * change / first.total_value : null
  const updateTime = updatedAt ? new Date(updatedAt) : null
  const updateLabel = updateTime && new Intl.DateTimeFormat(th ? 'th-TH' : 'en-GB', {
    ...(updateTime.toDateString() === new Date().toDateString() ? {} : { dateStyle: 'short' }),
    timeStyle: 'short',
  }).format(updateTime)

  return (
    <section className="hero-card" aria-labelledby="portfolio-value-title">
      <div className="hero-card-top">
        <h2 className="hero-eyebrow" id="portfolio-value-title">{th ? 'มูลค่าพอร์ตประเมินปัจจุบัน' : 'Estimated portfolio value'}</h2>
        <button className="hero-history-link" onClick={onOpenHistory} type="button">{th ? 'ดูประวัติ' : 'View history'} <ChevronRightIcon width={14} height={14} /></button>
      </div>
      <p className={valuesVisible ? 'hero-amount' : 'hero-amount value-concealed'}>
        <span className="portfolio-currency">฿</span>
        <span>{formatPortfolioValue(language, totalValue)}</span>
      </p>
      <div className="hero-trend-header">
        <div className="hero-meta">
          {change === null && history.length > 1 ? (th ? 'ข้อมูลในช่วงนี้ยังไม่พอ' : 'Too few snapshots in this range') : null}
          {change !== null ? <span className={`${change > 0 ? 'change-positive' : change < 0 ? 'change-negative' : ''}${valuesVisible ? '' : ' value-concealed'}`}>
            <span className="sr-only">{th ? 'มูลค่าเปลี่ยนแปลง' : 'Value change'} </span>
            {change > 0 ? '+' : ''}{currency(language).format(change)}
            {returnPercent === null ? null : <span className="hero-change-percent"> {returnPercent > 0 ? '+' : ''}{returnPercent.toFixed(2)}%</span>}
          </span> : null}
          <span>{updateLabel ? `${th ? 'อัปเดต' : 'Updated'} ${updateLabel}` : (th ? 'รอข้อมูลจาก sync แรก' : 'Awaiting first sync')}</span>
        </div>
        {history.length > 1 ? <div aria-label={th ? 'ช่วงแนวโน้มมูลค่า' : 'Value trend range'} className="hero-ranges" role="group">
          {[7, 30].map((range) => <button aria-pressed={days === range} key={range} onClick={() => setDays(range)} type="button">{th ? `${range} วัน` : `${range}D`}</button>)}
        </div> : null}
      </div>
      {change !== null ? <ValueHistoryChart chartLabel={th ? 'แนวโน้มมูลค่าพอร์ต ใช้ลูกศรเพื่อดูมูลค่าย้อนหลัง' : 'Portfolio value trend. Use arrow keys to inspect snapshots.'} compact key={days} language={language} points={points} valuesVisible={valuesVisible} /> : null}
    </section>
  )
}

const AssetPriceTrend = ({ accountId, asset, averageCost, language, valuesVisible }: { accountId?: string | undefined; asset: string; averageCost: number | null; language: Language; valuesVisible: boolean }) => {
  const costMethod = useContext(CostMethodContext)
  const [range, setRange] = useState<PriceHistoryRange>('7d')
  const [priceFeed, setPriceFeed] = useState<{ key: string; points: PriceHistoryPoint[]; unavailable: boolean }>()
  const [botFeed, setBotFeed] = useState<{ key: string; activity: DcaActivity | null; unavailable: boolean }>()
  const [tradeFeed, setTradeFeed] = useState<{ key: string; trades: TradeMarker[] }>()
  const requestedHistory = useMemo(() => priceHistoryRequest(range), [range, asset, accountId])
  const hasVerifiedAverageCost = averageCost !== null && Number.isFinite(averageCost) && averageCost > 0
  const botFeedKey = JSON.stringify([asset, accountId, range, requestedHistory.from])
  const priceFeedKey = JSON.stringify([botFeedKey, hasVerifiedAverageCost, costMethod])
  const currentPriceFeed = priceFeed?.key === priceFeedKey ? priceFeed : undefined
  const points = currentPriceFeed?.points ?? []
  const isLoading = !currentPriceFeed
  const priceUnavailable = currentPriceFeed?.unavailable ?? false
  const activity = botFeed?.key === botFeedKey ? botFeed.activity : null
  const botUnavailable = botFeed?.key === botFeedKey && botFeed.unavailable

  useEffect(() => {
    let active = true
    void loadAssetPriceHistory(asset, { ...requestedHistory, accountId, averageCost: hasVerifiedAverageCost, costMethod })
      .then((nextPoints) => {
        if (active) setPriceFeed({ key: priceFeedKey, points: nextPoints, unavailable: false })
      })
      .catch(() => {
        if (active) setPriceFeed({ key: priceFeedKey, points: [], unavailable: true })
      })
    return () => { active = false }
  }, [accountId, asset, costMethod, hasVerifiedAverageCost, priceFeedKey, requestedHistory])

  useEffect(() => {
    let active = true
    void loadDcaActivity(asset, requestedHistory.from, accountId)
      .then((activity) => {
        if (active) setBotFeed({ key: botFeedKey, activity, unavailable: false })
      })
      .catch(() => {
        if (active) setBotFeed({ key: botFeedKey, activity: null, unavailable: true })
      })
    return () => { active = false }
  }, [accountId, asset, botFeedKey, requestedHistory])

  useEffect(() => {
    let active = true
    void loadAssetTrades(asset, requestedHistory.from, accountId)
      .then((trades) => {
        if (active) setTradeFeed({ key: botFeedKey, trades })
      })
      .catch(() => {
        if (active) setTradeFeed({ key: botFeedKey, trades: [] })
      })
    return () => { active = false }
  }, [accountId, asset, botFeedKey, requestedHistory])

  const valuePoints = points.map((point) => ({ invested_value: point.average_cost ?? null, selected_value: null, snapshot_at: point.snapshot_at, total_value: point.price }))
  const hasHistoricalAverageCost = hasVerifiedAverageCost && valuePoints.filter((point) => point.invested_value !== null).length >= 2
  const stats = valuePoints.length > 0 ? historyStats(valuePoints) : null
  const first = valuePoints[0]
  const latest = valuePoints.at(-1)
  const change = first && latest ? latest.total_value - first.total_value : null
  const percentage = change !== null && first && first.total_value !== 0 ? (change / first.total_value) * 100 : null
  const selectedRange = priceHistoryRanges.find((option) => option.id === range)!
  const requestedFrom = requestedHistory.from || undefined
  const plottedBuys = valuesVisible ? activity?.buys.filter((buy): buy is DcaBuy & { price: number } => buy.price !== null && buy.price > 0 && buy.executedAt >= requestedHistory.from) : undefined
  const botBuyTimes = activity?.buys.map((buy) => buy.executedAt) ?? []
  const plottedTrades = valuesVisible && tradeFeed?.key === botFeedKey
    ? tradeFeed.trades.filter((trade) => trade.price > 0 && trade.executed_at >= requestedHistory.from
      && !(trade.side === 'buy' && botBuyTimes.some((time) => Math.abs(time - trade.executed_at) < 10 * 60 * 1_000)))
    : []
  const chartBounds = chartTimeBounds(valuePoints, [...(plottedBuys ?? []), ...plottedTrades.map((trade) => ({ executedAt: trade.executed_at }))])
  const hasBotBuysBeforeSnapshots = first !== undefined && chartTimeBounds(valuePoints, plottedBuys).from < first.snapshot_at
  const hasBuysBeforeSnapshots = first !== undefined && chartBounds.from < first.snapshot_at
  const historyIsShorterThanRange = first !== undefined && requestedFrom !== undefined && first.snapshot_at > requestedFrom + 60 * 60 * 1_000

  return (
    <section className="asset-price-trend" aria-label={language === 'th' ? `แนวโน้มราคา ${asset}` : `${asset} price trend`}>
      <div className="asset-price-heading">
        <div>
          <h2>{asset} / THB</h2>
          <p>{language === 'th' ? 'ราคาจาก snapshot ของ Bitkub' : 'Recorded Bitkub snapshot prices'}</p>
        </div>
        <div className="range-tabs" aria-label={language === 'th' ? 'ช่วงเวลาราคา' : 'Price range'}>
          {priceHistoryRanges.map((option) => (
            <button aria-pressed={range === option.id} className={range === option.id ? 'range-tab active' : 'range-tab'} key={option.id} onClick={() => setRange(option.id)} type="button">
              {priceRangeLabel(option.id, language)}
            </button>
          ))}
        </div>
      </div>
      {stats && first && latest ? (
        <>
          <div className={`asset-price-metrics${valuesVisible ? '' : ' value-concealed'}`}>
            <div><span>{language === 'th' ? 'ราคาล่าสุด' : 'Latest price'}</span><strong>{currency(language).format(latest.total_value)}</strong></div>
            <div><span>{language === 'th' ? 'การเปลี่ยนแปลงราคา' : 'Price change'}</span><strong className={change !== null && change >= 0 ? 'change-positive' : 'change-negative'}>{change !== null && change >= 0 ? '+' : ''}{currency(language).format(change ?? 0)}{percentage === null ? '' : ` (${percentage >= 0 ? '+' : ''}${percentage.toFixed(2)}%)`}</strong></div>
            <div><span>{language === 'th' ? 'สูงสุด' : 'High'}</span><strong>{currency(language).format(stats.maximum)}</strong></div>
            <div><span>{language === 'th' ? 'ต่ำสุด' : 'Low'}</span><strong>{currency(language).format(stats.minimum)}</strong></div>
          </div>
          <div className="history-legend" aria-label={language === 'th' ? 'คำอธิบายเส้นกราฟ' : 'Chart legend'}>
            <span><i className="history-legend-swatch portfolio-value" />{language === 'th' ? 'ราคา ณ snapshot' : 'Snapshot price'}</span>
            {hasHistoricalAverageCost ? <span><i className="history-legend-swatch invested-value" />{language === 'th' ? 'ต้นทุนเฉลี่ยย้อนหลัง' : 'Historical average cost'}</span> : null}
            {plottedTrades.some((trade) => trade.side === 'buy') ? <span><i className="history-legend-swatch trade-swatch buy" />{tradeSideLabel('buy', language)}</span> : null}
            {plottedTrades.some((trade) => trade.side === 'sell') ? <span><i className="history-legend-swatch trade-swatch sell" />{tradeSideLabel('sell', language)}</span> : null}
            {plottedBuys?.length ? <span><i className="history-legend-swatch dca-buy-swatch" />{language === 'th' ? 'ราคาซื้อที่บอทรายงาน' : 'Bot-reported buy price'}</span> : null}
          </div>
          <ValueHistoryChart buys={plottedBuys} trades={plottedTrades} chartLabel={language === 'th' ? `กราฟราคา ${asset} เทียบเงินบาท เลื่อนหรือแตะเพื่อดูข้อมูลแต่ละจุด` : `${asset} price in Thai baht. Hover or tap to inspect each point.`} language={language} points={valuePoints} primaryLabel={language === 'th' ? 'ราคา ณ snapshot' : 'Snapshot price'} secondaryLabel={language === 'th' ? 'ต้นทุนเฉลี่ยย้อนหลัง' : 'Historical average cost'} showInvestedValue={hasHistoricalAverageCost} valuesVisible={valuesVisible} />
          <div className="history-range">
            <span>{dateTime(language).format(chartBounds.from)}</span>
            <span>{selectedRange ? `${priceRangeLabel(selectedRange.id, language)} · ${valuePoints.length} ${language === 'th' ? 'จุดข้อมูล' : 'points'}` : null}</span>
            <span>{dateTime(language).format(chartBounds.to)}</span>
          </div>
          {hasBuysBeforeSnapshots || historyIsShorterThanRange ? (
            <p className="asset-price-availability">
              {language === 'th' ? `เริ่มบันทึกราคา ${dateTime(language).format(first.snapshot_at)}` : `Price snapshots start on ${dateTime(language).format(first.snapshot_at)}`}
              {hasBuysBeforeSnapshots ? (hasBotBuysBeforeSnapshots ? (language === 'th' ? ' · ก่อนหน้านั้นมีเฉพาะราคาซื้อที่บอทรายงาน' : ' · Earlier points are bot-reported buys') : (language === 'th' ? ' · ก่อนหน้านั้นมีเฉพาะรายการซื้อขายของคุณ' : ' · Earlier points are your trades')) : null}
            </p>
          ) : null}
          {hasVerifiedAverageCost && !hasHistoricalAverageCost ? <p className="asset-price-availability">{language === 'th' ? 'ต้นทุนเฉลี่ยย้อนหลังตรวจสอบไม่ครบสำหรับช่วงราคานี้ จึงไม่แสดงเส้นอ้างอิง' : 'Historical average cost is not verifiable for this entire price range, so no reference line is shown.'}</p> : null}
        </>
      ) : !isLoading && !priceUnavailable ? <p className="history-empty">{language === 'th' ? `ยังมีข้อมูลราคา ${asset} ไม่พอสำหรับแสดงกราฟในช่วงเวลานี้` : `There are not enough ${asset} price snapshots for this range.`}</p> : null}
      {isLoading ? (
        <div className="asset-price-loading" role="status">
          <div aria-hidden="true" className="asset-price-metrics">
            {[0, 1, 2, 3].map((tile) => <div key={tile}><span /><span /></div>)}
          </div>
          <div className="history-chart asset-price-placeholder">
            <span>{language === 'th' ? 'กำลังโหลดข้อมูลราคา…' : 'Loading price history…'}</span>
          </div>
          <div aria-hidden="true" className="asset-price-loading-footer" />
        </div>
      ) : null}
      {priceUnavailable ? <p className="history-error">{language === 'th' ? 'โหลดข้อมูลราคาไม่สำเร็จ' : 'Unable to load price data.'}</p> : null}
      {activity && (activity.buys.length > 0 || activity.signal !== null) ? <DcaActivityPanel activity={activity} dates={dateTime(language)} language={language} money={currency(language)} quantity={quantity} valuesVisible={valuesVisible} /> : null}
      {botUnavailable ? <p className="history-error">{language === 'th' ? 'โหลดข้อมูลบอท DCA ไม่สำเร็จ' : 'Unable to load DCA bot activity.'}</p> : null}
    </section>
  )
}

const PortfolioHistory = ({ language, onOpenHistory, points, valuesVisible }: { language: Language; onOpenHistory: () => void; points: ValueHistoryPoint[]; valuesVisible: boolean }) => {
  const [scope, setScope] = useState<'portfolio' | 'pnl'>('portfolio')
  if (points.length < 2) {
    return (
      <section className="portfolio-history">
        <h2>{language === 'th' ? 'แนวโน้มมูลค่าพอร์ต' : 'Portfolio value trend'}</h2>
        <p className="history-empty">{language === 'th' ? 'กำลังสะสมข้อมูลราคา ณ เวลา snapshot เพื่อสร้างกราฟที่ถูกต้อง' : 'Collecting price snapshots to build an accurate chart.'}</p>
      </section>
    )
  }

  const hasSelectedPnl = hasSelectedPnlValueHistory(points)
  const displayPoints = scope === 'pnl' && hasSelectedPnl ? selectedPnlHistory(points) : points
  const { maximum, minimum, values } = historyStats(displayPoints)
  const change = values.at(-1)! - values[0]!
  const money = currency(language)
  const dates = dateTime(language)

  const hasInvestedValue = scope === 'pnl' && hasSelectedPnl

  return (
    <section className="portfolio-history">
      <div className="section-heading">
        <div>
          <h2>{scope === 'pnl' ? (language === 'th' ? 'มูลค่าและต้นทุนสินทรัพย์ที่เลือก' : 'Selected asset value and cost') : (language === 'th' ? 'แนวโน้มมูลค่าพอร์ต' : 'Portfolio value trend')}</h2>
        </div>
        <div className="history-heading-actions">
          <span aria-label={language === 'th' ? 'การเปลี่ยนแปลงมูลค่าพอร์ตในช่วงกราฟ ไม่ใช่เงินต้นหรือกำไร' : 'Portfolio value change for this chart range, not principal or profit'} className={`${change >= 0 ? 'change-positive' : 'change-negative'}${valuesVisible ? '' : ' value-concealed'}`} title={language === 'th' ? 'มูลค่าพอร์ตล่าสุดลบมูลค่าจุดแรกของช่วงกราฟ ไม่ใช่เงินต้นหรือกำไร' : 'Latest portfolio value minus the first value in this range. This is not principal or profit.'}>{change >= 0 ? '+' : ''}{money.format(change)}</span>
          <button className="chart-link" onClick={onOpenHistory} type="button">{language === 'th' ? 'ดูกราฟเต็ม' : 'Open full chart'}</button>
        </div>
      </div>
      {hasSelectedPnl ? <div className="range-tabs" aria-label={language === 'th' ? 'ขอบเขตกราฟ' : 'Chart scope'}>
        <button aria-pressed={scope === 'portfolio'} className={scope === 'portfolio' ? 'range-tab active' : 'range-tab'} onClick={() => setScope('portfolio')} type="button">{language === 'th' ? 'พอร์ตรวม' : 'Whole portfolio'}</button>
        <button aria-pressed={scope === 'pnl'} className={scope === 'pnl' ? 'range-tab active' : 'range-tab'} onClick={() => setScope('pnl')} type="button">{language === 'th' ? 'P&L ที่เลือก' : 'Selected P&L'}</button>
      </div> : null}
      <div className="history-legend" aria-label={language === 'th' ? 'คำอธิบายเส้นกราฟ' : 'Chart legend'}>
        <span><i className="history-legend-swatch portfolio-value" />{hasInvestedValue ? (language === 'th' ? 'มูลค่าปัจจุบันของสินทรัพย์ที่เลือก' : 'Selected asset current value') : (language === 'th' ? 'มูลค่าพอร์ตรวม' : 'Whole portfolio value')}</span>
        {hasInvestedValue ? <span><i className="history-legend-swatch invested-value" />{language === 'th' ? 'ต้นทุนสินทรัพย์ที่เลือกใน P&L' : 'Selected P&L asset cost basis'}</span> : null}
      </div>
      <ValueHistoryChart language={language} points={displayPoints} showInvestedValue={hasInvestedValue} valuesVisible={valuesVisible} />
      <div className="history-range">
        <span>{dates.format(displayPoints[0]!.snapshot_at)}</span>
        <span>{dates.format(displayPoints.at(-1)!.snapshot_at)}</span>
      </div>
      <div className={`history-extremes${valuesVisible ? '' : ' value-concealed'}`}>
        <span>{language === 'th' ? 'ต่ำสุด' : 'Low'} {money.format(minimum)}</span>
        <span>{language === 'th' ? 'สูงสุด' : 'High'} {money.format(maximum)}</span>
      </div>
    </section>
  )
}

const HistoryView = ({ accountId, initialPoints, investedAssets, language, onBack, valuesVisible }: { accountId?: string | undefined; initialPoints: ValueHistoryPoint[]; investedAssets: readonly string[]; language: Language; onBack: () => void; valuesVisible: boolean }) => {
  const [range, setRange] = useState<HistoryRange>(30)
  const [scope, setScope] = useState<'portfolio' | 'pnl'>('portfolio')
  const [points, setPoints] = useState(initialPoints)
  const costMethod = useContext(CostMethodContext)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customStart, setCustomStart] = useState(() => formatDateInput(Date.now() - 30 * 24 * 60 * 60 * 1_000))
  const [customEnd, setCustomEnd] = useState(() => formatDateInput(Date.now()))
  const [customBounds, setCustomBounds] = useState<{ from: number; to: number } | null>(null)

  useEffect(() => {
    if (range === 30) {
      setPoints(initialPoints)
      setError(null)
      return
    }

    if (range === 'custom' && !customBounds) return

    let active = true
    setIsLoading(true)
    setError(null)

    void loadValueHistory({ ...(range === 'custom' ? customBounds! : { days: range }), accountId, assets: investedAssets, costMethod })
      .then((nextPoints) => {
        if (active) setPoints(nextPoints)
      })
      .catch(() => {
        if (active) setError(language === 'th' ? 'โหลดข้อมูลกราฟช่วงเวลานี้ไม่สำเร็จ' : 'Unable to load chart data for this range.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [accountId, costMethod, customBounds, initialPoints, investedAssets, language, range])

  const hasSelectedPnl = hasSelectedPnlValueHistory(points)
  const displayPoints = scope === 'pnl' && hasSelectedPnl ? selectedPnlHistory(points) : points
  const stats = displayPoints.length > 0 ? historyStats(displayPoints) : null
  const first = displayPoints[0]
  const latest = displayPoints.at(-1)
  const change = first && latest ? latest.total_value - first.total_value : null
  const percentage = change !== null && first && first.total_value !== 0 ? (change / first.total_value) * 100 : null
  const hasInvestedValue = scope === 'pnl' && hasSelectedPnl

  const applyCustomRange = () => {
    const fromDate = new Date(`${customStart}T00:00:00`)
    const toExclusiveDate = new Date(`${customEnd}T00:00:00`)
    toExclusiveDate.setDate(toExclusiveDate.getDate() + 1)
    const from = fromDate.getTime()
    const to = toExclusiveDate.getTime() - 1
    if (!customStart || !customEnd || !Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      setError(language === 'th' ? 'เลือกวันเริ่มต้นและวันสิ้นสุดให้ถูกต้อง' : 'Choose a valid start and end date.')
      return
    }
    setCustomBounds({ from, to })
    setRange('custom')
  }

  return (
    <section className="history-page" aria-label={language === 'th' ? 'กราฟมูลค่าพอร์ต' : 'Portfolio value chart'}>
      <div className="history-page-heading">
        <div>
          <h1>{language === 'th' ? 'กราฟมูลค่าพอร์ต' : 'Portfolio value chart'}</h1>
          <p>{hasInvestedValue ? (language === 'th' ? 'เทียบมูลค่าปัจจุบันกับต้นทุนเฉลี่ยของสินทรัพย์ที่เลือกใน P&L ณ เวลา snapshot' : 'Compare selected assets’ current value and average-cost basis at each snapshot.') : (language === 'th' ? 'มูลค่ารวมทุกสินทรัพย์ในพอร์ต ณ เวลา snapshot' : 'Total value of every portfolio asset at each snapshot.')}</p>
        </div>
        <div className="history-page-actions">
          <button className="back-link history-back tab-page-back" onClick={onBack} type="button">← {language === 'th' ? 'กลับไปภาพรวม' : 'Back to overview'}</button>
          <div className="range-tabs" aria-label={language === 'th' ? 'ช่วงเวลาของกราฟ' : 'Chart range'}>
            {historyRanges.map((option) => (
              <button aria-pressed={range === option.days} className={range === option.days ? 'range-tab active' : 'range-tab'} key={option.days} onClick={() => setRange(option.days)} type="button">
                {language === 'th' ? option.label : option.days === 1 ? '24h' : `${option.days}d`}
              </button>
            ))}
            <button aria-pressed={range === 'custom'} className={range === 'custom' ? 'range-tab active' : 'range-tab'} onClick={() => setRange('custom')} type="button">{language === 'th' ? 'กำหนดเอง' : 'Custom'}</button>
          </div>
        </div>
      </div>
      {hasSelectedPnl ? <div className="range-tabs history-scope-tabs" aria-label={language === 'th' ? 'ขอบเขตกราฟ' : 'Chart scope'}>
        <button aria-pressed={scope === 'portfolio'} className={scope === 'portfolio' ? 'range-tab active' : 'range-tab'} onClick={() => setScope('portfolio')} type="button">{language === 'th' ? 'พอร์ตรวม' : 'Whole portfolio'}</button>
        <button aria-pressed={scope === 'pnl'} className={scope === 'pnl' ? 'range-tab active' : 'range-tab'} onClick={() => setScope('pnl')} type="button">{language === 'th' ? 'P&L ที่เลือก' : 'Selected P&L'}</button>
      </div> : null}

      {range === 'custom' ? (
        <form className="custom-range" onSubmit={(event) => { event.preventDefault(); applyCustomRange() }}>
          <label>{language === 'th' ? 'เริ่มต้น' : 'Start'}<Input max={customEnd} onChange={(event) => setCustomStart(event.target.value)} type="date" value={customStart} /></label>
          <label>{language === 'th' ? 'สิ้นสุด' : 'End'}<Input min={customStart} onChange={(event) => setCustomEnd(event.target.value)} type="date" value={customEnd} /></label>
          <button className="export-button" type="submit">{language === 'th' ? 'แสดงกราฟ' : 'Show chart'}</button>
        </form>
      ) : null}

      {stats && latest && first ? (
        <>
          <div className={`history-metrics${hasInvestedValue ? '' : ' history-metrics-portfolio'}${valuesVisible ? '' : ' value-concealed'}`}>
            <div><span>{language === 'th' ? 'ล่าสุด' : 'Latest'}</span><strong>{currency(language).format(latest.total_value)}</strong></div>
            {hasInvestedValue ? <div><span>{language === 'th' ? 'ต้นทุนสินทรัพย์ที่เลือก' : 'Selected asset cost basis'}</span><strong>{latest.invested_value === null ? '—' : currency(language).format(latest.invested_value)}</strong></div> : null}
            <div><span>{language === 'th' ? 'สูงสุด' : 'High'}</span><strong>{currency(language).format(stats.maximum)}</strong></div>
            <div><span>{language === 'th' ? 'ต่ำสุด' : 'Low'}</span><strong>{currency(language).format(stats.minimum)}</strong></div>
          </div>
          <div className="history-detail-chart">
            <div className="history-legend" aria-label={language === 'th' ? 'คำอธิบายเส้นกราฟ' : 'Chart legend'}>
              <span><i className="history-legend-swatch portfolio-value" />{hasInvestedValue ? (language === 'th' ? 'มูลค่าปัจจุบันของสินทรัพย์ที่เลือก' : 'Selected asset current value') : (language === 'th' ? 'มูลค่าพอร์ตรวม' : 'Whole portfolio value')}</span>
              {hasInvestedValue ? <span><i className="history-legend-swatch invested-value" />{language === 'th' ? 'ต้นทุนสินทรัพย์ที่เลือกใน P&L' : 'Selected P&L asset cost basis'}</span> : null}
            </div>
            <ValueHistoryChart language={language} points={displayPoints} showInvestedValue={hasInvestedValue} valuesVisible={valuesVisible} />
          </div>
          <div className="history-detail-footer">
            <span>{dateTime(language).format(first.snapshot_at)}</span>
            <span>{percentage === null ? `${points.length} ${language === 'th' ? 'snapshot' : 'snapshots'}` : `${percentage >= 0 ? '+' : ''}${percentage.toFixed(2)}% · ${points.length} ${language === 'th' ? 'snapshot' : 'snapshots'}`}</span>
            <span>{dateTime(language).format(latest.snapshot_at)}</span>
          </div>
        </>
      ) : <p className="history-empty">{language === 'th' ? 'ยังมีข้อมูล snapshot ไม่พอสำหรับแสดงกราฟในช่วงเวลานี้' : 'There are not enough snapshots to show this chart range.'}</p>}
      {isLoading ? <p className="history-loading">{language === 'th' ? 'กำลังโหลดข้อมูลกราฟ' : 'Loading chart data'}</p> : null}
      {error ? <p className="history-error">{error}</p> : null}
    </section>
  )
}

const pushErrorMessage = (error: unknown, language: Language): string => {
  const detail = error instanceof Error ? error.message : ''
  if (detail === apiAccessRequired) return language === 'th' ? 'ต้องยืนยันสิทธิ์ API ให้เรียบร้อยก่อน' : 'Confirm API access first.'
  if (detail === 'Push notifications are not configured') return language === 'th' ? 'ระบบแจ้งเตือนยังไม่ได้ตั้งค่า' : 'Notifications are not configured.'
  if (detail === 'Push test is temporarily rate limited') return language === 'th' ? 'เพิ่งทดสอบไป กรุณารอ 1 นาทีแล้วลองใหม่' : 'Please wait one minute before testing again.'
  if (detail === 'No active push subscription') return language === 'th' ? 'ไม่พบการสมัครแจ้งเตือนของอุปกรณ์นี้ กรุณาเชื่อมใหม่' : 'No active subscription was found for this device. Reconnect notifications.'
  if (detail === 'Push delivery failed') return language === 'th' ? 'Worker ส่งไปยังบริการแจ้งเตือนไม่สำเร็จ' : 'The Worker could not deliver to the push service.'
  return language === 'th' ? 'บันทึกการแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง' : 'Unable to save notification settings. Try again.'
}

const NotificationSettings = ({ language }: { language: Language }) => {
  const [isSupported] = useState(() => isPushSupported())
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [requiresApiAccess, setRequiresApiAccess] = useState(false)
  const [preferences, setPreferences] = useState<PushNotificationPreferences>(resolveNotificationPreferences)

  useEffect(() => {
    if (!isSupported) return

    let isCurrent = true

    void getCurrentPushSubscription().then((subscription) => {
      if (!isCurrent || !subscription) return
      setIsSubscribed(true)
      void savePushSubscription(subscription.toJSON(), preferences).catch(() => undefined)
    }).catch(() => undefined)

    return () => {
      isCurrent = false
    }
  }, [isSupported])

  useEffect(() => {
    localStorage.setItem(notificationPreferencesStorageKey, JSON.stringify(preferences))
  }, [preferences])

  const showError = (error: unknown) => {
    setRequiresApiAccess(error instanceof Error && error.message === apiAccessRequired)
    setMessage(pushErrorMessage(error, language))
  }

  const enable = async () => {
    setIsWorking(true)
    setMessage(null)
    setRequiresApiAccess(false)
    try {
      const result = await subscribeToPush(await loadPushPublicKey())
      if (result.status === 'denied') {
        setMessage(language === 'th' ? 'เบราว์เซอร์ปิดสิทธิ์การแจ้งเตือนอยู่' : 'Notifications are blocked by this browser.')
        return
      }
      if (result.status === 'unsupported') {
        setMessage(language === 'th' ? 'เบราว์เซอร์นี้ไม่รองรับ Push notification' : 'This browser does not support push notifications.')
        return
      }
      await savePushSubscription(result.subscription.toJSON(), preferences)
      setIsSubscribed(true)
      setMessage(language === 'th' ? 'เปิดแจ้งเตือนรายการใหม่แล้ว' : 'New activity notifications are enabled.')
    } catch (error) {
      showError(error)
    } finally {
      setIsWorking(false)
    }
  }

  const disable = async () => {
    setIsWorking(true)
    setMessage(null)
    setRequiresApiAccess(false)
    try {
      const endpoint = await unsubscribeFromPush()
      setIsSubscribed(false)
      if (endpoint) {
        try {
          await removePushSubscription(endpoint)
        } catch (error) {
          showError(error)
          return
        }
      }
      setMessage(language === 'th' ? 'ปิดการแจ้งเตือนแล้ว' : 'Notifications are disabled.')
    } catch (error) {
      showError(error)
    } finally {
      setIsWorking(false)
    }
  }

  const updatePreference = (key: keyof PushNotificationPreferences) => {
    const next = { ...preferences, [key]: !preferences[key] }
    setPreferences(next)
    if (!isSubscribed) return

    setIsWorking(true)
    setMessage(null)
    setRequiresApiAccess(false)
    void getCurrentPushSubscription()
      .then((subscription) => subscription ? savePushSubscription(subscription.toJSON(), next) : undefined)
      .then(() => setMessage(language === 'th' ? 'บันทึกประเภทการแจ้งเตือนแล้ว' : 'Notification types saved.'))
      .catch(showError)
      .finally(() => setIsWorking(false))
  }

  const testDeviceNotification = () => {
    if (Notification.permission !== 'granted') {
      setMessage(language === 'th' ? 'เปิดสิทธิ์การแจ้งเตือนก่อนทดสอบ' : 'Enable notifications before testing.')
      return
    }

    const show = async () => {
      const body = language === 'th' ? 'การแจ้งเตือนบนอุปกรณ์ทำงานแล้ว' : 'Device notifications are working.'
      const tag = `moondi-test-${Date.now()}`
      const registration = await navigator.serviceWorker?.ready
      if (registration) {
        await registration.showNotification('Moondi', { body, requireInteraction: true, tag })
        const notifications = await registration.getNotifications({ tag })
        if (!notifications.some((notification) => notification.tag === tag)) throw new Error('The browser did not create the test notification.')
      } else {
        new Notification('Moondi', { body, tag })
      }
      setMessage(language === 'th' ? 'สร้างการแจ้งเตือนทดสอบแล้ว หากไม่เห็น banner ให้ตรวจ Notifications ของ Chrome และ macOS' : 'A test notification was created. If no banner appears, check Chrome and macOS notification settings.')
    }

    void show().catch(() => setMessage(language === 'th' ? 'ส่งการแจ้งเตือนทดสอบไม่สำเร็จ' : 'Unable to send the test notification.'))
  }

  const testWorkerDelivery = async () => {
    setIsWorking(true)
    setMessage(null)
    setRequiresApiAccess(false)
    try {
      const subscription = await getCurrentPushSubscription()
      if (!subscription) {
        setMessage(language === 'th' ? 'ไม่พบการสมัครแจ้งเตือนของอุปกรณ์นี้ กรุณาเชื่อมใหม่' : 'No active subscription was found for this device. Reconnect notifications.')
        return
      }
      await savePushSubscription(subscription.toJSON(), preferences)
      await testPushDelivery(subscription.endpoint)
      setMessage(language === 'th' ? 'Worker ส่งการทดสอบไปยังบริการแจ้งเตือนแล้ว หากไม่เห็น banner ให้ตรวจ Notifications ของ Chrome และ macOS' : 'The Worker sent a test to the push service. If no banner appears, check Chrome and macOS notification settings.')
    } catch (error) {
      showError(error)
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <section aria-label={language === 'th' ? 'ตั้งค่าการแจ้งเตือน' : 'Notification settings'} className="notification-settings">
      <div className="notification-panel-heading">
        <div>
          <p>{language === 'th' ? 'การแจ้งเตือน' : 'Notifications'}</p>
          <span>{language === 'th' ? 'ส่งเมื่อ sync พบรายการใหม่หรือเกิดปัญหา' : 'Sent when sync finds new activity or a problem.'}</span>
        </div>
        <span className={isSubscribed ? 'notification-state is-enabled' : 'notification-state'}>{isSubscribed ? (language === 'th' ? 'เปิดอยู่' : 'Enabled') : (language === 'th' ? 'ปิดอยู่' : 'Off')}</span>
      </div>
      {!isSupported ? <p className="push-status" role="status">{language === 'th' ? 'เบราว์เซอร์นี้ไม่รองรับ Push notification' : 'This browser does not support push notifications.'}</p> : (
        <>
          <button className="notification-action" disabled={isWorking} onClick={() => void (isSubscribed ? disable() : enable())} type="button">
            {isWorking ? (language === 'th' ? 'กำลังบันทึก…' : 'Saving…') : isSubscribed ? (language === 'th' ? 'ปิดการแจ้งเตือน' : 'Disable notifications') : (language === 'th' ? 'เปิดการแจ้งเตือน' : 'Enable notifications')}
          </button>
          <div className="notification-preferences" aria-disabled={!isSubscribed}>
            {([
              ['trades', language === 'th' ? 'ซื้อ / ขาย' : 'Trades'],
              ['cryptoTransfers', language === 'th' ? 'โอนคริปโต' : 'Crypto transfers'],
              ['fiatTransfers', language === 'th' ? 'ฝาก / ถอน THB' : 'THB deposits / withdrawals'],
              ['priceAlerts', language === 'th' ? 'ราคาแตะเป้าหมาย' : 'Price alerts'],
              ['syncIssues', language === 'th' ? 'ปัญหา sync' : 'Sync issues'],
            ] as const).map(([key, label]) => (
              <label key={key}><input checked={preferences[key]} disabled={!isSubscribed || isWorking} onChange={() => updatePreference(key)} type="checkbox" />{label}</label>
            ))}
          </div>
          <div className="notification-test-actions">
            <button className="notification-action" disabled={!isSubscribed || isWorking} onClick={testDeviceNotification} type="button">{language === 'th' ? 'ทดสอบการแสดงผล' : 'Test device display'}</button>
            <button className="notification-action" disabled={!isSubscribed || isWorking} onClick={() => void testWorkerDelivery()} type="button">{language === 'th' ? 'ทดสอบส่งจาก Worker' : 'Test Worker delivery'}</button>
          </div>
          <p className="notification-test-note">{language === 'th' ? 'ปุ่มแรกตรวจการแสดงผลบนอุปกรณ์ ส่วนปุ่มหลังทดสอบ Worker → push service → อุปกรณ์จริง' : 'The first button checks device display. The second tests Worker → push service → this device.'}</p>
        </>
      )}
      {message ? <p className="push-status" role="status">{message}</p> : null}
      {requiresApiAccess ? <a className="notification-action notification-access-link" href={apiAccessUrl}>{language === 'th' ? 'ยืนยันสิทธิ์ API แล้วลองใหม่' : 'Confirm API access and try again'}</a> : null}
      <p className="notification-retention">{language === 'th' ? 'ระบบลบการสมัครที่ไม่เปิด Moondi นาน 180 วันโดยอัตโนมัติ' : 'Subscriptions inactive for 180 days are removed automatically.'}</p>
    </section>
  )
}

const SettingsDialog = ({ accounts, archivedAccounts, ignoredPnlAssets, language, onArchiveAccount, onClose, onRestoreAccount, open, overviewSections, pnlAssets, setIgnoredPnlAssets, setLanguage, setOverviewSection, setTheme, setValuesVisible, theme, valuesVisible }: {
  accounts: Account[]
  archivedAccounts: Account[]
  ignoredPnlAssets: readonly string[]
  language: Language
  onArchiveAccount: (account: Account) => Promise<void>
  onClose: () => void
  onRestoreAccount: (account: Account) => Promise<void>
  open: boolean
  overviewSections: OverviewSections
  pnlAssets: PnlAsset[]
  setIgnoredPnlAssets: (assets: string[]) => void
  setLanguage: (language: Language) => void
  setOverviewSection: (section: OverviewSection, visible: boolean) => void
  setTheme: (theme: Theme) => void
  setValuesVisible: (valuesVisible: boolean) => void
  theme: Theme
  valuesVisible: boolean
}) => {
  const cancelArchiveRef = useRef<HTMLButtonElement>(null)
  const [accountMessage, setAccountMessage] = useState<string | null>(null)
  const [archivingAccountId, setArchivingAccountId] = useState<string | null>(null)
  const [pendingArchive, setPendingArchive] = useState<Account | null>(null)

  const archive = async (account: Account) => {
    setArchivingAccountId(account.id)
    setAccountMessage(null)
    try {
      await onArchiveAccount(account)
      setAccountMessage(language === 'th' ? `${account.label} ถูกตัดการเชื่อมต่อแล้ว` : `${account.label} has been disconnected.`)
    } catch {
      setAccountMessage(language === 'th' ? 'ตัดการเชื่อมต่อบัญชีไม่สำเร็จ ลองใหม่อีกครั้ง' : 'Unable to disconnect the account. Try again.')
    } finally {
      setArchivingAccountId(null)
      setPendingArchive(null)
    }
  }

  const restore = async (account: Account) => {
    setArchivingAccountId(account.id)
    setAccountMessage(null)
    try {
      await onRestoreAccount(account)
      setAccountMessage(language === 'th' ? `${account.label} กลับมาเชื่อมต่อแล้ว` : `${account.label} has been reconnected.`)
    } catch {
      setAccountMessage(language === 'th' ? 'เชื่อมต่อบัญชีเดิมกลับไม่สำเร็จ ลองใหม่อีกครั้ง' : 'Unable to reconnect this account. Try again.')
    } finally {
      setArchivingAccountId(null)
    }
  }

  return (
    <AppOverlay
      closeLabel={language === 'th' ? 'ปิด' : 'Close'}
      onClose={onClose}
      open={open}
      title={language === 'th' ? 'การตั้งค่า' : 'Settings'}
    >
      <div className="settings-content">
          <div className="settings-card">
            <div className="settings-row">
              <div>
                <p>{language === 'th' ? 'ภาษา' : 'Language'}</p>
                <span>{language === 'th' ? 'เลือกภาษาของเมนูและคำอธิบาย' : 'Interface language'}</span>
              </div>
              <div className="settings-segmented" role="group" aria-label={language === 'th' ? 'ภาษา' : 'Language'}>
                <button aria-pressed={language === 'th'} className={language === 'th' ? 'active' : undefined} onClick={() => setLanguage('th')} type="button">ไทย</button>
                <button aria-pressed={language === 'en'} className={language === 'en' ? 'active' : undefined} onClick={() => setLanguage('en')} type="button">English</button>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <p>{language === 'th' ? 'ธีมสี' : 'Appearance'}</p>
                <span>{language === 'th' ? 'โหมดสว่างหรือโหมดมืด' : 'Light or dark mode'}</span>
              </div>
              <div className="settings-segmented" role="group" aria-label={language === 'th' ? 'ธีม' : 'Theme'}>
                <button aria-pressed={theme === 'light'} className={theme === 'light' ? 'active' : undefined} onClick={() => setTheme('light')} type="button"><SunIcon height={14} width={14} />{language === 'th' ? 'สว่าง' : 'Light'}</button>
                <button aria-pressed={theme === 'dark'} className={theme === 'dark' ? 'active' : undefined} onClick={() => setTheme('dark')} type="button"><MoonIcon height={14} width={14} />{language === 'th' ? 'มืด' : 'Dark'}</button>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <p id="settings-hide-values-label">{language === 'th' ? 'ซ่อนมูลค่าและจำนวน' : 'Hide values & quantities'}</p>
                <span>{language === 'th' ? 'เบลอตัวเลขทางการเงินทั้งหมดบนหน้าจอ' : 'Blur balances and financial figures on screen'}</span>
              </div>
              <Switch.Root aria-labelledby="settings-hide-values-label" checked={!valuesVisible} className="switch-control" onCheckedChange={(hidden) => setValuesVisible(!hidden)}>
                <Switch.Thumb className="switch-thumb" />
              </Switch.Root>
            </div>
          </div>

          <section className="settings-card overview-section-settings">
            <div className="settings-card-header">
              <p>{language === 'th' ? 'ส่วนที่แสดงในภาพรวม' : 'Overview sections'}</p>
              <span>{language === 'th' ? 'ซ่อนหรือแสดงการ์ดต่าง ๆ ในหน้าภาพรวมเฉพาะเบราว์เซอร์นี้' : 'Show or hide cards on Overview in this browser.'}</span>
            </div>
            <div className="overview-section-list">
              {([
                ['pnl', language === 'th' ? 'กำไร / ขาดทุน Bitkub' : 'Bitkub profit and loss'],
                ['history', language === 'th' ? 'แนวโน้มมูลค่าพอร์ต' : 'Portfolio value trend'],
                ['allocation', language === 'th' ? 'สัดส่วนสินทรัพย์' : 'Portfolio allocation'],
                ['targets', language === 'th' ? 'เป้าหมายสัดส่วนพอร์ต' : 'Allocation targets'],
                ['rebalance', language === 'th' ? 'เทียบสัดส่วนกับเป้าหมาย' : 'Compare with targets'],
                ['watchlist', language === 'th' ? 'ติดตามราคาและแจ้งเตือน' : 'Watchlist and price alerts'],
                ['syncHealth', language === 'th' ? 'สถานะการเชื่อมต่อ' : 'Connection status'],
                ['holdings', language === 'th' ? 'สินทรัพย์ในพอร์ต' : 'Portfolio holdings'],
              ] as Array<[OverviewSection, string]>).map(([section, label]) => (
                <div className="settings-toggle-row" key={section}>
                  <span>{label}</span>
                  <Switch.Root aria-label={label} checked={overviewSections[section]} className="switch-control" onCheckedChange={(checked) => setOverviewSection(section, checked)}>
                    <Switch.Thumb className="switch-thumb" />
                  </Switch.Root>
                </div>
              ))}
            </div>
          </section>

          {pnlAssets.length > 0 ? <section className="settings-card pnl-preference-settings">
            <div className="settings-card-header">
              <p>{language === 'th' ? 'เหรียญที่รวมในการคำนวณ P&L' : 'P&L asset inclusion'}</p>
              <span>{language === 'th' ? 'เลือกเหรียญที่จะรวมในตาราง ยอดสรุป และการ์ด P&L ของเบราว์เซอร์นี้ โดยไม่ลบข้อมูลดิบ' : 'Choose assets included in P&L summaries in this browser without changing raw data.'}</span>
            </div>
            <div className="pnl-preference-options">
              {pnlAssets.map((asset) => {
                const included = !ignoredPnlAssets.includes(asset.asset)
                return <button aria-pressed={included} className={included ? 'active' : undefined} key={asset.asset} onClick={() => setIgnoredPnlAssets(included ? [...ignoredPnlAssets, asset.asset].toSorted() : ignoredPnlAssets.filter((name) => name !== asset.asset))} type="button">
                  <span>{asset.asset}</span><small>{included ? (language === 'th' ? 'รวม' : 'On') : (language === 'th' ? 'ซ่อน' : 'Off')}</small>
                </button>
              })}
            </div>
          </section> : null}

          <section className="settings-card account-settings">
            <div className="settings-card-header">
              <p>{language === 'th' ? 'บัญชีที่เชื่อมต่อ' : 'Connected accounts'}</p>
              <span>{language === 'th' ? 'ตัดการเชื่อมต่อเพื่อหยุด sync และซ่อนจากพอร์ต ประวัติและ secret จะไม่ถูกลบ' : 'Disconnecting stops sync and hides an account without deleting history or credentials.'}</span>
            </div>
            <div className="account-settings-list">
              {accounts.map((account) => (
                <div className="account-settings-row" key={account.id}>
                  <div><strong>{account.label}</strong><span>{account.exchange}</span></div>
                  <button className="text-button" disabled={archivingAccountId !== null} onClick={() => setPendingArchive(account)} type="button">{language === 'th' ? 'ตัดการเชื่อมต่อ' : 'Disconnect'}</button>
                </div>
              ))}
            </div>
            {archivedAccounts.length > 0 ? <div className="archived-account-settings">
              <p>{language === 'th' ? 'บัญชีที่ตัดการเชื่อมต่อ' : 'Disconnected accounts'}</p>
              <span>{language === 'th' ? 'เชื่อมต่อกลับเพื่อเปิด sync และแสดงข้อมูลเดิมอีกครั้ง หาก revoke key ใน Bitkub แล้ว ต้องเปลี่ยน credential ของบัญชีนี้ใน Worker secret ก่อน' : 'Reconnect to resume sync and show retained data. If you revoked the Bitkub key, replace this account entry in the Worker credential secret first.'}</span>
              <div className="account-settings-list">
                {archivedAccounts.map((account) => (
                  <div className="account-settings-row" key={account.id}>
                    <div><strong>{account.label}</strong><span>{account.exchange}</span></div>
                    <button className="text-button" disabled={archivingAccountId !== null} onClick={() => void restore(account)} type="button">{archivingAccountId === account.id ? (language === 'th' ? 'กำลังเชื่อมต่อ…' : 'Reconnecting…') : (language === 'th' ? 'เชื่อมต่ออีกครั้ง' : 'Reconnect')}</button>
                  </div>
                ))}
              </div>
            </div> : null}
            {accountMessage ? <p className="account-settings-message" role="status">{accountMessage}</p> : null}
          </section>

          <NotificationSettings language={language} />

          <section className="settings-card settings-session">
            <div>
              <p>{language === 'th' ? 'เซสชัน' : 'Session'}</p>
              <span>{language === 'th' ? 'ออกจากระบบ Cloudflare Access บนอุปกรณ์นี้' : 'Sign out of Cloudflare Access on this device.'}</span>
            </div>
            <a className="settings-logout-link" href="/cdn-cgi/access/logout">
              <SignOutIcon width={15} height={15} />
              <span>{language === 'th' ? 'ออกจากระบบ' : 'Sign out'}</span>
            </a>
          </section>
        </div>
      <AlertDialog.Root open={pendingArchive !== null} onOpenChange={(next, details) => {
        if (next) return
        if (archivingAccountId !== null) details.cancel()
        else setPendingArchive(null)
      }}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="app-overlay-backdrop account-confirm-layer" />
          <AlertDialog.Viewport className="app-overlay-viewport account-confirm-layer">
            <AlertDialog.Popup className="app-overlay-popup account-confirm-dialog" initialFocus={cancelArchiveRef}>
              {pendingArchive ? <div className="account-confirm-content">
                <AlertDialog.Title>{language === 'th' ? `ตัดการเชื่อมต่อ ${pendingArchive.label}?` : `Disconnect ${pendingArchive.label}?`}</AlertDialog.Title>
                <AlertDialog.Description>{language === 'th'
                  ? (accounts.length === 1 ? 'นี่คือบัญชีเดียวที่เชื่อมต่ออยู่ หน้า Portfolio จะว่างจนกว่าจะเชื่อมต่อบัญชีนี้กลับอีกครั้ง' : 'ระบบจะหยุด sync และซ่อนบัญชีนี้จากหน้า Portfolio')
                  : (accounts.length === 1 ? 'This is your only connected account. Your portfolio will be empty until you reconnect it.' : 'Sync will stop and this account will be hidden from the portfolio.')}</AlertDialog.Description>
                <ul>
                  <li>{language === 'th' ? 'ประวัติและ snapshot ที่บันทึกไว้จะไม่ถูกลบ' : 'Recorded history and snapshots will not be deleted.'}</li>
                  <li>{language === 'th' ? 'API key ไม่ถูกเปิดเผย แก้ไข หรือลบจากหน้านี้' : 'This page does not expose, edit, or delete the API key.'}</li>
                  <li>{language === 'th' ? 'เชื่อมต่อบัญชีเดิมกลับได้จาก Settings' : 'You can reconnect the same account from Settings.'}</li>
                </ul>
                <div className="account-confirm-actions">
                  <AlertDialog.Close disabled={archivingAccountId !== null} ref={cancelArchiveRef}>{language === 'th' ? 'ยกเลิก' : 'Cancel'}</AlertDialog.Close>
                  <button className="account-disconnect-button" disabled={archivingAccountId !== null} onClick={() => void archive(pendingArchive)} type="button">{archivingAccountId === pendingArchive.id ? (language === 'th' ? 'กำลังตัดการเชื่อมต่อ…' : 'Disconnecting…') : (language === 'th' ? 'ตัดการเชื่อมต่อ' : 'Disconnect')}</button>
                </div>
              </div> : null}
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </AppOverlay>
  )
}

const SyncHealth = ({ language, onOpenHistory, statuses }: { language: Language; onOpenHistory: () => void; statuses: SyncStatus[] }) => {
  const [now, setNow] = useState(Date.now)
  const attentionCount = statuses.filter((status) => status.status !== 'success' || isStaleSync(status, now)).length

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5 * 60 * 1_000)
    return () => window.clearInterval(interval)
  }, [])

  return (
    <section className="sync-health">
      <div className="section-heading">
        <div>
          <h2>{language === 'th' ? 'สถานะการเชื่อมต่อ' : 'Connection status'}</h2>
          <p className="sync-note">{language === 'th' ? 'Moondi อ่านข้อมูลจาก Bitkub เท่านั้น และไม่สามารถส่งคำสั่งซื้อ ขาย หรือถอนได้' : 'Moondi only reads data from Bitkub. It cannot place trades or withdrawals.'}</p>
          {attentionCount > 0 ? <p className="sync-alert" role="status">{language === 'th' ? `${attentionCount} แหล่งข้อมูลต้องตรวจสอบหรืออาจล่าช้า` : `${attentionCount} data source${attentionCount === 1 ? '' : 's'} needs attention or may be stale`}</p> : null}
        </div>
        <button className="chart-link" onClick={onOpenHistory} type="button">{language === 'th' ? 'ดูกิจกรรม' : 'View activity'}</button>
      </div>
      <div className="sync-list">
        {statuses.map((status) => {
          const stale = isStaleSync(status, now)
          return (
            <article className={`sync-item ${status.status}${stale ? ' stale' : ''}`} key={`${status.account_id}-${status.data_type}`}>
              <span className="sync-indicator" aria-hidden="true" />
              <div>
                <p>{syncLabel(status.data_type, language)}</p>
                <span>{status.account_label} · {stale ? (language === 'th' ? 'ข้อมูลอาจล่าช้า' : 'Data may be stale') : syncStatusLabel(status.status, language)}{status.occurred_at ? ` · ${dateTime(language).format(status.occurred_at)}` : ''}</span>
                {status.detail ? (
                  <details className="sync-details">
                    <summary>{language === 'th' ? 'ดูรายละเอียด' : 'View details'}</summary>
                    <p>{status.detail}</p>
                  </details>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

const SyncActivity = ({ accountId, language, onBack }: { accountId?: string | undefined; language: Language; onBack: () => void }) => {
  const [events, setEvents] = useState<SyncEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    void loadSyncEvents(100, accountId)
      .then((nextEvents) => {
        if (active) setEvents(nextEvents)
      })
      .catch(() => {
        if (active) setError(language === 'th' ? 'โหลดกิจกรรมการซิงก์ไม่สำเร็จ' : 'Unable to load sync activity.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [accountId, language])

  return (
    <section className="sync-activity" aria-label={language === 'th' ? 'กิจกรรมการซิงก์' : 'Sync activity'}>
      <button className="back-link tab-page-back" onClick={onBack} type="button">← {language === 'th' ? 'กลับไปภาพรวม' : 'Back to overview'}</button>
      <div className="sync-activity-heading">
        <div>
          <h1>{language === 'th' ? 'กิจกรรมการซิงก์' : 'Sync activity'}</h1>
          <p>{language === 'th' ? 'แสดง 100 เหตุการณ์ล่าสุดที่บันทึกไว้ ไม่ได้เรียก Bitkub เพิ่ม' : 'Shows the latest 100 stored events. It does not make another Bitkub request.'}</p>
        </div>
        <span>{events.length} {language === 'th' ? 'เหตุการณ์' : events.length === 1 ? 'event' : 'events'}</span>
      </div>
      {isLoading ? <p className="history-loading">{language === 'th' ? 'กำลังโหลดกิจกรรมการซิงก์' : 'Loading sync activity'}</p> : null}
      {error ? <p className="history-error">{error}</p> : null}
      {!isLoading && !error && events.length === 0 ? <p className="history-empty">{language === 'th' ? 'ยังไม่มีเหตุการณ์การซิงก์ที่บันทึกไว้' : 'No sync activity has been recorded yet.'}</p> : null}
      {!isLoading && !error && events.length > 0 ? (
        <ol className="sync-event-list">
          {events.map((event) => (
            <li className={`sync-event ${event.status}`} key={event.id}>
              <span className="sync-indicator" aria-hidden="true" />
              <div className="sync-event-content">
                <div className="sync-event-title">
                  <strong>{syncLabel(event.data_type, language)}</strong>
                  <span>{syncStatusLabel(event.status, language)}</span>
                </div>
                <p>{event.account_label} · {dateTime(language).format(event.occurred_at)}</p>
                {event.detail ? (
                  <details className="sync-details">
                    <summary>{language === 'th' ? 'ดูรายละเอียด' : 'View details'}</summary>
                    <p>{event.detail}</p>
                  </details>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}

const transactionLabel = (transaction: Transaction, language: Language): string => {
  if (transaction.category === 'trade') return transaction.direction === 'buy' ? (language === 'th' ? 'ซื้อ' : 'Buy') : (language === 'th' ? 'ขาย' : 'Sell')
  if (transaction.category === 'crypto_transfer') return transaction.direction === 'deposit' ? (language === 'th' ? 'รับเข้า' : 'Received') : (language === 'th' ? 'ถอนออก' : 'Sent')
  return transaction.direction === 'deposit' ? (language === 'th' ? 'ฝากเงินบาท' : 'THB deposit') : (language === 'th' ? 'ถอนเงินบาท' : 'THB withdrawal')
}

const transactionBadgeClass = (transaction: Transaction): string => (
  `transaction-badge ${transaction.category}-${transaction.direction}`
)

const Transactions = ({ language, nextCursor, onLoadMore, transactions, valuesVisible }: { language: Language; nextCursor: string | null; onLoadMore: () => Promise<void>; transactions: Transaction[]; valuesVisible: boolean }) => {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TransactionFilter>('all')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = deferredQuery.trim().toLocaleUpperCase('en-US')
  const filteredTransactions = useMemo(
    () => transactions.filter((transaction) =>
      (filter === 'all' || transaction.category === filter)
      && (normalizedQuery.length === 0 || transaction.asset.toLocaleUpperCase('en-US').includes(normalizedQuery)),
    ),
    [filter, normalizedQuery, transactions],
  )
  const hasTrades = transactions.some((transaction) => transaction.category === 'trade')

  const exportTransactions = () => {
    downloadCsv(
      'moondi-transactions.csv',
      ['Executed at', 'Type', 'Direction', 'Asset', 'Amount', 'Quote asset', 'Quote amount', 'Price', 'Fee', 'Account ID'],
      filteredTransactions.map((transaction) => [
        new Date(transaction.executed_at).toISOString(),
        transaction.category,
        transaction.direction,
        transaction.asset,
        transaction.amount,
        transaction.quote_asset,
        transaction.quote_amount,
        transaction.price,
        transaction.fee,
        transaction.account_id,
      ]),
    )
  }

  const loadMore = async () => {
    setIsLoadingMore(true)
    setLoadMoreError(null)

    try {
      await onLoadMore()
    } catch {
      setLoadMoreError('โหลดรายการเพิ่มเติมไม่สำเร็จ')
    } finally {
      setIsLoadingMore(false)
    }
  }

  return (
    <section className="transactions">
      <div className="section-heading">
        <div>
          <h2>{language === 'th' ? 'รายการล่าสุด' : 'Recent activity'}</h2>
        </div>
        <div className="section-actions">
          <span>{filteredTransactions.length} / {transactions.length} {language === 'th' ? 'รายการ' : 'items'}</span>
          <button className="export-button" disabled={!valuesVisible} onClick={exportTransactions} title={valuesVisible ? undefined : (language === 'th' ? 'แสดงมูลค่าก่อนส่งออก CSV' : 'Show values before exporting CSV')} type="button">{language === 'th' ? 'ส่งออก CSV' : 'Export CSV'}</button>
        </div>
      </div>
      <div className="transaction-controls">
        <label className="holding-search">
          <span className="sr-only">{language === 'th' ? 'ค้นหารายการตามสินทรัพย์' : 'Search activity by asset'}</span>
          <Input onChange={(event) => setQuery(event.target.value)} placeholder={language === 'th' ? 'ค้นหาสินทรัพย์' : 'Search assets'} type="search" value={query} />
        </label>
        <AppSelect<TransactionFilter>
          items={[
            { value: 'all', label: language === 'th' ? 'ทุกประเภท' : 'All types' },
            { value: 'trade', label: language === 'th' ? 'ซื้อ / ขาย' : 'Buy / sell' },
            { value: 'crypto_transfer', label: language === 'th' ? 'โอนคริปโต' : 'Crypto transfers' },
            { value: 'fiat_transfer', label: language === 'th' ? 'ฝาก / ถอนเงินบาท' : 'THB deposits / withdrawals' },
          ]}
          label={language === 'th' ? 'ประเภทของธุรกรรม' : 'Transaction type'}
          onChange={setFilter}
          value={filter}
        />
      </div>
      {!hasTrades ? <p className="transaction-status">{language === 'th' ? 'ยังไม่พบประวัติซื้อ/ขายที่นำมาแสดงได้ — Bitkub อาจไม่คืน order history สำหรับ symbol ที่มีอยู่' : 'No trade history is available yet. Bitkub may not return order history for the available symbols.'}</p> : null}
      {filteredTransactions.length > 0 ? (
        <>
          <div className="transaction-table" role="table">
            <div className="transaction-row transaction-header" role="row">
              <span>{language === 'th' ? 'เวลา' : 'Time'}</span>
              <span>{language === 'th' ? 'ประเภท' : 'Type'}</span>
              <span>{language === 'th' ? 'สินทรัพย์' : 'Asset'}</span>
              <span>{language === 'th' ? 'จำนวน' : 'Amount'}</span>
              <span>{language === 'th' ? 'ราคา/หน่วย' : 'Unit price'}</span>
              <span>{language === 'th' ? 'มูลค่า' : 'Value'}</span>
            </div>
            {filteredTransactions.map((transaction) => (
              <div className="transaction-row" key={`${transaction.category}-${transaction.id}`} role="row">
                <span>{dateTime(language).format(transaction.executed_at)}</span>
                <span><span className={transactionBadgeClass(transaction)}>{transactionLabel(transaction, language)}</span></span>
                <span>{transaction.asset}</span>
                <span className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(transaction.amount)}</span>
                <span className={valuesVisible ? undefined : 'value-concealed'}>{transaction.price === null || transaction.quote_asset === null ? '—' : formatTransactionMoney(language, transaction.price, transaction.quote_asset)}</span>
                <span className={valuesVisible ? undefined : 'value-concealed'}>{(() => {
                  const value = transactionValue(transaction)
                  return value ? `${value.approximate ? '≈' : ''}${formatTransactionMoney(language, value.value, value.quoteAsset)}` : '—'
                })()}</span>
              </div>
            ))}
          </div>
          <ul className="mobile-ledger" role="list">
            {filteredTransactions.map((transaction) => (
              <li className="mobile-transaction" key={`${transaction.category}-${transaction.id}`}>
                <div className="mobile-transaction-meta">
                  <time>{dateTime(language).format(transaction.executed_at)}</time>
                  <span className={transactionBadgeClass(transaction)}>{transactionLabel(transaction, language)}</span>
                </div>
                <div className="mobile-transaction-main">
                  <strong className="asset-symbol"><AssetIcon asset={transaction.asset} />{transaction.asset}</strong>
                  <span className={valuesVisible ? undefined : 'value-concealed'}><small>{language === 'th' ? 'จำนวน' : 'Amount'}</small>{quantity.format(transaction.amount)}</span>
                </div>
                {transaction.price !== null || transactionValue(transaction) ? <div className={`mobile-transaction-values${valuesVisible ? '' : ' value-concealed'}`}>
                  <span>{language === 'th' ? 'ราคา/หน่วย' : 'Unit price'} <strong>{transaction.price === null || transaction.quote_asset === null ? '—' : formatTransactionMoney(language, transaction.price, transaction.quote_asset)}</strong></span>
                  <span>{language === 'th' ? 'มูลค่า' : 'Value'} <strong>{(() => {
                    const value = transactionValue(transaction)
                    return value ? `${value.approximate ? '≈' : ''}${formatTransactionMoney(language, value.value, value.quoteAsset)}` : '—'
                  })()}</strong></span>
                </div> : null}
              </li>
            ))}
          </ul>
          {nextCursor ? (
            <div className="load-more">
              <button className="export-button" disabled={isLoadingMore} onClick={() => void loadMore()} type="button">{isLoadingMore ? (language === 'th' ? 'กำลังโหลด…' : 'Loading…') : (language === 'th' ? 'โหลดรายการเพิ่ม' : 'Load more')}</button>
              {loadMoreError ? <span>{loadMoreError}</span> : null}
            </div>
          ) : null}
        </>
      ) : <p className="no-results">{language === 'th' ? 'ไม่พบรายการที่ตรงกับตัวกรอง' : 'No activity matches the current filters.'}</p>}
    </section>
  )
}

export const App = () => {
  const accessDenied = accessMessage === 'unauthorized'
  const signedOut = accessMessage === 'logged_out'
  const isPublicState = accessDenied || signedOut
  const initialRoute = parseRoute(window.location.pathname)
  const [view, setView] = useState<View>(initialRoute.view)
  const [selectedAsset, setSelectedAsset] = useState<string | null>(initialRoute.selectedAsset)
  const [theme, setTheme] = useState<Theme>(resolveTheme)
  const [language, setLanguage] = useState<Language>(resolveLanguage)
  const [costMethod, setCostMethod] = useState<CostMethod>(resolveCostMethod)
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [nextTransactionCursor, setNextTransactionCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<ValueHistoryPoint[]>([])
  const [priceHistories, setPriceHistories] = useState<Record<string, PriceHistoryPoint[]>>({})
  const [syncStatus, setSyncStatus] = useState<SyncStatus[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [archivedAccounts, setArchivedAccounts] = useState<Account[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>()
  const [loadedAccountId, setLoadedAccountId] = useState<string | undefined>()
  const changingAccountScope = loadedAccountId !== selectedAccountId
  const [watchlist, setWatchlist] = useState<WatchlistAsset[]>([])
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([])
  const [allocationTargets, setAllocationTargets] = useState<AllocationTarget[]>([])
  const [error, setError] = useState<string | null>(null)
  const [valuesVisible, setValuesVisible] = useState(resolveValuesVisible)
  const [overviewSections, setOverviewSections] = useState(resolveOverviewSections)
  const [ignoredPnlAssets, setIgnoredPnlAssets] = useState(resolveIgnoredPnlAssets)
  const [isPortfolioCardOpen, setIsPortfolioCardOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(() => !accessDenied && !signedOut)
  const [isPullRefreshing, setIsPullRefreshing] = useState(false)
  const [pullRefreshFailed, setPullRefreshFailed] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const pullStartY = useRef<number | null>(null)
  const pullDistanceRef = useRef(0)
  const dashboardRequestId = useRef(0)
  const dashboardLoadedAt = useRef(0)
  const needsApiAccess = error === apiAccessRequired
  const investedAssets = useMemo(() => [...new Set((portfolio?.pnl.assets ?? [])
    .filter((asset) => asset.status === 'ready' && !ignoredPnlAssets.includes(asset.asset))
    .map((asset) => asset.asset))].toSorted(), [ignoredPnlAssets, portfolio?.pnl.assets])

  const loadDashboardScope = useCallback(async (accountId?: string) => {
    const requestId = dashboardRequestId.current + 1
    dashboardRequestId.current = requestId
    let dashboard: Dashboard
    try {
      dashboard = await loadDashboard(accountId, costMethod)
    } catch (reason) {
      if (dashboardRequestId.current !== requestId) return false
      throw reason
    }
    if (dashboardRequestId.current !== requestId) return false
    setHistory(dashboard.history)
    setPortfolio(dashboard.portfolio)
    setSyncStatus(dashboard.syncStatus)
    setTransactions(dashboard.transactions)
    setNextTransactionCursor(dashboard.nextTransactionCursor)
    setWatchlist(dashboard.watchlist)
    setPriceAlerts(dashboard.priceAlerts)
    setAllocationTargets(dashboard.targets)
    setLoadedAccountId(accountId)
    dashboardLoadedAt.current = Date.now()
    setError(null)
    return true
  }, [costMethod])

  const reloadDashboard = useCallback(async () => {
    return await loadDashboardScope(selectedAccountId)
  }, [loadDashboardScope, selectedAccountId])

  useEffect(() => {
    if (accessDenied || signedOut) {
      setIsLoading(false)
      return
    }

    let active = true

    void reloadDashboard()
      .then(() => {
        if (!active) return
        setIsLoading(false)
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : (language === 'th' ? 'ไม่สามารถโหลดข้อมูลพอร์ตได้' : 'Unable to load portfolio data.'))
        setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [accessDenied, language, reloadDashboard, signedOut])

  useEffect(() => {
    if (!portfolio || changingAccountScope) return
    let active = true
    void loadValueHistory({ accountId: selectedAccountId, assets: investedAssets, costMethod, days: 30 })
      .then((points) => {
        if (active) setHistory(points)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [changingAccountScope, costMethod, investedAssets, portfolio, selectedAccountId])

  useEffect(() => {
    if (accessDenied || signedOut) return
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      void reloadDashboard().catch(() => undefined)
    }
    const refreshWhenStale = () => {
      if (Date.now() - dashboardLoadedAt.current >= 5 * 60 * 1_000) refresh()
    }
    const interval = window.setInterval(refresh, 30 * 60 * 1_000)
    document.addEventListener('visibilitychange', refreshWhenStale)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenStale)
    }
  }, [accessDenied, reloadDashboard, signedOut])

  useEffect(() => {
    if (accessDenied || signedOut) return
    let active = true
    void Promise.all([loadAccounts(), loadArchivedAccounts()]).then(([nextAccounts, nextArchivedAccounts]) => {
      if (!active) return
      setAccounts(nextAccounts)
      setArchivedAccounts(nextArchivedAccounts)
    }).catch(() => undefined)
    return () => {
      active = false
    }
  }, [accessDenied, signedOut])

  useEffect(() => {
    const assets = [...new Set((portfolio?.holdings ?? [])
      .filter((holding) => holding.asset !== 'THB' && holdingAmount(holding) > 0)
      .map((holding) => holding.asset))]
    if (assets.length === 0) {
      setPriceHistories({})
      return
    }

    let active = true
    void loadAssetPriceHistories(assets, 1)
      .then((nextHistories) => {
        if (active) setPriceHistories(nextHistories)
      })
      .catch(() => {
        if (active) setPriceHistories({})
      })

    return () => {
      active = false
    }
  }, [portfolio])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(themeStorageKey, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(costMethodStorageKey, costMethod)
  }, [costMethod])

  useEffect(() => {
    localStorage.setItem(valuesVisibleStorageKey, valuesVisible ? 'visible' : 'hidden')
  }, [valuesVisible])

  useEffect(() => {
    localStorage.setItem(overviewSectionsStorageKey, JSON.stringify(overviewSections))
  }, [overviewSections])

  useEffect(() => {
    localStorage.setItem(pnlIgnoredAssetsStorageKey, JSON.stringify(ignoredPnlAssets))
  }, [ignoredPnlAssets])

  useEffect(() => {
    document.documentElement.lang = language
    localStorage.setItem(languageStorageKey, language)
  }, [language])

  const totalValue = portfolio?.totalValue ?? 0

  const loadMoreTransactions = async () => {
    if (!nextTransactionCursor) return
    const page = await loadTransactions(nextTransactionCursor, selectedAccountId)
    setTransactions((current) => {
      const existing = new Set(current.map((transaction) => `${transaction.category}-${transaction.id}`))
      return [...current, ...page.transactions.filter((transaction) => !existing.has(`${transaction.category}-${transaction.id}`))]
    })
    setNextTransactionCursor(page.nextCursor)
  }

  const downloadBackup = async () => {
    const backup = await loadBackup({ accountId: selectedAccountId })
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `moondi-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const disconnectAccount = async (account: Account) => {
    await archiveAccount(account.id)
    if (selectedAsset) navigateTo('overview')
    setSelectedAccountId(undefined)
    setError(null)
    setAccounts((current) => current.filter((item) => item.id !== account.id))
    setArchivedAccounts((current) => [account, ...current.filter((item) => item.id !== account.id)])
    if (selectedAccountId === undefined) await loadDashboardScope(undefined)
  }

  const reconnectAccount = async (account: Account) => {
    await restoreAccount(account.id)
    setArchivedAccounts((current) => current.filter((item) => item.id !== account.id))
    setAccounts((current) => [...current, account].sort((left, right) => left.label.localeCompare(right.label)))
    await loadDashboardScope(selectedAccountId)
  }

  const refreshFromPull = async () => {
    if (isPullRefreshing) return
    setIsPullRefreshing(true)
    setPullRefreshFailed(false)
    try {
      await reloadDashboard()
    } catch {
      setPullRefreshFailed(true)
    } finally {
      setIsPullRefreshing(false)
    }
  }

  const beginPullRefresh = (event: TouchEvent<HTMLElement>) => {
    if (event.touches.length !== 1 || window.scrollY > 0 || isPullRefreshing || isSettingsOpen || isPortfolioCardOpen) return
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
    setPullRefreshFailed(false)
    pullStartY.current = event.touches[0]?.clientY ?? null
  }

  const trackPullRefresh = (event: TouchEvent<HTMLElement>) => {
    if (pullStartY.current === null || event.touches.length !== 1) return
    const distance = Math.max(0, Math.min((event.touches[0]?.clientY ?? pullStartY.current) - pullStartY.current, 96))
    pullDistanceRef.current = distance
    setPullDistance(distance)
  }

  const resetPullRefresh = () => {
    pullStartY.current = null
    pullDistanceRef.current = 0
    setPullDistance(0)
  }

  const finishPullRefresh = () => {
    const shouldRefresh = pullDistanceRef.current >= 72
    resetPullRefresh()
    if (shouldRefresh) void refreshFromPull()
  }

  useEffect(() => {
    const onPopState = () => {
      const next = parseRoute(window.location.pathname)
      setView(next.view)
      setSelectedAsset(next.selectedAsset)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const syncAttentionCount = changingAccountScope ? 0 : syncStatus.filter((status) => status.status !== 'success' || isStaleSync(status)).length
  const allocationSlices = overviewSections.allocation ? aggregatePortfolioAllocation(portfolio?.holdings ?? []) : []
  const hasAllocationCard = allocationSlices.length > 0
  const notificationItems: NotificationItem[] = changingAccountScope ? [] : [
    ...transactions.slice(0, 20).map((item): NotificationItem => ({
      id: `ledger:${item.category}:${item.id}`,
      occurredAt: item.executed_at,
      target: 'transactions',
      title: `${transactionLabel(item, language)} ${item.category === 'fiat_transfer' ? '' : item.asset}`.trim(),
      detail: language === 'th' ? 'รายการจาก Bitkub' : 'Bitkub activity',
    })),
    ...syncStatus.flatMap((item): NotificationItem[] => item.occurred_at !== null && (item.status === 'failure' || item.status === 'deferred') ? [{
      id: `sync:${item.account_id}:${item.data_type}:${item.occurred_at}`,
      occurredAt: item.occurred_at,
      target: 'sync',
      title: language === 'th' ? 'ต้องตรวจสอบการซิงก์' : 'Sync needs attention',
      detail: item.account_label,
    }] : []),
    ...priceAlerts.flatMap((item): NotificationItem[] => item.last_triggered_at === null ? [] : [{
      id: `price:${item.id}:${item.last_triggered_at}`,
      occurredAt: item.last_triggered_at,
      target: 'overview',
      title: language === 'th' ? `${item.asset} แตะราคาเป้าหมาย` : `${item.asset} reached its price target`,
    }]),
  ].toSorted((a, b) => b.occurredAt - a.occurredAt).slice(0, 20)
  const navigateTo = (nextView: View, nextAsset: string | null = null) => {
    setSelectedAsset(nextAsset)
    setView(nextView)
    const nextUrl = buildRouteUrl(nextView, nextAsset)
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history.pushState(null, '', nextUrl)
    }
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const onRouteClick = (nextView: View, nextAsset: string | null = null) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    navigateTo(nextView, nextAsset)
  }
  const viewTitle = selectedAsset
    ? selectedAsset
    : view === 'overview'
      ? (language === 'th' ? 'ภาพรวมพอร์ต' : 'Portfolio overview')
      : view === 'transactions'
        ? (language === 'th' ? 'รายการธุรกรรม' : 'Activity ledger')
        : view === 'history'
          ? (language === 'th' ? 'ประวัติมูลค่าพอร์ต' : 'Value history')
          : (language === 'th' ? 'กิจกรรมการซิงก์' : 'Sync activity')

  if (isLoading) {
    return (
      <main aria-label="Moondi" className="startup-shell">
        <img alt="" className="startup-icon" height={84} src="/icon-512.png" width={84} />
        <div className="startup-detail">
          <p className="startup-status" role="status">{language === 'th' ? 'กำลังโหลดพอร์ต…' : 'Loading portfolio…'}</p>
          <a className="startup-retry" href="">{language === 'th' ? 'โหลดใหม่' : 'Reload'}</a>
        </div>
      </main>
    )
  }

  if (isPublicState) {
    return (
      <main className="public-shell">
        <header className="public-header">
          <a className="brand-lockup" href="/" aria-label="Moondi home">
            <img alt="" className="brand-icon" height={32} src="/icon.svg" width={32} />
            <span className="wordmark">moondi<span>.</span></span>
          </a>
        </header>
        {accessDenied ? (
          <section className="access-denied">
            <p className="eyebrow">Access denied</p>
            <h1>{language === 'th' ? 'บัญชีนี้ไม่มีสิทธิ์เข้าถึง Moondi' : 'This account is not allowed to access Moondi.'}</h1>
            <p>{language === 'th' ? 'ออกจากระบบ Cloudflare Access แล้วลงชื่อเข้าใช้อีกครั้งด้วยบัญชีที่ได้รับอนุญาต' : 'Sign out of Cloudflare Access, then sign in again with an allowed account.'}</p>
            <a className="access-link" href="/cdn-cgi/access/logout">{language === 'th' ? 'ออกจากระบบและเปลี่ยนบัญชี' : 'Sign out and change account'}</a>
          </section>
        ) : null}
        {signedOut ? (
          <section className="access-denied">
            <p className="eyebrow">Signed out</p>
            <h1>{language === 'th' ? 'ออกจากระบบแล้ว' : 'You are signed out.'}</h1>
            <p>{language === 'th' ? 'ลงชื่อเข้าใช้ Google อีกครั้งเพื่อดูข้อมูลพอร์ต' : 'Sign in with Google again to view portfolio data.'}</p>
            <button className="access-link access-button" onClick={restartAccess} type="button">{language === 'th' ? 'ลงชื่อเข้าใช้อีกครั้ง' : 'Sign in again'}</button>
          </section>
        ) : null}
      </main>
    )
  }

  return (
    <CostMethodContext.Provider value={costMethod}>
    <div className="app-layout">
      <div aria-hidden="true" className="status-bar-edge" />
      <aside className="app-sidebar" aria-label={language === 'th' ? 'แถบนำทางด้านข้าง' : 'Sidebar navigation'}>
        <div className="sidebar-brand">
          <a className="brand-lockup" href={buildRouteUrl('overview')} onClick={onRouteClick('overview')} aria-label="Moondi home">
            <img alt="" className="brand-icon" height={34} src="/icon.svg" width={34} />
            <div className="brand-copy">
              <span className="wordmark">moondi<span>.</span></span>
              <span className="brand-subtitle">{language === 'th' ? 'Bitkub · อ่านอย่างเดียว' : 'Bitkub · Read-only'}</span>
            </div>
          </a>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          <p className="sidebar-group-label">{language === 'th' ? 'เมนูหลัก' : 'Workspace'}</p>
          <a className={view === 'overview' && !selectedAsset ? 'sidebar-nav-item active' : 'sidebar-nav-item'} href={buildRouteUrl('overview')} onClick={onRouteClick('overview')}>
            <OverviewIcon />
            <span>{language === 'th' ? 'ภาพรวม' : 'Overview'}</span>
          </a>
          <a className={view === 'transactions' ? 'sidebar-nav-item active' : 'sidebar-nav-item'} href={buildRouteUrl('transactions')} onClick={onRouteClick('transactions')}>
            <ActivityIcon />
            <span>{language === 'th' ? 'รายการ' : 'Activity'}</span>
          </a>
          <a className={view === 'history' ? 'sidebar-nav-item active' : 'sidebar-nav-item'} href={buildRouteUrl('history')} onClick={onRouteClick('history')}>
            <HistoryIcon />
            <span>{language === 'th' ? 'ประวัติมูลค่า' : 'History'}</span>
          </a>
          <a className={view === 'sync' ? 'sidebar-nav-item active' : 'sidebar-nav-item'} href={buildRouteUrl('sync')} onClick={onRouteClick('sync')}>
            <SyncIcon />
            <span>{language === 'th' ? 'สถานะการซิงก์' : 'Sync activity'}</span>
            {syncAttentionCount > 0 ? <span className="nav-badge" aria-label={language === 'th' ? `${syncAttentionCount} รายการต้องตรวจสอบ` : `${syncAttentionCount} need attention`}>{syncAttentionCount}</span> : null}
          </a>
        </nav>

        <div className="sidebar-footer">
          <div className="theme-segmented" role="group" aria-label={language === 'th' ? 'สลับธีม' : 'Theme switcher'}>
            <button aria-pressed={theme === 'light'} className={theme === 'light' ? 'active' : undefined} onClick={() => setTheme('light')} type="button">
              <SunIcon width={15} height={15} />
              <span>{language === 'th' ? 'สว่าง' : 'Light'}</span>
            </button>
            <button aria-pressed={theme === 'dark'} className={theme === 'dark' ? 'active' : undefined} onClick={() => setTheme('dark')} type="button">
              <MoonIcon width={15} height={15} />
              <span>{language === 'th' ? 'มืด' : 'Dark'}</span>
            </button>
          </div>

          <div className="sidebar-utility-row">
            <button aria-label={language === 'th' ? 'เปลี่ยนภาษา' : 'Switch language'} className="sidebar-utility-btn" onClick={() => setLanguage(language === 'th' ? 'en' : 'th')} type="button">
              <span>{language === 'th' ? 'TH / EN' : 'EN / TH'}</span>
            </button>
            <button aria-label={language === 'th' ? 'เปิดการตั้งค่า' : 'Open settings'} className="sidebar-utility-btn" onClick={() => setIsSettingsOpen(true)} type="button">
              <SettingsIcon width={15} height={15} />
              <span>{language === 'th' ? 'ตั้งค่า' : 'Settings'}</span>
            </button>
          </div>

          <div className="sidebar-account-card">
            <div className="sidebar-account-info">
              <img alt="" className="sidebar-account-icon" height={30} src="/icon.svg" width={30} />
              <div>
                <strong>{accounts.length > 0 ? (language === 'th' ? `${accounts.length} บัญชี Bitkub` : `${accounts.length} Bitkub ${accounts.length === 1 ? 'account' : 'accounts'}`) : 'Bitkub'}</strong>
                <span>{language === 'th' ? 'โหมดอ่านอย่างเดียว' : 'Read-only session'}</span>
              </div>
            </div>
            <a aria-label={language === 'th' ? 'ออกจากระบบ' : 'Sign out'} className="sidebar-logout-btn" href="/cdn-cgi/access/logout" title={language === 'th' ? 'ออกจากระบบ' : 'Sign out'}>
              <SignOutIcon width={16} height={16} />
            </a>
          </div>
        </div>
      </aside>

      <main className="app-main" onTouchCancel={resetPullRefresh} onTouchEnd={finishPullRefresh} onTouchMove={trackPullRefresh} onTouchStart={beginPullRefresh}>
        <header className="app-topbar">
          <div className="topbar-left">
            <a className="brand-lockup mobile-brand" href={buildRouteUrl('overview')} onClick={onRouteClick('overview')} aria-label="Moondi home">
              <img alt="" className="brand-icon" height={28} src="/icon.svg" width={28} />
              <span className="wordmark">moondi<span>.</span></span>
            </a>
            <div className="topbar-heading">
              <h1>{viewTitle}</h1>
            </div>
          </div>

          <div className="topbar-actions">
            {accounts.length > 1 ? (
              <div className="account-scope">
                <AppSelect
                  items={[
                    { value: '', label: language === 'th' ? 'ทุกบัญชี' : 'All accounts' },
                    ...accounts.map(({ id, label }) => ({ value: id, label })),
                  ]}
                  label={language === 'th' ? 'ขอบเขตบัญชี' : 'Account scope'}
                  onChange={(accountId) => {
                    setError(null)
                    setPullRefreshFailed(false)
                    setSelectedAccountId(accountId || undefined)
                    if (selectedAsset) navigateTo('overview')
                  }}
                  value={selectedAccountId ?? ''}
                />
              </div>
            ) : null}

            <NotificationCenter
              dates={dateTime(language)}
              items={notificationItems}
              language={language}
              onOpen={(target) => target === 'settings' ? setIsSettingsOpen(true) : navigateTo(target)}
            />

            <button
              aria-label={valuesVisible ? (language === 'th' ? 'ซ่อนมูลค่าพอร์ต' : 'Hide portfolio values') : (language === 'th' ? 'แสดงมูลค่าพอร์ต' : 'Show portfolio values')}
              aria-pressed={!valuesVisible}
              className={valuesVisible ? 'topbar-pill-btn' : 'topbar-pill-btn is-active'}
              onClick={() => setValuesVisible((visible) => !visible)}
              type="button"
            >
              {valuesVisible ? <EyeIcon width={16} height={16} /> : <EyeOffIcon width={16} height={16} />}
              <span className="topbar-pill-label">{valuesVisible ? (language === 'th' ? 'ซ่อนมูลค่า' : 'Hide values') : (language === 'th' ? 'แสดงมูลค่า' : 'Show values')}</span>
            </button>

            {portfolio && view === 'overview' && !selectedAsset ? (
              <button className="topbar-pill-btn desktop-only-btn" onClick={() => setIsPortfolioCardOpen(true)} type="button">
                <ImageCardIcon width={16} height={16} />
                <span className="topbar-pill-label">{language === 'th' ? 'สร้างภาพพอร์ต' : 'Share card'}</span>
              </button>
            ) : null}

            <button aria-label={language === 'th' ? 'เปิดการตั้งค่า' : 'Open settings'} className="topbar-icon-btn mobile-only-btn" onClick={() => setIsSettingsOpen(true)} type="button">
              <SettingsIcon width={18} height={18} />
            </button>
          </div>
        </header>
        <UpdateNotice language={language} />
        <div aria-live="polite" className={isPullRefreshing || pullRefreshFailed || pullDistance > 0 ? 'pull-refresh-indicator is-visible' : 'pull-refresh-indicator'}>
          <span>{isPullRefreshing ? (language === 'th' ? 'กำลังโหลดข้อมูลล่าสุด…' : 'Refreshing latest data…') : pullRefreshFailed ? (language === 'th' ? 'รีเฟรชไม่สำเร็จ ลองดึงลงอีกครั้ง' : 'Refresh failed. Pull down to try again.') : pullDistance >= 72 ? (language === 'th' ? 'ปล่อยเพื่อโหลดข้อมูลล่าสุด' : 'Release to refresh latest data') : (language === 'th' ? 'ดึงลงเพื่อโหลดข้อมูลล่าสุด' : 'Pull to refresh latest data')}</span>
        </div>

        <div className="app-content">
          {changingAccountScope && !error ? <p className="history-loading" role="status">{language === 'th' ? 'กำลังโหลดข้อมูลบัญชี…' : 'Loading account data…'}</p> : null}
          {error ? (
            <section className="error-state surface-card">
              <h1>{needsApiAccess ? (language === 'th' ? 'ต้องยืนยันสิทธิ์ API' : 'API access needs confirmation') : (language === 'th' ? 'ยังติดต่อข้อมูลพอร์ตไม่ได้' : 'Portfolio data is unavailable')}</h1>
              <p>{needsApiAccess ? (language === 'th' ? 'Cloudflare Access ของ API ยังไม่ได้ยืนยันในเบราว์เซอร์นี้' : 'Cloudflare Access for the API has not been confirmed in this browser.') : (language === 'th' ? 'ลองรีเฟรชหน้าอีกครั้ง หรือตรวจสอบการเชื่อมต่อ' : 'Try refreshing the page or check your connection.')}</p>
              {needsApiAccess ? <a className="access-link" href={apiAccessUrl}>{language === 'th' ? 'ยืนยันสิทธิ์ API' : 'Confirm API access'}</a> : <a className="access-link" href="">{language === 'th' ? 'โหลดใหม่' : 'Reload'}</a>}
            </section>
          ) : null}

          {!error && !changingAccountScope && view === 'overview' ? (
            selectedAsset && portfolio ? (
              <AssetDetail accountId={selectedAccountId} asset={selectedAsset} holdings={portfolio.holdings} language={language} onClose={() => navigateTo('overview')} pnlAsset={portfolio.pnl.assets.find((item) => item.asset === selectedAsset)} portfolioValue={portfolio.totalValue} transactions={transactions} valuesVisible={valuesVisible} />
            ) : (
              <div className="overview-stack">
                <div className={hasAllocationCard ? 'overview-summary-grid has-allocation' : 'overview-summary-grid'}>
                  <PortfolioValueCard history={history} language={language} onOpenHistory={() => navigateTo('history')} totalValue={totalValue} updatedAt={portfolio?.updatedAt} valuesVisible={valuesVisible} />

                  {hasAllocationCard ? <PortfolioAllocation language={language} slices={allocationSlices} valuesVisible={valuesVisible} /> : null}
                </div>

                {overviewSections.pnl && portfolio ? <PnlPanel costMethod={costMethod} ignoredAssets={ignoredPnlAssets} language={language} onCostMethodChange={setCostMethod} onSaveCostBasis={async (transferId, totalCostThb) => { await saveCryptoTransferCostBasis(transferId, totalCostThb); await reloadDashboard() }} pnl={portfolio.pnl} valuesVisible={valuesVisible} /> : null}
                {overviewSections.history ? <PortfolioHistory language={language} onOpenHistory={() => navigateTo('history')} points={history} valuesVisible={valuesVisible} /> : null}
                {overviewSections.targets ? <AllocationTargets holdings={portfolio?.holdings ?? []} language={language} onRemove={async (asset) => { await removeAllocationTarget(asset); setAllocationTargets((current) => current.filter((target) => target.asset !== asset)) }} onSave={async (asset, targetPercent) => { const target = await saveAllocationTarget(asset, targetPercent); setAllocationTargets((current) => [...current.filter((item) => item.asset !== asset), target].toSorted((left, right) => left.asset.localeCompare(right.asset))) }} targets={allocationTargets} /> : null}
                {overviewSections.rebalance ? <RebalanceAssistant holdings={portfolio?.holdings ?? []} language={language} targets={allocationTargets} valuesVisible={valuesVisible} /> : null}
                {overviewSections.watchlist ? <TrackedPrices holdings={portfolio?.holdings ?? []} language={language} onAddAlert={async (asset, direction, targetPrice) => { const alert = await addPriceAlert(asset, direction, targetPrice); setPriceAlerts((current) => [alert, ...current]) }} onAddAsset={async (asset) => { const result = await addWatchlistAsset(asset); if (result.created) setWatchlist((current) => [{ asset: result.asset, created_at: Date.now(), price: null, updated_at: null }, ...current]); return result }} onRemoveAlert={async (id) => { await removePriceAlert(id); setPriceAlerts((current) => current.filter((alert) => alert.id !== id)) }} onRemoveAsset={async (asset) => { await removeWatchlistAsset(asset); setWatchlist((current) => current.filter((item) => item.asset !== asset)) }} priceAlerts={priceAlerts} valuesVisible={valuesVisible} watchlist={watchlist} /> : null}
                {overviewSections.syncHealth ? <SyncHealth language={language} onOpenHistory={() => navigateTo('sync')} statuses={syncStatus} /> : null}
                {overviewSections.holdings && portfolio && portfolio.holdings.length > 0 ? (
                  <Holdings holdings={portfolio.holdings} language={language} onOpenPortfolioCard={() => setIsPortfolioCardOpen(true)} onSelectAsset={(asset) => navigateTo('overview', asset)} onDownloadBackup={() => void downloadBackup()} priceHistories={priceHistories} valuesVisible={valuesVisible} />
                ) : (overviewSections.holdings ? <EmptyState language={language} /> : null)}

                <footer className="overview-footer">
                  <a className="overview-ledger-cta" href={buildRouteUrl('transactions')} onClick={onRouteClick('transactions')}>
                    <ActivityIcon width={17} height={17} />
                    <span>{language === 'th' ? 'ดูรายการธุรกรรมทั้งหมด' : 'View all transactions'}</span>
                  </a>
                  <p className="overview-readonly-note">
                    {language === 'th' ? 'Moondi เชื่อมต่อ Bitkub แบบอ่านอย่างเดียว ไม่สามารถส่งคำสั่งซื้อ ขาย หรือถอนสินทรัพย์ได้' : 'Moondi uses read-only Bitkub access and cannot place trades or withdrawals.'}
                  </p>
                </footer>
              </div>
            )
          ) : null}

          {!error && !changingAccountScope && view === 'transactions' ? <Transactions language={language} nextCursor={nextTransactionCursor} onLoadMore={loadMoreTransactions} transactions={transactions} valuesVisible={valuesVisible} /> : null}
          {!error && !changingAccountScope && view === 'history' ? <HistoryView accountId={selectedAccountId} initialPoints={history} investedAssets={investedAssets} language={language} onBack={() => navigateTo('overview')} valuesVisible={valuesVisible} /> : null}
          {!error && !changingAccountScope && view === 'sync' ? <SyncActivity accountId={selectedAccountId} language={language} onBack={() => navigateTo('overview')} /> : null}
        </div>
      </main>

      <nav className="mobile-tab-bar" data-view={view} aria-label={language === 'th' ? 'เมนูด้านล่าง' : 'Bottom navigation'}>
        <a aria-current={view === 'overview' ? 'page' : undefined} className="mobile-tab" href={buildRouteUrl('overview')} onClick={onRouteClick('overview')}>
          <span className="mobile-tab-pill"><OverviewIcon width={20} height={20} /></span>
          <span>{language === 'th' ? 'ภาพรวม' : 'Overview'}</span>
        </a>
        <a aria-current={view === 'transactions' ? 'page' : undefined} className="mobile-tab" href={buildRouteUrl('transactions')} onClick={onRouteClick('transactions')}>
          <span className="mobile-tab-pill"><ActivityIcon width={20} height={20} /></span>
          <span>{language === 'th' ? 'รายการ' : 'Activity'}</span>
        </a>
        <a aria-current={view === 'history' ? 'page' : undefined} className="mobile-tab" href={buildRouteUrl('history')} onClick={onRouteClick('history')}>
          <span className="mobile-tab-pill"><HistoryIcon width={20} height={20} /></span>
          <span>{language === 'th' ? 'ประวัติ' : 'History'}</span>
        </a>
        <a aria-current={view === 'sync' ? 'page' : undefined} className="mobile-tab" href={buildRouteUrl('sync')} onClick={onRouteClick('sync')}>
          <span className="mobile-tab-pill">
            <SyncIcon width={20} height={20} />
            {syncAttentionCount > 0 ? <span className="mobile-tab-dot" aria-hidden="true" /> : null}
          </span>
          <span>{language === 'th' ? 'การซิงก์' : 'Sync'}</span>
        </a>
      </nav>

      {portfolio && !changingAccountScope ? <PortfolioCardDialog holdings={portfolio.holdings} ignoredPnlAssets={ignoredPnlAssets} language={language} onClose={() => setIsPortfolioCardOpen(false)} open={isPortfolioCardOpen} pnl={portfolio.pnl} totalValue={portfolio.totalValue} /> : null}
      <SettingsDialog accounts={accounts} archivedAccounts={archivedAccounts} ignoredPnlAssets={ignoredPnlAssets} language={language} onArchiveAccount={disconnectAccount} onClose={() => setIsSettingsOpen(false)} onRestoreAccount={reconnectAccount} open={isSettingsOpen} overviewSections={overviewSections} pnlAssets={changingAccountScope ? [] : portfolio?.pnl.assets ?? []} setIgnoredPnlAssets={setIgnoredPnlAssets} setLanguage={setLanguage} setOverviewSection={(section, visible) => setOverviewSections((current) => ({ ...current, [section]: visible }))} setTheme={setTheme} setValuesVisible={setValuesVisible} theme={theme} valuesVisible={valuesVisible} />
    </div>
    </CostMethodContext.Provider>
  )
}
