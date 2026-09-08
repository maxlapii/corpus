/**
 * better-sqlite3 adapter, for local development, scripts and the integration
 * test suite. Never used in the Worker runtime.
 *
 * The module is imported dynamically so the Worker bundle never pulls in a
 * native Node dependency.
 */

import type { SqlDatabase, SqlRunResult, SqlStatement, SqlValue } from './sql.js'

interface BetterSqliteStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}

interface BetterSqliteDatabase {
  prepare(sql: string): BetterSqliteStatement
  exec(sql: string): unknown
  transaction<T extends (...args: any[]) => any>(fn: T): T
  pragma(source: string): unknown
  close(): void
}

class SqliteStatement implements SqlStatement {
  constructor(
    private readonly db: BetterSqliteDatabase,
    private readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new SqliteStatement(this.db, this.sql, values)
  }

  private normalisedParams(): unknown[] {
    // SQLite has no boolean type; store as 0/1 exactly as D1 does.
    return this.params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p))
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.normalisedParams())
    return (row as T | undefined) ?? null
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...this.normalisedParams())
    return { results: rows as T[] }
  }

  async run(): Promise<SqlRunResult> {
    const info = this.db.prepare(this.sql).run(...this.normalisedParams())
    return {
      success: true,
      meta: { changes: info.changes, lastRowId: Number(info.lastInsertRowid) },
    }
  }

  /** Internal: expose the pieces so `batch` can execute inside a transaction. */
  parts(): { sql: string; params: unknown[] } {
    return { sql: this.sql, params: this.normalisedParams() }
  }
}

export interface SqliteDatabaseHandle extends SqlDatabase {
  close(): void
  /** For scripts needing multi-statement execution. */
  raw(): BetterSqliteDatabase
}

class SqliteDatabaseAdapter implements SqliteDatabaseHandle {
  constructor(private readonly db: BetterSqliteDatabase) {}

  prepare(sql: string): SqlStatement {
    return new SqliteStatement(this.db, sql)
  }

  async batch(statements: SqlStatement[]): Promise<SqlRunResult[]> {
    const parts = statements.map((s) => (s as SqliteStatement).parts())
    const tx = this.db.transaction((items: { sql: string; params: unknown[] }[]) => {
      const results: SqlRunResult[] = []
      for (const item of items) {
        const info = this.db.prepare(item.sql).run(...item.params)
        results.push({
          success: true,
          meta: { changes: info.changes, lastRowId: Number(info.lastInsertRowid) },
        })
      }
      return results
    })
    return tx(parts)
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql)
  }

  close(): void {
    this.db.close()
  }

  raw(): BetterSqliteDatabase {
    return this.db
  }
}

/**
 * Open a local SQLite database with the same pragmas D1 enforces:
 * foreign keys on, WAL journalling, and busy timeout for parallel test runs.
 */
export async function openSqlite(path = ':memory:'): Promise<SqliteDatabaseHandle> {
  const mod = await import('better-sqlite3')
  const Database = (mod.default ?? mod) as unknown as new (p: string) => BetterSqliteDatabase
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  return new SqliteDatabaseAdapter(db)
}
