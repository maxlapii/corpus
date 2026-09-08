/**
 * Shared helper for the local development scripts.
 *
 * These run on Node against a file-backed SQLite database, which is the
 * documented local substitute for D1 (CLAUDE.md §49). Production never uses it.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseService } from '@corpus/db'
import { loadMigrationsFromDir } from '@corpus/db/migration-files'
import { runMigrations } from '@corpus/db'
import { createRepositories, type Repositories } from '@corpus/db'
import { openSqlite, type SqliteDatabaseHandle } from '@corpus/db/sqlite-adapter'
import { migrationsDir } from '@corpus/db/test-support'

export function localDbPath(): string {
  return resolve(process.env.LOCAL_DB_PATH ?? './data/corpus.sqlite')
}

export interface LocalDb {
  handle: SqliteDatabaseHandle
  db: DatabaseService
  repos: Repositories
  path: string
  close(): void
}

export async function openLocalDb(options: { migrate?: boolean } = {}): Promise<LocalDb> {
  const path = localDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const handle = await openSqlite(path)
  if (options.migrate !== false) {
    const result = await runMigrations(handle, loadMigrationsFromDir(migrationsDir()))
    if (result.applied.length > 0) {
      console.log(`Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`)
    }
  }
  const db = new DatabaseService(handle)
  return { handle, db, repos: createRepositories(db), path, close: () => handle.close() }
}
