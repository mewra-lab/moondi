type Language = 'th' | 'en'

type TransactionValueInput = {
  amount: number
  category: 'trade' | 'crypto_transfer' | 'fiat_transfer'
  price: number | null
  quote_amount: number | null
  quote_asset: string | null
}

export type TransactionMoney = {
  approximate: boolean
  quoteAsset: string
  value: number
}

export const transactionValue = (transaction: TransactionValueInput): TransactionMoney | undefined => {
  if (!transaction.quote_asset) return undefined
  if (transaction.quote_amount !== null) {
    return { approximate: false, quoteAsset: transaction.quote_asset, value: transaction.quote_amount }
  }
  if (transaction.category === 'trade' && transaction.price !== null) {
    return { approximate: true, quoteAsset: transaction.quote_asset, value: transaction.amount * transaction.price }
  }
  return undefined
}

export const formatTransactionMoney = (language: Language, value: number, quoteAsset: string): string => {
  if (quoteAsset === 'THB') {
    return new Intl.NumberFormat(language === 'th' ? 'th-TH' : 'en-US', {
      currency: 'THB',
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
      style: 'currency',
    }).format(value)
  }

  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value)} ${quoteAsset}`
}
