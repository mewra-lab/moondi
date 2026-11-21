export type DcaBuy = {
  id: string
  executedAt: number
  amount: number | null
  price: number | null
  thbAmount: number | null
  fee: number | null
  reason: string | null
}

export type DcaActivity = {
  buys: DcaBuy[]
  truncated: boolean
  signal: { lastSeenAt: number; active: boolean | null; levels: string[]; hasError: boolean } | null
}
