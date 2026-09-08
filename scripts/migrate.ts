/** Applies all migrations to the local development database. */

import { appliedMigrations } from '@corpus/db'
import { openLocalDb } from './local-db.js'

const local = await openLocalDb()
const applied = await appliedMigrations(local.handle)
console.log(`Database: ${local.path}`)
console.log(`Migrations applied (${applied.length}):`)
for (const name of applied) console.log(`  • ${name}`)
local.close()
