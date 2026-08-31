import { describe, expect, it } from 'vitest'
import { credentialIssue, parseBitkubCredentialSource, resolveBitkubCredentials, scopedExchangeRecordId } from './account-credentials'

describe('Bitkub account credentials', () => {
  it('uses the secret mapping for the matching local account only', () => {
    const source = parseBitkubCredentialSource(JSON.stringify({
      bitkub_main: { apiKey: 'key-main', apiSecret: 'secret-main' },
      bitkub_second: { apiKey: 'key-second', apiSecret: 'secret-second' },
    }))

    expect(resolveBitkubCredentials({ accountCount: 2, accountId: 'bitkub_second', legacyApiKey: 'legacy-key', legacyApiSecret: 'legacy-secret', source })).toEqual({ apiKey: 'key-second', apiSecret: 'secret-second' })
    expect(resolveBitkubCredentials({ accountCount: 2, accountId: 'missing', legacyApiKey: 'legacy-key', legacyApiSecret: 'legacy-secret', source })).toBeUndefined()
  })

  it('keeps a single-account installation compatible with the legacy secrets', () => {
    const source = parseBitkubCredentialSource(undefined)

    expect(resolveBitkubCredentials({ accountCount: 1, accountId: 'bitkub_main', legacyApiKey: 'legacy-key', legacyApiSecret: 'legacy-secret', source })).toEqual({ apiKey: 'legacy-key', apiSecret: 'legacy-secret' })
    expect(resolveBitkubCredentials({ accountCount: 2, accountId: 'bitkub_main', legacyApiKey: 'legacy-key', legacyApiSecret: 'legacy-secret', source })).toBeUndefined()
    expect(credentialIssue(source, 2)).toBe('Multiple Bitkub accounts require BITKUB_ACCOUNTS_JSON')
  })

  it('rejects malformed mappings without exposing their contents', () => {
    const source = parseBitkubCredentialSource('{"bitkub_main":{"apiKey":"key-only"}}')

    expect(source).toEqual({ kind: 'invalid' })
    expect(credentialIssue(source, 1)).toBe('Invalid BITKUB_ACCOUNTS_JSON configuration')
  })

  it('creates collision-safe database identifiers per account', () => {
    expect(scopedExchangeRecordId('ab', 'c:d')).not.toBe(scopedExchangeRecordId('a', 'bc:d'))
  })
})
