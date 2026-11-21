import type { Plugin } from 'vite'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

export const apiOrigin = (apiBaseUrl: string | undefined): string | undefined => {
  const trimmed = apiBaseUrl?.trim() ?? ''
  if (trimmed === '') return undefined
  const parsed = new URL(trimmed)
  const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname))
  if (!secure || parsed.username || parsed.password) throw new Error('VITE_API_BASE_URL must be an https origin without credentials')
  return parsed.origin
}

export const contentSecurityPolicy = (apiBaseUrl: string | undefined): string => {
  const api = apiOrigin(apiBaseUrl)
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://cdn.bitkubnow.com",
    `connect-src 'self'${api ? ` ${api}` : ''} https://*.cloudflareaccess.com`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ')
}

export const securityHeadersFile = (apiBaseUrl: string | undefined): string => `${[
  '/*',
  `  Content-Security-Policy: ${contentSecurityPolicy(apiBaseUrl)}`,
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  '  Referrer-Policy: no-referrer',
  '  Permissions-Policy: accelerometer=(), bluetooth=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), serial=(), usb=()',
  '  Strict-Transport-Security: max-age=31536000',
].join('\n')}\n`

export const securityHeadersPlugin = (apiBaseUrl: string | undefined): Plugin => ({
  apply: 'build',
  generateBundle() {
    this.emitFile({ fileName: '_headers', source: securityHeadersFile(apiBaseUrl), type: 'asset' })
  },
  name: 'moondi-security-headers',
})
