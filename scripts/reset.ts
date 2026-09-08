/** Deletes the local development database file. Development only. */

import { existsSync, rmSync } from 'node:fs'
import { localDbPath } from './local-db.js'

const path = localDbPath()
if (process.env.ENVIRONMENT === 'production') {
  console.error('Refusing to reset the database with ENVIRONMENT=production.')
  process.exit(1)
}

for (const suffix of ['', '-wal', '-shm']) {
  const file = `${path}${suffix}`
  if (existsSync(file)) {
    rmSync(file)
    console.log(`Removed ${file}`)
  }
}
console.log('Local database reset. Run `npm run db:migrate` to recreate it.')
