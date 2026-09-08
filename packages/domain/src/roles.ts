/**
 * Roles and permissions (CLAUDE.md §10).
 *
 * Roles are stored in the database and loaded per request. A caller can never
 * assert a role: `Identity.roles` is populated exclusively from `user_roles`.
 */

export const ROLES = ['EMPLOYEE', 'MANAGER', 'HR', 'HR_ADMIN', 'SYSTEM_ADMIN'] as const
export type Role = (typeof ROLES)[number]

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v)
}

export const PERMISSIONS = [
  // Employee directory
  'employee.read.self',
  'employee.read.team',
  'employee.read.all',
  'employee.create',
  'employee.update',
  'employee.read.compensation',

  // Leave
  'leave.read.self',
  'leave.read.team',
  'leave.read.all',
  'leave.create.self',
  'leave.cancel.self',
  'leave.approve.team',
  'leave.approve.all',
  'leave.manage',

  // Recruitment
  'job.read.public',
  'job.read.internal',
  'job.create',
  'job.update',
  'job.delete',
  'candidate.read',
  'candidate.update',
  'candidate.create.public',
  'application.read',
  'application.read.self',
  'application.create.public',
  'application.update',
  'interview.read',
  'interview.manage',
  'offer.read',
  'offer.manage',

  // Knowledge / policy
  'policy.read',
  'policy.read.confidential',
  'policy.read.restricted',
  'policy.create',
  'policy.update',
  'policy.delete',

  // Reporting and oversight
  'report.read',
  'audit.read',
  'security.read',
  'system.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v)
}

/**
 * Canonical role → permission mapping. Seeded into the database by
 * `migrations/`, and asserted against the database by an integration test so
 * code and data cannot silently diverge.
 *
 * Note deliberately: no role receives a wildcard. SYSTEM_ADMIN is enumerated.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  EMPLOYEE: [
    'employee.read.self',
    'leave.read.self',
    'leave.create.self',
    'leave.cancel.self',
    'policy.read',
    'job.read.internal',
    'job.read.public',
  ],

  MANAGER: [
    'employee.read.self',
    'employee.read.team',
    'leave.read.self',
    'leave.read.team',
    'leave.create.self',
    'leave.cancel.self',
    'leave.approve.team',
    'policy.read',
    'job.read.internal',
    'job.read.public',
    'interview.read',
    'report.read',
  ],

  HR: [
    'employee.read.self',
    'employee.read.team',
    'employee.read.all',
    'employee.update',
    'leave.read.self',
    'leave.read.team',
    'leave.read.all',
    'leave.create.self',
    'leave.cancel.self',
    'leave.approve.all',
    'leave.manage',
    'policy.read',
    'policy.read.confidential',
    'policy.create',
    'policy.update',
    'job.read.public',
    'job.read.internal',
    'job.create',
    'job.update',
    'candidate.read',
    'candidate.update',
    'application.read',
    'application.update',
    'interview.read',
    'interview.manage',
    'offer.read',
    'report.read',
  ],

  HR_ADMIN: [
    'employee.read.self',
    'employee.read.team',
    'employee.read.all',
    'employee.create',
    'employee.update',
    'employee.read.compensation',
    'leave.read.self',
    'leave.read.team',
    'leave.read.all',
    'leave.create.self',
    'leave.cancel.self',
    'leave.approve.all',
    'leave.manage',
    'policy.read',
    'policy.read.confidential',
    'policy.read.restricted',
    'policy.create',
    'policy.update',
    'policy.delete',
    'job.read.public',
    'job.read.internal',
    'job.create',
    'job.update',
    'job.delete',
    'candidate.read',
    'candidate.update',
    'application.read',
    'application.update',
    'interview.read',
    'interview.manage',
    'offer.read',
    'offer.manage',
    'report.read',
    'audit.read',
    'security.read',
  ],

  // §10 permits an explicit broad grant for SYSTEM_ADMIN only. It is still
  // enumerated rather than a wildcard so every grant remains auditable.
  SYSTEM_ADMIN: [...PERMISSIONS],
}

/** For an unauthenticated caller: the external bot and the careers site. */
export const PUBLIC_PERMISSIONS: readonly Permission[] = [
  'job.read.public',
  'candidate.create.public',
  'application.create.public',
  'application.read.self',
]

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>()
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p)
  }
  return out
}

/**
 * The highest data classification a set of permissions may read.
 * Drives RAG filtering (CLAUDE.md §24) — computed in the backend, never by AI.
 */
export function maxReadableClassification(
  permissions: ReadonlySet<Permission>,
): 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' {
  if (permissions.has('policy.read.restricted')) return 'RESTRICTED'
  if (permissions.has('policy.read.confidential')) return 'CONFIDENTIAL'
  if (permissions.has('policy.read')) return 'INTERNAL'
  return 'PUBLIC'
}
