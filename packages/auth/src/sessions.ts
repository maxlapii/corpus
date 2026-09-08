/**
 * Dashboard sessions. Only the token's SHA-256 is stored, so a database leak
 * yields no usable session, and revocation is immediate because every request
 * looks the session up (§34).
 */

import {
  base64UrlEncode,
  hmacSha256,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  unauthenticated,
} from '@corpus/shared'
import type { SessionRepository, UserRepository } from '@corpus/db'
import { tenantScope } from '@corpus/db'
import { permissionsForRoles, type Permission, type Role } from '@corpus/domain'

export const SESSION_COOKIE = 'corpus_session'
export const CSRF_HEADER = 'x-corpus-csrf'
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60

export interface IssuedSession {
  sessionId: string
  token: string
  csrfToken: string
  expiresAt: string
}

export interface SessionContext {
  sessionId: string
  tenantId: string
  userId: string
  csrfToken: string
  roles: Role[]
  permissions: Set<Permission>
}

export interface SessionServiceDeps {
  sessions: SessionRepository
  users: UserRepository
}

export class SessionService {
  constructor(
    private readonly deps: SessionServiceDeps,
    private readonly ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  ) {}

  async issue(input: {
    tenantId: string
    userId: string
    userAgent?: string | null
    ipHash?: string | null
  }): Promise<IssuedSession> {
    const token = randomToken(32)
    const csrfToken = randomToken(24)
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString()
    const sessionId = await this.deps.sessions.create({
      tenantId: input.tenantId,
      userId: input.userId,
      tokenHash: await sha256Hex(token),
      csrfToken,
      userAgent: (input.userAgent ?? null)?.slice(0, 200) ?? null,
      ipHash: input.ipHash ?? null,
      expiresAt,
    })
    return { sessionId, token, csrfToken, expiresAt }
  }

  /** Null for any invalid, expired or revoked session — never "unrestricted". */
  async resolve(token: string | null | undefined): Promise<SessionContext | null> {
    if (!token || token.length < 20 || token.length > 200) return null
    const row = await this.deps.sessions.findByTokenHash(await sha256Hex(token))
    if (!row) return null
    if (row.revokedAt) return null
    if (new Date(row.expiresAt).getTime() <= Date.now()) return null

    const scope = tenantScope(row.tenantId)
    const user = await this.deps.users.findById(scope, row.userId)
    if (!user || user.status !== 'ACTIVE') return null

    const roles = await this.deps.users.listRoles(scope, row.userId)
    await this.deps.sessions.touch(row.id)

    return {
      sessionId: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      csrfToken: row.csrfToken,
      roles,
      permissions: permissionsForRoles(roles),
    }
  }

  async revoke(sessionId: string): Promise<void> {
    await this.deps.sessions.revoke(sessionId)
  }

  async revokeAllForUser(tenantId: string, userId: string): Promise<void> {
    await this.deps.sessions.revokeAllForUser(tenantScope(tenantId), userId)
  }
}

/** Double-submit CSRF for state-changing requests; constant-time. */
export function assertCsrf(session: SessionContext, presented: string | null | undefined): void {
  if (!presented || !timingSafeEqual(session.csrfToken, presented)) {
    throw unauthenticated('This request could not be verified. Please reload and try again.', {
      internal: 'CSRF token mismatch',
    })
  }
}

export interface CookieOptions {
  secure: boolean
  /**
   * 'None' when the dashboard and API are different sites — the default
   * `*.pages.dev` → `*.workers.dev` topology is, and a Lax cookie would never
   * be sent. Safe because CSRF rests on the double-submit token and the CORS
   * allowlist, not on SameSite.
   */
  sameSite: 'Lax' | 'None'
}

export function sessionCookie(
  token: string,
  expiresAt: string,
  options: CookieOptions,
): string {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${options.sameSite}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ]
  // Browsers reject SameSite=None without Secure.
  if (options.secure || options.sameSite === 'None') attributes.push('Secure')
  return attributes.join('; ')
}

/** `requestUrl` is the API's own; `origin` the caller's. */
export function cookiePolicyFor(
  requestUrl: string,
  origin: string | null | undefined,
  isProduction: boolean,
): CookieOptions {
  const sameSite = isCrossSite(requestUrl, origin) ? 'None' : 'Lax'
  return { secure: isProduction || sameSite === 'None', sameSite }
}

/**
 * Approximates the public-suffix rule by comparing the last two host labels.
 * Erring towards cross-site only widens the cookie to None, which is safe here.
 */
function isCrossSite(requestUrl: string, origin: string | null | undefined): boolean {
  if (!origin) return false
  try {
    const api = new URL(requestUrl)
    const caller = new URL(origin)
    if (api.protocol !== caller.protocol) return true
    return registrableSite(api.hostname) !== registrableSite(caller.hostname)
  } catch {
    return false
  }
}

function registrableSite(hostname: string): string {
  const labels = hostname.split('.')
  return labels.length <= 2 ? hostname : labels.slice(-2).join('.')
}

export function clearSessionCookie(options: CookieOptions): string {
  const attributes = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${options.sameSite}`,
    'Max-Age=0',
  ]
  if (options.secure || options.sameSite === 'None') attributes.push('Secure')
  return attributes.join('; ')
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

/** Abuse tracking without storing PII. */
export async function hashIp(ip: string | null | undefined, secret: string): Promise<string | null> {
  if (!ip) return null
  return base64UrlEncode(await hmacSha256(secret, `ip:${ip}`)).slice(0, 22)
}
