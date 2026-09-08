/**
 * Retention enforcement (CLAUDE.md §29).
 *
 * The `retention_policies` table declares how long each table is kept; these
 * tests prove the scheduled handler acts on it, and that it does not delete
 * anything still inside its window.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nullLogger } from '@corpus/shared'
import { applyRetention } from '@corpus/api/scheduled'
import { createTestDatabase, type TestDatabase } from '@corpus/db/test-support'
import { seedDatabase, type SeedResult } from '../../scripts/seed-data.js'

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()

describe('retention', () => {
  let database: TestDatabase
  let seed: SeedResult

  beforeEach(async () => {
    database = await createTestDatabase()
    seed = await seedDatabase(database.repos, { tenantSlug: 'default', tenantName: 'A' })
  })
  afterEach(() => database.close())

  async function seedAgedRows(): Promise<void> {
    const scope = { tenantId: seed.tenantId }
    // Two audit rows: one well past the 730-day policy, one recent.
    for (const [id, timestamp] of [
      ['aud_old', daysAgo(800)],
      ['aud_new', daysAgo(1)],
    ] as const) {
      await database.db.run(
        `INSERT INTO audit_logs (id, timestamp, tenant_id, channel, resource, action, decision)
         VALUES (?, ?, ?, 'WEB', 'employee', 'read', 'ALLOW')`,
        [id, timestamp, seed.tenantId],
      )
    }
    for (const [id, timestamp] of [
      ['sev_old', daysAgo(800)],
      ['sev_new', daysAgo(2)],
    ] as const) {
      await database.db.run(
        `INSERT INTO security_events
           (id, timestamp, tenant_id, event_type, severity, channel, summary)
         VALUES (?, ?, ?, 'BLOCKED_REQUEST', 'LOW', 'WEB', 'test')`,
        [id, timestamp, seed.tenantId],
      )
    }

    const conversation = await database.repos.conversations.findOrCreate(scope, {
      channel: 'WEB',
      subjectKey: 'subject',
      userId: null,
      candidateId: null,
    })
    for (const [id, createdAt] of [
      ['msg_old', daysAgo(200)],
      ['msg_new', daysAgo(3)],
    ] as const) {
      await database.db.run(
        `INSERT INTO messages (id, tenant_id, conversation_id, role, content, created_at)
         VALUES (?, ?, ?, 'user', 'hello', ?)`,
        [id, seed.tenantId, conversation.id, createdAt],
      )
    }
    await database.db.run(
      `INSERT INTO tool_calls (id, tenant_id, tool_name, decision, created_at)
       VALUES ('tlc_old', ?, 'get_holidays', 'ALLOW', ?)`,
      [seed.tenantId, daysAgo(200)],
    )
    await database.db.run(
      `INSERT INTO rate_limit_counters (bucket_key, window_start, count, expires_at)
       VALUES ('stale', 0, 1, ?)`,
      [Math.floor(Date.now() / 1000) - 10_000],
    )
    await database.repos.sessions.create({
      tenantId: seed.tenantId,
      userId: seed.employees.employee!.userId!,
      tokenHash: 'hash_expired',
      csrfToken: 'csrf',
      userAgent: null,
      ipHash: null,
      expiresAt: daysAgo(1),
    })
  }

  const count = (sql: string, params: unknown[] = []) => database.db.count(sql, params as never)

  it('removes rows past their policy window and keeps recent ones', async () => {
    await seedAgedRows()

    const outcomes = await applyRetention(database.db, database.repos, nullLogger)
    expect(outcomes.length).toBeGreaterThan(0)

    expect(await count("SELECT COUNT(*) AS c FROM audit_logs WHERE id = 'aud_old'")).toBe(0)
    expect(await count("SELECT COUNT(*) AS c FROM audit_logs WHERE id = 'aud_new'")).toBe(1)
    expect(await count("SELECT COUNT(*) AS c FROM security_events WHERE id = 'sev_old'")).toBe(0)
    expect(await count("SELECT COUNT(*) AS c FROM security_events WHERE id = 'sev_new'")).toBe(1)
    expect(await count("SELECT COUNT(*) AS c FROM messages WHERE id = 'msg_old'")).toBe(0)
    expect(await count("SELECT COUNT(*) AS c FROM messages WHERE id = 'msg_new'")).toBe(1)
    expect(await count("SELECT COUNT(*) AS c FROM tool_calls WHERE id = 'tlc_old'")).toBe(0)
    expect(await count("SELECT COUNT(*) AS c FROM rate_limit_counters WHERE bucket_key = 'stale'")).toBe(0)
    expect(await count("SELECT COUNT(*) AS c FROM sessions WHERE token_hash = 'hash_expired'")).toBe(0)
  })

  it('is idempotent: a second run removes nothing more', async () => {
    await seedAgedRows()
    await applyRetention(database.db, database.repos, nullLogger)
    const second = await applyRetention(database.db, database.repos, nullLogger)
    expect(second.every((o) => o.removed === 0)).toBe(true)
  })

  it('covers every declared policy, or reports the gap', async () => {
    const warnings: string[] = []
    const logger = { ...nullLogger, warn: (m: string) => warnings.push(m) }
    await applyRetention(database.db, database.repos, logger as never)
    expect(warnings.filter((w) => w.includes('no pruner'))).toEqual([])
  })

  it('leaves seeded business data untouched', async () => {
    await applyRetention(database.db, database.repos, nullLogger)
    expect(await count('SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ?', [seed.tenantId])).toBe(7)
    expect(await count('SELECT COUNT(*) AS c FROM jobs WHERE tenant_id = ?', [seed.tenantId])).toBe(3)
    expect(await count('SELECT COUNT(*) AS c FROM applications WHERE tenant_id = ?', [seed.tenantId])).toBe(3)
  })
})
