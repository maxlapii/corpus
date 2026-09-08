/**
 * Health and readiness.
 *
 * Reports *degradation* honestly (missing R2, mock AI provider, unset secrets)
 * without leaking any secret value — `describeConfig` is secret-free.
 */

import { describeConfig } from '@corpus/shared'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'

export const healthRoutes = new Hono<AppBindings>()

healthRoutes.get('/', async (c) => {
  const container = c.get('container')

  let database: 'ok' | 'error' = 'ok'
  let migrations = 0
  try {
    const row = await container.db.one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM d1_migrations WHERE name LIKE '%.sql'",
    )
    migrations = Number(row?.c ?? 0)
  } catch {
    database = 'error'
  }

  const errors = container.configProblems.filter((p) => p.severity === 'error')
  const warnings = container.configProblems.filter((p) => p.severity === 'warning')
  const healthy = database === 'ok' && errors.length === 0

  return c.json(
    {
      status: healthy ? 'ok' : 'degraded',
      version: '0.1.0',
      database,
      migrationsApplied: migrations,
      documentStorage: container.storageDurable ? 'r2' : 'ephemeral',
      config: describeConfig(container.config),
      // Keys only, never values.
      configErrors: errors.map((p) => `${p.key}: ${p.message}`),
      configWarnings: warnings.map((p) => `${p.key}: ${p.message}`),
    },
    healthy ? 200 : 503,
  )
})

/** Liveness only — no database access, so it stays cheap. */
healthRoutes.get('/live', (c) => c.json({ status: 'ok' }))
