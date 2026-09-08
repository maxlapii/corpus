/**
 * Error boundary (CLAUDE.md §46).
 *
 * Clients receive a stable code and a safe message. Stack traces, SQL and
 * driver text stay on the server side, attached to the request id so an
 * operator can correlate.
 */

import { toAppError } from '@corpus/shared'
import type { ErrorHandler, NotFoundHandler } from 'hono'
import type { AppBindings } from '../context.js'

export const errorHandler: ErrorHandler<AppBindings> = (err, c) => {
  const requestId = c.get('requestId') ?? 'unknown'
  const appError = toAppError(err)

  // Container may be missing if the failure happened during setup.
  const logger = c.get('container')?.logger
  const detail = {
    requestId,
    route: new URL(c.req.url).pathname,
    method: c.req.method,
    errorCode: appError.code,
    result: String(appError.status),
    internal: appError.internal instanceof Error ? appError.internal.message : appError.internal,
  }
  if (appError.status >= 500) {
    logger?.error('unhandled request error', detail)
  } else {
    logger?.warn('request rejected', detail)
  }

  return c.json(appError.toPublicJSON(requestId), appError.status as 400)
}

export const notFoundHandler: NotFoundHandler<AppBindings> = (c) =>
  c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
        requestId: c.get('requestId') ?? undefined,
      },
    },
    404,
  )
