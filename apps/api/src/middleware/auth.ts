/**
 * Authentication middleware (CLAUDE.md §34).
 *
 * `requireSession` is the only way a route obtains an internal identity. It
 * resolves the session server-side on every request, so a revoked session or a
 * disabled user is rejected immediately, and it enforces CSRF on writes.
 */

import { rateLimited, unauthenticated } from '@corpus/shared'
import { CSRF_HEADER, SESSION_COOKIE, assertCsrf, readCookie } from '@corpus/auth'
import type { MiddlewareHandler } from 'hono'
import { clientIpKey } from '../client-ip.js'
import type { AppBindings } from '../context.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Extract a session token from the cookie, or an `Authorization: Bearer`. */
function readToken(c: Parameters<MiddlewareHandler<AppBindings>>[0]): string | null {
  const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE)
  if (cookie) return cookie
  const authorization = c.req.header('authorization')
  if (authorization?.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim()
  return null
}

export const requireSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  const container = c.get('container')
  const session = await container.sessions.resolve(readToken(c))

  if (!session) {
    await container.securityEvents.record({
      tenantId: null,
      eventType: 'AUTH_FAILURE',
      channel: 'WEB',
      summary: 'Unauthenticated request to a protected route',
      detail: { route: new URL(c.req.url).pathname, method: c.req.method },
      requestId: c.get('requestId'),
    })
    throw unauthenticated()
  }

  // Double-submit CSRF on every state-changing request.
  if (!SAFE_METHODS.has(c.req.method)) {
    assertCsrf(session, c.req.header(CSRF_HEADER))
  }

  // Per-user API budget, so a compromised session cannot be used to scrape.
  const limit = await container.rateLimiter.consume(
    `api:${session.tenantId}:${session.userId}`,
    container.rateLimits.adminApiPerUser,
  )
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.resetSeconds))
    throw rateLimited()
  }

  c.set('session', session)
  c.set('identity', await container.identityResolver.fromSession(session, 'WEB'))
  await next()
}

/**
 * Public routes: attaches an ANONYMOUS/EXTERNAL identity so the PolicyGateway
 * still runs. Public callers are rate limited per client IP.
 */
export const publicIdentity: MiddlewareHandler<AppBindings> = async (c, next) => {
  const container = c.get('container')
  const tenant = await container.repos.tenants.findBySlug(container.config.defaultTenantSlug)
  if (!tenant) throw unauthenticated('This deployment is not initialised.')

  const ip = clientIpKey(c.req)
  const limit = await container.rateLimiter.consume(
    `pub:${tenant.id}:${ip}`,
    container.rateLimits.publicApiPerIp,
  )
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.resetSeconds))
    throw rateLimited()
  }

  c.set(
    'identity',
    await container.identityResolver.anonymous({
      tenantId: tenant.id,
      channel: 'WEB',
      rawSubject: ip,
    }),
  )
  await next()
}
