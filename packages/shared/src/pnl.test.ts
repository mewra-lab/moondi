import { describe, expect, it } from 'vitest'
import { calculateAverageCostHistory, calculateAverageCostPnl, calculateOpenCostBasisHistory } from './index'

describe('calculateAverageCostPnl', () => {
  it('tracks only the selected assets’ remaining average-cost basis at each snapshot', () => {
    const history = calculateOpenCostBasisHistory({
      assets: ['BTC'],
      cryptoTransfers: [],
      overrides: [],
      snapshots: [0, 1, 2, 3],
      trades: [
        { amount: 2, baseAsset: 'BTC', executedAt: 1, fee: 1, feeAsset: 'THB', id: 'buy-btc', price: 100, quoteAmount: 200, quoteAsset: 'THB', side: 'buy' },
        { amount: 1, baseAsset: 'SOL', executedAt: 2, fee: 0, feeAsset: 'THB', id: 'buy-sol', price: 50, quoteAmount: 50, quoteAsset: 'THB', side: 'buy' },
        { amount: 0.5, baseAsset: 'BTC', executedAt: 3, fee: 2, feeAsset: 'THB', id: 'sell-btc', price: 200, quoteAmount: 100, quoteAsset: 'THB', side: 'sell' },
      ],
    })

    expect(history).toEqual([0, 201, 201, 150.75])
  })

  it('derives historical average cost from the ledger at each snapshot', () => {
    const history = calculateAverageCostHistory({
      asset: 'BTC',
      cryptoTransfers: [],
      overrides: [],
      snapshots: [10, 20, 30, 40],
      trades: [
        { amount: 1, baseAsset: 'BTC', executedAt: 15, fee: 0, feeAsset: 'THB', id: 'buy-one', price: 100, quoteAmount: 100, quoteAsset: 'THB', side: 'buy' },
        { amount: 1, baseAsset: 'BTC', executedAt: 25, fee: 0, feeAsset: 'THB', id: 'buy-two', price: 200, quoteAmount: 200, quoteAsset: 'THB', side: 'buy' },
        { amount: 1, baseAsset: 'BTC', executedAt: 35, fee: 0, feeAsset: 'THB', id: 'sell-one', price: 300, quoteAmount: 300, quoteAsset: 'THB', side: 'sell' },
      ],
    })

    expect(history).toEqual([null, 100, 150, 150])
  })

  it('withholds historical average cost after an external deposit without a verified cost basis', () => {
    const history = calculateAverageCostHistory({
      asset: 'BTC',
      cryptoTransfers: [{ amount: 1, asset: 'BTC', direction: 'deposit', executedAt: 15, fee: 0, id: 'external-btc' }],
      overrides: [],
      snapshots: [10, 20],
      trades: [],
    })

    expect(history).toEqual([null, null])
  })

  it('withholds the selected open-cost line after an unresolved cost-basis event', () => {
    const history = calculateOpenCostBasisHistory({
      assets: ['BTC'],
      cryptoTransfers: [{ amount: 1, asset: 'BTC', direction: 'deposit', executedAt: 15, fee: 0, id: 'external-btc' }],
      overrides: [],
      snapshots: [10, 20],
      trades: [],
    })

    expect(history).toEqual([0, null])
  })

  it('uses THB average cost and includes THB fees', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [],
      holdings: [{ amount: 1.5, asset: 'BTC', price: 150 }],
      overrides: [],
      trades: [
        { amount: 2, baseAsset: 'BTC', executedAt: 3, fee: 1, feeAsset: 'THB', id: 'buy', price: 100, quoteAmount: 200, quoteAsset: 'THB', side: 'buy' },
        { amount: 0.5, baseAsset: 'BTC', executedAt: 4, fee: 2, feeAsset: 'THB', id: 'sell', price: 200, quoteAmount: 100, quoteAsset: 'THB', side: 'sell' },
      ],
    })

    expect(pnl).toMatchObject({ complete: true, investedAmount: 201, realizedPnl: 47.75, unrealizedPnl: 74.25, totalPnl: 122 })
    expect(pnl.assets).toEqual([expect.objectContaining({
      asset: 'BTC',
      averageCost: 100.5,
      costBasis: 150.75,
      currentValue: 225,
      pnlPercent: expect.closeTo(60.7, 2),
      quantity: 1.5,
      realizedCostBasis: 50.25,
      status: 'ready',
    })])
  })

  it('keeps the cost already sold so closed and open P&L use the same return-on-cost denominator', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [],
      holdings: [{ amount: 1, asset: 'BTC', price: 200 }],
      overrides: [],
      trades: [
        { amount: 2, baseAsset: 'BTC', executedAt: 1, fee: 1, feeAsset: 'THB', id: 'buy', price: 100, quoteAmount: 200, quoteAsset: 'THB', side: 'buy' },
        { amount: 1, baseAsset: 'BTC', executedAt: 2, fee: 0, feeAsset: 'THB', id: 'sell', price: 150, quoteAmount: 150, quoteAsset: 'THB', side: 'sell' },
      ],
    })

    expect(pnl.assets).toEqual([expect.objectContaining({
      asset: 'BTC',
      costBasis: 100.5,
      realizedCostBasis: 100.5,
      realizedPnl: 49.5,
      unrealizedPnl: 99.5,
      totalPnl: 149,
      pnlPercent: expect.closeTo(74.13, 2),
    })])
  })

  it('excludes externally deposited crypto until its total THB cost basis is supplied', () => {
    const input = {
      cryptoTransfers: [{ amount: 1, asset: 'IOST', direction: 'deposit' as const, executedAt: 1, fee: 0, id: 'outside-in' }],
      holdings: [{ amount: 1, asset: 'IOST', price: 3 }],
      trades: [],
    }

    expect(calculateAverageCostPnl({ ...input, overrides: [] })).toMatchObject({
      complete: false,
      missingCostBasis: [{ amount: 1, asset: 'IOST', executedAt: 1, transferId: 'outside-in' }],
      realizedPnl: null,
      totalPnl: null,
      unrealizedPnl: null,
    })
    expect(calculateAverageCostPnl({ ...input, overrides: [{ totalCostThb: 2, transferId: 'outside-in' }] })).toMatchObject({
      complete: true,
      totalPnl: 1,
      unrealizedPnl: 1,
    })
  })

  it('does not pretend that a non-THB quote has a THB cost basis', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [],
      holdings: [{ amount: 1, asset: 'BTC', price: 2_000_000 }],
      overrides: [],
      trades: [{ amount: 1, baseAsset: 'BTC', executedAt: 1, fee: 0, feeAsset: 'USDT', id: 'usdt-buy', price: 50_000, quoteAmount: 50_000, quoteAsset: 'USDT', side: 'buy' }],
    })

    expect(pnl.complete).toBe(false)
    expect(pnl.assets).toEqual([expect.objectContaining({ asset: 'BTC', averageCost: null, status: 'unsupported_quote', totalPnl: null })])
  })

  it('requires the reconstructed quantity to agree with the current holding', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [],
      holdings: [{ amount: 0.8, asset: 'BTC', price: 100 }],
      overrides: [],
      trades: [{ amount: 1, baseAsset: 'BTC', executedAt: 1, fee: 0, feeAsset: 'THB', id: 'buy', price: 100, quoteAmount: 100, quoteAsset: 'THB', side: 'buy' }],
    })

    expect(pnl.assets).toEqual([expect.objectContaining({ asset: 'BTC', status: 'quantity_mismatch', totalPnl: null })])
    expect(pnl.complete).toBe(false)
  })

  it('accepts normal exchange rounding across many small fills', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [],
      holdings: [{ amount: 0.00916082, asset: 'BTC', price: 2_000_000 }],
      overrides: [],
      trades: [{ amount: 0.00916087, baseAsset: 'BTC', executedAt: 1, fee: 0, feeAsset: 'THB', id: 'rounded-buy', price: 1_000_000, quoteAmount: 9_160.87, quoteAsset: 'THB', side: 'buy' }],
    })

    expect(pnl).toMatchObject({ complete: true, totalPnl: expect.any(Number) })
    expect(pnl.assets).toEqual([expect.objectContaining({ asset: 'BTC', status: 'ready' })])
  })

  it('withholds P&L for a positive holding that has no normalized history', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [],
      holdings: [{ amount: 1, asset: 'BTC', price: 100 }],
      overrides: [],
      trades: [],
    })

    expect(pnl).toMatchObject({ complete: false })
    expect(pnl.assets).toEqual([expect.objectContaining({ asset: 'BTC', status: 'missing_history', totalPnl: null })])
  })

  it('does not use one Bitkub account to cover a sale in another', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [],
      holdings: [
        { accountId: 'account-a', amount: 1, asset: 'BTC', price: 100 },
        { accountId: 'account-b', amount: 0, asset: 'BTC', price: 100 },
      ],
      overrides: [],
      trades: [
        { accountId: 'account-a', amount: 1, baseAsset: 'BTC', executedAt: 1, fee: 0, feeAsset: 'THB', id: 'buy-a', price: 80, quoteAmount: 80, quoteAsset: 'THB', side: 'buy' },
        { accountId: 'account-b', amount: 1, baseAsset: 'BTC', executedAt: 2, fee: 0, feeAsset: 'THB', id: 'sell-b', price: 100, quoteAmount: 100, quoteAsset: 'THB', side: 'sell' },
      ],
    })

    expect(pnl).toMatchObject({ complete: false })
    expect(pnl.assets).toEqual([expect.objectContaining({ asset: 'BTC', status: 'quantity_mismatch', totalPnl: null })])
  })

  it('removes a crypto withdrawal fee from the reconstructed asset quantity', () => {
    const pnl = calculateAverageCostPnl({
      cryptoTransfers: [
        { amount: 0.9, asset: 'BTC', direction: 'withdraw', executedAt: 2, fee: 0.1, id: 'withdraw' },
      ],
      holdings: [{ amount: 0, asset: 'BTC', price: 100 }],
      overrides: [],
      trades: [{ amount: 1, baseAsset: 'BTC', executedAt: 1, fee: 0, feeAsset: 'THB', id: 'buy', price: 80, quoteAmount: 80, quoteAsset: 'THB', side: 'buy' }],
    })

    expect(pnl).toMatchObject({ complete: true, totalPnl: 0 })
  })
})
