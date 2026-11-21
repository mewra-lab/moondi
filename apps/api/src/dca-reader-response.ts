import type { DcaActivity, DcaBuy } from '@moondi/shared'

const maximumReaderBytes = 128 * 1024
const maximumBuyRecords = 200
const maximumSignalLevels = 24

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isDate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15

const isNullableAmount = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

const parseBuy = (value: unknown): DcaBuy | undefined => {
  if (!isRecord(value)) return
  const { id, executedAt, amount, price, thbAmount, fee, reason } = value
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !isDate(executedAt)) return
  if (!isNullableAmount(amount) || !isNullableAmount(price) || !isNullableAmount(thbAmount) || !isNullableAmount(fee)) return
  if (reason !== null && (typeof reason !== 'string' || !/^(?:Signal|DCA|Fibo (?:1D )?[0-9]{1,3}(?:\.[0-9]{1,6})?)$/.test(reason))) return
  return { id, executedAt, amount, price, thbAmount, fee, reason }
}

const parseSignal = (value: unknown): DcaActivity['signal'] | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return
  const { lastSeenAt, active, levels, hasError } = value
  if (!isDate(lastSeenAt) || (active !== null && typeof active !== 'boolean') || typeof hasError !== 'boolean') return
  if (!Array.isArray(levels) || levels.length > maximumSignalLevels ||
    !levels.every((level): level is string => typeof level === 'string' && /^(?:1D:)?[0-9]{1,3}(?:\.[0-9]{1,6})?$/.test(level))) return
  return { lastSeenAt, active, levels, hasError }
}

const readReaderJson = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let received = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return JSON.parse(body + decoder.decode()) as unknown
      received += chunk.value.byteLength
      if (received > maximumReaderBytes) {
        await reader.cancel()
        return
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export const readDcaActivity = async (response: Response, from: number, to: number): Promise<DcaActivity | null | undefined> => {
  const payload = await readReaderJson(response)
  if (!isRecord(payload)) return
  if (payload.activity === null) return null
  if (!isRecord(payload.activity)) return
  const { buys, signal, truncated } = payload.activity
  if (!Array.isArray(buys) || buys.length > maximumBuyRecords || typeof truncated !== 'boolean') return
  const normalizedSignal = parseSignal(signal)
  if (normalizedSignal === undefined) return
  const normalizedBuys = new Map<string, DcaBuy>()
  for (const row of buys) {
    const buy = parseBuy(row)
    if (!buy || buy.executedAt < from || buy.executedAt > to) return
    normalizedBuys.set(buy.id, buy)
  }
  return { buys: [...normalizedBuys.values()].sort((a, b) => b.executedAt - a.executedAt), signal: normalizedSignal, truncated }
}
