/**
 * Identity fixtures for unit tests.
 *
 * These construct identities *directly* — which production code never does
 * outside IdentityResolver — so that policy behaviour can be tested for an
 * arbitrary role/ownership combination.
 */

import {
  PUBLIC_PERMISSIONS,
  permissionsForRoles,
  type AnonymousIdentity,
  type Channel,
  type Permission,
  type Role,
  type UserIdentity,
} from '@corpus/domain'

export const TENANT_A = 'ten_a'
export const TENANT_B = 'ten_b'

export function makeUser(options: {
  roles: Role[]
  employeeId?: string | null
  userId?: string
  tenantId?: string
  channel?: Channel
  managedEmployeeIds?: string[]
  /** Override the derived permission set (for negative tests). */
  permissions?: Permission[]
}): UserIdentity {
  const roles = options.roles
  return {
    kind: 'USER',
    zone: 'INTERNAL',
    channel: options.channel ?? 'WEB',
    tenantId: options.tenantId ?? TENANT_A,
    subjectKey: `subj_${options.userId ?? 'u1'}`,
    userId: options.userId ?? 'usr_1',
    employeeId: options.employeeId === undefined ? 'emp_1' : options.employeeId,
    email: 'user@corpus.test',
    displayName: 'Test User',
    roles,
    permissions: new Set(options.permissions ?? [...permissionsForRoles(roles)]),
    managedEmployeeIds: options.managedEmployeeIds ?? [],
  }
}

export function makeAnonymous(options: {
  tenantId?: string
  channel?: Channel
  candidateId?: string
  telegramUserId?: string
} = {}): AnonymousIdentity {
  return {
    kind: 'ANONYMOUS',
    zone: 'EXTERNAL',
    channel: options.channel ?? 'TELEGRAM_EXTERNAL',
    tenantId: options.tenantId ?? TENANT_A,
    subjectKey: 'subj_anon',
    ...(options.candidateId ? { candidateId: options.candidateId } : {}),
    ...(options.telegramUserId ? { telegramUserId: options.telegramUserId } : {}),
    roles: [] as const,
    permissions: new Set(PUBLIC_PERMISSIONS),
  }
}

export const EMPLOYEE = () => makeUser({ roles: ['EMPLOYEE'], employeeId: 'emp_1' })
export const MANAGER = () =>
  makeUser({ roles: ['MANAGER'], employeeId: 'emp_mgr', managedEmployeeIds: ['emp_1', 'emp_2'] })
export const HR = () => makeUser({ roles: ['HR'], employeeId: 'emp_hr', userId: 'usr_hr' })
export const HR_ADMIN = () => makeUser({ roles: ['HR_ADMIN'], employeeId: 'emp_hra', userId: 'usr_hra' })
export const SYSTEM_ADMIN = () =>
  makeUser({ roles: ['SYSTEM_ADMIN'], employeeId: 'emp_sa', userId: 'usr_sa' })
