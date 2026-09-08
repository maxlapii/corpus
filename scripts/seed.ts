/**
 * Seeds the local development database (CLAUDE.md §50).
 *
 * Refuses to run against a production environment. All data is fictional.
 */

import { createLogger } from '@corpus/shared'
import { MemoryStorageService } from '@corpus/db'
import { SecurityEventService } from '@corpus/security'
import { DocumentIngestionService } from '@corpus/knowledge'
import { openLocalDb } from './local-db.js'
import { SEED_DOCUMENT_TEXTS, SEED_MARKER, seedDatabase } from './seed-data.js'

if (process.env.ENVIRONMENT === 'production') {
  console.error('Refusing to seed development data with ENVIRONMENT=production.')
  process.exit(1)
}

const logger = createLogger('warn')
const local = await openLocalDb()

console.log(`\n${SEED_MARKER}\n`)
const result = await seedDatabase(local.repos)

// Index the policy documents through the real ingestion pipeline so local
// search behaves exactly as it does in production.
const ingestion = new DocumentIngestionService({
  knowledge: local.repos.knowledge,
  storage: new MemoryStorageService(),
  securityEvents: new SecurityEventService(local.repos.securityEvents, logger),
  logger,
})

const today = new Date().toISOString().slice(0, 10)
const effectiveFrom = `${today.slice(0, 4)}-01-01`

for (const [key, documentId] of Object.entries(result.documentIds)) {
  const source = SEED_DOCUMENT_TEXTS[key]
  if (!source) continue
  const versions = await local.repos.knowledge.listVersions({ tenantId: result.tenantId }, documentId)
  if (versions.length > 0) {
    console.log(`  • ${source.name} already indexed (v${versions[0]!.version})`)
    continue
  }
  const document = await local.repos.knowledge.findDocumentById(
    { tenantId: result.tenantId },
    documentId,
  )
  if (!document) continue
  const ingested = await ingestion.ingestText({
    tenantId: result.tenantId,
    documentId,
    classification: document.classification,
    effectiveFrom,
    filename: `${source.name}.txt`,
    text: source.text,
    uploadedByUserId: null,
    supersedePrevious: true,
  })
  console.log(`  • ${source.name} indexed (${ingested.chunkCount} chunks, ${document.classification})`)
}

console.log('\nSeeded accounts (development only):')
for (const [key, employee] of Object.entries(result.employees)) {
  console.log(`  ${key.padEnd(10)} ${employee.email.padEnd(34)} roles=${employee.roles.join(',')}`)
}
console.log(`\nPassword for all seeded accounts: ${result.password}`)
console.log(`Database: ${local.path}`)
console.log('\nChange SEED_PASSWORD in your .env to use a different value.\n')

local.close()
