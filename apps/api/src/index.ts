/**
 * Worker entrypoint. Stateless per request (CLAUDE.md §4): the container is
 * built per request from bindings, and nothing survives between them.
 */

import { prefixedId } from '@corpus/shared'
import { createApp } from './app.js'
import { createContainer } from './container.js'
import { applyRetention } from './scheduled.js'
import type { WorkerEnv } from './env.js'

const app = createApp()

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx)
  },

  /** Retention (CLAUDE.md §29). Failures are logged, never propagated. */
  async scheduled(event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const container = createContainer(env, prefixedId('cron'))
    ctx.waitUntil(
      applyRetention(container.db, container.repos, container.logger)
        .then((outcomes) => {
          container.logger.info('scheduled maintenance complete', {
            action: 'maintenance.scheduled',
            result: 'ok',
            cron: event.cron,
            outcomes: outcomes.map((o) => `${o.table}:${o.removed}`).join(','),
          })
        })
        .catch((e: unknown) => {
          container.logger.error('scheduled maintenance failed', {
            action: 'maintenance.scheduled',
            result: 'error',
            cron: event.cron,
            error: e instanceof Error ? e.message : String(e),
          })
        }),
    )
  },
}

export { createApp }
export { applyRetention }
export type { WorkerEnv }
