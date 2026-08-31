import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { addPriceAlert, addWatchlistAsset, apiAccessRequired, apiAccessUrl, archiveAccount, loadAccounts, loadArchivedAccounts, loadAssetPriceHistories, loadAssetPriceHistory, loadBackup, loadDashboard, loadPushPublicKey, loadSyncEvents, loadTransactions, loadValueHistory, removeAllocationTarget, removePriceAlert, removePushSubscription, removeWatchlistAsset, restoreAccount, saveAllocationTarget, savePushSubscription, testPushDelivery, triggerManualSync } from './api'
import type { Account, AllocationTarget, Dashboard, Holding, Portfolio, PriceAlert, PriceHistoryPoint, PushNotificationPreferences, SyncEvent, SyncStatus, Transaction, ValueHistoryPoint, WatchlistAsset } from './api'
import { getCurrentPushSubscription, isPushSupported, subscribeToPush, unsubscribeFromPush } from './push'

type View = 'overview' | 'history' | 'sync' | 'transactions'
type Theme = 'light' | 'dark'
type Language = 'th' | 'en'
type HoldingSort = 'asset' | 'quantity' | 'value'
type TransactionFilter = 'all' | Transaction['category']
type PortfolioCardPreset = 'private' | 'value'
const overviewSectionIds = ['history', 'allocation', 'targets', 'rebalance', 'watchlist', 'syncHealth', 'holdings'] as const
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
const overviewSectionsStorageKey = 'moondi.overview-sections.v1'
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
const defaultOverviewSections: OverviewSections = { allocation: true, history: true, holdings: true, rebalance: true, syncHealth: true, targets: true, watchlist: true }

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
  } catch {
    // Use the privacy-preserving defaults when storage is absent or malformed.
  }
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

