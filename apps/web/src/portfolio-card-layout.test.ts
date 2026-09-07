import { describe, expect, it } from 'vitest'
import { fitCanvasText } from './portfolio-card-layout'

const characterWidth = (value: string) => Array.from(value).length * 10

describe('portfolio card canvas layout', () => {
  it('truncates a long Thai metric value to its column instead of letting it overlap the next value', () => {
    const value = 'กำไร / ขาดทุนของเหรียญที่เลือก 2 เหรียญ'
    const fitted = fitCanvasText(value, characterWidth, 300)

    expect(fitted).toMatch(/…$/)
    expect(characterWidth(fitted)).toBeLessThanOrEqual(300)
  })

  it('keeps a metric value intact when it fits its column', () => {
    expect(fitCanvasText('฿44,533.82', characterWidth, 300)).toBe('฿44,533.82')
  })
})
