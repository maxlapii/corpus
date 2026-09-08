/**
 * Authentication routes (CLAUDE.md §35).
 *
 *   POST /auth/login
 *   POST /auth/logout
 *   GET  /auth/me
 *   POST /auth/telegram/link
 *   POST /auth/telegram/verify
 */

import { email as emailValidator, forbidden, object, parse, rateLimited, str, unauthenticated } from '@corpus/shared'
import { clearSessionCookie, cookiePolicyFor, hashIp, sessionCookie } from '@corpus/auth'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { clientIpKey } from '../client-ip.js'
import { readJsonBody } from '../middleware/body.js'
import { requireSession } from '../middleware/auth.js'
import { userIdentityOf } from './helpers.js'

const loginBody = object({
  email: emailValidator(),
  password: str({ min: 1, max: 200, trim: false }),
})

const linkBody = object({ email: emailValidator() })
const verifyBody = object({ code: str({ min: 4, max: 12 }), telegramUserId: str({ min: 1, max: 32 }) })

export const authRoutes = new Hono<AppBindings>()

authRoutes.post('/login', async (c) => {
  const container = c.get('container')
  const body = parse(loginBody, await readJsonBody(c))

  const tenant = await container.repos.tenants.findBySlug(container.config.defaultTenantSlug)
  if (!tenant) throw unauthenticated('This deployment is not initialised.')

  // Rate limit per e-mail *and* per IP, so neither dimension can be used alone
  // to brute force.
  const ip = clientIpKey(c.req)
  for (const key of [`login:email:${body.email}`, `login:ip:${ip}`]) {
    const limit = await container.rateLimiter.consume(key, container.rateLimits.loginPerIdentifier)
    if (!limit.allowed) {
      await container.securityEvents.record({
        tenantId: tenant.id,
        eventType: 'RATE_LIMIT',
        channel: 'WEB',
        summary: 'Login rate limit exceeded',
        requestId: c.get('requestId'),
      })
      c.header('Retry-After', String(limit.resetSeconds))
      throw rateLimited()
    }
  }

  const result = await container.login.login({
    tenantId: tenant.id,
    email: body.email,
    password: body.password,
    userAgent: c.req.header('user-agent') ?? null,
    ipHash: await hashIp(ip, container.config.sessionSecret),
  })

  if (!result.ok) {
    await container.securityEvents.record({
      tenantId: tenant.id,
      eventType: 'AUTH_FAILURE',
      channel: 'WEB',
      summary: `Login failed (${result.reason})`,
      requestId: c.get('requestId'),
    })
    // One message for every failure mode, so the response cannot be used to
    // discover which accounts exist or are locked.
    throw unauthenticated('Those credentials are not valid.')
  }

  const cookiePolicy = cookiePolicyFor(
    c.req.url,
    c.req.header('origin'),
    container.config.environment !== 'development',
  )
  c.header('Set-Cookie', sessionCookie(result.session.token, result.session.expiresAt, cookiePolicy))

  const roles = await container.repos.users.listRoles(
    { tenantId: tenant.id },
    result.userId,
  )

  return c.json({
    user: { id: result.userId, displayName: result.displayName, roles },
    // The CSRF token must be readable by the dashboard, unlike the session
    // cookie, which is HttpOnly.
    csrfToken: result.session.csrfToken,
    expiresAt: result.session.expiresAt,
  })
})

authRoutes.post('/logout', requireSession, async (c) => {
  const container = c.get('container')
  const session = c.get('session')
  if (session) await container.sessions.revoke(session.sessionId)
  c.header(
    'Set-Cookie',
    clearSessionCookie(
      cookiePolicyFor(c.req.url, c.req.header('origin'), container.config.environment !== 'development'),
    ),
  )
  return c.json({ ok: true })
})

authRoutes.get('/me', requireSession, async (c) => {
  const identity = userIdentityOf(c)
  const session = c.get('session')!
  return c.json({
    user: {
      id: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      employeeId: identity.employeeId,
      roles: identity.roles,
      // Permissions are sent for UX only. The dashboard must not treat them as
      // authoritative — the backend re-checks everything (CLAUDE.md §34).
      permissions: [...identity.permissions],
      managedEmployeeCount: identity.managedEmployeeIds.length,
    },
    csrfToken: session.csrfToken,
  })
})

/**
 * Issue a Telegram linking code for the *signed-in* user's own e-mail.
 *
 * The dashboard flow only ever links the caller's own account: the e-mail in
 * the body must match the session's e-mail, so an HR user cannot link their
 * Telegram to someone else's employee record.
 */
authRoutes.post('/telegram/link', requireSession, async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(linkBody, await readJsonBody(c))

  if (body.email !== identity.email) {
    await container.securityEvents.record({
      tenantId: identity.tenantId,
      eventType: 'IDENTITY_SPOOF_ATTEMPT',
      channel: 'WEB',
      userId: identity.userId,
      summary: 'Attempt to link a Telegram account to another employee e-mail',
      requestId: c.get('requestId'),
    })
    throw forbidden('You can only link your own account.')
  }

  const telegramUserId = c.req.query('telegramUserId')
  if (!telegramUserId || !/^\d{1,20}$/.test(telegramUserId)) {
    return c.json(
      {
        instructions:
          'Start the internal bot on Telegram and send /verify with your company e-mail. ' +
          'The code is delivered to your e-mail, not to Telegram.',
      },
      202,
    )
  }

  const result = await container.telegramIdentity.requestLink({
    tenantId: identity.tenantId,
    telegramUserId,
    claimedEmail: identity.email,
  })
  // The code itself is never returned in the response body.
  return c.json({ accepted: result.accepted })
})

authRoutes.post('/telegram/verify', requireSession, async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(verifyBody, await readJsonBody(c))

  const limit = await container.rateLimiter.consume(
    `verify:${identity.userId}`,
    container.rateLimits.verificationPerUser,
  )
  if (!limit.allowed) throw rateLimited()

  const outcome = await container.telegramIdentity.verifyLink({
    tenantId: identity.tenantId,
    telegramUserId: body.telegramUserId,
    code: body.code,
  })

  if (!outcome.ok) {
    await container.securityEvents.record({
      tenantId: identity.tenantId,
      eventType: 'AUTH_FAILURE',
      channel: 'WEB',
      userId: identity.userId,
      summary: `Telegram verification failed (${outcome.reason})`,
      requestId: c.get('requestId'),
    })
    throw unauthenticated('That verification code is not valid.')
  }

  // The link is made against the employee resolved from the *code*, which the
  // backend issued — so this cannot be redirected to another employee.
  if (outcome.employeeId !== identity.employeeId) {
    throw forbidden('You can only link your own account.')
  }

  return c.json({ linked: true })
})
