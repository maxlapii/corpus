/**
 * Request body reading with a hard size cap (CLAUDE.md §52).
 *
 * Workers charge for CPU and memory, so an unbounded body is both a cost and a
 * denial-of-service vector.
 */

import { badRequest, type AppError } from '@corpus/shared'
import { AppError as AppErrorClass } from '@corpus/shared'
import type { Context } from 'hono'
import type { AppBindings } from '../context.js'

export async function readJsonBody(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const limits = c.get('container').config.limits
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > limits.maxRequestBodyBytes) {
    throw payloadTooLarge(limits.maxRequestBodyBytes)
  }

  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw badRequest('This endpoint expects a JSON body.')
  }

  const text = await c.req.text()
  if (text.length > limits.maxRequestBodyBytes) throw payloadTooLarge(limits.maxRequestBodyBytes)
  if (text.trim().length === 0) return {}

  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw badRequest('The request body must be a JSON object.')
    }
    return parsed as Record<string, unknown>
  } catch (e) {
    if (e instanceof AppErrorClass) throw e
    throw badRequest('The request body is not valid JSON.')
  }
}

function payloadTooLarge(max: number): AppError {
  return new AppErrorClass('PAYLOAD_TOO_LARGE', `The request body must be at most ${max} bytes.`)
}

/** Query parameters as a plain object, for the shared validators. */
export function queryObject(c: Context<AppBindings>): Record<string, unknown> {
  const url = new URL(c.req.url)
  const out: Record<string, unknown> = {}
  for (const [key, value] of url.searchParams.entries()) {
    // Last value wins; array parameters are not accepted anywhere.
    out[key] = value
  }
  return out
}
