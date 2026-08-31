import { describe, expect, it } from 'vitest'
import { mergeTradeAssets } from './sync-selection'

describe('trade-history asset selection', () => {
  it('retains previously held assets after their current balance reaches zero', () => {
    expect(mergeTradeAssets(['BTC', 'THB'], ['SOL', 'btc'])).toEqual(['BTC', 'SOL'])
  })
})
