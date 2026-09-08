/**
 * Per-request setup: request id, container construction, structured access log.
 *
 * The access log records what CLAUDE.md §47 asks for and nothing sensitive.
 */

import { prefixedId } from '@corpus/shared'
import type { MiddlewareHandler } from 'hono'
import { createContainer } from '../container.js'
import type { AppBindings } from '../context.js'

export const REQUEST_ID_HEADER = 'x-request-id'

export const requestContext: MiddlewareHandler<AppBindings> = async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER)
  // An inbound id is echoed for tracing, but only if it looks like an id —
  // never interpolated anywhere but a header and a log field.
  const requestId =
    inbound && /^[A-Za-z0-9_-]{6,64}$/.test(inbound) ? inbound : prefixedId('req')

  c.set('requestId', requestId)
  c.set('startedAt', Date.now())
  c.set('container', createContainer(c.env, requestId))
  c.header(REQUEST_ID_HEADER, requestId)

  await next()

  const { logger } = c.get('container')
  logger.info('request', {
    requestId,
    route: new URL(c.req.url).pathname,
    method: c.req.method,
    result: String(c.res.status),
    latencyMs: Date.now() - c.get('startedAt'),
    userId: c.get('session')?.userId,
    tenantId: c.get('session')?.tenantId,
  })
}
