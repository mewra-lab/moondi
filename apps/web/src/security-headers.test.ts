import { describe, expect, it } from 'vitest'
import { apiOrigin, contentSecurityPolicy, securityHeadersFile } from '../security-headers'

describe('security headers', () => {
  it('allows scripts only from the app itself and never evaluates strings', () => {
    const policy = contentSecurityPolicy('https://api.example.test')
    expect(policy).toContain("script-src 'self';")
    expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|script-src[^;]*https?:/)
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'none'")
  })

  it('limits network access to the app, its own API origin, and Cloudflare Access', () => {
    const policy = contentSecurityPolicy('https://api.example.test/some/path?x=1')
    expect(policy).toContain("connect-src 'self' https://api.example.test https://*.cloudflareaccess.com;")
    expect(policy).not.toContain('some/path')
  })

  it('works for a same-origin API and for a local development API', () => {
    expect(contentSecurityPolicy(undefined)).toContain("connect-src 'self' https://*.cloudflareaccess.com;")
    expect(contentSecurityPolicy('')).toContain("connect-src 'self' https://*.cloudflareaccess.com;")
    expect(apiOrigin('http://localhost:8787/')).toBe('http://localhost:8787')
  })

  it.each(['http://api.example.test', 'https://user:pass@api.example.test', 'not a url'])('refuses to build with API base URL %s', (value) => {
    expect(() => apiOrigin(value)).toThrow()
  })

  it('emits one rule for every path with the framing and sniffing protections', () => {
    const file = securityHeadersFile('https://api.example.test')
    expect(file.startsWith('/*\n')).toBe(true)
    expect(file).toContain('X-Content-Type-Options: nosniff')
    expect(file).toContain('X-Frame-Options: DENY')
    expect(file).toContain('Referrer-Policy: no-referrer')
    expect(file).toContain('Strict-Transport-Security: max-age=31536000\n')
    expect(file.split('\n').filter((line) => line.startsWith('/'))).toEqual(['/*'])
  })
})
