/**
 * Database abstraction (CLAUDE.md §5), deliberately shaped like D1 so D1
 * satisfies it unwrapped and SQLite plugs in for tests. Business logic depends
 * on DatabaseService, never D1, keeping the PostgreSQL path open.
 */

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array | boolean

export interface SqlRunMeta {
  changes: number
  lastRowId: number | null
  duration?: number
}

export interface SqlRunResult {
  success: boolean
  meta: SqlRunMeta
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<SqlRunResult>
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  batch(statements: SqlStatement[]): Promise<SqlRunResult[]>
  exec(sql: string): Promise<unknown>
}

export interface PendingWrite {
  sql: string
  params: SqlValue[]
}
