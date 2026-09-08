/**
 * Structured application errors.
 *
 * Rule (CLAUDE.md §46): user-facing payloads never contain stack traces, SQL
 * text, secrets or internal architecture. Every error therefore carries a
 * stable machine `code`, a safe `publicMessage`, and an optional `internal`
 * payload that is only ever written to the server log.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL'

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
}

export interface AppErrorOptions {
  /** Extra machine-readable detail that is safe to return to the caller. */
  details?: Record<string, unknown>
  /** Detail for server logs only. Never serialised into a response. */
  internal?: unknown
  cause?: unknown
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: Record<string, unknown>
  readonly internal?: unknown

  constructor(code: ErrorCode, publicMessage: string, options: AppErrorOptions = {}) {
    super(publicMessage)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS[code]
    this.details = options.details
    this.internal = options.internal ?? options.cause
  }

  /** Payload returned to clients. Deliberately narrow. */
  toPublicJSON(requestId?: string): {
    error: { code: ErrorCode; message: string; details?: Record<string, unknown>; requestId?: string }
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    }
  }
}

export const badRequest = (m = 'The request could not be processed.', o?: AppErrorOptions) =>
  new AppError('BAD_REQUEST', m, o)
export const validationFailed = (m = 'The submitted data is invalid.', o?: AppErrorOptions) =>
  new AppError('VALIDATION_FAILED', m, o)
export const unauthenticated = (m = 'Authentication is required.', o?: AppErrorOptions) =>
  new AppError('UNAUTHENTICATED', m, o)
export const forbidden = (m = 'You are not authorised to perform this action.', o?: AppErrorOptions) =>
  new AppError('FORBIDDEN', m, o)
export const notFound = (m = 'The requested resource was not found.', o?: AppErrorOptions) =>
  new AppError('NOT_FOUND', m, o)
export const conflict = (m = 'The request conflicts with the current state.', o?: AppErrorOptions) =>
  new AppError('CONFLICT', m, o)
export const rateLimited = (m = 'Too many requests. Please try again later.', o?: AppErrorOptions) =>
  new AppError('RATE_LIMITED', m, o)
export const internalError = (o?: AppErrorOptions) =>
  new AppError('INTERNAL', 'An unexpected error occurred.', o)

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/**
 * Normalise any thrown value into an AppError. Unknown throwables become a
 * generic INTERNAL error so that nothing leaks through the response body.
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e
  return internalError({ internal: e })
}
