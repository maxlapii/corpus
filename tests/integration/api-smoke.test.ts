/**
 * Boots the whole application and verifies the basics: health, login, session,
 * security headers, and that unauthenticated access is refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness, seedEmail, type Harness } from '../helpers/harness.js'

describe('API smoke', () => {
  let h: Harness
  beforeAll(async () => {
    h = await createHarness()
  })
  afterAll(() => h.close())

  it('reports health with the migrations applied', async () => {
    const { status, body } = await h.json('/health')
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.database).toBe('ok')
    expect(body.migrationsApplied).toBe(9)
  })

  it('never exposes secrets through /health', async () => {
    const response = await h.request('/health')
    const text = await response.text()
    expect(text).not.toContain('test-session-secret')
    expect(text).not.toContain('test-webhook-secret')
    expect(text).toContain('sessionSecretConfigured')
  })

  it('sets restrictive security headers', async () => {
    const response = await h.request('/health')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses unauthenticated access to internal routes', async () => {
    for (const path of ['/employees/me', '/leave/balance/me', '/policies', '/audit', '/security/events']) {
      const { status, body } = await h.json(path)
      expect(status, path).toBe(401)
      expect(body.error.code).toBe('UNAUTHENTICATED')
    }
  })

  it('logs in a seeded employee and returns a session plus CSRF token', async () => {
    const client = await h.login(seedEmail(h.seed, 'employee'))
    expect(client.token.length).toBeGreaterThan(20)
    expect(client.csrfToken.length).toBeGreaterThan(20)

    const me = await client.get('/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.roles).toEqual(['EMPLOYEE'])
    expect(me.body.user.email).toBe(seedEmail(h.seed, 'employee'))
  })

  it('rejects a wrong password with a generic message', async () => {
    const { status, body } = await h.json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: seedEmail(h.seed, 'employee'), password: 'wrong-password-123' }),
    })
    expect(status).toBe(401)
    expect(body.error.message).toBe('Those credentials are not valid.')
  })

  it('gives the same response for an unknown account as for a wrong password', async () => {
    const { status, body } = await h.json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@corpus.test', password: 'whatever-123456' }),
    })
    expect(status).toBe(401)
    expect(body.error.message).toBe('Those credentials are not valid.')
  })

  it('requires a CSRF token for state-changing requests', async () => {
    const client = await h.login(seedEmail(h.seed, 'employee'))
    // Same session, but the CSRF header omitted.
    const response = await h.request('/leave/requests', {
      method: 'POST',
      headers: { cookie: `corpus_session=${client.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaveTypeId: 'x', startDate: '2025-06-02', endDate: '2025-06-03' }),
    })
    expect(response.status).toBe(401)
  })

  it('revokes a session on logout', async () => {
    const client = await h.login(seedEmail(h.seed, 'employee2'))
    expect((await client.post('/auth/logout')).status).toBe(200)
    expect((await client.get('/auth/me')).status).toBe(401)
  })

  it('fails closed on unknown internal paths rather than revealing the route map', async () => {
    // The internal sub-app is mounted at `/` behind requireSession, so an
    // unmatched path is answered 401, not 404. That is deliberate: an
    // unauthenticated caller learns nothing about which routes exist.
    const { status, body } = await h.json('/does-not-exist')
    expect(status).toBe(401)
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('returns a stable 404 for an authenticated caller on an unknown path', async () => {
    const client = await h.login(seedEmail(h.seed, 'hr'))
    const { status, body } = await client.get('/does-not-exist')
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('answers a CORS preflight only for an allowed origin', async () => {
    const allowed = await h.request('/health', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')

    const denied = await h.request('/health', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})