const PortfolioAllocation = ({ holdings, language, valuesVisible }: { holdings: Holding[]; language: Language; valuesVisible: boolean }) => {
  const slices = aggregatePortfolioAllocation(holdings)
  if (slices.length === 0) return null

  let offset = 0
  const label = language === 'th' ? 'สัดส่วนมูลค่าสินทรัพย์ปัจจุบันในพอร์ต' : 'Current portfolio value allocation'
  const money = currency(language)

  return (
    <section aria-labelledby="allocation-title" className="portfolio-allocation">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Allocation</p>
          <h2 id="allocation-title">{language === 'th' ? 'สัดส่วนสินทรัพย์' : 'Portfolio allocation'}</h2>
          <p className="allocation-note">{language === 'th' ? 'แบ่งตามมูลค่าประเมินปัจจุบัน ไม่ใช่กำไรหรือเงินลงทุน' : 'Based on current estimated value, not profit or invested capital.'}</p>
        </div>
      </div>
      <div className="allocation-content">
        <div className="allocation-donut">
          <svg aria-label={label} role="img" viewBox="0 0 120 120">
            <circle className="allocation-track" cx="60" cy="60" fill="none" pathLength="100" r="48" strokeWidth="14" />
            {slices.map((slice, index) => {
              const dash = Math.max(slice.share - 1.2, 0)
              const segment = (
                <circle
                  className="allocation-segment"
                  cx="60"
                  cy="60"
                  fill="none"
                  key={slice.asset}
                  pathLength="100"
                  r="48"
                  strokeDasharray={`${dash} ${100 - dash}`}
                  strokeDashoffset={-offset}
                  strokeWidth="14"
                  style={{ stroke: allocationColors[index % allocationColors.length] }}
                />
              )
              offset += slice.share
              return segment
            })}
          </svg>
          <span>{language === 'th' ? 'มูลค่าปัจจุบัน' : 'Current value'}</span>
        </div>
        <ul className="allocation-legend">
          {slices.map((slice, index) => (
            <li key={slice.asset}>
              <span aria-hidden="true" className="allocation-swatch" style={{ background: allocationColors[index % allocationColors.length] }} />
              <span className="allocation-asset"><strong>{slice.asset === 'Other' ? (language === 'th' ? 'อื่น ๆ' : 'Other') : slice.asset}</strong><small className={valuesVisible ? undefined : 'value-concealed'}>{money.format(slice.value)}</small></span>
              <span>{slice.share.toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
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
          <p className="eyebrow">Allocation targets</p>
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
            <div className="allocation-target-row" key={asset}>
              <strong>{asset}</strong>
              <span>{language === 'th' ? `ปัจจุบัน ${current.toFixed(1)}%` : `Current ${current.toFixed(1)}%`}</span>
              <label className="percent-input"><span className="sr-only">{language === 'th' ? `เป้าหมาย ${asset}` : `${asset} target`}</span><input autoComplete="off" inputMode="decimal" maxLength={6} onChange={(event) => { if (isDecimalDraft(event.target.value)) setDrafts((currentDrafts) => ({ ...currentDrafts, [asset]: event.target.value })) }} pattern="[0-9]*[.,]?[0-9]*" placeholder="0.0" type="text" value={draft} /><span aria-hidden="true">%</span></label>
              <button className="export-button" disabled={workingAsset === asset} onClick={() => void save(asset)} type="button">{target === undefined ? (language === 'th' ? 'ตั้งเป้า' : 'Set') : (language === 'th' ? 'บันทึก' : 'Save')}</button>
              {target !== undefined ? <button className="text-button" disabled={workingAsset === asset} onClick={() => void remove(asset)} type="button">{language === 'th' ? 'ลบ' : 'Remove'}</button> : null}
            </div>
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
          <p className="eyebrow">Rebalance check</p>
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

const TrackedPrices = ({ holdings, language, onAddAlert, onAddAsset, onRemoveAlert, onRemoveAsset, priceAlerts, watchlist }: {
  holdings: Holding[]
  language: Language
  onAddAlert: (asset: string, direction: 'above' | 'below', targetPrice: number) => Promise<void>
  onAddAsset: (asset: string) => Promise<{ asset: string; created: boolean }>
  onRemoveAlert: (id: string) => Promise<void>
  onRemoveAsset: (asset: string) => Promise<void>
  priceAlerts: PriceAlert[]
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
          <p className="eyebrow">Watchlist</p>
          <h2 id="tracked-prices-title">{language === 'th' ? 'ติดตามราคาและตั้งแจ้งเตือน' : 'Watch prices and set alerts'}</h2>
          <p className="allocation-note">{language === 'th' ? 'แจ้งเตือนเมื่อราคา THB แตะเป้าหมายระหว่างการ sync และต้องเปิด Push ประเภท “ราคาแตะเป้าหมาย” ในการตั้งค่า' : 'Alerts are checked during sync. Enable “Price alerts” in notification settings to receive them.'}</p>
        </div>
      </div>
      {availableAssets.length > 0 ? <div className="tracked-price-controls">
        <label><span>{language === 'th' ? 'สินทรัพย์' : 'Asset'}</span><select className="form-select" onChange={(event) => { setAsset(event.target.value); setMessage(null) }} value={asset}>{availableAssets.map((availableAsset) => <option key={availableAsset} value={availableAsset}>{availableAsset}</option>)}</select></label>
        <button className="export-button" disabled={isWorking || watchlist.some((item) => item.asset === asset)} onClick={() => void addWatch()} type="button">{watchlist.some((item) => item.asset === asset) ? (language === 'th' ? 'กำลังติดตามอยู่' : 'Watching') : (language === 'th' ? 'เพิ่มในรายการติดตาม' : 'Add to watchlist')}</button>
        <div className="alert-composer">
          <select aria-label={language === 'th' ? 'เงื่อนไขราคา' : 'Price condition'} className="form-select" onChange={(event) => setDirection(event.target.value as 'above' | 'below')} value={direction}><option value="above">{language === 'th' ? 'ราคา ≥' : 'Price ≥'}</option><option value="below">{language === 'th' ? 'ราคา ≤' : 'Price ≤'}</option></select>
          <label className="currency-input"><span className="sr-only">{language === 'th' ? 'ราคาเป้าหมาย THB' : 'Target THB price'}</span><input autoComplete="off" inputMode="decimal" onChange={(event) => { if (isDecimalDraft(event.target.value)) setTargetPrice(event.target.value) }} pattern="[0-9]*[.,]?[0-9]*" placeholder={language === 'th' ? 'ราคาเป้าหมาย' : 'Target price'} type="text" value={targetPrice} /><span aria-hidden="true">THB</span></label>
          <button className="export-button" disabled={isWorking} onClick={() => void addAlert()} type="button">{language === 'th' ? 'สร้างแจ้งเตือน' : 'Create alert'}</button>
        </div>
      </div> : null}
      {watchlist.length > 0 ? <div className="watchlist-grid">{watchlist.map((item) => <article className="watchlist-item" key={item.asset}><strong>{item.asset}</strong><span>{item.price === null ? (language === 'th' ? 'ยังไม่มีราคา' : 'No price yet') : currency(language).format(item.price)}</span><button className="text-button" disabled={isWorking} onClick={() => void removeWatch(item.asset)} type="button">{language === 'th' ? 'เอาออก' : 'Remove'}</button></article>)}</div> : null}
      {priceAlerts.length > 0 ? <ul className="price-alert-list">{priceAlerts.map((alert) => <li key={alert.id}><span><strong>{alert.asset}</strong> · {alert.direction === 'above' ? (language === 'th' ? '≥' : '≥') : '≤'} {currency(language).format(alert.target_price)} {alert.active === 1 ? '' : `· ${language === 'th' ? 'ปิดอยู่' : 'Off'}`}</span><button className="text-button" disabled={isWorking} onClick={() => void removeAlert(alert.id)} type="button">{language === 'th' ? 'ลบ' : 'Remove'}</button></li>)}</ul> : null}
      {message ? <p className="inline-status" role="status">{message}</p> : null}
    </section>
  )
}

const createPortfolioCardImage = ({ createdAt, holdings, language, preset, totalValue }: {
  createdAt: Date
  holdings: Holding[]
  language: Language
  preset: PortfolioCardPreset
  totalValue: number
}): Promise<Blob> => {
  const canvas = document.createElement('canvas')
  canvas.height = 630
  canvas.width = 1200
  const context = canvas.getContext('2d')

  if (!context) return Promise.reject(new Error('Canvas is unavailable.'))

  const assets = aggregateCardAssets(holdings)
  const isThai = language === 'th'
  const label = isThai ? 'สรุปพอร์ตส่วนตัว' : 'Private portfolio snapshot'
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

const PortfolioCardDialog = ({ holdings, language, onClose, open, totalValue }: {
  holdings: Holding[]
  language: Language
  onClose: () => void
  open: boolean
  totalValue: number
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [preset, setPreset] = useState<PortfolioCardPreset>('private')
  const [status, setStatus] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setPreset('private')
      setStatus(null)
      dialog.showModal()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  const run = async (action: (image: Blob, createdAt: Date) => Promise<void> | void) => {
    setIsWorking(true)
    setStatus(null)
    const createdAt = new Date()

    try {
      const image = await createPortfolioCardImage({ createdAt, holdings, language, preset, totalValue })
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
    const image = createPortfolioCardImage({ createdAt: new Date(), holdings, language, preset, totalValue })

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
    <dialog aria-labelledby="portfolio-card-title" className="portfolio-card-dialog" onCancel={(event) => { event.preventDefault(); dialogRef.current?.close() }} onClose={onClose} ref={dialogRef}>
      <div className="portfolio-card-drawer">
        <div className="portfolio-card-drawer-handle" aria-hidden="true" />
        <div className="portfolio-card-dialog-heading">
          <div>
            <p className="eyebrow">Portfolio card</p>
            <h2 id="portfolio-card-title">{language === 'th' ? 'สร้างรูปสรุปพอร์ต' : 'Create portfolio image'}</h2>
            <p>{language === 'th' ? 'รูปถูกสร้างในเบราว์เซอร์นี้เท่านั้น และไม่มีลิงก์สาธารณะ' : 'The image is created only in this browser. No public link is made.'}</p>
          </div>
          <button aria-label={language === 'th' ? 'ปิด' : 'Close'} className="portfolio-card-close" onClick={() => dialogRef.current?.close()} type="button">×</button>
        </div>
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
        </fieldset>
        <p className="portfolio-card-note">{language === 'th' ? 'การ์ดนี้ไม่แสดงชื่อบัญชี รายการธุรกรรม หรือ P&L' : 'This card excludes account names, transaction data, and P&L.'}</p>
        <div className="portfolio-card-actions">
          <button className="portfolio-card-primary" disabled={isWorking} onClick={copyImage} type="button">{language === 'th' ? 'คัดลอกรูป' : 'Copy image'}</button>
          <button className="export-button" disabled={isWorking} onClick={download} type="button">{language === 'th' ? 'บันทึกรูป' : 'Download'}</button>
          <button className="export-button" disabled={isWorking} onClick={shareImage} type="button">{language === 'th' ? 'แชร์รูป' : 'Share image'}</button>
        </div>
        <p aria-live="polite" className="portfolio-card-status">{status}</p>
      </div>
    </dialog>
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
  const change = latest - values[0]!
  const percentage = values[0] === 0 ? null : (change / values[0]!) * 100
  const trend = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral'
  const line = coordinates.map(({ x, y }) => `${x},${y}`).join(' ')
  const area = `${line} 100,100 0,100`

  return (
    <div aria-label={language === 'th' ? `กราฟราคา ${asset} ใน 24 ชั่วโมง เปลี่ยนแปลง ${percentage?.toFixed(2) ?? '0'} เปอร์เซ็นต์` : `${asset} price over 24 hours, changed ${percentage?.toFixed(2) ?? '0'} percent`} className={`holding-sparkline ${trend}${valuesVisible ? '' : ' value-concealed'}`} role="img">
      <span>{language === 'th' ? 'กราฟ 24 ชม.' : '24h trend'} {percentage === null ? '' : `${percentage >= 0 ? '+' : ''}${percentage.toFixed(2)}%`}</span>
      <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
        <polygon className="holding-sparkline-area" points={area} />
        <polyline className="holding-sparkline-line" fill="none" points={line} vectorEffect="non-scaling-stroke" />
      </svg>
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
          <p className="eyebrow">Holdings</p>
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
          <input onChange={(event) => setQuery(event.target.value)} placeholder={language === 'th' ? 'ค้นหาสินทรัพย์' : 'Search assets'} type="search" value={query} />
        </label>
        <label className="sort-control">
          <span>{language === 'th' ? 'เรียงตาม' : 'Sort by'}</span>
          <select onChange={(event) => setSort(event.target.value as HoldingSort)} value={sort}>
            <option value="value">{language === 'th' ? 'มูลค่า' : 'Value'}</option>
            <option value="quantity">{language === 'th' ? 'จำนวน' : 'Quantity'}</option>
            <option value="asset">{language === 'th' ? 'ชื่อสินทรัพย์' : 'Asset'}</option>
          </select>
        </label>
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
                <p className="asset">{holding.asset}</p>
                <p className="account">{holding.account_label}</p>
              </div>
              <div className="holding-quantity">
                <p className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(holdingAmount(holding))}</p>
                <span className={valuesVisible ? undefined : 'value-concealed'}>{money.format(valueOf(holding.available, holding.reserved, holding.price))}</span>
              </div>
              <HoldingSparkline asset={holding.asset} language={language} points={priceHistories[holding.asset] ?? []} valuesVisible={valuesVisible} />
            </button>
          ))}
        </div>
      ) : (
        <p className="no-results">{language === 'th' ? 'ไม่พบสินทรัพย์ที่ตรงกับตัวกรอง' : 'No assets match the current filters.'}</p>
      )}
    </section>
  )
}

const AssetDetail = ({ asset, holdings, language, onClose, portfolioValue, transactions, valuesVisible }: { asset: string; holdings: Holding[]; language: Language; onClose: () => void; portfolioValue: number; transactions: Transaction[]; valuesVisible: boolean }) => {
  const assetHoldings = holdings.filter((holding) => holding.asset === asset)
  const assetTransactions = transactions.filter((transaction) => transaction.asset === asset)
  const totalAmount = assetHoldings.reduce((total, holding) => total + holdingAmount(holding), 0)
  const totalValue = assetHoldings.reduce((total, holding) => total + valueOf(holding.available, holding.reserved, holding.price), 0)
  const currentPrice = totalAmount > 0 ? totalValue / totalAmount : 0
  const allocation = portfolioValue > 0 ? (totalValue / portfolioValue) * 100 : 0
  const money = currency(language)
  const dates = dateTime(language)

  return (
    <section className="asset-detail" aria-label={`${language === 'th' ? 'รายละเอียด' : 'Details'} ${asset}`}>
      <button className="back-link" onClick={onClose} type="button">← {language === 'th' ? 'กลับไปภาพรวม' : 'Back to overview'}</button>
      <div className="asset-detail-heading">
        <div>
          <p className="eyebrow">Asset detail</p>
          <h1>{asset}</h1>
        </div>
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
      <AssetPriceTrend asset={asset} language={language} valuesVisible={valuesVisible} />
      <div className="asset-detail-section">
        <p className="eyebrow">Balances</p>
        {assetHoldings.map((holding) => (
          <div className="asset-account" key={holding.account_id}>
            <span>{holding.account_label}</span>
            <strong className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(holdingAmount(holding))}</strong>
          </div>
        ))}
      </div>
      <div className="asset-detail-section">
        <p className="eyebrow">Recent activity</p>
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

const ValueHistoryChart = ({ chartLabel, language, points, valuesVisible }: { chartLabel?: string; language: Language; points: ValueHistoryPoint[]; valuesVisible: boolean }) => {
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(points.length - 1, 0))

  useEffect(() => {
    setSelectedIndex(Math.max(points.length - 1, 0))
  }, [points])

  if (points.length < 2) return null

  const { coordinates } = historyStats(points)
  const selected = points[clamp(selectedIndex, 0, points.length - 1)]!
  const selectedCoordinate = coordinates[clamp(selectedIndex, 0, coordinates.length - 1)]!
  const money = currency(language)
  const dates = dateTime(language)
  const line = coordinates.map(({ x, y }) => `${x},${y}`).join(' ')
  const area = `M ${coordinates[0]!.x} 100 L ${coordinates.map(({ x, y }) => `${x} ${y}`).join(' L ')} L ${coordinates.at(-1)!.x} 100 Z`

  const selectPoint = (clientX: number, target: SVGSVGElement) => {
    const bounds = target.getBoundingClientRect()
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1)
    setSelectedIndex(Math.round(ratio * (points.length - 1)))
  }

  return (
    <div className={`history-visual${valuesVisible ? '' : ' value-concealed'}`}>
      <svg
        aria-label={chartLabel ?? (language === 'th' ? 'กราฟมูลค่าพอร์ตย้อนหลัง เลื่อนหรือแตะเพื่อดูข้อมูลแต่ละจุด' : 'Portfolio value history. Hover or tap to inspect each point.')}
        className="history-chart"
        onPointerDown={(event) => selectPoint(event.clientX, event.currentTarget)}
        onPointerMove={(event) => selectPoint(event.clientX, event.currentTarget)}
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 100 100"
      >
        <defs>
          <linearGradient id="portfolio-history-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="history-grid-line" x1="0" x2="100" y1="8" y2="8" />
        <line className="history-grid-line" x1="0" x2="100" y1="50" y2="50" />
        <line className="history-grid-line" x1="0" x2="100" y1="92" y2="92" />
        <path className="history-area" d={area} />
        <polyline className="history-line" fill="none" points={line} vectorEffect="non-scaling-stroke" />
        <line className="history-selected-line" x1={selectedCoordinate.x} x2={selectedCoordinate.x} y1="8" y2="92" vectorEffect="non-scaling-stroke" />
      </svg>
      <div aria-live="polite" className="history-tooltip">
        <strong>{money.format(selected.total_value)}</strong>
        <span>{dates.format(selected.snapshot_at)}</span>
      </div>
    </div>
  )
}

const AssetPriceTrend = ({ asset, language, valuesVisible }: { asset: string; language: Language; valuesVisible: boolean }) => {
  const [range, setRange] = useState<PriceHistoryRange>('7d')
  const [points, setPoints] = useState<PriceHistoryPoint[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setError(null)

    void loadAssetPriceHistory(asset, priceHistoryRequest(range))
      .then((nextPoints) => {
        if (active) setPoints(nextPoints)
      })
      .catch(() => {
        if (active) setError(language === 'th' ? 'โหลดข้อมูลราคาไม่สำเร็จ' : 'Unable to load price data.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [asset, language, range])

  const valuePoints = points.map((point) => ({ snapshot_at: point.snapshot_at, total_value: point.price }))
  const stats = valuePoints.length > 0 ? historyStats(valuePoints) : null
  const first = valuePoints[0]
  const latest = valuePoints.at(-1)
  const change = first && latest ? latest.total_value - first.total_value : null
  const percentage = change !== null && first && first.total_value !== 0 ? (change / first.total_value) * 100 : null
  const selectedRange = priceHistoryRanges.find((option) => option.id === range)!
  const requestedFrom = priceHistoryStart(range)
  const historyIsShorterThanRange = first !== undefined && requestedFrom !== undefined && first.snapshot_at > requestedFrom + 60 * 60 * 1_000

  return (
    <section className="asset-price-trend" aria-label={language === 'th' ? `แนวโน้มราคา ${asset}` : `${asset} price trend`}>
      <div className="asset-price-heading">
        <div>
          <p className="eyebrow">Price trend</p>
          <h2>{asset} / THB</h2>
          <p>{language === 'th' ? 'ราคา ณ เวลา snapshot ที่บันทึกไว้ ไม่ใช่กำไรหรือขาดทุนของคุณ' : 'Recorded snapshot prices, not your profit or loss.'}</p>
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
          <ValueHistoryChart chartLabel={language === 'th' ? `กราฟราคา ${asset} เทียบเงินบาท เลื่อนหรือแตะเพื่อดูข้อมูลแต่ละจุด` : `${asset} price in Thai baht. Hover or tap to inspect each point.`} language={language} points={valuePoints} valuesVisible={valuesVisible} />
          <div className="history-range">
            <span>{dateTime(language).format(first.snapshot_at)}</span>
            <span>{selectedRange ? `${priceRangeLabel(selectedRange.id, language)} · ${valuePoints.length} ${language === 'th' ? 'จุดข้อมูล' : 'points'}` : null}</span>
            <span>{dateTime(language).format(latest.snapshot_at)}</span>
          </div>
          {historyIsShorterThanRange ? <p className="asset-price-availability">{language === 'th' ? `มีข้อมูลราคาตั้งแต่ ${dateTime(language).format(first.snapshot_at)} เท่านั้น` : `Price history is available from ${dateTime(language).format(first.snapshot_at)} only.`}</p> : null}
        </>
      ) : !isLoading ? <p className="history-empty">{language === 'th' ? `ยังมีข้อมูลราคา ${asset} ไม่พอสำหรับแสดงกราฟในช่วงเวลานี้` : `There are not enough ${asset} price snapshots for this range.`}</p> : null}
      {isLoading ? <p className="history-loading">{language === 'th' ? 'กำลังโหลดข้อมูลราคา' : 'Loading price data'}</p> : null}
      {error ? <p className="history-error">{error}</p> : null}
    </section>
  )
}

const PortfolioHistory = ({ language, onOpenHistory, points, valuesVisible }: { language: Language; onOpenHistory: () => void; points: ValueHistoryPoint[]; valuesVisible: boolean }) => {
  if (points.length < 2) {
    return (
      <section className="portfolio-history">
        <p className="eyebrow">Snapshot history</p>
        <h2>{language === 'th' ? 'แนวโน้มมูลค่าพอร์ต' : 'Portfolio value trend'}</h2>
        <p className="history-empty">{language === 'th' ? 'กำลังสะสมข้อมูลราคา ณ เวลา snapshot เพื่อสร้างกราฟที่ถูกต้อง' : 'Collecting price snapshots to build an accurate chart.'}</p>
      </section>
    )
  }

  const { maximum, minimum, values } = historyStats(points)
  const change = values.at(-1)! - values[0]!
  const money = currency(language)
  const dates = dateTime(language)

  return (
    <section className="portfolio-history">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Snapshot history</p>
          <h2>{language === 'th' ? 'แนวโน้มมูลค่าพอร์ต' : 'Portfolio value trend'}</h2>
        </div>
        <div className="history-heading-actions">
          <span aria-label={language === 'th' ? 'การเปลี่ยนแปลงมูลค่าพอร์ตในช่วงกราฟ ไม่ใช่เงินต้นหรือกำไร' : 'Portfolio value change for this chart range, not principal or profit'} className={`${change >= 0 ? 'change-positive' : 'change-negative'}${valuesVisible ? '' : ' value-concealed'}`} title={language === 'th' ? 'มูลค่าพอร์ตล่าสุดลบมูลค่าจุดแรกของช่วงกราฟ ไม่ใช่เงินต้นหรือกำไร' : 'Latest portfolio value minus the first value in this range. This is not principal or profit.'}>{change >= 0 ? '+' : ''}{money.format(change)}</span>
          <button className="chart-link" onClick={onOpenHistory} type="button">{language === 'th' ? 'ดูกราฟเต็ม' : 'Open full chart'}</button>
        </div>
      </div>
      <ValueHistoryChart language={language} points={points} valuesVisible={valuesVisible} />
      <div className="history-range">
        <span>{dates.format(points[0]!.snapshot_at)}</span>
        <span>{dates.format(points.at(-1)!.snapshot_at)}</span>
      </div>
      <div className={`history-extremes${valuesVisible ? '' : ' value-concealed'}`}>
        <span>{language === 'th' ? 'ต่ำสุด' : 'Low'} {money.format(minimum)}</span>
        <span>{language === 'th' ? 'สูงสุด' : 'High'} {money.format(maximum)}</span>
      </div>
    </section>
  )
}

const HistoryView = ({ accountId, initialPoints, language, onBack, valuesVisible }: { accountId?: string | undefined; initialPoints: ValueHistoryPoint[]; language: Language; onBack: () => void; valuesVisible: boolean }) => {
  const [range, setRange] = useState<HistoryRange>(30)
  const [points, setPoints] = useState(initialPoints)
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

    void loadValueHistory({ ...(range === 'custom' ? customBounds! : { days: range }), accountId })
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
  }, [accountId, customBounds, initialPoints, language, range])

  const stats = points.length > 0 ? historyStats(points) : null
  const first = points[0]
  const latest = points.at(-1)
  const change = first && latest ? latest.total_value - first.total_value : null
  const percentage = change !== null && first && first.total_value !== 0 ? (change / first.total_value) * 100 : null

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
          <p className="eyebrow">Portfolio history</p>
          <h1>{language === 'th' ? 'กราฟมูลค่าพอร์ต' : 'Portfolio value chart'}</h1>
          <p>{language === 'th' ? 'มูลค่ารวมของสินทรัพย์ ณ เวลา balance snapshot ไม่ใช่กำไรหรือขาดทุน' : 'Total asset value at each balance snapshot, not profit or loss.'}</p>
        </div>
        <div className="history-page-actions">
          <button className="back-link history-back" onClick={onBack} type="button">← {language === 'th' ? 'กลับไปภาพรวม' : 'Back to overview'}</button>
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

      {range === 'custom' ? (
        <form className="custom-range" onSubmit={(event) => { event.preventDefault(); applyCustomRange() }}>
          <label>{language === 'th' ? 'เริ่มต้น' : 'Start'}<input max={customEnd} onChange={(event) => setCustomStart(event.target.value)} type="date" value={customStart} /></label>
          <label>{language === 'th' ? 'สิ้นสุด' : 'End'}<input min={customStart} onChange={(event) => setCustomEnd(event.target.value)} type="date" value={customEnd} /></label>
          <button className="export-button" type="submit">{language === 'th' ? 'แสดงกราฟ' : 'Show chart'}</button>
        </form>
      ) : null}

      {stats && latest && first ? (
        <>
          <div className={`history-metrics${valuesVisible ? '' : ' value-concealed'}`}>
            <div><span>{language === 'th' ? 'ล่าสุด' : 'Latest'}</span><strong>{currency(language).format(latest.total_value)}</strong></div>
            <div><span>{language === 'th' ? 'การเปลี่ยนแปลงมูลค่า' : 'Value change'}</span><strong className={change !== null && change >= 0 ? 'change-positive' : 'change-negative'} title={language === 'th' ? 'มูลค่าพอร์ตล่าสุดลบมูลค่าจุดแรกของช่วงกราฟ ไม่ใช่เงินต้นหรือกำไร' : 'Latest portfolio value minus the first value in this range. This is not principal or profit.'}>{change !== null && change >= 0 ? '+' : ''}{currency(language).format(change ?? 0)}</strong></div>
            <div><span>{language === 'th' ? 'สูงสุด' : 'High'}</span><strong>{currency(language).format(stats.maximum)}</strong></div>
            <div><span>{language === 'th' ? 'ต่ำสุด' : 'Low'}</span><strong>{currency(language).format(stats.minimum)}</strong></div>
          </div>
          <div className="history-detail-chart">
            <ValueHistoryChart language={language} points={points} valuesVisible={valuesVisible} />
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

const SettingsDialog = ({ accounts, archivedAccounts, language, onArchiveAccount, onClose, onRestoreAccount, open, overviewSections, setLanguage, setOverviewSection, setTheme, setValuesVisible, theme, valuesVisible }: {
  accounts: Account[]
  archivedAccounts: Account[]
  language: Language
  onArchiveAccount: (account: Account) => Promise<void>
  onClose: () => void
  onRestoreAccount: (account: Account) => Promise<void>
  open: boolean
  overviewSections: OverviewSections
  setLanguage: (language: Language) => void
  setOverviewSection: (section: OverviewSection, visible: boolean) => void
  setTheme: (theme: Theme) => void
  setValuesVisible: (valuesVisible: boolean) => void
  theme: Theme
  valuesVisible: boolean
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const confirmationRef = useRef<HTMLDialogElement>(null)
  const [accountMessage, setAccountMessage] = useState<string | null>(null)
  const [archivingAccountId, setArchivingAccountId] = useState<string | null>(null)
  const [pendingArchive, setPendingArchive] = useState<Account | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = confirmationRef.current
    if (!dialog) return
    if (pendingArchive && !dialog.open) dialog.showModal()
    if (!pendingArchive && dialog.open) dialog.close()
  }, [pendingArchive])

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
    <dialog aria-labelledby="settings-title" className="settings-dialog" onCancel={(event) => { event.preventDefault(); dialogRef.current?.close() }} onClose={onClose} ref={dialogRef}>
      <div className="settings-drawer">
        <div className="settings-drawer-handle" aria-hidden="true" />
        <div className="settings-heading">
          <div><p className="eyebrow">Settings</p><h2 id="settings-title">{language === 'th' ? 'การตั้งค่า' : 'Settings'}</h2></div>
          <button aria-label={language === 'th' ? 'ปิด' : 'Close'} className="portfolio-card-close" onClick={() => dialogRef.current?.close()} type="button">×</button>
        </div>
        <div className="settings-content">
          <section className="settings-section">
            <p>{language === 'th' ? 'ภาษา' : 'Language'}</p>
            <div className="settings-options">
              <button aria-pressed={language === 'th'} className={language === 'th' ? 'active' : undefined} onClick={() => setLanguage('th')} type="button">ไทย</button>
              <button aria-pressed={language === 'en'} className={language === 'en' ? 'active' : undefined} onClick={() => setLanguage('en')} type="button">English</button>
            </div>
          </section>
          <section className="settings-section">
            <p>{language === 'th' ? 'ธีม' : 'Theme'}</p>
            <div className="settings-options">
              <button aria-pressed={theme === 'dark'} className={theme === 'dark' ? 'active' : undefined} onClick={() => setTheme('dark')} type="button">{language === 'th' ? 'มืด' : 'Dark'}</button>
              <button aria-pressed={theme === 'light'} className={theme === 'light' ? 'active' : undefined} onClick={() => setTheme('light')} type="button">{language === 'th' ? 'สว่าง' : 'Light'}</button>
            </div>
          </section>
          <section className="settings-section settings-privacy">
            <div><p>{language === 'th' ? 'ความเป็นส่วนตัว' : 'Privacy'}</p><span>{language === 'th' ? 'ซ่อนมูลค่าและจำนวนบนหน้าจอ' : 'Hide values and quantities on screen.'}</span></div>
            <button aria-pressed={!valuesVisible} className={valuesVisible ? undefined : 'active'} onClick={() => setValuesVisible(!valuesVisible)} type="button">{valuesVisible ? (language === 'th' ? 'ซ่อนมูลค่า' : 'Hide values') : (language === 'th' ? 'แสดงมูลค่า' : 'Show values')}</button>
          </section>
          <section className="settings-section overview-section-settings">
            <p>{language === 'th' ? 'ส่วนที่แสดงในภาพรวม' : 'Overview sections'}</p>
            <span>{language === 'th' ? 'ซ่อนหรือแสดงส่วนต่าง ๆ ของหน้า Overview เฉพาะในเบราว์เซอร์นี้' : 'Show or hide Overview sections on this browser only.'}</span>
            <div className="overview-section-options">
              {([
                ['history', language === 'th' ? 'แนวโน้มมูลค่าพอร์ต' : 'Portfolio value trend'],
                ['allocation', language === 'th' ? 'สัดส่วนสินทรัพย์' : 'Portfolio allocation'],
                ['targets', language === 'th' ? 'เป้าหมายสัดส่วนพอร์ต' : 'Allocation targets'],
                ['rebalance', language === 'th' ? 'เทียบสัดส่วนกับเป้าหมาย' : 'Compare with targets'],
                ['watchlist', language === 'th' ? 'ติดตามราคาและแจ้งเตือน' : 'Watchlist and price alerts'],
                ['syncHealth', language === 'th' ? 'สถานะการเชื่อมต่อ' : 'Connection status'],
                ['holdings', language === 'th' ? 'สินทรัพย์ในพอร์ต' : 'Portfolio holdings'],
              ] as Array<[OverviewSection, string]>).map(([section, label]) => (
                <label key={section}><input checked={overviewSections[section]} onChange={(event) => setOverviewSection(section, event.target.checked)} type="checkbox" /><span>{label}</span></label>
              ))}
            </div>
          </section>
          <section className="settings-section account-settings">
            <p>{language === 'th' ? 'บัญชีที่เชื่อมต่อ' : 'Connected accounts'}</p>
            <span>{language === 'th' ? 'ตัดการเชื่อมต่อเพื่อหยุด sync และซ่อนจากพอร์ต ประวัติข้อมูลและ secret จะไม่ถูกลบ และเชื่อมต่อบัญชีเดิมกลับได้จากด้านล่าง' : 'Disconnecting stops sync and hides an account. This page does not delete history or credentials, and you can reconnect the same account below.'}</span>
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
        </div>
      </div>
      <dialog aria-describedby="disconnect-account-description" aria-labelledby="disconnect-account-title" className="account-confirm-dialog" onCancel={(event) => { event.preventDefault(); event.stopPropagation(); setPendingArchive(null) }} onClose={(event) => { event.stopPropagation(); setPendingArchive(null) }} ref={confirmationRef}>
        {pendingArchive ? <div className="account-confirm-content">
          <p className="eyebrow">{language === 'th' ? 'ยืนยันการตัดการเชื่อมต่อ' : 'Confirm disconnect'}</p>
          <h3 id="disconnect-account-title">{language === 'th' ? `ตัดการเชื่อมต่อ ${pendingArchive.label}?` : `Disconnect ${pendingArchive.label}?`}</h3>
          <p id="disconnect-account-description">{language === 'th'
            ? (accounts.length === 1 ? 'นี่คือบัญชีเดียวที่เชื่อมต่ออยู่ หน้า Portfolio จะว่างจนกว่าจะเชื่อมต่อบัญชีนี้กลับอีกครั้ง' : 'ระบบจะหยุด sync และซ่อนบัญชีนี้จากหน้า Portfolio')
            : (accounts.length === 1 ? 'This is your only connected account. Your portfolio will be empty until you reconnect it.' : 'Sync will stop and this account will be hidden from the portfolio.')}</p>
          <ul>
            <li>{language === 'th' ? 'ประวัติและ snapshot ที่บันทึกไว้จะไม่ถูกลบ' : 'Recorded history and snapshots will not be deleted.'}</li>
            <li>{language === 'th' ? 'API key ไม่ถูกเปิดเผย แก้ไข หรือลบจากหน้านี้' : 'This page does not expose, edit, or delete the API key.'}</li>
            <li>{language === 'th' ? 'เชื่อมต่อบัญชีเดิมกลับได้จาก Settings' : 'You can reconnect the same account from Settings.'}</li>
          </ul>
          <div className="account-confirm-actions">
            <button disabled={archivingAccountId !== null} onClick={() => setPendingArchive(null)} type="button">{language === 'th' ? 'ยกเลิก' : 'Cancel'}</button>
            <button className="account-disconnect-button" disabled={archivingAccountId !== null} onClick={() => void archive(pendingArchive)} type="button">{archivingAccountId === pendingArchive.id ? (language === 'th' ? 'กำลังตัดการเชื่อมต่อ…' : 'Disconnecting…') : (language === 'th' ? 'ตัดการเชื่อมต่อ' : 'Disconnect')}</button>
          </div>
        </div> : null}
      </dialog>
    </dialog>
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
          <p className="eyebrow">Sync health</p>
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
      <button className="back-link" onClick={onBack} type="button">← {language === 'th' ? 'กลับไปภาพรวม' : 'Back to overview'}</button>
      <div className="sync-activity-heading">
        <div>
          <p className="eyebrow">Sync activity</p>
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
      ['Executed at', 'Type', 'Direction', 'Asset', 'Amount', 'Quote asset', 'Price', 'Fee', 'Account ID'],
      filteredTransactions.map((transaction) => [
        new Date(transaction.executed_at).toISOString(),
        transaction.category,
        transaction.direction,
        transaction.asset,
        transaction.amount,
        transaction.quote_asset,
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
          <p className="eyebrow">Ledger</p>
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
          <input onChange={(event) => setQuery(event.target.value)} placeholder={language === 'th' ? 'ค้นหาสินทรัพย์' : 'Search assets'} type="search" value={query} />
        </label>
        <label className="sort-control">
          <span>{language === 'th' ? 'ประเภท' : 'Type'}</span>
          <select onChange={(event) => setFilter(event.target.value as TransactionFilter)} value={filter}>
            <option value="all">{language === 'th' ? 'ทั้งหมด' : 'All'}</option>
            <option value="trade">{language === 'th' ? 'ซื้อ / ขาย' : 'Buy / sell'}</option>
            <option value="crypto_transfer">{language === 'th' ? 'โอนคริปโต' : 'Crypto transfers'}</option>
            <option value="fiat_transfer">{language === 'th' ? 'ฝาก / ถอนเงินบาท' : 'THB deposits / withdrawals'}</option>
          </select>
        </label>
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
            </div>
            {filteredTransactions.map((transaction) => (
              <div className="transaction-row" key={`${transaction.category}-${transaction.id}`} role="row">
                <span>{dateTime(language).format(transaction.executed_at)}</span>
                <span className="transaction-kind">{transactionLabel(transaction, language)}</span>
                <span>{transaction.asset}</span>
                <span className={valuesVisible ? undefined : 'value-concealed'}>{quantity.format(transaction.amount)}</span>
              </div>
            ))}
          </div>
          <div className="mobile-ledger">
            {filteredTransactions.map((transaction) => (
              <article className="mobile-transaction" key={`${transaction.category}-${transaction.id}`}>
                <div className="mobile-transaction-meta">
                  <time>{dateTime(language).format(transaction.executed_at)}</time>
                  <span className="transaction-kind">{transactionLabel(transaction, language)}</span>
                </div>
                <div className="mobile-transaction-main">
                  <strong>{transaction.asset}</strong>
                  <span className={valuesVisible ? undefined : 'value-concealed'}><small>{language === 'th' ? 'จำนวน' : 'Amount'}</small>{quantity.format(transaction.amount)}</span>
                </div>
              </article>
            ))}
          </div>
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
  const [view, setView] = useState<View>('overview')
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(resolveTheme)
  const [language, setLanguage] = useState<Language>(resolveLanguage)
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [nextTransactionCursor, setNextTransactionCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<ValueHistoryPoint[]>([])
  const [priceHistories, setPriceHistories] = useState<Record<string, PriceHistoryPoint[]>>({})
  const [syncStatus, setSyncStatus] = useState<SyncStatus[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [archivedAccounts, setArchivedAccounts] = useState<Account[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>()
  const [watchlist, setWatchlist] = useState<WatchlistAsset[]>([])
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([])
  const [allocationTargets, setAllocationTargets] = useState<AllocationTarget[]>([])
  const [manualSyncMessage, setManualSyncMessage] = useState<string | null>(null)
  const [isManualSyncWorking, setIsManualSyncWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [valuesVisible, setValuesVisible] = useState(resolveValuesVisible)
  const [overviewSections, setOverviewSections] = useState(resolveOverviewSections)
  const [isPortfolioCardOpen, setIsPortfolioCardOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(() => !accessDenied && !signedOut)
  const [isPullRefreshing, setIsPullRefreshing] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const pullStartY = useRef<number | null>(null)
  const pullDistanceRef = useRef(0)
  const dashboardRequestId = useRef(0)
  const needsApiAccess = error === apiAccessRequired

  const loadDashboardScope = useCallback(async (accountId?: string) => {
    const requestId = dashboardRequestId.current + 1
    dashboardRequestId.current = requestId
    let dashboard: Dashboard
    try {
      dashboard = await loadDashboard(accountId)
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
    setError(null)
    return true
  }, [])

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
    localStorage.setItem(valuesVisibleStorageKey, valuesVisible ? 'visible' : 'hidden')
  }, [valuesVisible])

  useEffect(() => {
    localStorage.setItem(overviewSectionsStorageKey, JSON.stringify(overviewSections))
  }, [overviewSections])

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

  const requestManualSync = async () => {
    setIsManualSyncWorking(true)
    setManualSyncMessage(null)
    try {
      const { retryAt } = await triggerManualSync()
      setManualSyncMessage(language === 'th' ? `เริ่ม sync แล้ว ข้อมูลจะอัปเดตหลังงานเสร็จ · กดได้อีก ${dateTime(language).format(retryAt)}` : `Sync started. Data updates when it finishes · available again ${dateTime(language).format(retryAt)}.`)
      window.setTimeout(() => void reloadDashboard().catch(() => undefined), 12_000)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : ''
      if (message === 'Manual sync is temporarily rate limited') setManualSyncMessage(language === 'th' ? 'เพิ่งเริ่ม sync ไปแล้ว กรุณารอสักครู่' : 'A manual sync was recently started. Please wait a little.')
      else if (message === 'A sync is already running') setManualSyncMessage(language === 'th' ? 'มีงาน sync กำลังทำงานอยู่แล้ว' : 'A sync is already running.')
      else setManualSyncMessage(language === 'th' ? 'เริ่ม sync ไม่สำเร็จ ลองใหม่ภายหลัง' : 'Unable to start sync. Try again later.')
    } finally {
      setIsManualSyncWorking(false)
    }
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
    setSelectedAsset(null)
    setSelectedAccountId(undefined)
    setAccounts((current) => current.filter((item) => item.id !== account.id))
    setArchivedAccounts((current) => [account, ...current.filter((item) => item.id !== account.id)])
    await loadDashboardScope(undefined)
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
    try {
      await reloadDashboard()
    } finally {
      setIsPullRefreshing(false)
    }
  }

  const beginPullRefresh = (event: TouchEvent<HTMLElement>) => {
    if (event.touches.length !== 1 || window.scrollY > 0 || isPullRefreshing || isSettingsOpen) return
    pullStartY.current = event.touches[0]?.clientY ?? null
  }

  const trackPullRefresh = (event: TouchEvent<HTMLElement>) => {
    if (pullStartY.current === null || event.touches.length !== 1) return
    const distance = Math.max(0, Math.min((event.touches[0]?.clientY ?? pullStartY.current) - pullStartY.current, 96))
    pullDistanceRef.current = distance
    setPullDistance(distance)
  }

  const finishPullRefresh = () => {
    const shouldRefresh = pullDistanceRef.current >= 72
    pullStartY.current = null
    pullDistanceRef.current = 0
    setPullDistance(0)
    if (shouldRefresh) void refreshFromPull()
  }

  if (isLoading) {
    return (
      <main className="loading-shell" aria-busy="true" aria-live="polite">
        <div className="loading-state">
          <p className="wordmark">moondi<span>.</span></p>
          <span className="loading-indicator" aria-hidden="true" />
          <p>{language === 'th' ? 'กำลังตรวจสอบสิทธิ์และโหลดพอร์ต' : 'Checking access and loading your portfolio'}</p>
        </div>
      </main>
    )
  }

  return (
    <main className="shell" onTouchEnd={finishPullRefresh} onTouchMove={trackPullRefresh} onTouchStart={beginPullRefresh}>
      <UpdateNotice language={language} />
      <div aria-live="polite" className={isPullRefreshing || pullDistance > 0 ? 'pull-refresh-indicator is-visible' : 'pull-refresh-indicator'}>
        <span>{isPullRefreshing ? (language === 'th' ? 'กำลังโหลดข้อมูลล่าสุด…' : 'Refreshing latest data…') : pullDistance >= 72 ? (language === 'th' ? 'ปล่อยเพื่อโหลดข้อมูลล่าสุด' : 'Release to refresh latest data') : (language === 'th' ? 'ดึงลงเพื่อโหลดข้อมูลล่าสุด' : 'Pull to refresh latest data')}</span>
      </div>
      <header className={isPublicState ? 'topbar public-topbar' : 'topbar'}>
        <a className="wordmark" href="/" aria-label="Moondi home">moondi<span>.</span></a>
        {!isPublicState ? <>
          <nav aria-label="Main navigation">
            <button className={view === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => { setSelectedAsset(null); setView('overview') }}>{language === 'th' ? 'ภาพรวม' : 'Overview'}</button>
            <button className={view === 'transactions' ? 'nav-item active' : 'nav-item'} onClick={() => { setSelectedAsset(null); setView('transactions') }}>{language === 'th' ? 'รายการ' : 'Activity'}</button>
          </nav>
          <div className="header-actions">
            <span className="sync-status">THB · {portfolio?.updatedAt ? `${language === 'th' ? 'อัปเดต' : 'Updated'} ${dateTime(language).format(portfolio.updatedAt)}` : (language === 'th' ? 'รอการ sync' : 'Awaiting sync')}</span>
            <button aria-label={language === 'th' ? 'เปิดการตั้งค่า' : 'Open settings'} className="settings-toggle" onClick={() => setIsSettingsOpen(true)} type="button">⚙</button>
            <a className="logout-link" href="/cdn-cgi/access/logout">{language === 'th' ? 'ออกจากระบบ' : 'Sign out'}</a>
          </div>
        </> : null}
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

      {error && !accessDenied && !signedOut ? (
        <section className="error-state">
          <p className="eyebrow">Connection unavailable</p>
          <h1>{needsApiAccess ? (language === 'th' ? 'ต้องยืนยันสิทธิ์ API' : 'API access needs confirmation') : (language === 'th' ? 'ยังติดต่อข้อมูลพอร์ตไม่ได้' : 'Portfolio data is unavailable')}</h1>
          <p>{needsApiAccess ? (language === 'th' ? 'Cloudflare Access ของ API ยังไม่ได้ยืนยันในเบราว์เซอร์นี้' : 'Cloudflare Access for the API has not been confirmed in this browser.') : (language === 'th' ? 'ลองรีเฟรชหน้าอีกครั้ง หรือตรวจสอบการเชื่อมต่อ' : 'Try refreshing the page or check your connection.')}</p>
          {needsApiAccess ? <a className="access-link" href={apiAccessUrl}>{language === 'th' ? 'ยืนยันสิทธิ์ API' : 'Confirm API access'}</a> : null}
        </section>
      ) : null}

      {!error && !accessDenied && !signedOut && view === 'overview' ? (
        selectedAsset && portfolio ? (
          <AssetDetail asset={selectedAsset} holdings={portfolio.holdings} language={language} onClose={() => setSelectedAsset(null)} portfolioValue={portfolio.totalValue} transactions={transactions} valuesVisible={valuesVisible} />
        ) : <>
          <section className="hero">
            <div className="hero-heading">
              <p className="eyebrow">Portfolio value</p>
              <div className="hero-actions">
                {accounts.length > 1 ? <label className="account-scope"><span>{language === 'th' ? 'ขอบเขต' : 'Scope'}</span><select onChange={(event) => { setSelectedAsset(null); setSelectedAccountId(event.target.value || undefined) }} value={selectedAccountId ?? ''}><option value="">{language === 'th' ? 'ทุกบัญชี' : 'All accounts'}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label> : null}
                <button aria-label={valuesVisible ? (language === 'th' ? 'ซ่อนมูลค่าพอร์ต' : 'Hide portfolio values') : (language === 'th' ? 'แสดงมูลค่าพอร์ต' : 'Show portfolio values')} aria-pressed={!valuesVisible} className="value-toggle" onClick={() => setValuesVisible((visible) => !visible)} type="button">
                  {valuesVisible ? `◉ ${language === 'th' ? 'ซ่อนมูลค่า' : 'Hide values'}` : `◌ ${language === 'th' ? 'แสดงมูลค่า' : 'Show values'}`}
                </button>
              </div>
            </div>
            <h1 className={valuesVisible ? undefined : 'value-concealed'}>
              <span className="portfolio-currency">฿</span>
              <span className="portfolio-number">{formatPortfolioValue(language, totalValue)}</span>
            </h1>
            <p className="hero-note">{language === 'th' ? 'มูลค่าประเมินปัจจุบันจาก balance snapshot ล่าสุด ไม่ใช่เงินต้นหรือกำไร' : 'Estimated current value from the latest balance snapshot. It is not principal or profit.'}</p>
          </section>
          <section className="freshness-banner" aria-live="polite">
            <div><strong>{language === 'th' ? 'อัปเดตข้อมูลแบบอ่านอย่างเดียว' : 'Read-only data refresh'}</strong><span>{portfolio?.updatedAt ? (language === 'th' ? `ข้อมูลล่าสุด ${dateTime(language).format(portfolio.updatedAt)}` : `Latest data ${dateTime(language).format(portfolio.updatedAt)}`) : (language === 'th' ? 'กำลังรอข้อมูลจาก sync แรก' : 'Waiting for the first sync.')}</span></div>
            <button className="export-button" disabled={isManualSyncWorking} onClick={() => void requestManualSync()} type="button">{isManualSyncWorking ? (language === 'th' ? 'กำลังเริ่ม…' : 'Starting…') : (language === 'th' ? 'sync ตอนนี้' : 'Sync now')}</button>
            {manualSyncMessage ? <p>{manualSyncMessage}</p> : null}
          </section>
          {overviewSections.history ? <PortfolioHistory language={language} onOpenHistory={() => setView('history')} points={history} valuesVisible={valuesVisible} /> : null}
          {overviewSections.allocation ? <PortfolioAllocation holdings={portfolio?.holdings ?? []} language={language} valuesVisible={valuesVisible} /> : null}
          {overviewSections.targets ? <AllocationTargets holdings={portfolio?.holdings ?? []} language={language} onRemove={async (asset) => { await removeAllocationTarget(asset); setAllocationTargets((current) => current.filter((target) => target.asset !== asset)) }} onSave={async (asset, targetPercent) => { const target = await saveAllocationTarget(asset, targetPercent); setAllocationTargets((current) => [...current.filter((item) => item.asset !== asset), target].toSorted((left, right) => left.asset.localeCompare(right.asset))) }} targets={allocationTargets} /> : null}
          {overviewSections.rebalance ? <RebalanceAssistant holdings={portfolio?.holdings ?? []} language={language} targets={allocationTargets} valuesVisible={valuesVisible} /> : null}
          {overviewSections.watchlist ? <TrackedPrices holdings={portfolio?.holdings ?? []} language={language} onAddAlert={async (asset, direction, targetPrice) => { const alert = await addPriceAlert(asset, direction, targetPrice); setPriceAlerts((current) => [alert, ...current]) }} onAddAsset={async (asset) => { const result = await addWatchlistAsset(asset); if (result.created) setWatchlist((current) => [{ asset: result.asset, created_at: Date.now(), price: null, updated_at: null }, ...current]); return result }} onRemoveAlert={async (id) => { await removePriceAlert(id); setPriceAlerts((current) => current.filter((alert) => alert.id !== id)) }} onRemoveAsset={async (asset) => { await removeWatchlistAsset(asset); setWatchlist((current) => current.filter((item) => item.asset !== asset)) }} priceAlerts={priceAlerts} watchlist={watchlist} /> : null}
          {overviewSections.syncHealth ? <SyncHealth language={language} onOpenHistory={() => setView('sync')} statuses={syncStatus} /> : null}
          {overviewSections.holdings && portfolio && portfolio.holdings.length > 0 ? (
            <Holdings holdings={portfolio.holdings} language={language} onOpenPortfolioCard={() => setIsPortfolioCardOpen(true)} onSelectAsset={setSelectedAsset} onDownloadBackup={() => void downloadBackup()} priceHistories={priceHistories} valuesVisible={valuesVisible} />
          ) : (overviewSections.holdings ? <EmptyState language={language} /> : null)}
        </>
      ) : null}

      {portfolio ? <PortfolioCardDialog holdings={portfolio.holdings} language={language} onClose={() => setIsPortfolioCardOpen(false)} open={isPortfolioCardOpen} totalValue={portfolio.totalValue} /> : null}
      <SettingsDialog accounts={accounts} archivedAccounts={archivedAccounts} language={language} onArchiveAccount={disconnectAccount} onClose={() => setIsSettingsOpen(false)} onRestoreAccount={reconnectAccount} open={isSettingsOpen} overviewSections={overviewSections} setLanguage={setLanguage} setOverviewSection={(section, visible) => setOverviewSections((current) => ({ ...current, [section]: visible }))} setTheme={setTheme} setValuesVisible={setValuesVisible} theme={theme} valuesVisible={valuesVisible} />

      {!error && !accessDenied && !signedOut && view === 'transactions' ? <Transactions language={language} nextCursor={nextTransactionCursor} onLoadMore={loadMoreTransactions} transactions={transactions} valuesVisible={valuesVisible} /> : null}
      {!error && !accessDenied && !signedOut && view === 'history' ? <HistoryView accountId={selectedAccountId} initialPoints={history} language={language} onBack={() => setView('overview')} valuesVisible={valuesVisible} /> : null}
      {!error && !accessDenied && !signedOut && view === 'sync' ? <SyncActivity accountId={selectedAccountId} language={language} onBack={() => setView('overview')} /> : null}
    </main>
  )
}
