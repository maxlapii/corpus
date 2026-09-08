/**
 * Rate limiting and AI cost control (CLAUDE.md §37, §45, §52).
 *
 * Each surface is tested with its limit configured low, and the D1-backed
 * limiter is exercised (no KV binding is present in tests), so the fallback
 * path is the one under test.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { D1RateLimiter } from '@corpus/security'
import { createHarness, seedEmail, TEST_WEBHOOK_SECRET, type Harness } from '../helpers/harness.js'

describe('rate limiting', () => {
  let h: Harness
  afterEach(() => h?.close())

  it('throttles repeated failed logins per e-mail', async () => {
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_15M: '3' } })
    const email = seedEmail(h.seed, 'employee')

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const response = await h.json('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'definitely-wrong-000' }),
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(3)).toEqual([429, 429])

    // Even the correct password is throttled while the window is open, so the
    // limiter cannot be bypassed by finally guessing right.
    const correct = await h.json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: h.seed.password }),
    })
    expect(correct.status).toBe(429)
  })

  it('locks an account after repeated password failures, independent of the limiter', async () => {
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_15M: '100' } })
    const email = seedEmail(h.seed, 'employee2')

    for (let i = 0; i < 9; i++) {
      await h.json('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: `wrong-${i}-000000` }),
      })
    }
    const afterLock = await h.json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: h.seed.password }),
    })
    expect(afterLock.status).toBe(401)

    const row = await h.database.db.one<{ status: string; failed_login_count: number }>(
      'SELECT status, failed_login_count FROM users WHERE email = ? AND tenant_id = ?',
      [email, h.seed.tenantId],
    )
    expect(row?.status).toBe('LOCKED')
    expect(Number(row?.failed_login_count)).toBeGreaterThanOrEqual(8)
  })

  it('caps AI requests per user and records a security event', async () => {
    h = await createHarness({ env: { AI_REQUESTS_PER_HOUR: '2' } })
    const employee = await h.login(seedEmail(h.seed, 'employee'))

    const first = await employee.post('/assistant/ask', { message: 'What is my leave balance?' })
    const second = await employee.post('/assistant/ask', { message: 'What are the holidays?' })
    const third = await employee.post('/assistant/ask', { message: 'What is my leave balance?' })

    expect(first.body.refused).toBe(false)
    expect(second.body.refused).toBe(false)
    expect(third.body.refused).toBe(true)
    expect(third.body.reply).toMatch(/Too many requests/i)

    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const events = await admin.get('/security/events?eventType=RATE_LIMIT&limit=20')
    expect(events.body.items.length).toBeGreaterThan(0)
  })

  it('caps public application submissions per subject', async () => {
    h = await createHarness({ env: { RATE_LIMIT_APPLICATIONS_PER_HOUR: '2' } })

    const attempt = (n: number) =>
      h.json('/public/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobCode: 'ENG-001',
          fullName: `Applicant ${n}`,
          email: `applicant${n}@example.test`,
        }),
      })

    expect((await attempt(1)).status).toBe(201)
    expect((await attempt(2)).status).toBe(201)
    expect((await attempt(3)).status).toBe(429)
  })

  it('caps Telegram messages per user', async () => {
    h = await createHarness({ env: { RATE_LIMIT_TELEGRAM_PER_MINUTE: '2' } })

    const send = (updateId: number) =>
      h.request('/telegram/external', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: updateId,
          message: {
            message_id: updateId,
            chat: { id: 991001, type: 'private' },
            date: 1,
            from: { id: 991001, first_name: 'Spammer' },
            text: 'What jobs are available?',
          },
        }),
      })

    for (let i = 0; i < 4; i++) await send(970000 + i)

    // Telegram always receives 200; the throttle shows up as a security event.
    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const events = await admin.get('/security/events?eventType=RATE_LIMIT&limit=20')
    expect(events.body.items.length).toBeGreaterThan(0)
  })

  it('caps the admin API per user', async () => {
    h = await createHarness({ env: { RATE_LIMIT_ADMIN_API_PER_MINUTE: '5' } })
    const employee = await h.login(seedEmail(h.seed, 'employee'))

    const statuses: number[] = []
    for (let i = 0; i < 8; i++) statuses.push((await employee.get('/employees/me')).status)
    expect(statuses).toContain(429)
  })

  it('bounds every list endpoint with a maximum page size', async () => {
    h = await createHarness()
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const response = await hr.get('/employees?limit=100000')
    expect(response.status).toBe(200)
    // Clamped to MAX_PAGE_SIZE, not honoured verbatim.
    expect(response.body.limit).toBe(100)
  })

  it('rejects an oversized request body', async () => {
    h = await createHarness()
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const response = await employee.post('/assistant/ask', { message: 'x'.repeat(600_000) })
    expect([413, 422]).toContain(response.status)
  })

  it('shares counters through the D1 table so limits survive an isolate restart', async () => {
    h = await createHarness()
    const rule = { limit: 2, windowSeconds: 60 }
    // A fresh limiter instance over the same database must see prior usage.
    const first = new D1RateLimiter(h.database.db)
    const second = new D1RateLimiter(h.database.db)

    expect((await first.consume('shared:key', rule)).allowed).toBe(true)
    expect((await second.consume('shared:key', rule)).allowed).toBe(true)
    expect((await first.consume('shared:key', rule)).allowed).toBe(false)
  })
})
