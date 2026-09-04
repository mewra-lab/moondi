import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasInternalAccess } from './index'

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
})
