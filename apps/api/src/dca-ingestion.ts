import type { DcaBuy } from '@moondi/shared'

export type DcaIngestionBuy = DcaBuy & { asset: string }

export type DcaIngestionSignal = {
  active: boolean | null
  asset: string
  hasError: boolean
  lastSeenAt: number
  levels: string[]
}

export type DcaIngestion = {
  accountId: string
  buys: DcaIngestionBuy[]
  signals: DcaIngestionSignal[]
  syncAt: number
}

export const dcaMaxBuysPerIngestion = 200
export const dcaMaxSignalsPerIngestion = 50
export const dcaMaxSignalLevels = 24

const maximumSyncAgeMs = 30 * 60 * 1_000
const maximumClockSkewMs = 5 * 60 * 1_000
const maximumQuantity = 1e15
const accountPattern = /^[A-Za-z0-9_-]{1,128}$/
const assetPattern = /^[A-Z0-9_-]{1,20}$/
const buyIdPattern = /^[A-Za-z0-9_-]{1,64}$/
const levelPattern = /^(?:1D:)?[0-9]{1,3}(?:\.[0-9]{1,6})?$/
const reasonPattern = /^(?:Signal|DCA|Fibo (?:1D )?[0-9]{1,3}(?:\.[0-9]{1,6})?)$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown, latest: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= latest

const isNullableQuantity = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximumQuantity)

const parseBuy = (value: unknown, latest: number): DcaIngestionBuy | undefined => {
  if (!isRecord(value)) return
  const { amount, asset, executedAt, fee, id, price, reason, thbAmount } = value
  if (typeof id !== 'string' || !buyIdPattern.test(id) || typeof asset !== 'string' || !assetPattern.test(asset)) return
  if (!isTimestamp(executedAt, latest)) return
  if (!isNullableQuantity(amount) || !isNullableQuantity(price) || !isNullableQuantity(thbAmount) || !isNullableQuantity(fee)) return
  if (reason !== null && (typeof reason !== 'string' || !reasonPattern.test(reason))) return
  return { amount, asset, executedAt, fee, id, price, reason, thbAmount }
}

const parseSignal = (value: unknown, latest: number): DcaIngestionSignal | undefined => {
  if (!isRecord(value)) return
  const { active, asset, hasError, lastSeenAt, levels } = value
  if (typeof asset !== 'string' || !assetPattern.test(asset) || !isTimestamp(lastSeenAt, latest)) return
  if ((active !== null && typeof active !== 'boolean') || typeof hasError !== 'boolean') return
  if (!Array.isArray(levels) || levels.length > dcaMaxSignalLevels) return
  if (!levels.every((level): level is string => typeof level === 'string' && levelPattern.test(level))) return
  return { active, asset, hasError, lastSeenAt, levels }
}

const parseUnique = <T>(values: unknown, limit: number, parse: (value: unknown) => T | undefined, key: (item: T) => string): T[] | undefined => {
  if (!Array.isArray(values) || values.length > limit) return
  const seen = new Set<string>()
  const items: T[] = []
  for (const value of values) {
    const item = parse(value)
    if (item === undefined || seen.has(key(item))) return
    seen.add(key(item))
    items.push(item)
  }
  return items
}

export const parseDcaStateRequest = (value: unknown): { accountId: string } | undefined => {
  if (!isRecord(value)) return
  const { accountId } = value
  return typeof accountId === 'string' && accountPattern.test(accountId) ? { accountId } : undefined
}

export const parseDcaIngestion = (value: unknown, requestTimestamp: number): DcaIngestion | undefined => {
  if (!isRecord(value)) return
  const { accountId, buys, signals, syncAt } = value
  if (typeof accountId !== 'string' || !accountPattern.test(accountId)) return
  if (!isTimestamp(syncAt, requestTimestamp) || requestTimestamp - syncAt > maximumSyncAgeMs) return
  const latest = syncAt + maximumClockSkewMs
  const parsedBuys = parseUnique(buys, dcaMaxBuysPerIngestion, (item) => parseBuy(item, latest), (buy) => buy.id)
  const parsedSignals = parseUnique(signals, dcaMaxSignalsPerIngestion, (item) => parseSignal(item, latest), (signal) => signal.asset)
  if (!parsedBuys || !parsedSignals || parsedBuys.length + parsedSignals.length === 0) return
  return { accountId, buys: parsedBuys, signals: parsedSignals, syncAt }
}
