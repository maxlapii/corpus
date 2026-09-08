/**
 * Security headers and CORS (CLAUDE.md §34).
 *
 * The API is JSON-only and never renders HTML, so the CSP is maximally
 * restrictive. CORS is an explicit allowlist — never `*` with credentials.
 */

import type { MiddlewareHandler } from 'hono'
import type { AppBindings } from '../context.js'

export const securityHeaders: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cross-Origin-Resource-Policy', 'same-site')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  )
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  c.header('Cache-Control', 'no-store')
  if (c.get('container')?.config.environment === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

export const cors: MiddlewareHandler<AppBindings> = async (c, next) => {
  const origin = c.req.header('origin')
  const allowed = c.get('container').config.corsOrigins

  if (origin && allowed.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Allow-Credentials', 'true')
    c.header('Vary', 'Origin')
  }
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'content-type, authorization, x-corpus-csrf, x-request-id')
  c.header('Access-Control-Max-Age', '600')

  if (c.req.method === 'OPTIONS') {
    // Only answer the preflight for an allowed origin.
    return c.body(null, origin && allowed.includes(origin) ? 204 : 403)
  }
  await next()
  return undefined
}
