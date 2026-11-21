import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sendNotification } from 'web-push'
import worker, { hasInternalAccess } from './index'

vi.mock('web-push', () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) }))

beforeAll(() => {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => {
      const a = new Uint8Array(left instanceof ArrayBuffer ? left : left.buffer, left instanceof ArrayBuffer ? 0 : left.byteOffset, left instanceof ArrayBuffer ? left.byteLength : left.byteLength)
      const b = new Uint8Array(right instanceof ArrayBuffer ? right : right.buffer, right instanceof ArrayBuffer ? 0 : right.byteOffset, right instanceof ArrayBuffer ? right.byteLength : right.byteLength)
      if (a.byteLength !== b.byteLength) return false
      let difference = 0
      for (let index = 0; index < a.byteLength; index += 1) difference |= a[index]! ^ b[index]!
      return difference === 0
    },
  })
})

afterAll(() => {
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
})

describe('internal access token', () => {
  const env = { INTERNAL_PUSH_TEST_TOKEN: 'expected-token-value' } as unknown as Env

  it('accepts the configured token', async () => {
    const request = new Request('https://worker.example/internal', { headers: { 'x-moond-internal-token': 'expected-token-value' } })
    await expect(hasInternalAccess(request, env)).resolves.toBe(true)
  })

  it('rejects a different token even when its length differs', async () => {
    const request = new Request('https://worker.example/internal', { headers: { 'x-moond-internal-token': 'short' } })
    await expect(hasInternalAccess(request, env)).resolves.toBe(false)
  })

  it.each([
    ['trades', 'notify_trades', 'ซื้อ 1 รายการ · ขาย 2 รายการ'],
    ['crypto_transfers', 'notify_crypto_transfers', 'รับเข้า 1 รายการ · โอนออก 2 รายการ'],
    ['fiat_transfers', 'notify_fiat_transfers', 'ฝากเงิน 1 รายการ · ถอนเงิน 2 รายการ'],
  ])('delivers a grouped %s push to opted-in browsers', async (dataType, preference, body) => {
    vi.mocked(sendNotification).mockClear()
    const prepare = vi.fn(() => ({
      all: vi.fn().mockResolvedValue({ results: [{ endpoint: 'https://push.example/fixture', p256dh: 'fixture-p256dh', auth: 'fixture-auth' }] }),
    }))
    const request = new Request('https://worker.example/internal/push/activity', {
      body: JSON.stringify({ dataType, incoming: 1, outgoing: 2 }),
      headers: { 'x-moond-internal-token': 'expected-token-value' },
      method: 'POST',
    })
    const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], {
      INTERNAL_PUSH_TEST_TOKEN: 'expected-token-value',
      VAPID_PUBLIC_KEY: 'fixture-public-key',
      VAPID_PRIVATE_KEY: 'fixture-private-key',
      VAPID_SUBJECT: 'mailto:fixture@example.test',
      DB: { prepare },
    } as unknown as Env, {} as ExecutionContext)
    expect(response.status).toBe(204)
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining(`WHERE ${preference} = 1`))
    expect(sendNotification).toHaveBeenCalledOnce()
    expect(JSON.parse(String(vi.mocked(sendNotification).mock.calls[0]![1]))).toMatchObject({ body, url: '/activity' })
  })
})
