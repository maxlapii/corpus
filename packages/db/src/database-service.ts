/**
 * The single place business logic touches SQL. Always parameterised — user
 * values are never interpolated, and dynamic identifiers are caller-whitelisted.
 */

import { internalError } from '@corpus/shared'
import type { SqlDatabase, SqlRunResult, SqlValue } from './sql.js'

export interface QueryOptions {
  /** Label used in slow-query logs. Never contains user data. */
  label?: string
}

export interface UnitOfWork {
  /** Queue a write. Nothing executes until `commit()`. */
  add(sql: string, params?: SqlValue[]): void
  size(): number
  commit(): Promise<SqlRunResult[]>
}

export class DatabaseService {
  constructor(private readonly db: SqlDatabase) {}

  /** Only migration and seed tooling should reach for this. */
  get raw(): SqlDatabase {
    return this.db
  }

  async one<T = Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = [],
    _options: QueryOptions = {},
  ): Promise<T | null> {
    try {
      return await this.db.prepare(sql).bind(...params).first<T>()
    } catch (e) {
      throw wrap(e, sql)
    }
  }

  async many<T = Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = [],
    _options: QueryOptions = {},
  ): Promise<T[]> {
    try {
      const res = await this.db.prepare(sql).bind(...params).all<T>()
      return res.results ?? []
    } catch (e) {
      throw wrap(e, sql)
    }
  }

  async run(sql: string, params: SqlValue[] = [], _options: QueryOptions = {}): Promise<SqlRunResult> {
    try {
      return await this.db.prepare(sql).bind(...params).run()
    } catch (e) {
      throw wrap(e, sql)
    }
  }

  async count(sql: string, params: SqlValue[] = []): Promise<number> {
    const row = await this.one<{ c: number }>(sql, params)
    return Number(row?.c ?? 0)
  }

  /**
   * Atomic multi-statement write. D1 `batch()` is an implicit transaction and
   * the SQLite adapter uses a real one, so partial application cannot happen.
   */
  async transaction(build: (uow: UnitOfWork) => void | Promise<void>): Promise<SqlRunResult[]> {
    const pending: { sql: string; params: SqlValue[] }[] = []
    const uow: UnitOfWork = {
      add: (sql, params = []) => {
        pending.push({ sql, params })
      },
      size: () => pending.length,
      commit: async () => this.commitPending(pending),
    }
    await build(uow)
    return this.commitPending(pending)
  }

  private async commitPending(
    pending: { sql: string; params: SqlValue[] }[],
  ): Promise<SqlRunResult[]> {
    if (pending.length === 0) return []
    try {
      const statements = pending.map((p) => this.db.prepare(p.sql).bind(...p.params))
      return await this.db.batch(statements)
    } catch (e) {
      throw wrap(e, pending.map((p) => p.sql).join('; '))
    }
  }
}

/** Keeps SQL text and driver internals away from the client (§46). */
function wrap(e: unknown, sql: string): Error {
  const message = e instanceof Error ? e.message : String(e)
  // Kept distinguishable so repositories can map them to CONFLICT.
  const err = internalError({ internal: { driverMessage: message, sql } })
  ;(err as unknown as { driverMessage: string }).driverMessage = message
  return err
}

export function isUniqueViolation(e: unknown): boolean {
  const m = (e as { driverMessage?: string } | null)?.driverMessage ?? ''
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|D1_ERROR.*UNIQUE/i.test(m)
}

export function isForeignKeyViolation(e: unknown): boolean {
  const m = (e as { driverMessage?: string } | null)?.driverMessage ?? ''
  return /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(m)
}

export function placeholders(count: number): string {
  if (count <= 0) throw new Error('placeholders() requires a positive count')
  return new Array(count).fill('?').join(', ')
}
