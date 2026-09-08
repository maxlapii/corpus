/**
 * Rate limiting (CLAUDE.md §45). Fixed-window counters over KV (preferred),
 * the `rate_limit_counters` D1 table (when no KV is bound), or memory (tests).
 */

export interface RateLimitRule {
  limit: number
  windowSeconds: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
  resetSeconds: number
}

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult>
}

export interface RateLimitConfig {
  telegramPerUser: RateLimitRule
  aiPerUser: RateLimitRule
  loginPerIdentifier: RateLimitRule
  verificationPerUser: RateLimitRule
  applicationPerSubject: RateLimitRule
  adminApiPerUser: RateLimitRule
  publicApiPerIp: RateLimitRule
}

export function createRateLimits(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    telegramPerUser: { limit: 30, windowSeconds: 60 },
    aiPerUser: { limit: 60, windowSeconds: 3600 },
    loginPerIdentifier: { limit: 10, windowSeconds: 900 },
    verificationPerUser: { limit: 5, windowSeconds: 900 },
    applicationPerSubject: { limit: 5, windowSeconds: 3600 },
    adminApiPerUser: { limit: 600, windowSeconds: 60 },
    publicApiPerIp: { limit: 120, windowSeconds: 60 },
    ...overrides,
  }
}

function windowStart(rule: RateLimitRule, now: number): number {
  return Math.floor(now / (rule.windowSeconds * 1000)) * rule.windowSeconds
}

/** Declared structurally to avoid a runtime dependency on the Workers types. */
export interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export class KvRateLimiter implements RateLimiter {
  constructor(private readonly kv: KvLike) {}

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = Date.now()
    const start = windowStart(rule, now)
    const bucket = `rl:${key}:${start}`

    // KV is eventually consistent, so a cold edge lets a few extra through.
    // Acceptable: authorisation, not the limiter, is what protects data.
    const current = Number((await this.kv.get(bucket)) ?? 0)
    const next = current + 1
    const resetSeconds = start + rule.windowSeconds - Math.floor(now / 1000)

    if (next > rule.limit) {
      return { allowed: false, remaining: 0, limit: rule.limit, resetSeconds }
    }
    await this.kv.put(bucket, String(next), { expirationTtl: Math.max(60, rule.windowSeconds + 60) })
    return { allowed: true, remaining: rule.limit - next, limit: rule.limit, resetSeconds }
  }
}

interface RateLimitDb {
  one<T>(sql: string, params?: unknown[]): Promise<T | null>
  run(sql: string, params?: unknown[]): Promise<unknown>
}

export class D1RateLimiter implements RateLimiter {
  constructor(private readonly db: RateLimitDb) {}

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = Date.now()
    const start = windowStart(rule, now)
    const bucket = `${key}:${start}`
    const expiresAt = start + rule.windowSeconds + 60
    const resetSeconds = start + rule.windowSeconds - Math.floor(now / 1000)

    await this.db.run(
      `INSERT INTO rate_limit_counters (bucket_key, window_start, count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (bucket_key) DO UPDATE SET count = count + 1`,
      [bucket, start, expiresAt],
    )
    const row = await this.db.one<{ count: number }>(
      'SELECT count FROM rate_limit_counters WHERE bucket_key = ?',
      [bucket],
    )
    const count = Number(row?.count ?? 1)
    if (count > rule.limit) {
      return { allowed: false, remaining: 0, limit: rule.limit, resetSeconds }
    }
    return { allowed: true, remaining: rule.limit - count, limit: rule.limit, resetSeconds }
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, number>()

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = Date.now()
    const start = windowStart(rule, now)
    const bucket = `${key}:${start}`
    const count = (this.counters.get(bucket) ?? 0) + 1
    this.counters.set(bucket, count)
    const resetSeconds = start + rule.windowSeconds - Math.floor(now / 1000)
    if (count > rule.limit) {
      return { allowed: false, remaining: 0, limit: rule.limit, resetSeconds }
    }
    return { allowed: true, remaining: rule.limit - count, limit: rule.limit, resetSeconds }
  }

  reset(): void {
    this.counters.clear()
  }
}

export class NoopRateLimiter implements RateLimiter {
  async consume(_key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    return { allowed: true, remaining: rule.limit, limit: rule.limit, resetSeconds: rule.windowSeconds }
  }
}
