export type DcaPushPayload = { body: string; tag: string; title: string; url: string }

const maximumListedBuys = 3
const maximumTotal = 200
const maximumQuantity = 1e15
const idPattern = /^[A-Za-z0-9_-]{1,64}$/
const assetPattern = /^[A-Z0-9_-]{1,20}$/
const reasonPattern = /^(?:Signal|DCA|Fibo (?:1D )?[0-9]{1,3}(?:\.[0-9]{1,6})?)$/
const quantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 })
const baht = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNullableQuantity = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximumQuantity)

export const parseDcaPush = (body: unknown): { category: 'trades'; payloads: DcaPushPayload[] } | undefined => {
  if (!isRecord(body)) return
  const { buys, total } = body
  if (!Array.isArray(buys) || buys.length < 1 || buys.length > maximumListedBuys) return
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < buys.length || total > maximumTotal) return

  const payloads: DcaPushPayload[] = []
  for (const item of buys) {
    if (!isRecord(item)) return
    const { amount, asset, id, reason, thbAmount } = item
    if (typeof id !== 'string' || !idPattern.test(id) || typeof asset !== 'string' || !assetPattern.test(asset)) return
    if (!isNullableQuantity(amount) || !isNullableQuantity(thbAmount)) return
    if (reason !== null && (typeof reason !== 'string' || !reasonPattern.test(reason))) return
    const details = [
      reason,
      amount === null ? null : `${quantity.format(amount)} ${asset}`,
      thbAmount === null ? null : `฿${baht.format(thbAmount)}`,
    ].filter((part): part is string => part !== null)
    payloads.push({
      body: details.length > 0 ? details.join(' · ') : 'มีรายการซื้อใหม่',
      tag: `moondi-dca-buy-${id}`,
      title: `บอท DCA ซื้อ ${asset}`,
      url: '/activity',
    })
  }
  if (total > buys.length) {
    const first = (buys[0] as Record<string, unknown>).id as string
    payloads.push({
      body: `บอท DCA ซื้ออีก ${total - buys.length} รายการ`,
      tag: `moondi-dca-more-${first}`,
      title: 'Moondi มีรายการซื้อของบอทใหม่',
      url: '/activity',
    })
  }
  return { category: 'trades', payloads }
}
