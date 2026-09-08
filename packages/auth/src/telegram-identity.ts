/**
 * Telegram identity linking (CLAUDE.md §12).
 *
 * The flow deliberately never accepts an employee id from the user:
 *
 *   1. The user gives a *company e-mail*.
 *   2. The backend resolves that e-mail to an employee row itself.
 *   3. A one-time code is issued; only its hash is stored.
 *   4. The user returns the code; the backend links the Telegram id.
 *
 * Enumeration is avoided by returning the same result whether or not the
 * e-mail matched an employee.
 */

import {
  randomNumericCode,
  sha256Hex,
  timingSafeEqual,
  nowIso,
  type Logger,
} from '@corpus/shared'
import { tenantScope, type Repositories } from '@corpus/db'
import type { Role } from '@corpus/domain'

export const CODE_TTL_SECONDS = 10 * 60
export const MAX_CODE_ATTEMPTS = 5

export interface LinkRequestResult {
  /** Always true — never reveals whether the e-mail exists. */
  accepted: true
  /**
   * The code, returned only so the caller can *deliver* it (e-mail transport).
   * Never logged, never included in an API response body.
   */
  deliverTo: { email: string; code: string } | null
}

export type VerifyOutcome =
  | { ok: true; employeeId: string; userId: string | null; roles: Role[] }
  | { ok: false; reason: 'NO_ACTIVE_CODE' | 'INVALID_CODE' | 'TOO_MANY_ATTEMPTS' | 'EXPIRED' }

export interface TelegramIdentityDeps {
  repos: Repositories
  logger: Logger
}

export class TelegramIdentityService {
  constructor(private readonly deps: TelegramIdentityDeps) {}

  /**
   * Issue a linking code for a Telegram user who claims a company e-mail.
   * The claim is only ever used as a *lookup key*, never as authorisation.
   */
  async requestLink(input: {
    tenantId: string
    telegramUserId: string
    claimedEmail: string
  }): Promise<LinkRequestResult> {
    const scope = tenantScope(input.tenantId)
    const employee = await this.deps.repos.employees.findByEmail(scope, input.claimedEmail)

    // Invalidate any outstanding code for this Telegram user regardless of
    // whether the e-mail resolved, so timing does not leak existence either.
    await this.deps.repos.verificationCodes.consumeOutstanding(
      scope,
      'TELEGRAM_LINK',
      input.telegramUserId,
      null,
    )

    if (!employee || (employee.status !== 'ACTIVE' && employee.status !== 'ON_LEAVE')) {
      this.deps.logger.info('telegram link requested for unknown or inactive employee', {
        channel: 'TELEGRAM_INTERNAL',
        action: 'telegram.link.request',
        result: 'no_match',
      })
      return { accepted: true, deliverTo: null }
    }

    const code = randomNumericCode(6)
    const user = await this.deps.repos.users.findByEmployeeId(scope, employee.id)

    await this.deps.repos.verificationCodes.create(scope, {
      purpose: 'TELEGRAM_LINK',
      employeeId: employee.id,
      userId: user?.id ?? null,
      telegramUserId: input.telegramUserId,
      codeHash: await sha256Hex(`${input.telegramUserId}:${code}`),
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
      maxAttempts: MAX_CODE_ATTEMPTS,
    })

    // The code is never logged (CLAUDE.md §47).
    this.deps.logger.info('telegram link code issued', {
      channel: 'TELEGRAM_INTERNAL',
      action: 'telegram.link.request',
      result: 'issued',
      employeeId: employee.id,
    })

    return { accepted: true, deliverTo: { email: employee.email, code } }
  }

  /** Verify a submitted code and, on success, create the account link. */
  async verifyLink(input: {
    tenantId: string
    telegramUserId: string
    code: string
  }): Promise<VerifyOutcome> {
    const scope = tenantScope(input.tenantId)
    const active = await this.deps.repos.verificationCodes.findActive(
      scope,
      'TELEGRAM_LINK',
      input.telegramUserId,
      nowIso(),
    )
    if (!active) return { ok: false, reason: 'NO_ACTIVE_CODE' }
    if (active.attempts >= active.maxAttempts) {
      await this.deps.repos.verificationCodes.markConsumed(active.id)
      return { ok: false, reason: 'TOO_MANY_ATTEMPTS' }
    }

    await this.deps.repos.verificationCodes.recordAttempt(active.id)

    const presented = await sha256Hex(`${input.telegramUserId}:${input.code.trim()}`)
    if (!timingSafeEqual(presented, active.codeHash)) {
      return { ok: false, reason: 'INVALID_CODE' }
    }
    if (!active.employeeId) {
      // A code always carries a backend-resolved employee; missing means the
      // record was tampered with, so refuse rather than link anything.
      await this.deps.repos.verificationCodes.markConsumed(active.id)
      return { ok: false, reason: 'INVALID_CODE' }
    }

    await this.deps.repos.verificationCodes.markConsumed(active.id)
    await this.deps.repos.telegramAccounts.link(scope, {
      telegramUserId: input.telegramUserId,
      scope: 'INTERNAL',
      employeeId: active.employeeId,
      userId: active.userId,
    })

    const roles = active.userId
      ? await this.deps.repos.users.listRoles(scope, active.userId)
      : []

    this.deps.logger.info('telegram account linked', {
      channel: 'TELEGRAM_INTERNAL',
      action: 'telegram.link.verify',
      result: 'linked',
      employeeId: active.employeeId,
    })

    return { ok: true, employeeId: active.employeeId, userId: active.userId, roles }
  }

  async revokeLink(input: { tenantId: string; telegramAccountId: string }): Promise<void> {
    await this.deps.repos.telegramAccounts.revoke(
      tenantScope(input.tenantId),
      input.telegramAccountId,
    )
  }
}
