/**
 * Verifies that every committed migration applies cleanly to a real SQLite
 * engine, in order, and that the schema's key invariants exist.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appliedMigrations, runMigrations } from '@corpus/db'
import { loadMigrationsFromDir } from '@corpus/db/migration-files'
import { openSqlite, type SqliteDatabaseHandle } from '@corpus/db/sqlite-adapter'
import { migrationsDir } from '@corpus/db/test-support'

describe('database schema', () => {
  let handle: SqliteDatabaseHandle

  beforeAll(async () => {
    handle = await openSqlite(':memory:')
    await runMigrations(handle, loadMigrationsFromDir(migrationsDir()))
  })

  afterAll(() => handle.close())

  it('applies all migrations exactly once', async () => {
    const applied = await appliedMigrations(handle)
    expect(applied).toEqual([
      '0001_core_identity.sql',
      '0002_hr_core.sql',
      '0003_recruitment.sql',
      '0004_knowledge.sql',
      '0005_security_conversations.sql',
      '0006_rbac_reference.sql',
    ])

    // Re-running must be a no-op.
    const second = await runMigrations(handle, loadMigrationsFromDir(migrationsDir()))
    expect(second.applied).toEqual([])
    expect(second.skipped).toHaveLength(6)
  })

  it('creates every expected table', async () => {
    const { results } = await handle
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
    const names = results.map((r) => r.name)

    for (const table of [
      'tenants', 'roles', 'permissions', 'role_permissions', 'users', 'user_roles',
      'sessions', 'telegram_accounts', 'verification_codes',
      'departments', 'positions', 'employees', 'employee_managers', 'employee_compensation',
      'leave_types', 'leave_balances', 'leave_requests', 'leave_approvals', 'holidays',
      'jobs', 'job_requirements', 'candidates', 'applications', 'application_events',
      'interviews', 'offers',
      'documents', 'document_versions', 'document_chunks', 'document_chunks_fts',
      'audit_logs', 'security_events', 'conversations', 'messages', 'tool_calls',
      'unanswered_questions', 'hr_tickets', 'rate_limit_counters', 'retention_policies',
    ]) {
      expect(names, `missing table ${table}`).toContain(table)
    }
  })

  it('enforces foreign keys', async () => {
    await handle
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES ('t1','a','A','ACTIVE','x','x')")
      .run()

    await expect(
      handle
        .prepare(
          `INSERT INTO employees
             (id, tenant_id, employee_no, first_name, last_name, email, hire_date, employment_type, status, created_at, updated_at)
           VALUES ('e1','MISSING_TENANT','E1','A','B','a@b.c','2024-01-01','FULL_TIME','ACTIVE','x','x')`,
        )
        .run(),
    ).rejects.toThrow()
  })

  it('rejects a leave request whose end date precedes its start date', async () => {
    await handle
      .prepare(
        `INSERT INTO employees
           (id, tenant_id, employee_no, first_name, last_name, email, hire_date, employment_type, status, created_at, updated_at)
         VALUES ('e2','t1','E2','A','B','e2@b.c','2024-01-01','FULL_TIME','ACTIVE','x','x')`,
      )
      .run()
    await handle
      .prepare(
        `INSERT INTO leave_types
           (id, tenant_id, code, name, paid, requires_approval, counts_working_days_only, active, created_at, updated_at)
         VALUES ('lt1','t1','ANNUAL','Annual',1,1,1,1,'x','x')`,
      )
      .run()

    await expect(
      handle
        .prepare(
          `INSERT INTO leave_requests
             (id, tenant_id, employee_id, leave_type_id, start_date, end_date, working_days, status, submitted_at, created_at, updated_at)
           VALUES ('lr1','t1','e2','lt1','2025-05-10','2025-05-01',3,'PENDING','x','x','x')`,
        )
        .run(),
    ).rejects.toThrow()
  })

  it('keeps the chunk FTS index in step with document_chunks', async () => {
    await handle
      .prepare(
        `INSERT INTO documents (id, tenant_id, name, category, classification, status, created_at, updated_at)
         VALUES ('d1','t1','Handbook','POLICY','INTERNAL','ACTIVE','x','x')`,
      )
      .run()
    await handle
      .prepare(
        `INSERT INTO document_versions (id, tenant_id, document_id, version, effective_from, created_at)
         VALUES ('dv1','t1','d1',1,'2025-01-01','x')`,
      )
      .run()
    await handle
      .prepare(
        `INSERT INTO document_chunks
           (id, tenant_id, document_id, document_version_id, version, classification,
            effective_from, section, ordinal, content, token_estimate, created_at)
         VALUES ('c1','t1','d1','dv1',1,'INTERNAL','2025-01-01','Leave',0,
                 'Employees accrue twenty annual leave days per year.',12,'x')`,
      )
      .run()

    const hit = await handle
      .prepare("SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH 'accrue'")
      .first<{ chunk_id: string }>()
    expect(hit?.chunk_id).toBe('c1')

    await handle.prepare("DELETE FROM document_chunks WHERE id = 'c1'").run()
    const after = await handle
      .prepare("SELECT COUNT(*) AS c FROM document_chunks_fts WHERE document_chunks_fts MATCH 'accrue'")
      .first<{ c: number }>()
    expect(Number(after?.c)).toBe(0)
  })
})
