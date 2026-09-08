/**
 * Date arithmetic on plain `YYYY-MM-DD` strings, in UTC.
 *
 * Leave calculations are deterministic backend logic (CLAUDE.md §38) so they
 * must never depend on the server's local timezone.
 */

export type DateOnly = string // YYYY-MM-DD

export function toUtcDate(d: DateOnly): Date {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, day))
}

export function fromUtcDate(d: Date): DateOnly {
  return d.toISOString().slice(0, 10)
}

export function isValidDateOnly(d: unknown): d is DateOnly {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  return fromUtcDate(toUtcDate(d)) === d
}

export function addDays(d: DateOnly, days: number): DateOnly {
  const dt = toUtcDate(d)
  dt.setUTCDate(dt.getUTCDate() + days)
  return fromUtcDate(dt)
}

/** Inclusive day count between two dates. */
export function daysBetweenInclusive(from: DateOnly, to: DateOnly): number {
  const ms = toUtcDate(to).getTime() - toUtcDate(from).getTime()
  return Math.floor(ms / 86_400_000) + 1
}

export function compareDates(a: DateOnly, b: DateOnly): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 0 = Sunday … 6 = Saturday, in UTC. */
export function dayOfWeek(d: DateOnly): number {
  return toUtcDate(d).getUTCDay()
}

export function eachDate(from: DateOnly, to: DateOnly, limit = 1000): DateOnly[] {
  const out: DateOnly[] = []
  let cur = from
  while (compareDates(cur, to) <= 0) {
    out.push(cur)
    if (out.length >= limit) break
    cur = addDays(cur, 1)
  }
  return out
}

export function todayUtc(now: Date = new Date()): DateOnly {
  return fromUtcDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())))
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

/** True when [aStart,aEnd] and [bStart,bEnd] share at least one day. */
export function rangesOverlap(
  aStart: DateOnly,
  aEnd: DateOnly,
  bStart: DateOnly,
  bEnd: DateOnly,
): boolean {
  return compareDates(aStart, bEnd) <= 0 && compareDates(bStart, aEnd) <= 0
}

/**
 * True when `date` falls inside an effective-dated window.
 * `from` is inclusive, `to` is inclusive; null `to` means "still in force".
 */
export function isEffectiveOn(
  date: DateOnly,
  from: DateOnly | null | undefined,
  to: DateOnly | null | undefined,
): boolean {
  if (from && compareDates(date, from) < 0) return false
  if (to && compareDates(date, to) > 0) return false
  return true
}
