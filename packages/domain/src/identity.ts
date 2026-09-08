/**
 * Identity (CLAUDE.md §12).
 *
 * An `Identity` is only ever produced by the backend after verifying a session
 * cookie/bearer token or a linked Telegram account. Nothing a user or the LLM
 * says can construct or mutate one.
 */

import type { Permission, Role } from './roles.js'

export const SECURITY_ZONES = ['EXTERNAL', 'INTERNAL'] as const
export type SecurityZone = (typeof SECURITY_ZONES)[number]

export const CHANNELS = ['WEB', 'TELEGRAM_EXTERNAL', 'TELEGRAM_INTERNAL', 'SYSTEM'] as const
export type Channel = (typeof CHANNELS)[number]

/** Anonymous / public caller. Carries no employee linkage. */
export interface AnonymousIdentity {
  kind: 'ANONYMOUS'
  zone: 'EXTERNAL'
  channel: Channel
  tenantId: string
  /** Stable pseudonymous handle for rate limiting and audit (never a claim of who they are). */
  subjectKey: string
  telegramUserId?: string
  candidateId?: string
  roles: readonly []
  permissions: ReadonlySet<Permission>
}

/** Verified internal user. */
export interface UserIdentity {
  kind: 'USER'
  zone: 'INTERNAL'
  channel: Channel
  tenantId: string
  subjectKey: string
  /**
   * The user account behind this identity, or null when a verified employee has
   * no dashboard account (possible for a Telegram-only employee). Never
   * synthesise a value here: audit and conversation rows carry a foreign key to
   * `users`, so an invented id fails the constraint and loses the trail.
   */
  userId: string | null
  employeeId: string | null
  email: string
  displayName: string
  telegramUserId?: string
  roles: readonly Role[]
  permissions: ReadonlySet<Permission>
  /** Employee ids this identity directly manages. Loaded from the database. */
  managedEmployeeIds: readonly string[]
  sessionId?: string
}

export type Identity = AnonymousIdentity | UserIdentity

export function isUserIdentity(i: Identity): i is UserIdentity {
  return i.kind === 'USER'
}

export function hasPermission(i: Identity, permission: Permission): boolean {
  return i.permissions.has(permission)
}

export function hasRole(i: Identity, role: Role): boolean {
  return i.kind === 'USER' && i.roles.includes(role)
}

export function managesEmployee(i: Identity, employeeId: string): boolean {
  return i.kind === 'USER' && i.managedEmployeeIds.includes(employeeId)
}

export function ownsEmployee(i: Identity, employeeId: string): boolean {
  return i.kind === 'USER' && i.employeeId !== null && i.employeeId === employeeId
}

/** Short description used in audit rows and logs. Contains no secrets. */
export function describeIdentity(i: Identity): Record<string, unknown> {
  return i.kind === 'USER'
    ? {
        kind: i.kind,
        zone: i.zone,
        channel: i.channel,
        tenantId: i.tenantId,
        userId: i.userId,
        employeeId: i.employeeId,
        roles: [...i.roles],
      }
    : {
        kind: i.kind,
        zone: i.zone,
        channel: i.channel,
        tenantId: i.tenantId,
        subjectKey: i.subjectKey,
        candidateId: i.candidateId ?? null,
      }
}
