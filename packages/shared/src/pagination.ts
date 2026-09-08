/** Pagination primitives. Every list endpoint is bounded (CLAUDE.md §52). */

export interface PageRequest {
  limit: number
  offset: number
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export function resolvePage(
  input: { limit?: number; offset?: number } | undefined,
  defaults: { defaultPageSize: number; maxPageSize: number },
): PageRequest {
  // A non-finite value (NaN from `Number('abc')`, or Infinity) is treated as
  // absent rather than propagated: it used to survive the clamp and reach the
  // SQL bind, turning a malformed query string into a 500.
  const finite = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  const limit = Math.min(
    Math.max(1, Math.floor(finite(input?.limit, defaults.defaultPageSize))),
    defaults.maxPageSize,
  )
  const offset = Math.max(0, Math.floor(finite(input?.offset, 0)))
  return { limit, offset }
}

export function makePage<T>(items: T[], total: number, page: PageRequest): Page<T> {
  return {
    items,
    total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.offset + items.length < total,
  }
}
