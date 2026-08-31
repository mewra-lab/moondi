export type BitkubCredentials = {
  apiKey: string
  apiSecret: string
}

export type BitkubCredentialSource =
  | { credentialsByAccount: Map<string, BitkubCredentials>; kind: 'mapped' }
  | { kind: 'legacy' }
  | { kind: 'invalid' }

const isCredential = (value: unknown): value is BitkubCredentials => {
  if (typeof value !== 'object' || value === null) return false
  const apiKey = Reflect.get(value, 'apiKey')
  const apiSecret = Reflect.get(value, 'apiSecret')
  return typeof apiKey === 'string' && apiKey.length > 0 && typeof apiSecret === 'string' && apiSecret.length > 0
}

export const parseBitkubCredentialSource = (value: string | undefined): BitkubCredentialSource => {
  if (!value) return { kind: 'legacy' }

  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'invalid' }
    const entries = Object.entries(parsed)
    if (entries.length === 0 || entries.some(([accountId, credentials]) => accountId.length === 0 || !isCredential(credentials))) return { kind: 'invalid' }
    return { credentialsByAccount: new Map(entries), kind: 'mapped' }
  } catch {
    return { kind: 'invalid' }
  }
}

export const resolveBitkubCredentials = ({
  accountId,
  accountCount,
  legacyApiKey,
  legacyApiSecret,
  source,
}: {
  accountId: string
  accountCount: number
  legacyApiKey: string | undefined
  legacyApiSecret: string | undefined
  source: BitkubCredentialSource
}): BitkubCredentials | undefined => {
  if (source.kind === 'mapped') return source.credentialsByAccount.get(accountId)
  if (source.kind === 'invalid' || accountCount !== 1 || !legacyApiKey || !legacyApiSecret) return undefined
  return { apiKey: legacyApiKey, apiSecret: legacyApiSecret }
}

export const scopedExchangeRecordId = (accountId: string, externalId: string): string => `${accountId.length}:${accountId}:${externalId}`

export const credentialIssue = (source: BitkubCredentialSource, accountCount: number): string => {
  if (source.kind === 'invalid') return 'Invalid BITKUB_ACCOUNTS_JSON configuration'
  if (source.kind === 'legacy' && accountCount > 1) return 'Multiple Bitkub accounts require BITKUB_ACCOUNTS_JSON'
  return 'No configured read-only Bitkub credentials for this account'
}
