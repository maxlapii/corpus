/**
 * Test/script helper: an in-memory (or file-backed) SQLite database with every
 * migration applied. Node-only.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DatabaseService } from './database-service.js'
import { loadMigrationsFromDir } from './migration-files.js'
import { runMigrations } from './migrations.js'
import { createRepositories, type Repositories } from './repositories/index.js'
import { openSqlite, type SqliteDatabaseHandle } from './sqlite-adapter.js'

/** Absolute path to the repository's `migrations/` directory. */
export function migrationsDir(): string {
  // packages/db/src → repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations')
}

export interface TestDatabase {
  handle: SqliteDatabaseHandle
  db: DatabaseService
  repos: Repositories
  close(): void
}

export async function createTestDatabase(path = ':memory:'): Promise<TestDatabase> {
  const handle = await openSqlite(path)
  await runMigrations(handle, loadMigrationsFromDir(migrationsDir()))
  const db = new DatabaseService(handle)
  return {
    handle,
    db,
    repos: createRepositories(db),
    close: () => handle.close(),
  }
}
