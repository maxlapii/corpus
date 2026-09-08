/**
 * Dashboard login (CLAUDE.md §35 `POST /auth/login`).
 *
 * Fails uniformly: an unknown e-mail, a wrong password and a disabled account
 * all produce the same response and the same rough timing.
 */

import { nowIso, type Logger } from '@corpus/shared'
import { tenantScope, type Repositories } from '@corpus/db'
import { verifyPassword, hashPassword, needsRehash } from './passwords.js'
import type { SessionService, IssuedSession } from './sessions.js'

export const MAX_LOGIN_ATTEMPTS = 8
export const LOCK_MINUTES = 15

export type LoginResult =
  | { ok: true; session: IssuedSession; userId: string; displayName: string }
  | { ok: false; reason: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'ACCOUNT_DISABLED' }

export interface LoginServiceDeps {
  repos: Repositories
  sessions: SessionService
  logger: Logger
}

export class LoginService {
  constructor(private readonly deps: LoginServiceDeps) {}

  async login(input: {
    tenantId: string
    email: string
    password: string
    userAgent?: string | null
    ipHash?: string | null
  }): Promise<LoginResult> {
    const scope = tenantScope(input.tenantId)
    const user = await this.deps.repos.users.findByEmailWithSecret(scope, input.email)

    if (!user) {
      // Equal work to a real verification, so timing does not reveal existence.
      await verifyPassword(input.password, DUMMY_HASH)
      return { ok: false, reason: 'INVALID_CREDENTIALS' }
    }

    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      return { ok: false, reason: 'ACCOUNT_LOCKED' }
    }
    // The lock window has passed: release it before evaluating the password, so
    // the attempt starts from a clean counter and an ACTIVE status.
    if (user.lockedUntil) {
      await this.deps.repos.users.clearExpiredLock(scope, user.id)
      user.status = 'ACTIVE'
    }
    if (user.status === 'DISABLED') {
      await verifyPassword(input.password, user.passwordHash)
      return { ok: false, reason: 'ACCOUNT_DISABLED' }
    }

    const valid = await verifyPassword(input.password, user.passwordHash)
    if (!valid) {
      const attempts = await this.deps.repos.users.recordLoginFailure(
        scope,
        user.id,
        MAX_LOGIN_ATTEMPTS,
        LOCK_MINUTES,
      )
      this.deps.logger.warn('login failed', {
        action: 'auth.login',
        result: 'invalid_credentials',
        userId: user.id,
        tenantId: input.tenantId,
        attempts,
      })
      return {
        ok: false,
        reason: attempts >= MAX_LOGIN_ATTEMPTS ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
      }
    }

    // Opportunistically upgrade the stored hash when parameters have moved on.
    if (needsRehash(user.passwordHash)) {
      await this.deps.repos.users.setPasswordHash(scope, user.id, await hashPassword(input.password))
    }

    await this.deps.repos.users.recordLoginSuccess(scope, user.id)
    const session = await this.deps.sessions.issue({
      tenantId: input.tenantId,
      userId: user.id,
      userAgent: input.userAgent ?? null,
      ipHash: input.ipHash ?? null,
    })

    this.deps.logger.info('login succeeded', {
      action: 'auth.login',
      result: 'ok',
      userId: user.id,
      tenantId: input.tenantId,
      at: nowIso(),
    })

    return { ok: true, session, userId: user.id, displayName: user.displayName }
  }
}

/**
 * Verified against when no account matches, so an unknown e-mail costs the same
 * work as a wrong password (§35).
 *
 * A *literal* rather than `hashPassword(...)` at module scope: Workers forbid
 * generating random values in global scope, so computing it there rejected and
 * turned every unknown-account login into a 500 — the opposite of the
 * indistinguishability this exists to provide. It is a hash of a fixed
 * placeholder, so it is not a credential and nothing can authenticate with it.
 */
const DUMMY_HASH =
  'pbkdf2-sha256$210000$3YRJyOuH2WVJONa7lMgpgg$PJdpQM_DpQV_xPnzA26bLn4j05dI3AqgZbEf-RJv5yM'
