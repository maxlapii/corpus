/** Shared route helpers: identity access, pagination, resource fetch-or-404. */

import {
  notFound,
  num,
  object,
  optional,
  parse,
  resolvePage,
  type PageRequest,
  type Validator,
} from '@corpus/shared'
import { tenantScope, type TenantScope } from '@corpus/db'
import type { Identity, UserIdentity } from '@corpus/domain'
import type { Context } from 'hono'
import type { AppBindings } from '../context.js'
import { queryObject } from '../middleware/body.js'

export function identityOf(c: Context<AppBindings>): Identity {
  const identity = c.get('identity')
  if (!identity) throw new Error('identity middleware did not run for this route')
  return identity
}

export function userIdentityOf(c: Context<AppBindings>): UserIdentity {
  const identity = identityOf(c)
  if (identity.kind !== 'USER') throw new Error('route requires an internal identity')
  return identity
}

/**
 * The user account id for a dashboard-session route. `SessionService.resolve`
 * only produces an identity for a real, ACTIVE user row, so a null here is a
 * programming error (the route was mounted outside the session middleware),
 * not a runtime condition.
 */
export function sessionUserIdOf(c: Context<AppBindings>): string {
  const identity = userIdentityOf(c)
  if (identity.userId === null) {
    throw new Error('route requires a dashboard session identity with a user account')
  }
  return identity.userId
}

export function scopeOf(c: Context<AppBindings>): TenantScope {
  return tenantScope(identityOf(c).tenantId)
}

const pageQuery = object({
  limit: optional(num({ int: true, min: 1 })),
  offset: optional(num({ int: true, min: 0 })),
})

/**
 * Pagination from the query string. A malformed value is a 422 rather than a
 * silent default, so a broken client is told what is wrong; a valid but
 * oversized limit is clamped to the configured maximum (CLAUDE.md §52).
 */
export function pageOf(c: Context<AppBindings>): PageRequest {
  const limits = c.get('container').config.limits
  const parsed = parse(pageQuery, queryObject(c))
  return resolvePage(parsed, limits)
}

export function parseQuery<T>(c: Context<AppBindings>, validator: Validator<T>): T {
  return parse(validator, queryObject(c))
}

/** Fetch or throw a uniform 404. Never reveals whether the id exists elsewhere. */
export async function orNotFound<T>(value: Promise<T | null>, label = 'resource'): Promise<T> {
  const resolved = await value
  if (resolved === null || resolved === undefined) {
    throw notFound(`The requested ${label} was not found.`)
  }
  return resolved
}
