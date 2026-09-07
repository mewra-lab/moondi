import { describe, expect, it } from 'vitest'
import { balancesForSnapshot, historyFetchStart, mergeTradeAssets, pricesForPersistence, sharedHistoryCoverage } from './sync-selection'

describe('trade-history asset selection', () => {
  it('retains previously held assets after their current balance reaches zero', () => {
    expect(mergeTradeAssets(['BTC', 'THB'], ['SOL', 'btc'])).toEqual(['BTC', 'SOL'])
  })
})

describe('D1 snapshot selection', () => {
  it('keeps positive balances plus THB as a complete sparse snapshot marker', () => {
    expect(balancesForSnapshot([
      { asset: 'BTC', available: 1, reserved: 0 },
      { asset: 'SOL', available: 0, reserved: 0 },
      { asset: 'THB', available: 0, reserved: 0 },
    ]).map((balance) => balance.asset)).toEqual(['BTC', 'THB'])
  })

  it('persists only relevant THB prices while leaving fetched prices available in memory', () => {
    const prices = [
      { asset: 'BTC', price: 1, quote: 'THB', updatedAt: 1 },
      { asset: 'SOL', price: 2, quote: 'THB', updatedAt: 1 },
      { asset: 'BTC', price: 3, quote: 'USDT', updatedAt: 1 },
    ]
    expect(pricesForPersistence(prices, new Set(['BTC']))).toEqual([prices[0]])
    expect(prices).toHaveLength(3)
  })
})

describe('history coverage selection', () => {
  it('reuses the earliest established boundary and refetches a mismatched stream', () => {
    const earliest = { covered_from: 100, last_synced_at: 300 }
    const later = { covered_from: 120, last_synced_at: 320 }
    const coverage = sharedHistoryCoverage(200, [earliest, later, null])

    expect(coverage).toBe(100)
    expect(historyFetchStart(earliest, coverage)).toBe(300)
    expect(historyFetchStart(later, coverage)).toBe(100)
    expect(historyFetchStart(null, coverage)).toBe(100)
  })
})
