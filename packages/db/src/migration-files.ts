// Node-only: the Worker applies migrations through wrangler, not this.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Migration } from './migrations.js'

export function loadMigrationsFromDir(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}
