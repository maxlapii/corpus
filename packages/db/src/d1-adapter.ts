import type { SqlDatabase } from './sql.js'

/** D1Database already satisfies SqlDatabase, so this is a guarded cast. */
export function fromD1(db: unknown): SqlDatabase {
  const looksLikeD1 =
    typeof db === 'object' && db !== null && typeof (db as { prepare?: unknown }).prepare === 'function'

  if (!looksLikeD1) throw new Error('The DB binding is missing or is not a D1 database')
  return db as SqlDatabase
}
