import { describe, expect, it } from 'vitest'
import { formatTransactionMoney, transactionValue } from './transaction-display'

describe('transaction display values', () => {
  it('keeps a non-THB trade value in its quote asset', () => {
    const value = transactionValue({ category: 'trade', amount: 0.5, price: 60_000, quote_amount: 30_000, quote_asset: 'USDT' })

    expect(value).toEqual({ approximate: false, quoteAsset: 'USDT', value: 30_000 })
    expect(formatTransactionMoney('en', value?.value ?? 0, value?.quoteAsset ?? '')).toContain('USDT')
    expect(formatTransactionMoney('en', value?.value ?? 0, value?.quoteAsset ?? '')).not.toContain('THB')
  })

  it('marks a derived trade value as approximate', () => {
    expect(transactionValue({ category: 'trade', amount: 2, price: 25, quote_amount: null, quote_asset: 'USDT' })).toEqual({
      approximate: true,
      quoteAsset: 'USDT',
      value: 50,
    })
  })
})
