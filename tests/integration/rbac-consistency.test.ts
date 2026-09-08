/**
 * Asserts the committed RBAC migration matches the canonical tables in
 * `@corpus/domain`. Prevents code and reference data drifting apart
 * (regenerate with `npx tsx scripts/generate-rbac-migration.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '@corpus/domain'
import { createTestDatabase, type TestDatabase } from '@corpus/db/test-support'

describe('RBAC reference data', () => {
  let database: TestDatabase
  beforeAll(async () => {
    database = await createTestDatabase()
  })
  afterAll(() => database.close())

  it('stores exactly the canonical roles', async () => {
    const rows = await database.db.many<{ code: string }>('SELECT code FROM roles ORDER BY code')
    expect(rows.map((r) => r.code).sort()).toEqual([...ROLES].sort())
  })

  it('stores exactly the canonical permissions', async () => {
    const rows = await database.db.many<{ code: string }>(
      'SELECT code FROM permissions ORDER BY code',
    )
    expect(rows.map((r) => r.code).sort()).toEqual([...PERMISSIONS].sort())
  })

  it('stores exactly the canonical grants for every role', async () => {
    for (const role of ROLES) {
      const rows = await database.db.many<{ permission_code: string }>(
        'SELECT permission_code FROM role_permissions WHERE role_code = ? ORDER BY permission_code',
        [role],
      )
      expect(rows.map((r) => r.permission_code).sort(), `grants for ${role}`).toEqual(
        [...ROLE_PERMISSIONS[role]].sort(),
      )
    }
  })

  it('has no grant referencing an unknown role or permission', async () => {
    const orphans = await database.db.many<{ role_code: string; permission_code: string }>(
      `SELECT rp.role_code, rp.permission_code FROM role_permissions rp
        LEFT JOIN roles r ON r.code = rp.role_code
        LEFT JOIN permissions p ON p.code = rp.permission_code
       WHERE r.code IS NULL OR p.code IS NULL`,
    )
    expect(orphans).toEqual([])
  })

  it('declares a retention policy for every audit-bearing table', async () => {
    const rows = await database.db.many<{ table_name: string }>(
      'SELECT table_name FROM retention_policies',
    )
    const names = rows.map((r) => r.table_name)
    for (const table of ['audit_logs', 'security_events', 'messages', 'verification_codes']) {
      expect(names, `retention policy for ${table}`).toContain(table)
    }
  })
})
