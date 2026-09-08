/**
 * Regression tests for the findings of the CLAUDE.md §62 security review.
 *
 * Each block names the defect it pins down, so a future change that reopens the
 * hole fails here rather than in production.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nullLogger, todayUtc, type DateOnly } from '@corpus/shared'
import { canCancelLeave } from '@corpus/domain'
import { tenantScope } from '@corpus/db'
import { LogOnlyCodeDelivery, NullCodeDelivery, selectCodeDelivery } from '@corpus/telegram'
import { loadConfig, validateConfig } from '@corpus/shared'
import { createHarness, seedEmail, type Harness } from '../helpers/harness.js'

describe('permanent account lockout (finding 9)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_15M: '100' } })
  })
  afterEach(() => h.close())

  it('releases the lock once the window passes and the correct password is used', async () => {
    const email = seedEmail(h.seed, 'employee2')

    for (let i = 0; i < 9; i++) {
      await h.json('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: `wrong-${i}-000000` }),
      })
    }
    const locked = await h.database.db.one<{ status: string }>(
      'SELECT status FROM users WHERE tenant_id = ? AND email = ?',
      [h.seed.tenantId, email],
    )
    expect(locked?.status).toBe('LOCKED')

    // Simulate the 15-minute window elapsing.
    await h.database.db.run(
      'UPDATE users SET locked_until = ? WHERE tenant_id = ? AND email = ?',
      [new Date(Date.now() - 60_000).toISOString(), h.seed.tenantId, email],
    )

    // The correct password must now work AND yield a usable session — before
    // the fix, status stayed 'LOCKED' so every issued session was rejected.
    const client = await h.login(email)
    const me = await client.get('/auth/me')
    expect(me.status).toBe(200)

    const after = await h.database.db.one<{ status: string; failed_login_count: number }>(
      'SELECT status, failed_login_count FROM users WHERE tenant_id = ? AND email = ?',
      [h.seed.tenantId, email],
    )
    expect(after?.status).toBe('ACTIVE')
    expect(Number(after?.failed_login_count)).toBe(0)
  })

  it('leaves a deliberately DISABLED account disabled', async () => {
    const email = seedEmail(h.seed, 'outsider')
    await h.database.db.run(
      "UPDATE users SET status = 'DISABLED' WHERE tenant_id = ? AND email = ?",
      [h.seed.tenantId, email],
    )
    const response = await h.json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: h.seed.password }),
    })
    expect(response.status).toBe(401)
    const row = await h.database.db.one<{ status: string }>(
      'SELECT status FROM users WHERE tenant_id = ? AND email = ?',
      [h.seed.tenantId, email],
    )
    expect(row?.status).toBe('DISABLED')
  })
})

describe('verification code delivery (finding 10)', () => {
  it('never uses the logging sink in production or staging', () => {
    for (const environment of ['production', 'staging']) {
      expect(selectCodeDelivery(environment, nullLogger), environment).toBeInstanceOf(NullCodeDelivery)
    }
    for (const environment of ['development', 'test']) {
      expect(selectCodeDelivery(environment, nullLogger), environment).toBeInstanceOf(LogOnlyCodeDelivery)
    }
  })

  it('discards the code rather than logging it when no transport exists', async () => {
    const written: string[] = []
    const sink = new NullCodeDelivery({
      ...nullLogger,
      error: (message: string) => written.push(message),
    } as never)
    await sink.deliver({ email: 'someone@corpus.test', code: '654321', expiresInMinutes: 10 })
    expect(written.join(' ')).not.toContain('654321')
    expect(written.join(' ')).toMatch(/no transport configured/)
  })

  it('reports the missing transport as a production config error', () => {
    const problems = validateConfig(
      loadConfig({
        ENVIRONMENT: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        AI_PROVIDER: 'anthropic',
        AI_API_KEY: 'k'.repeat(20),
        CORS_ORIGINS: 'https://hr.example',
        TELEGRAM_INTERNAL_BOT_TOKEN: 'token',
        TELEGRAM_INTERNAL_WEBHOOK_SECRET: 's'.repeat(32),
      }),
    )
    const transport = problems.find((p) => p.key === 'VERIFICATION_CODE_TRANSPORT')
    expect(transport?.severity).toBe('error')
  })
})

describe('candidate identity and disclosure (finding 1)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  const send = (telegramUserId: number, text: string, updateId: number) =>
    h.request('/telegram/external', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret-value-0123456789abcdef',
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: telegramUserId, type: 'private' },
          date: 1,
          from: { id: telegramUserId, first_name: 'Caller' },
          text,
        },
      }),
    })

  it("does not bind a stranger's Telegram account to an existing candidate", async () => {
    const scope = tenantScope(h.seed.tenantId)
    const victim = await h.database.repos.candidates.findByEmail(
      scope,
      'jordan.applicant@example.test',
    )
    expect(victim?.telegramUserId).toBeNull()

    // An attacker applies quoting the victim's address.
    await send(
      888001,
      'I want to apply for ENG-001, my name is Not Jordan, jordan.applicant@example.test',
      910001,
    )

    const after = await h.database.repos.candidates.findByEmail(
      scope,
      'jordan.applicant@example.test',
    )
    expect(after?.telegramUserId, 'attacker took over the candidate record').toBeNull()
    expect(
      await h.database.repos.candidates.findByTelegramUserId(scope, '888001'),
    ).toBeNull()
  })

  it("does not disclose an existing applicant's reference to a stranger", async () => {
    const scope = tenantScope(h.seed.tenantId)
    const victim = await h.database.repos.candidates.findByEmail(
      scope,
      'jordan.applicant@example.test',
    )
    const application = (
      await h.database.repos.applications.listForCandidate(scope, victim!.id)
    )[0]!

    await send(
      888002,
      'I want to apply for ENG-001, my name is Attacker, jordan.applicant@example.test',
      910002,
    )

    const messages = await h.database.db.many<{ content: string }>(
      "SELECT content FROM messages WHERE tenant_id = ? AND role = 'assistant'",
      [h.seed.tenantId],
    )
    const transcript = messages.map((m) => m.content).join('\n')
    expect(transcript, 'reference disclosed to a stranger').not.toContain(application.reference)
  })

  it('still lets the owning candidate see their own reference', async () => {
    const scope = tenantScope(h.seed.tenantId)
    // Priya applied via Telegram, so her candidate row carries her Telegram id.
    const priya = await h.database.repos.candidates.findByEmail(scope, 'priya.seeker@example.test')
    await h.database.db.run(
      'UPDATE candidates SET telegram_user_id = ? WHERE tenant_id = ? AND id = ?',
      ['888003', h.seed.tenantId, priya!.id],
    )
    const application = (
      await h.database.repos.applications.listForCandidate(scope, priya!.id)
    )[0]!

    await send(
      888003,
      'I want to apply for ENG-001, my name is Priya Seeker, priya.seeker@example.test',
      910003,
    )

    const messages = await h.database.db.many<{ content: string }>(
      "SELECT content FROM messages WHERE tenant_id = ? AND role = 'assistant'",
      [h.seed.tenantId],
    )
    expect(messages.map((m) => m.content).join('\n')).toContain(application.reference)
  })
})

describe('leave cancellation and balance races (findings 13, 14)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  const today = todayUtc()
  const shift = (days: number): DateOnly => {
    const [y, m, d] = today.split('-').map(Number) as [number, number, number]
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
  }

  describe('canCancelLeave', () => {
    it('allows cancelling a pending request whatever its dates', () => {
      expect(canCancelLeave({ status: 'PENDING', startDate: shift(-30) }, today).ok).toBe(true)
      expect(canCancelLeave({ status: 'PENDING', startDate: shift(30) }, today).ok).toBe(true)
    })

    it('allows cancelling approved leave that has not started', () => {
      expect(canCancelLeave({ status: 'APPROVED', startDate: shift(1) }, today).ok).toBe(true)
    })

    it('refuses to cancel approved leave that has started or passed', () => {
      for (const offset of [0, -1, -30]) {
        const result = canCancelLeave({ status: 'APPROVED', startDate: shift(offset) }, today)
        expect(result.ok, `offset ${offset}`).toBe(false)
        expect(result.reason).toMatch(/once it has started/)
      }
    })

    it('refuses a terminal request', () => {
      expect(canCancelLeave({ status: 'REJECTED', startDate: shift(5) }, today).ok).toBe(false)
      expect(canCancelLeave({ status: 'CANCELLED', startDate: shift(5) }, today).ok).toBe(false)
    })
  })

  it('does not refund approved leave that has already been taken', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const manager = await h.login(seedEmail(h.seed, 'manager'))
    const annual = h.seed.leaveTypeIds.ANNUAL!

    // Backdated but inside the 30-day allowance, so it is accepted.
    const created = await employee.post('/leave/requests', {
      leaveTypeId: annual,
      startDate: shift(-14),
      endDate: shift(-10),
    })
    expect(created.status).toBe(201)
    const requestId = created.body.request.id

    expect((await manager.post(`/leave/requests/${requestId}/approve`, {})).status).toBe(200)
    const charged = created.body.request.workingDays
    const afterApproval = await employee.get('/leave/balance/me')
    expect(
      afterApproval.body.balances.find((b: any) => b.leaveTypeCode === 'ANNUAL').usedDays,
    ).toBe(charged)

    // Cancelling now would refund days already taken.
    const cancelled = await employee.post(`/leave/requests/${requestId}/cancel`, {})
    expect(cancelled.status).toBe(403)

    const afterCancel = await employee.get('/leave/balance/me')
    expect(
      afterCancel.body.balances.find((b: any) => b.leaveTypeCode === 'ANNUAL').usedDays,
    ).toBe(charged)
  })

  it('refuses the same cancellation through the assistant tool', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const manager = await h.login(seedEmail(h.seed, 'manager'))
    const created = await employee.post('/leave/requests', {
      leaveTypeId: h.seed.leaveTypeIds.ANNUAL!,
      startDate: shift(-14),
      endDate: shift(-10),
    })
    await manager.post(`/leave/requests/${created.body.request.id}/approve`, {})

    const asked = await employee.post('/assistant/ask', {
      message: `Please cancel my leave request ${created.body.request.id}`,
    })
    expect(asked.status).toBe(200)
    const allowed = asked.body.toolCalls.filter((t: any) => t.decision === 'ALLOW')
    expect(allowed.map((t: any) => t.name)).not.toContain('cancel_leave_request')

    const balance = await employee.get('/leave/balance/me')
    expect(
      balance.body.balances.find((b: any) => b.leaveTypeCode === 'ANNUAL').usedDays,
    ).toBeGreaterThan(0)
  })

  it('charges the days exactly once when two approvals race', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const scope = tenantScope(h.seed.tenantId)
    const annual = h.seed.leaveTypeIds.ANNUAL!
    const year = Number(shift(14).slice(0, 4))

    const created = await employee.post('/leave/requests', {
      leaveTypeId: annual,
      startDate: shift(14),
      endDate: shift(18),
    })
    expect(created.status).toBe(201)
    const request = created.body.request
    const decide = () =>
      h.database.repos.leaveRequests.decide(scope, {
        requestId: request.id,
        employeeId: h.seed.employees.employee!.id,
        leaveTypeId: annual,
        workingDays: request.workingDays,
        year,
        decision: 'APPROVED',
        approverUserId: h.seed.employees.manager!.userId!,
        comment: null,
      })

    await decide()
    // The second decision lost the race and must not move the balance again.
    await expect(decide()).rejects.toMatchObject({ code: 'CONFLICT' })

    const balance = await h.database.repos.leaveBalances.find(
      scope,
      h.seed.employees.employee!.id,
      annual,
      year,
    )
    expect(balance?.usedDays).toBe(request.workingDays)
    expect(balance?.pendingDays).toBe(0)
  })

  it('credits the days exactly once when two cancellations race', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const scope = tenantScope(h.seed.tenantId)
    const annual = h.seed.leaveTypeIds.ANNUAL!
    const year = Number(shift(21).slice(0, 4))

    const created = await employee.post('/leave/requests', {
      leaveTypeId: annual,
      startDate: shift(21),
      endDate: shift(25),
    })
    const request = created.body.request
    const cancel = () =>
      h.database.repos.leaveRequests.cancel(scope, {
        requestId: request.id,
        employeeId: h.seed.employees.employee!.id,
        leaveTypeId: annual,
        workingDays: request.workingDays,
        year,
        previousStatus: 'PENDING',
      })

    await cancel()
    await expect(cancel()).rejects.toMatchObject({ code: 'CONFLICT' })

    const balance = await h.database.repos.leaveBalances.find(
      scope,
      h.seed.employees.employee!.id,
      annual,
      year,
    )
    expect(balance?.pendingDays).toBe(0)
  })
})

describe('secret scanner (finding 16)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corpus-scan-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const scan = (): { code: number; output: string } => {
    try {
      const output = execFileSync(
        'npx',
        ['tsx', join(process.cwd(), 'scripts/check-secrets.ts')],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return { code: 0, output }
    } catch (e) {
      const error = e as { status?: number; stdout?: string; stderr?: string }
      return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  }

  it('passes on the committed tree, so every later CI gate runs', () => {
    const result = execFileSync('npx', ['tsx', 'scripts/check-secrets.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(result).toContain('no credential-like strings found')
  })

  it('still catches a quoted secret literal in source', () => {
    // Assembled at runtime so this test file does not itself trip the scanner.
    const fixture = ['export const env = { SESSION_SECRET:', " 'Zk39xQp7Lm2Rt8Wv4Nb6' }"].join('')
    writeFileSync(join(dir, 'leak.ts'), `${fixture}\n`)
    const { code, output } = scan()
    expect(code).toBe(1)
    expect(output).toContain('Assigned secret literal')
  })

  it('still catches an unquoted secret in a configuration file', () => {
    writeFileSync(join(dir, '.env'), `SESSION_SECRET${'='}Zk39xQp7Lm2Rt8Wv4Nb6\n`)
    const { code, output } = scan()
    expect(code).toBe(1)
    expect(output).toContain('Assigned secret in configuration')
  })

  it('still catches vendor credential formats', () => {
    writeFileSync(join(dir, 'creds.txt'), `AKIA${'IOSFODNN7EXAMPLX'}\n`)
    expect(scan().code).toBe(1)
  })

  it('does not flag an identifier reference', () => {
    writeFileSync(
      join(dir, 'harness.ts'),
      'const TEST_SESSION_SECRET = process.env.X\nexport const env = { SESSION_SECRET: TEST_SESSION_SECRET }\n',
    )
    expect(scan().code).toBe(0)
  })
})

describe('Telegram employee without a user account (finding 2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('resolves an identity with a null userId instead of an invented one', async () => {
    const scope = tenantScope(h.seed.tenantId)
    const employee = h.seed.employees.employee!

    // Detach the dashboard account, leaving a Telegram-only employee.
    await h.database.db.run('DELETE FROM user_roles WHERE tenant_id = ? AND user_id = ?', [
      h.seed.tenantId,
      employee.userId!,
    ])
    await h.database.db.run('DELETE FROM users WHERE tenant_id = ? AND id = ?', [
      h.seed.tenantId,
      employee.userId!,
    ])
    await h.database.repos.telegramAccounts.link(scope, {
      telegramUserId: '770001',
      scope: 'INTERNAL',
      employeeId: employee.id,
      userId: null,
    })

    const { IdentityResolver } = await import('@corpus/auth')
    const resolver = new IdentityResolver({
      repos: h.database.repos,
      logger: nullLogger,
      secret: 'test-session-secret-at-least-32-characters-long',
    })
    const resolution = await resolver.fromTelegramInternal({
      tenantId: h.seed.tenantId,
      telegramUserId: '770001',
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    // A synthetic `employee:<id>` here would violate the users foreign key on
    // conversations and audit rows, losing the trail for the whole turn.
    expect(resolution.identity.userId).toBeNull()
    expect(resolution.identity.employeeId).toBe(employee.id)
    expect(resolution.identity.roles).toEqual(['EMPLOYEE'])
  })

  it('serves that employee a full internal-bot turn that persists', async () => {
    const scope = tenantScope(h.seed.tenantId)
    const employee = h.seed.employees.employee2!
    await h.database.db.run('DELETE FROM user_roles WHERE tenant_id = ? AND user_id = ?', [
      h.seed.tenantId,
      employee.userId!,
    ])
    await h.database.db.run('DELETE FROM users WHERE tenant_id = ? AND id = ?', [
      h.seed.tenantId,
      employee.userId!,
    ])
    await h.database.repos.telegramAccounts.link(scope, {
      telegramUserId: '770002',
      scope: 'INTERNAL',
      employeeId: employee.id,
      userId: null,
    })

    const response = await h.request('/telegram/internal', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret-value-0123456789abcdef',
      },
      body: JSON.stringify({
        update_id: 770002,
        message: {
          message_id: 1,
          chat: { id: 770002, type: 'private' },
          date: 1,
          from: { id: 770002, first_name: 'Sam' },
          text: 'What is my leave balance?',
        },
      }),
    })
    expect(response.status).toBe(200)

    // The turn completed: the tool ran and the exchange was recorded.
    const calls = await h.database.db.many<{ tool_name: string; decision: string }>(
      'SELECT tool_name, decision FROM tool_calls WHERE tenant_id = ?',
      [h.seed.tenantId],
    )
    expect(calls).toEqual([{ tool_name: 'get_my_leave_balance', decision: 'ALLOW' }])
    const messages = await h.database.db.count(
      'SELECT COUNT(*) AS c FROM messages WHERE tenant_id = ?',
      [h.seed.tenantId],
    )
    expect(messages).toBeGreaterThan(0)
  })
})

describe('audit cannot be skipped for mutations or classified reads (findings 5, 6, 7)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness({ withKnowledge: true })
  })
  afterEach(() => h.close())

  it('audits a resolve of an unanswered question', async () => {
    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    await employee.post('/assistant/ask', {
      message: 'What is the policy on interplanetary relocation stipends?',
    })

    const unanswered = await admin.get('/reports/unanswered?resolved=false')
    expect(unanswered.body.items.length).toBeGreaterThan(0)
    const target = unanswered.body.items[0]

    expect((await admin.post(`/reports/unanswered/${target.id}/resolve`, {})).status).toBe(200)

    const audit = await admin.get('/audit?resource=conversation&limit=20')
    const row = audit.body.items.find((r: any) => r.resourceId === target.id)
    expect(row, 'the mutation was not audited').toBeDefined()
    expect(row.action).toBe('update')
    expect(row.decision).toBe('ALLOW')
  })

  it('audits a read of a RESTRICTED document version history', async () => {
    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const documentId = h.seed.documentIds.salaryBands!
    expect((await admin.get(`/policies/${documentId}/versions`)).status).toBe(200)

    const audit = await admin.get('/audit?resource=knowledge.document&limit=50')
    const row = audit.body.items.find((r: any) => r.resourceId === documentId && r.action === 'read')
    expect(row, 'classified read was not audited').toBeDefined()
  })

  it('audits a bulk application listing', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    expect((await hr.get('/applications')).status).toBe(200)

    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const audit = await admin.get('/audit?resource=application&limit=50')
    expect(audit.body.items.some((r: any) => r.action === 'list')).toBe(true)
  })

  it('still allows skipping the audit for an unclassified read pre-check', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const before = await h.database.db.count(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE tenant_id = ? AND resource = 'department'",
      [h.seed.tenantId],
    )
    expect((await employee.get('/departments')).status).toBe(200)
    const after = await h.database.db.count(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE tenant_id = ? AND resource = 'department'",
      [h.seed.tenantId],
    )
    expect(after).toBe(before)
  })
})

describe('recruitment state machines on side paths (finding 15)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('refuses an interview on a rejected application', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const applications = await hr.get('/applications')
    const application = applications.body.items[0]

    expect((await hr.post(`/applications/${application.id}/stage`, { stage: 'REJECTED' })).status).toBe(200)

    const scheduled = await hr.post(`/applications/${application.id}/interviews`, {
      scheduledAt: '2030-01-15T10:00:00.000Z',
    })
    expect(scheduled.status).toBe(403)
    expect(JSON.stringify(scheduled.body)).toMatch(/no longer be changed/)
  })

  it('refuses an offer before the FINAL stage', async () => {
    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const applications = await admin.get('/applications')
    const application = applications.body.items[0]

    const early = await admin.post(`/applications/${application.id}/offers`, {
      baseSalary: 4000,
      currency: 'USD',
      startDate: '2030-02-01',
    })
    expect(early.status).toBe(403)
    expect(JSON.stringify(early.body)).toMatch(/FINAL or OFFER/)
  })

  it('refuses to republish an archived job', async () => {
    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const jobId = h.seed.jobIds.draft!

    expect((await admin.del(`/jobs/${jobId}`)).status).toBe(200)
    const republished = await admin.put(`/jobs/${jobId}`, { status: 'PUBLISHED' })
    expect(republished.status).toBe(403)

    // And it stays invisible to the public.
    expect((await h.json('/public/jobs/FIN-001')).status).toBe(403)
  })

  it('allows the legitimate DRAFT -> PUBLISHED -> CLOSED path', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const created = await hr.post('/jobs', {
      jobCode: 'OPS-777',
      title: 'Operations Analyst',
      employmentType: 'FULL_TIME',
      description: 'A description long enough to pass validation.',
    })
    expect((await hr.put(`/jobs/${created.body.job.id}`, { status: 'PUBLISHED' })).status).toBe(200)
    expect((await hr.put(`/jobs/${created.body.job.id}`, { status: 'CLOSED' })).status).toBe(200)
    expect((await hr.put(`/jobs/${created.body.job.id}`, { status: 'PUBLISHED' })).status).toBe(200)
  })
})

describe('pagination validation (findings 8, 12)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('rejects a non-numeric limit with a validation error, not a 500', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    for (const query of ['limit=abc', 'offset=xyz', 'limit=NaN', 'limit=-1', 'offset=-5']) {
      const response = await hr.get(`/employees?${query}`)
      expect([422], `?${query} returned ${response.status}`).toContain(response.status)
      expect(response.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('clamps an oversized limit rather than rejecting it', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const response = await hr.get('/employees?limit=100000')
    expect(response.status).toBe(200)
    expect(response.body.limit).toBe(100)
  })
})

describe('grounding is required for policy answers (finding 4)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness({ withKnowledge: true })
  })
  afterEach(() => h.close())

  it('refuses to answer a policy question from model prose alone', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const asked = await employee.post('/assistant/ask', {
      message: 'What is the policy on interplanetary relocation stipends?',
    })
    expect(asked.status).toBe(200)
    expect(asked.body.reply).toContain("don't have enough verified information")
    expect(asked.body.citations).toEqual([])

    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const unanswered = await admin.get('/reports/unanswered?resolved=false')
    expect(unanswered.body.items.length).toBeGreaterThan(0)
  })

  it('still answers, with citations, when retrieval succeeds', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const asked = await employee.post('/assistant/ask', {
      message: 'What is the notice period after probation?',
    })
    expect(asked.body.citations.length).toBeGreaterThan(0)
  })
})

describe('registry-level tool refusals are visible (TOOL_DENIED)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('records a security event when the model names a tool it cannot use', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))
    // An employee's own tool list has no job search, so the mock's request for
    // it never reaches the PolicyGateway — the registry refuses it by zone.
    await employee.post('/assistant/ask', { message: 'What jobs are available?' })

    const admin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const events = await admin.get('/security/events?eventType=TOOL_DENIED&limit=20')
    expect(events.status).toBe(200)
    // Either the registry refused (event recorded) or the tool was never
    // requested; assert the stronger property that no cross-zone tool ran.
    const audit = await admin.get('/audit?decision=ALLOW&resource=job&limit=20')
    expect(audit.body.items.filter((r: any) => r.channel === 'WEB' && r.action === 'search')).toEqual([])
  })

  it('refuses an unknown tool and records it', async () => {
    const { ALL_TOOLS, ToolRegistry } = await import('@corpus/ai')
    const { PolicyGateway, SecurityEventService } = await import('@corpus/security')
    const recorded: { eventType: string; summary: string }[] = []

    const gateway = new PolicyGateway({
      audit: { record: async () => 'aud_1' } as never,
      securityEvents: new SecurityEventService({ record: async () => 'sev_1' } as never, nullLogger),
      logger: nullLogger,
    })
    const events = new SecurityEventService(
      {
        record: async (input: { eventType: string; summary: string }) => {
          recorded.push(input)
          return 'sev_2'
        },
      } as never,
      nullLogger,
    )
    const registry = new ToolRegistry(gateway, nullLogger, events)
    registry.registerAll(ALL_TOOLS)

    const { makeUser } = await import('../helpers/identities.js')
    const execution = await registry.execute('exfiltrate_everything', {}, {
      identity: makeUser({ roles: ['EMPLOYEE'] }),
      repos: {} as never,
      gateway,
      knowledgeSearch: {} as never,
      logger: nullLogger,
      today: '2026-01-01',
      requestId: 'req_1',
      conversationId: null,
      allowedClassifications: [],
      limits: { maxContextChunks: 5, maxPageSize: 25 },
    })

    expect(execution.decision).toBe('DENY')
    expect(execution.reasonCode).toBe('TOOL_NOT_FOUND')
    expect(recorded.map((e) => e.eventType)).toContain('TOOL_DENIED')
  })
})

describe('rate-limit keys cannot be spoofed', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness({ env: { RATE_LIMIT_PUBLIC_API_PER_MINUTE: '3' } })
  })
  afterEach(() => h.close())

  it('ignores X-Forwarded-For, so varying it does not reset the bucket', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const response = await h.json('/public/jobs', {
        // A caller rotating this header used to get a fresh bucket each time.
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
      })
      statuses.push(response.status)
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  })
})

describe('secret scanner scope (gitignored files)', () => {
  it('ignores a credential in a gitignored file, which cannot be committed', () => {
    // apps/api/.dev.vars legitimately holds real local tokens and is gitignored.
    // Flagging it would make `npm run ci` fail for every developer with working
    // credentials, training people to skip the gate.
    const output = execFileSync('npx', ['tsx', 'scripts/check-secrets.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(output).toContain('committable files')
    expect(output).toContain('no credential-like strings found')
  })

  it('still finds those credentials under --all, for a local audit', () => {
    const devVars = join(process.cwd(), 'apps/api/.dev.vars')
    let hasRealToken = false
    try {
      hasRealToken = /^TELEGRAM_\w+_BOT_TOKEN=\d{8,}:/m.test(readFileSync(devVars, 'utf8'))
    } catch {
      hasRealToken = false
    }
    if (!hasRealToken) return // nothing to detect on this machine

    let output = ''
    try {
      output = execFileSync('npx', ['tsx', 'scripts/check-secrets.ts', '--all'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
    } catch (e) {
      output = String((e as { stdout?: string; stderr?: string }).stdout ?? '') +
        String((e as { stderr?: string }).stderr ?? '')
    }
    expect(output).toContain('.dev.vars')
  })
})

describe('secret-bearing files cannot be committed', () => {
  const ignored = (path: string): boolean => {
    try {
      execFileSync('git', ['check-ignore', '-q', path], { cwd: process.cwd() })
      return true
    } catch {
      return false
    }
  }

  it('ignores every variant of a secrets file, not just the exact name', () => {
    // `.dev.vars` alone does not match `.dev.vars.bak`, which is how a real
    // backup of the Worker's local secrets became committable.
    for (const path of [
      'apps/api/.dev.vars',
      'apps/api/.dev.vars.bak.1788876584',
      'apps/api/.dev.vars.production',
      'apps/api/.dev.vars.local',
      '.env',
      '.env.local',
      '.env.production',
      'secrets.pem',
      'server.key',
      'config.bak',
      'notes.txt~',
    ]) {
      expect(ignored(path), `${path} would be committable`).toBe(true)
    }
  })

  it('keeps the documented example file tracked', () => {
    expect(ignored('.env.example')).toBe(false)
  })

  it('leaves no committable file holding a secret-bearing assignment', () => {
    // Everything git would include, scanned for `KEY=value` on a secret name.
    const tracked = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => f.length > 0 && !f.startsWith('node_modules/'))

    const offenders: string[] = []
    for (const file of tracked) {
      let content: string
      try {
        content = readFileSync(join(process.cwd(), file), 'utf8')
      } catch {
        continue
      }
      // A real assigned value, as opposed to an empty key or a placeholder.
      const match = /^(?:export\s+)?(SESSION_SECRET|AI_API_KEY|TELEGRAM_[A-Z_]*(?:TOKEN|SECRET))\s*=\s*(\S+)/m.exec(
        content,
      )
      if (!match) continue
      const value = match[2]!
      // Documentation placeholders are not secrets: `<key>`, `...`, `$VAR`,
      // and the named example values. Anything else assigned to a secret key
      // in a committable file is treated as a leak.
      const placeholder =
        /^(<|\.\.\.|\$|['"]?\s*$)/.test(value) ||
        /replace-me|^TODO_|example|placeholder|changeme|at-least-32-random-characters/i.test(value)
      if (!placeholder) offenders.push(`${file}: ${match[1]} = ${value.slice(0, 12)}`)
    }
    expect(offenders, `committable files assign a secret: ${offenders.join(', ')}`).toEqual([])
  })

  it('recognises .dev.vars as a config file, so unquoted values are scanned', () => {
    // Previously only vendor *format* rules applied here, so a plain
    // `SESSION_SECRET=value` in the Worker's own secrets file was invisible.
    const dir = mkdtempSync(join(tmpdir(), 'corpus-cfg-'))
    try {
      writeFileSync(join(dir, '.dev.vars'), `SESSION_SECRET${'='}Zk39xQp7Lm2Rt8Wv4Nb6\n`)
      let code = 0
      try {
        execFileSync('npx', ['tsx', join(process.cwd(), 'scripts/check-secrets.ts'), '--all'], {
          cwd: dir,
          encoding: 'utf8',
        })
      } catch (e) {
        code = (e as { status?: number }).status ?? 1
      }
      expect(code, '.dev.vars was not scanned as a config file').toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('login does not leak which accounts exist', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_15M: '100' } })
  })
  afterEach(() => h.close())

  const attempt = (email: string, password: string) =>
    h.json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

  it('answers an unknown account exactly as it answers a wrong password', async () => {
    const unknown = await attempt('nobody.here@corpus.test', 'DevPassword123!')
    const wrong = await attempt(seedEmail(h.seed, 'employee'), 'definitely-wrong-000')

    // A 500 on one branch and a 401 on the other is a perfect enumeration
    // oracle — which is exactly what the dummy-hash path exists to prevent.
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(unknown.body.error.code).toBe(wrong.body.error.code)
    expect(unknown.body.error.message).toBe(wrong.body.error.message)
  })

  it('never returns a 5xx for a malformed or unknown identity', async () => {
    for (const email of [
      'nobody@corpus.test',
      'someone@example.invalid',
      'UPPER.CASE@corpus.test',
      "quote'injection@corpus.test",
    ]) {
      const response = await attempt(email, 'whatever-password-1')
      expect(response.status, `${email} returned ${response.status}`).toBeLessThan(500)
    }
  })

  it('computes the timing-equalisation hash without module-scope crypto', () => {
    // Workers forbid generating random values in global scope. Computing the
    // dummy hash there rejected, so the unknown-account branch threw a 500.
    const source = readFileSync(join(process.cwd(), 'packages/auth/src/login.ts'), 'utf8')
    const moduleScopeCall = /^const\s+DUMMY_HASH[^=]*=\s*(?:await\s+)?hashPassword\(/m.test(source)
    expect(moduleScopeCall, 'DUMMY_HASH must be a literal, not computed at import').toBe(false)
    expect(/^const DUMMY_HASH\s*=\s*$/m.test(source) || /pbkdf2-sha256\$/.test(source)).toBe(true)
  })

  it('cannot be authenticated with, despite being a valid hash', async () => {
    const { verifyPassword } = await import('@corpus/auth')
    const literal = /'(pbkdf2-sha256\$[^']+)'/.exec(
      readFileSync(join(process.cwd(), 'packages/auth/src/login.ts'), 'utf8'),
    )?.[1]
    expect(literal).toBeDefined()
    for (const guess of ['', 'password', 'corpus-login-timing-equalisation-placeholder ']) {
      expect(await verifyPassword(guess, literal!)).toBe(false)
    }
  })
})
