/**
 * Generates `migrations/0006_rbac_reference.sql` from the canonical role and
 * permission tables in `@corpus/domain`.
 *
 * Run with `npx tsx scripts/generate-rbac-migration.ts` after changing roles or
 * permissions. `tests/integration/rbac-consistency.test.ts` fails if the
 * committed migration and the code ever drift apart.
 */

import { writeFileSync } from 'node:fs'
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '@corpus/domain'

const ROLE_DESCRIPTIONS: Record<string, string> = {
  EMPLOYEE: 'Verified employee — self-service only',
  MANAGER: 'People manager — self plus direct reports',
  HR: 'HR generalist — organisation-wide HR operations',
  HR_ADMIN: 'HR administrator — includes compensation, audit and security read',
  SYSTEM_ADMIN: 'Platform administrator — full explicit permission set',
}

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'employee.read.self': 'Read own employee record',
  'employee.read.team': 'Read direct reports',
  'employee.read.all': 'Read all employees in the tenant',
  'employee.create': 'Create employee records',
  'employee.update': 'Update employee records',
  'employee.read.compensation': 'Read RESTRICTED compensation data',
  'leave.read.self': 'Read own leave',
  'leave.read.team': 'Read direct reports leave',
  'leave.read.all': 'Read all leave in the tenant',
  'leave.create.self': 'Submit own leave request',
  'leave.cancel.self': 'Cancel own leave request',
  'leave.approve.team': 'Approve or reject direct reports leave',
  'leave.approve.all': 'Approve or reject any leave',
  'leave.manage': 'Manage leave types, balances and holidays',
  'job.read.public': 'Read published jobs',
  'job.read.internal': 'Read draft and closed jobs',
  'job.create': 'Create jobs',
  'job.update': 'Update jobs',
  'job.delete': 'Delete or archive jobs',
  'candidate.read': 'Read candidate records',
  'candidate.update': 'Update candidate records',
  'candidate.create.public': 'Create a candidate record via public application',
  'application.read': 'Read applications',
  'application.read.self': 'Read own application status',
  'application.create.public': 'Submit a public application',
  'application.update': 'Update application stage',
  'interview.read': 'Read interviews',
  'interview.manage': 'Schedule and evaluate interviews',
  'offer.read': 'Read offers',
  'offer.manage': 'Create and manage offers',
  'policy.read': 'Read INTERNAL knowledge documents',
  'policy.read.confidential': 'Read CONFIDENTIAL knowledge documents',
  'policy.read.restricted': 'Read RESTRICTED knowledge documents',
  'policy.create': 'Create knowledge documents',
  'policy.update': 'Update knowledge documents',
  'policy.delete': 'Delete or archive knowledge documents',
  'report.read': 'Read HR reports and analytics',
  'audit.read': 'Read the audit trail',
  'security.read': 'Read security events',
  'system.manage': 'Manage tenants, users and roles',
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

const lines: string[] = [
  '-- CORPUS 0006 — RBAC reference data.',
  '--',
  '-- GENERATED FILE. Do not edit by hand.',
  '-- Source of truth: packages/domain/src/roles.ts',
  '-- Regenerate:     npx tsx scripts/generate-rbac-migration.ts',
  '',
  'PRAGMA foreign_keys = ON;',
  '',
  'INSERT OR REPLACE INTO roles (code, name, description) VALUES',
]

lines.push(
  ROLES.map(
    (r) => `  (${q(r)}, ${q(r.replace(/_/g, ' '))}, ${q(ROLE_DESCRIPTIONS[r] ?? r)})`,
  ).join(',\n') + ';',
)

lines.push('', 'INSERT OR REPLACE INTO permissions (code, description) VALUES')
lines.push(
  PERMISSIONS.map((p) => `  (${q(p)}, ${q(PERMISSION_DESCRIPTIONS[p] ?? p)})`).join(',\n') + ';',
)

lines.push(
  '',
  '-- Role → permission grants. No wildcards: SYSTEM_ADMIN is fully enumerated',
  '-- so every grant stays visible in the audit trail.',
  'DELETE FROM role_permissions;',
  'INSERT INTO role_permissions (role_code, permission_code) VALUES',
)

const grants: string[] = []
for (const role of ROLES) {
  for (const perm of ROLE_PERMISSIONS[role]) grants.push(`  (${q(role)}, ${q(perm)})`)
}
lines.push(grants.join(',\n') + ';')
lines.push('')

writeFileSync('migrations/0006_rbac_reference.sql', lines.join('\n'), 'utf8')
console.log(
  `Wrote migrations/0006_rbac_reference.sql — ${ROLES.length} roles, ${PERMISSIONS.length} permissions, ${grants.length} grants`,
)
