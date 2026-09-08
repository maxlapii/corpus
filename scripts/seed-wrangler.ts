/**
 * Seed the *wrangler local D1* database used by `wrangler dev`.
 *
 * `npm run db:seed` targets the plain SQLite file used by scripts and tests.
 * `wrangler dev --local` keeps its own D1 store under `.wrangler/state`, so it
 * needs the same fixtures loaded into that file. Development only.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createLogger } from '@corpus/shared'
import { DatabaseService, MemoryStorageService, createRepositories, runMigrations } from '@corpus/db'
import { loadMigrationsFromDir } from '@corpus/db/migration-files'
import { openSqlite } from '@corpus/db/sqlite-adapter'
import { migrationsDir } from '@corpus/db/test-support'
import { SecurityEventService } from '@corpus/security'
import { DocumentIngestionService } from '@corpus/knowledge'
import { SEED_DOCUMENT_TEXTS, SEED_MARKER, seedDatabase } from './seed-data.js'

if (process.env.ENVIRONMENT === 'production') {
  console.error('Refusing to seed development data with ENVIRONMENT=production.')
  process.exit(1)
}

const stateDir = resolve('apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
if (!existsSync(stateDir)) {
  console.error(
    'No wrangler D1 state found. Run this first:\n' +
      '  cd apps/api && npx wrangler d1 migrations apply corpus --local',
  )
  process.exit(1)
}

const files = readdirSync(stateDir).filter((f) => f.endsWith('.sqlite'))
if (files.length !== 1) {
  console.error(`Expected exactly one D1 state file in ${stateDir}, found ${files.length}.`)
  process.exit(1)
}

const path = join(stateDir, files[0]!)
const handle = await openSqlite(path)
await runMigrations(handle, loadMigrationsFromDir(migrationsDir()))

const db = new DatabaseService(handle)
const repos = createRepositories(db)
const logger = createLogger('warn')

console.log(`\n${SEED_MARKER}\n`)
const result = await seedDatabase(repos)

const ingestion = new DocumentIngestionService({
  knowledge: repos.knowledge,
  storage: new MemoryStorageService(),
  securityEvents: new SecurityEventService(repos.securityEvents, logger),
  logger,
})

const year = new Date().getUTCFullYear()
for (const [key, documentId] of Object.entries(result.documentIds)) {
  const source = SEED_DOCUMENT_TEXTS[key]
  if (!source) continue
  const versions = await repos.knowledge.listVersions({ tenantId: result.tenantId }, documentId)
  if (versions.length > 0) continue
  const document = await repos.knowledge.findDocumentById({ tenantId: result.tenantId }, documentId)
  if (!document) continue
  const ingested = await ingestion.ingestText({
    tenantId: result.tenantId,
    documentId,
    classification: document.classification,
    effectiveFrom: `${year}-01-01`,
    filename: `${source.name}.txt`,
    text: source.text,
    uploadedByUserId: null,
    supersedePrevious: true,
  })
  console.log(`  • ${source.name} indexed (${ingested.chunkCount} chunks)`)
}

console.log('\nSeeded the wrangler local D1 store:')
for (const [key, employee] of Object.entries(result.employees)) {
  console.log(`  ${key.padEnd(10)} ${employee.email.padEnd(34)} ${employee.roles.join(',')}`)
}
console.log(`\nPassword: ${result.password}`)
console.log(`Store: ${path}\n`)

handle.close()
