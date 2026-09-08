/**
 * Migration runner.
 *
 * `wrangler d1 migrations apply` is the production path; this runner exists so
 * scripts and the integration tests apply exactly the same SQL files locally,
 * in the same order, against a real SQLite engine.
 */

import type { SqlDatabase } from './sql.js'

export interface Migration {
  name: string
  sql: string
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)`

/**
 * Split a migration file into individual statements.
 *
 * SQLite's `exec` handles multiple statements, but triggers contain internal
 * semicolons, so naive splitting corrupts them. We track BEGIN…END depth.
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')

  const statements: string[] = []
  let current = ''
  let depth = 0
  let inString = false

  const tokens = withoutComments.split(/(;|\bBEGIN\b|\bEND\b|')/i)
  for (const token of tokens) {
    if (token === "'") {
      inString = !inString
      current += token
      continue
    }
    if (inString) {
      current += token
      continue
    }
    const upper = token.toUpperCase()
    if (upper === 'BEGIN') {
      depth++
      current += token
      continue
    }
    if (upper === 'END') {
      depth = Math.max(0, depth - 1)
      current += token
      continue
    }
    if (token === ';' && depth === 0) {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      continue
    }
    current += token
  }
  const tail = current.trim()
  if (tail) statements.push(tail)
  return statements.filter((s) => s.length > 0)
}

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

/** Apply every not-yet-applied migration, in name order. */
export async function runMigrations(
  db: SqlDatabase,
  migrations: readonly Migration[],
): Promise<MigrateResult> {
  await db.exec(MIGRATIONS_TABLE.replace(/\s+/g, ' ').trim())

  const existing = await db
    .prepare('SELECT name FROM d1_migrations')
    .all<{ name: string }>()
  const done = new Set(existing.results.map((r) => r.name))

  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name))
  const result: MigrateResult = { applied: [], skipped: [] }

  for (const migration of ordered) {
    if (done.has(migration.name)) {
      result.skipped.push(migration.name)
      continue
    }
    for (const statement of splitStatements(migration.sql)) {
      // PRAGMA inside a prepared statement is a no-op on D1; run via exec.
      if (/^PRAGMA\b/i.test(statement)) {
        await db.exec(statement)
        continue
      }
      await db.prepare(statement).run()
    }
    await db
      .prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)')
      .bind(migration.name, new Date().toISOString())
      .run()
    result.applied.push(migration.name)
  }

  return result
}

export async function appliedMigrations(db: SqlDatabase): Promise<string[]> {
  const res = await db
    .prepare('SELECT name FROM d1_migrations ORDER BY name')
    .all<{ name: string }>()
  return res.results.map((r) => r.name)
}
