/**
 * Identity resolution — the ONLY place an `Identity` is constructed.
 *
 * Every field originates in the database:
 *   • roles          → user_roles
 *   • permissions    → ROLE_PERMISSIONS applied to those roles
 *   • employeeId     → users.employee_id / telegram_accounts.employee_id
 *   • managed ids    → employees.manager_id + employee_managers
 *
 * Nothing is taken from a request body, a Telegram display name, or an LLM.
 */

import { base64UrlEncode, hmacSha256, type Logger } from '@corpus/shared'
import { tenantScope, type Repositories } from '@corpus/db'
import {
  PUBLIC_PERMISSIONS,
  permissionsForRoles,
  type AnonymousIdentity,
  type Channel,
  type Identity,
  type Permission,
  type UserIdentity,
} from '@corpus/domain'
import type { SessionContext } from './sessions.js'

export interface IdentityResolverDeps {
  repos: Repositories
  logger: Logger
  /** Used to derive pseudonymous subject keys. Must be the session secret. */
  secret: string
}

/** Reasons an internal-zone resolution can fail. Mapped to user-safe text upstream. */
export type InternalResolutionFailure =
  | 'NOT_LINKED'
  | 'LINK_REVOKED'
  | 'EMPLOYEE_MISSING'
  | 'EMPLOYEE_INACTIVE'
  | 'USER_DISABLED'

export type TelegramInternalResolution =
  | { ok: true; identity: UserIdentity }
  | { ok: false; reason: InternalResolutionFailure }

export class IdentityResolver {
  constructor(private readonly deps: IdentityResolverDeps) {}

  /** Stable pseudonymous key for rate limiting and conversation threading. */
  async subjectKey(channel: Channel, raw: string): Promise<string> {
    return base64UrlEncode(await hmacSha256(this.deps.secret, `${channel}:${raw}`)).slice(0, 22)
  }

  /** Public / unauthenticated caller. Carries only PUBLIC_PERMISSIONS. */
  async anonymous(input: {
    tenantId: string
    channel: Channel
    rawSubject: string
    telegramUserId?: string
    candidateId?: string
  }): Promise<AnonymousIdentity> {
    return {
      kind: 'ANONYMOUS',
      zone: 'EXTERNAL',
      channel: input.channel,
      tenantId: input.tenantId,
      subjectKey: await this.subjectKey(input.channel, input.rawSubject),
      ...(input.telegramUserId ? { telegramUserId: input.telegramUserId } : {}),
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      roles: [] as const,
      permissions: new Set<Permission>(PUBLIC_PERMISSIONS),
    }
  }

  /** Build an internal identity from an already-validated dashboard session. */
  async fromSession(session: SessionContext, channel: Channel = 'WEB'): Promise<UserIdentity> {
    const scope = tenantScope(session.tenantId)
    const user = await this.deps.repos.users.findById(scope, session.userId)
    if (!user) {
      // resolve() already checked this; treat as a hard failure rather than
      // silently degrading to an identity with no employee linkage.
      throw new Error('session references a missing user')
    }
    return {
      kind: 'USER',
      zone: 'INTERNAL',
      channel,
      tenantId: session.tenantId,
      subjectKey: await this.subjectKey(channel, session.userId),
      userId: user.id,
      employeeId: user.employeeId,
      email: user.email,
      displayName: user.displayName,
      roles: session.roles,
      permissions: session.permissions,
      managedEmployeeIds: await this.loadManagedEmployeeIds(session.tenantId, user.employeeId),
      sessionId: session.sessionId,
    }
  }

  /**
   * Build an internal identity for a Telegram user. Requires a *verified*,
   * non-revoked INTERNAL link; anything else fails closed.
   */
  async fromTelegramInternal(input: {
    tenantId: string
    telegramUserId: string
  }): Promise<TelegramInternalResolution> {
    const scope = tenantScope(input.tenantId)
    const link = await this.deps.repos.telegramAccounts.findVerified(
      scope,
      input.telegramUserId,
      'INTERNAL',
    )
    if (!link) {
      const any = await this.deps.repos.telegramAccounts.findAny(
        scope,
        input.telegramUserId,
        'INTERNAL',
      )
      return { ok: false, reason: any?.revokedAt ? 'LINK_REVOKED' : 'NOT_LINKED' }
    }
    if (!link.employeeId) return { ok: false, reason: 'EMPLOYEE_MISSING' }

    const employee = await this.deps.repos.employees.findById(scope, link.employeeId)
    if (!employee) return { ok: false, reason: 'EMPLOYEE_MISSING' }
    if (employee.status === 'TERMINATED' || employee.status === 'SUSPENDED') {
      return { ok: false, reason: 'EMPLOYEE_INACTIVE' }
    }

    // Roles come from the linked user account. An employee without a user
    // account still gets the baseline EMPLOYEE role so self-service works.
    const user = link.userId
      ? await this.deps.repos.users.findById(scope, link.userId)
      : await this.deps.repos.users.findByEmployeeId(scope, employee.id)

    if (user && user.status !== 'ACTIVE') return { ok: false, reason: 'USER_DISABLED' }

    const roles = user ? await this.deps.repos.users.listRoles(scope, user.id) : (['EMPLOYEE'] as const)
    const effectiveRoles = roles.length > 0 ? roles : (['EMPLOYEE'] as const)

    return {
      ok: true,
      identity: {
        kind: 'USER',
        zone: 'INTERNAL',
        channel: 'TELEGRAM_INTERNAL',
        tenantId: input.tenantId,
        subjectKey: await this.subjectKey('TELEGRAM_INTERNAL', input.telegramUserId),
        userId: user?.id ?? null,
        employeeId: employee.id,
        email: employee.email,
        displayName: `${employee.firstName} ${employee.lastName}`,
        telegramUserId: input.telegramUserId,
        roles: [...effectiveRoles],
        permissions: permissionsForRoles([...effectiveRoles]),
        managedEmployeeIds: await this.loadManagedEmployeeIds(input.tenantId, employee.id),
      },
    }
  }

  private async loadManagedEmployeeIds(
    tenantId: string,
    employeeId: string | null,
  ): Promise<string[]> {
    if (!employeeId) return []
    return this.deps.repos.employees.listDirectReportIds(tenantScope(tenantId), employeeId)
  }
}

/** Type guard used by routes that require an internal identity. */
export function requireUserIdentity(identity: Identity): UserIdentity {
  if (identity.kind !== 'USER') {
    throw new Error('requireUserIdentity called with an anonymous identity')
  }
  return identity
}
