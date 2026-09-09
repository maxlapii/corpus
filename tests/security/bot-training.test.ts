/**
 * Security tests for dashboard-authored bot answers (CLAUDE.md §8, §9, §24).
 *
 * A curated answer is served verbatim with no model turn, so there is no
 * summarisation step to hide behind: whatever retrieval returns is exactly what
 * the user reads. These tests assert that retrieval never returns anything the
 * caller is not entitled to, from every direction that could go wrong —
 * audience, classification, status, effective date, tenant and role.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantScope } from '@corpus/db'
import { D1AnswerSearchService } from '@corpus/knowledge'
import { nullLogger } from '@corpus/shared'
import { createHarness, seedEmail, TEST_WEBHOOK_SECRET, type Harness } from '../helpers/harness.js'

const SECRET_ANSWER = 'Directors are paid between 9000 and 12000 USD per month.'
const PUBLIC_ANSWER = 'We post all openings on our careers channel.'

async function authorAnswer(
  h: Harness,
  input: {
    question: string
    answer: string
    audience: 'EXTERNAL' | 'INTERNAL' | 'BOTH'
    classification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'
    status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
    requiresAccount?: boolean
    effectiveFrom?: string
    effectiveTo?: string | null
    phrases?: string[]
    tenantId?: string
  },
) {
  return h.database.repos.knowledgeAnswers.create(tenantScope(input.tenantId ?? h.seed.tenantId), {
    question: input.question,
    answer: input.answer,
    category: 'GENERAL',
    audience: input.audience,
    classification: input.classification,
    status: input.status ?? 'ACTIVE',
    ...(input.requiresAccount === undefined ? {} : { requiresAccount: input.requiresAccount }),
    effectiveFrom: input.effectiveFrom ?? '2020-01-01',
    effectiveTo: input.effectiveTo ?? null,
    phrases: input.phrases ?? [],
    actorUserId: null,
  })
}

async function askExternalBot(h: Harness, text: string, telegramUserId = 909090): Promise<number> {
  const response = await h.request('/telegram/external', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: Math.floor(Math.random() * 1e9),
        chat: { id: telegramUserId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        from: { id: telegramUserId, first_name: 'Candidate' },
        text,
      },
    }),
  })
  return response.status
}

/** Retrieval as the external bot sees it: anonymous, PUBLIC ceiling. */
function externalSearch(h: Harness, query: string) {
  return h.database.repos.knowledgeAnswers.search(tenantScope(h.seed.tenantId), {
    query,
    compartment: 'EXTERNAL',
    verifiedAccount: true,
    allowedClassifications: ['PUBLIC'],
    onDate: '2026-06-01',
    limit: 10,
  })
}

describe('curated answers: audience isolation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('never serves an INTERNAL-audience answer to the external zone', async () => {
    await authorAnswer(h, {
      question: 'What is the director salary band?',
      answer: SECRET_ANSWER,
      audience: 'INTERNAL',
      classification: 'INTERNAL',
      phrases: ['director salary band'],
    })

    const hits = await externalSearch(h, 'director salary band')
    expect(hits).toHaveLength(0)
  })

  it('serves an EXTERNAL answer to the external zone', async () => {
    await authorAnswer(h, {
      question: 'Where are jobs advertised?',
      answer: PUBLIC_ANSWER,
      audience: 'EXTERNAL',
      classification: 'PUBLIC',
    })

    const hits = await externalSearch(h, 'Where are jobs advertised')
    expect(hits.map((hit) => hit.answer)).toContain(PUBLIC_ANSWER)
  })

  it('never serves an EXTERNAL-only answer to the internal zone', async () => {
    await authorAnswer(h, {
      question: 'Candidate only notice',
      answer: 'Applicants should bring photo identification.',
      audience: 'EXTERNAL',
      classification: 'PUBLIC',
    })

    const hits = await h.database.repos.knowledgeAnswers.search(tenantScope(h.seed.tenantId), {
      query: 'Candidate only notice',
      compartment: 'INTERNAL',
      verifiedAccount: true,
      allowedClassifications: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'],
      onDate: '2026-06-01',
      limit: 10,
    })
    expect(hits).toHaveLength(0)
  })

  it('serves a BOTH answer to either zone', async () => {
    await authorAnswer(h, {
      question: 'What are the office opening hours?',
      answer: 'Reception is open 08:30 to 17:30, Monday to Friday.',
      audience: 'BOTH',
      classification: 'PUBLIC',
    })

    for (const zone of ['EXTERNAL', 'INTERNAL'] as const) {
      const hits = await h.database.repos.knowledgeAnswers.search(tenantScope(h.seed.tenantId), {
        query: 'office opening hours',
        compartment: zone,
        verifiedAccount: true,
        allowedClassifications: ['PUBLIC'],
        onDate: '2026-06-01',
        limit: 10,
      })
      expect(hits.length, `zone ${zone}`).toBeGreaterThan(0)
    }
  })

  it('the LIKE fallback applies the same audience filter as FTS', async () => {
    await authorAnswer(h, {
      question: 'What is the director salary band?',
      answer: SECRET_ANSWER,
      audience: 'INTERNAL',
      classification: 'INTERNAL',
    })

    const hits = await h.database.repos.knowledgeAnswers.searchFallback(
      tenantScope(h.seed.tenantId),
      {
        terms: ['director', 'salary', 'band'],
        compartment: 'EXTERNAL',
        verifiedAccount: true,
        allowedClassifications: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'],
        onDate: '2026-06-01',
        limit: 10,
      },
    )
    expect(hits).toHaveLength(0)
  })
})

describe('curated answers: classification, status and dates', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('excludes a classification outside the caller ceiling', async () => {
    await authorAnswer(h, {
      question: 'What is the disciplinary escalation path?',
      answer: 'Escalate to the HR Director after a second written warning.',
      audience: 'INTERNAL',
      classification: 'CONFIDENTIAL',
    })

    const asEmployee = await h.database.repos.knowledgeAnswers.search(
      tenantScope(h.seed.tenantId),
      {
        query: 'disciplinary escalation path',
        compartment: 'INTERNAL',
        verifiedAccount: true,
        allowedClassifications: ['PUBLIC', 'INTERNAL'],
        onDate: '2026-06-01',
        limit: 10,
      },
    )
    expect(asEmployee).toHaveLength(0)

    const asHr = await h.database.repos.knowledgeAnswers.search(tenantScope(h.seed.tenantId), {
      query: 'disciplinary escalation path',
      compartment: 'INTERNAL',
      verifiedAccount: true,
      allowedClassifications: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      onDate: '2026-06-01',
      limit: 10,
    })
    expect(asHr).toHaveLength(1)
  })

  it('returns nothing when the caller has no authorised classification at all', async () => {
    await authorAnswer(h, {
      question: 'Anything at all',
      answer: PUBLIC_ANSWER,
      audience: 'BOTH',
      classification: 'PUBLIC',
    })

    const hits = await h.database.repos.knowledgeAnswers.search(tenantScope(h.seed.tenantId), {
      query: 'Anything at all',
      compartment: 'EXTERNAL',
      verifiedAccount: true,
      allowedClassifications: [],
      onDate: '2026-06-01',
      limit: 10,
    })
    expect(hits).toHaveLength(0)
  })

  it.each(['DRAFT', 'ARCHIVED'] as const)('never serves a %s answer', async (status) => {
    await authorAnswer(h, {
      question: 'Is this visible?',
      answer: 'This text is not approved for serving.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      status,
    })

    expect(await externalSearch(h, 'Is this visible')).toHaveLength(0)
  })

  it('respects effective dates, so a retired answer stops being served', async () => {
    await authorAnswer(h, {
      question: 'What was the old parking arrangement?',
      answer: 'Parking was free until the end of 2025.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      effectiveFrom: '2024-01-01',
      effectiveTo: '2025-12-31',
    })

    const scope = tenantScope(h.seed.tenantId)
    const whileEffective = await h.database.repos.knowledgeAnswers.search(scope, {
      query: 'old parking arrangement',
      compartment: 'EXTERNAL',
      verifiedAccount: true,
      allowedClassifications: ['PUBLIC'],
      onDate: '2025-06-01',
      limit: 10,
    })
    expect(whileEffective).toHaveLength(1)

    const afterExpiry = await h.database.repos.knowledgeAnswers.search(scope, {
      query: 'old parking arrangement',
      compartment: 'EXTERNAL',
      verifiedAccount: true,
      allowedClassifications: ['PUBLIC'],
      onDate: '2026-06-01',
      limit: 10,
    })
    expect(afterExpiry).toHaveLength(0)
  })

  it('does not serve an answer before it takes effect', async () => {
    await authorAnswer(h, {
      question: 'What is the new expenses limit?',
      answer: 'The limit rises in 2027.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      effectiveFrom: '2027-01-01',
    })
    expect(await externalSearch(h, 'new expenses limit')).toHaveLength(0)
  })
})

describe('curated answers: the database refuses an unsafe row', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it.each(['EXTERNAL', 'BOTH'] as const)(
    'rejects a non-PUBLIC %s answer even when inserted directly',
    async (audience) => {
      // Bypasses every application-layer check, leaving only the CHECK
      // constraint — which is the point: the schema is the last line.
      await expect(
        authorAnswer(h, {
          question: `Direct insert ${audience}`,
          answer: SECRET_ANSWER,
          audience,
          classification: 'RESTRICTED',
        }),
      ).rejects.toThrow()
    },
  )
})

describe('curated answers: tenant isolation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness({ secondTenant: true })
  })
  afterEach(() => h.close())

  it('does not return another tenant’s answer', async () => {
    const other = h.seedB!
    await authorAnswer(h, {
      question: 'Tenant B internal notice',
      answer: 'This belongs to the other company.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      tenantId: other.tenantId,
    })

    expect(await externalSearch(h, 'Tenant B internal notice')).toHaveLength(0)

    const inOwnTenant = await h.database.repos.knowledgeAnswers.search(
      tenantScope(other.tenantId),
      {
        query: 'Tenant B internal notice',
        compartment: 'EXTERNAL',
        verifiedAccount: true,
        allowedClassifications: ['PUBLIC'],
        onDate: '2026-06-01',
        limit: 10,
      },
    )
    expect(inOwnTenant).toHaveLength(1)
  })
})

describe('curated answers: authoring authorisation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  const draft = {
    question: 'Can an employee publish this?',
    answer: 'It should never be created by someone without faq.manage.',
    audience: 'INTERNAL',
    classification: 'INTERNAL',
    status: 'ACTIVE',
  }

  it.each([
    ['employee', 403],
    ['manager', 403],
    ['hr', 201],
    ['hrAdmin', 201],
    ['admin', 201],
  ] as const)('%s posting a new answer gets %i', async (key, expected) => {
    const client = await h.login(seedEmail(h.seed, key))
    const response = await client.post('/knowledge/answers', {
      ...draft,
      question: `${draft.question} ${key}`,
    })
    expect(response.status).toBe(expected)
  })

  it.each(['employee', 'manager'] as const)('%s cannot list curated answers', async (key) => {
    const client = await h.login(seedEmail(h.seed, key))
    expect((await client.get('/knowledge/answers')).status).toBe(403)
  })

  it.each(['employee', 'manager'] as const)('%s cannot read the training backlog', async (key) => {
    const client = await h.login(seedEmail(h.seed, key))
    expect((await client.get('/knowledge/answers/unanswered')).status).toBe(403)
  })

  it('rejects an EXTERNAL answer above PUBLIC through the API', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const response = await hr.post('/knowledge/answers', {
      question: 'Should never be created',
      answer: SECRET_ANSWER,
      audience: 'EXTERNAL',
      classification: 'CONFIDENTIAL',
    })
    expect(response.status).toBe(400)
    expect(String(response.body.error.message)).toMatch(/PUBLIC/i)
  })

  it('refuses to resurrect an archived answer', async () => {
    const hrAdmin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const created = await hrAdmin.post('/knowledge/answers', {
      question: 'Retired guidance',
      answer: 'This guidance has been withdrawn.',
      audience: 'INTERNAL',
      classification: 'INTERNAL',
      status: 'ACTIVE',
    })
    expect(created.status).toBe(201)
    const id = created.body.answer.id

    expect((await hrAdmin.post(`/knowledge/answers/${id}/status`, { status: 'ARCHIVED' })).status).toBe(200)
    const revive = await hrAdmin.post(`/knowledge/answers/${id}/status`, { status: 'ACTIVE' })
    expect(revive.status).toBe(409)
  })

  it('an external preview stays capped at PUBLIC even for an administrator', async () => {
    await authorAnswer(h, {
      question: 'What is the director salary band?',
      answer: SECRET_ANSWER,
      audience: 'INTERNAL',
      classification: 'RESTRICTED',
    })

    const admin = await h.login(seedEmail(h.seed, 'admin'))
    const preview = await admin.post('/knowledge/answers/preview', {
      question: 'What is the director salary band?',
      audience: 'EXTERNAL',
    })
    expect(preview.status).toBe(200)
    expect(JSON.stringify(preview.body)).not.toContain('9000')
  })
})

describe('curated answers: the external bot end to end', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('answers a candidate from approved text and leaks nothing internal', async () => {
    await authorAnswer(h, {
      question: 'Do you sponsor visas for new hires?',
      answer: 'We sponsor work permits for senior engineering roles only.',
      audience: 'EXTERNAL',
      classification: 'PUBLIC',
      phrases: ['visa sponsorship', 'do you sponsor visas'],
    })
    await authorAnswer(h, {
      question: 'What is the director salary band?',
      answer: SECRET_ANSWER,
      audience: 'INTERNAL',
      classification: 'RESTRICTED',
    })

    expect(await askExternalBot(h, 'Do you sponsor visas for new hires?')).toBe(200)

    const scope = tenantScope(h.seed.tenantId)
    const rows = await h.database.db.many<{ content: string; role: string }>(
      `SELECT m.content, m.role FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_EXTERNAL' AND m.role = 'assistant'
        ORDER BY m.created_at DESC LIMIT 5`,
      [scope.tenantId],
    )
    const replies = rows.map((r) => r.content).join('\n')
    expect(replies).toContain('work permits')
    expect(replies).not.toContain('9000')
  })

  it('scores a merely adjacent question below the serving threshold', async () => {
    await authorAnswer(h, {
      question: 'How do I reset my expenses portal password?',
      answer: 'Use the forgot-password link on the expenses portal.',
      audience: 'INTERNAL',
      classification: 'INTERNAL',
    })

    const service = new D1AnswerSearchService({
      answers: h.database.repos.knowledgeAnswers,
      logger: nullLogger,
    })

    // Shares the "password" stem but asks something else entirely. Retrieval
    // may surface the row; the coverage floor is what stops it being served.
    const adjacent = await service.search({
      tenantId: h.seed.tenantId,
      query: 'what is the minimum password complexity requirement for company laptops',
      compartment: 'INTERNAL',
      verifiedAccount: true,
      allowedClassifications: ['PUBLIC', 'INTERNAL'],
      onDate: '2026-06-01',
      limit: 3,
    })
    for (const answer of adjacent.answers) expect(answer.coverage).toBeLessThan(0.67)

    const onTopic = await service.search({
      tenantId: h.seed.tenantId,
      query: 'How do I reset my expenses portal password?',
      compartment: 'INTERNAL',
      verifiedAccount: true,
      allowedClassifications: ['PUBLIC', 'INTERNAL'],
      onDate: '2026-06-01',
      limit: 3,
    })
    expect(onTopic.answers[0]?.coverage).toBeGreaterThanOrEqual(0.67)
  })
})

describe('curated answers cannot bypass the RESTRICTED intent gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  // The curated lookup runs before the zone gate so a candidate can be served
  // approved public text. RESTRICTED-risk intents are excluded from that, and
  // this is the test that keeps the exclusion honest.
  it('refuses a salary question even when a curated answer would match it', async () => {
    await authorAnswer(h, {
      question: 'What is another employee salary?',
      answer: SECRET_ANSWER,
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      phrases: ['what is the salary of another employee', 'show me a colleague salary'],
    })

    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const response = await employee.post('/assistant/ask', {
      message: 'What is another employee salary?',
    })

    expect(response.status).toBe(200)
    expect(response.body.reply).not.toContain('9000')

    const denials = await h.database.db.many<{ decision: string }>(
      `SELECT decision FROM audit_logs
        WHERE tenant_id = ? AND decision = 'DENY' ORDER BY timestamp DESC LIMIT 5`,
      [h.seed.tenantId],
    )
    expect(denials.length, 'the refusal must leave an audited DENY').toBeGreaterThan(0)
  })

  it('refuses a candidate asking for salary data, curated answer or not', async () => {
    await authorAnswer(h, {
      question: 'What is the engineering salary band?',
      answer: SECRET_ANSWER,
      audience: 'BOTH',
      classification: 'PUBLIC',
      phrases: ['engineering salary band'],
    })

    expect(await askExternalBot(h, 'What is the engineering salary band?', 828282)).toBe(200)

    const rows = await h.database.db.many<{ content: string }>(
      `SELECT m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_EXTERNAL' AND m.role = 'assistant'
        ORDER BY m.created_at DESC LIMIT 3`,
      [h.seed.tenantId],
    )
    expect(rows.map((r) => r.content).join('\n')).not.toContain('9000')
  })
})

describe('curated answers: the verified-account gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  const internalSearch = (verifiedAccount: boolean, query: string) =>
    h.database.repos.knowledgeAnswers.search(tenantScope(h.seed.tenantId), {
      query,
      compartment: 'INTERNAL',
      verifiedAccount,
      allowedClassifications: verifiedAccount
        ? ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']
        : ['PUBLIC'],
      onDate: '2026-06-01',
      limit: 10,
    })

  it('withholds an account-gated answer from an unverified reader', async () => {
    await authorAnswer(h, {
      question: 'What is the office wifi password?',
      answer: 'Ask IT for the current guest credentials.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: true,
    })

    const unverified = await internalSearch(false, 'office wifi password')
    expect(unverified.map((h) => h.question)).not.toContain('What is the office wifi password?')

    const verified = await internalSearch(true, 'office wifi password')
    expect(verified.map((h) => h.question)).toContain('What is the office wifi password?')
  })

  it('serves a general answer to an unverified reader', async () => {
    await authorAnswer(h, {
      question: 'Where is the staff entrance?',
      answer: 'The staff entrance is on the north side of the building.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: false,
    })

    const hits = await internalSearch(false, 'Where is the staff entrance?')
    expect(hits.map((h) => h.question)).toContain('Where is the staff entrance?')
  })

  it('the LIKE fallback applies the same account gate', async () => {
    await authorAnswer(h, {
      question: 'What is the office wifi password?',
      answer: 'Ask IT for the current guest credentials.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: true,
    })

    const hits = await h.database.repos.knowledgeAnswers.searchFallback(
      tenantScope(h.seed.tenantId),
      {
        terms: ['office', 'wifi', 'password'],
        compartment: 'INTERNAL',
        verifiedAccount: false,
        allowedClassifications: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'],
        onDate: '2026-06-01',
        limit: 10,
      },
    )
    expect(hits).toHaveLength(0)
  })

  it.each(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const)(
    'the database refuses an ungated %s answer',
    async (classification) => {
      // The trigger in migration 0009 is the last line: classified text can
      // never be dropped out of the account gate, whatever the caller believes.
      await expect(
        authorAnswer(h, {
          question: `Ungated ${classification}`,
          answer: SECRET_ANSWER,
          audience: 'INTERNAL',
          classification,
          requiresAccount: false,
        }),
      ).rejects.toThrow()
    },
  )

  it('rejects an ungated classified answer through the API', async () => {
    const hrAdmin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const response = await hrAdmin.post('/knowledge/answers', {
      question: 'Ungated internal guidance',
      answer: 'Should never be reachable without an account.',
      audience: 'INTERNAL',
      classification: 'INTERNAL',
      requiresAccount: false,
    })
    expect(response.status).toBe(400)
    expect(String(response.body.error.message)).toMatch(/PUBLIC/i)
  })
})

describe('the internal bot and unverified users', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  async function askInternalBot(text: string, telegramUserId: number): Promise<number> {
    const response = await h.request('/telegram/internal', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 1e9),
        message: {
          message_id: Math.floor(Math.random() * 1e9),
          chat: { id: telegramUserId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: telegramUserId, first_name: 'Stranger' },
          text,
        },
      }),
    })
    return response.status
  }

  async function lastInternalReply(): Promise<string> {
    const rows = await h.database.db.many<{ content: string }>(
      `SELECT m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_INTERNAL' AND m.role = 'assistant'
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
      [h.seed.tenantId],
    )
    return rows[0]?.content ?? ''
  }

  it('answers a general question without a linked account', async () => {
    await authorAnswer(h, {
      question: 'What are the standard working hours?',
      answer: 'Standard hours are 08:30 to 17:30, Monday to Friday.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: false,
      phrases: ['what time does the office open', 'standard working hours'],
    })

    expect(await askInternalBot('What are the standard working hours?', 313001)).toBe(200)
    expect(await lastInternalReply()).toContain('08:30 to 17:30')
  })

  it('still refuses a personal question without a linked account', async () => {
    await authorAnswer(h, {
      question: 'What are the standard working hours?',
      answer: 'Standard hours are 08:30 to 17:30, Monday to Friday.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: false,
    })

    expect(await askInternalBot('What is my remaining leave balance?', 313002)).toBe(200)
    // Nothing is recorded, because nothing was answered: the refusal is the
    // verification prompt, which never reaches the conversation log.
    expect(await lastInternalReply()).toBe('')
  })

  it('never serves an account-gated answer to an unverified user', async () => {
    await authorAnswer(h, {
      question: 'What is the disciplinary escalation path?',
      answer: 'Escalate to the HR Director after a second written warning.',
      audience: 'INTERNAL',
      classification: 'CONFIDENTIAL',
      requiresAccount: true,
    })

    expect(await askInternalBot('What is the disciplinary escalation path?', 313003)).toBe(200)
    expect(await lastInternalReply()).not.toContain('HR Director after a second')
  })
})

describe('a curated answer never pre-empts a person-specific tool', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('answers "my leave balance" from the database, not from approved prose', async () => {
    // Deliberately worded to match: the words overlap heavily, and without the
    // person-specific exclusion this answer wins on coverage alone.
    await authorAnswer(h, {
      question: 'What is the annual leave balance policy?',
      answer: 'Everyone is entitled to 18 days of paid annual leave each year.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: false,
      phrases: ['leave balance', 'my leave balance', 'what is my remaining leave balance'],
    })

    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const asked = await employee.post('/assistant/ask', {
      message: 'What is my remaining leave balance?',
    })

    expect(asked.status).toBe(200)
    // The tool ran; the curated text did not short-circuit it.
    expect(asked.body.toolCalls.map((t: { name: string }) => t.name)).toContain(
      'get_my_leave_balance',
    )
    expect(asked.body.reply).not.toContain('Everyone is entitled to 18 days')
  })

  it('still serves a curated answer for an organisation-wide question', async () => {
    await authorAnswer(h, {
      question: 'What is the company policy on carrying leave over?',
      answer: 'Up to five unused days may be carried into the following year.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: false,
    })

    const employee = await h.login(seedEmail(h.seed, 'employee'))
    const asked = await employee.post('/assistant/ask', {
      message: 'What is the company policy on carrying leave over?',
    })
    expect(asked.body.reply).toContain('five unused days')
  })
})

describe('bot commands bound to curated answers', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  const withCommand = (
    input: Parameters<typeof authorAnswer>[1] & { command: string; commandDescription: string },
  ) =>
    h.database.repos.knowledgeAnswers.create(tenantScope(h.seed.tenantId), {
      question: input.question,
      answer: input.answer,
      category: 'GENERAL',
      audience: input.audience,
      classification: input.classification,
      status: input.status ?? 'ACTIVE',
      ...(input.requiresAccount === undefined ? {} : { requiresAccount: input.requiresAccount }),
      command: input.command,
      commandDescription: input.commandDescription,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      phrases: input.phrases ?? [],
      actorUserId: null,
    })

  const menu = (compartment: 'EXTERNAL' | 'INTERNAL') =>
    h.database.repos.knowledgeAnswers.listMenuCommands(tenantScope(h.seed.tenantId), {
      compartment,
      onDate: '2026-06-01',
    })

  it('lists a PUBLIC external command in the recruitment bot menu only', async () => {
    await withCommand({
      question: 'How should I prepare for an interview?',
      answer: 'Bring photo identification and read the job advert again.',
      audience: 'EXTERNAL',
      classification: 'PUBLIC',
      command: 'interview_tips',
      commandDescription: 'How to prepare for an interview',
    })

    expect((await menu('EXTERNAL')).map((c) => c.command)).toContain('interview_tips')
    expect((await menu('INTERNAL')).map((c) => c.command)).not.toContain('interview_tips')
  })

  it.each(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const)(
    'never lists a %s answer in a menu, because the menu is visible before verification',
    async (classification) => {
      await withCommand({
        question: `Sensitive ${classification} guidance`,
        answer: SECRET_ANSWER,
        audience: 'INTERNAL',
        classification,
        command: `secret_${classification.toLowerCase()}`,
        commandDescription: 'Should never appear in a menu',
      })

      for (const compartment of ['EXTERNAL', 'INTERNAL'] as const) {
        const commands = (await menu(compartment)).map((c) => c.command)
        expect(commands, compartment).not.toContain(`secret_${classification.toLowerCase()}`)
      }
    },
  )

  it.each(['DRAFT', 'ARCHIVED'] as const)('never lists a %s answer', async (status) => {
    await withCommand({
      question: 'Unpublished command',
      answer: 'Not live.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      status,
      command: 'unpublished',
      commandDescription: 'Not live yet',
    })
    expect((await menu('EXTERNAL')).map((c) => c.command)).not.toContain('unpublished')
  })

  it('refuses two answers claiming the same command', async () => {
    await withCommand({
      question: 'First claim',
      answer: 'A.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      command: 'duplicate',
      commandDescription: 'First',
    })
    await expect(
      withCommand({
        question: 'Second claim',
        answer: 'B.',
        audience: 'BOTH',
        classification: 'PUBLIC',
        command: 'duplicate',
        commandDescription: 'Second',
      }),
    ).rejects.toThrow()
  })

  it('the database refuses a command with no menu description', async () => {
    await expect(
      h.database.repos.knowledgeAnswers.create(tenantScope(h.seed.tenantId), {
        question: 'Bare command',
        answer: 'No description.',
        category: 'GENERAL',
        audience: 'BOTH',
        classification: 'PUBLIC',
        status: 'ACTIVE',
        command: 'bare',
        commandDescription: '   ',
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        phrases: [],
        actorUserId: null,
      }),
    ).rejects.toThrow()
  })

  it('the API refuses a command that shadows a built-in', async () => {
    const hrAdmin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const response = await hrAdmin.post('/knowledge/answers', {
      question: 'Hijack the verification flow',
      answer: 'Should never be created.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: false,
      command: 'verify',
      commandDescription: 'Definitely not',
    })
    expect(response.status).toBe(400)
    expect(String(response.body.error.message)).toMatch(/built-in/i)
  })

  it.each(['employee', 'manager'] as const)('%s cannot read or push the menus', async (key) => {
    const client = await h.login(seedEmail(h.seed, key))
    expect((await client.get('/knowledge/answers/commands')).status).toBe(403)
    expect((await client.post('/knowledge/answers/commands/sync', {})).status).toBe(403)
  })

  it('the menu preview always includes the built-ins alongside curated commands', async () => {
    // `/benefits` comes from the seed fixtures, on a BOTH-audience answer.

    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const response = await hr.get('/knowledge/answers/commands')
    expect(response.status).toBe(200)

    for (const m of response.body.menus) {
      const names = m.effective.map((c: { command: string }) => c.command)
      // setMyCommands replaces the whole list, so losing these would delete
      // the bot's own commands from the menu.
      expect(names, m.compartment).toContain('start')
      expect(names, m.compartment).toContain('help')
      expect(names, m.compartment).toContain('benefits')
    }
  })

  it('running a command goes through the ordinary authorisation path', async () => {
    // Bound to an account-gated answer, so an unverified Telegram user running
    // the command must get the verification prompt, not the text.
    await withCommand({
      question: 'What is the payroll escalation path?',
      answer: 'Escalate to the payroll lead, then to the HR Director.',
      audience: 'INTERNAL',
      classification: 'INTERNAL',
      requiresAccount: true,
      command: 'payroll',
      commandDescription: 'Payroll escalation',
    })

    const updateId = Math.floor(Math.random() * 1e9)
    const response = await h.request('/telegram/internal', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: 424001, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: 424001, first_name: 'Stranger' },
          text: '/payroll',
        },
      }),
    })
    expect(response.status).toBe(200)

    const rows = await h.database.db.many<{ content: string }>(
      `SELECT m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_INTERNAL' AND m.role = 'assistant'
        ORDER BY m.created_at DESC LIMIT 1`,
      [h.seed.tenantId],
    )
    expect(rows.map((r) => r.content).join('')).not.toContain('payroll lead')
  })

  it('an ungated command answers an unverified user', async () => {
    await withCommand({
      question: 'What are the standard working hours?',
      answer: 'Standard hours are 08:30 to 17:30, Monday to Friday.',
      audience: 'INTERNAL',
      classification: 'PUBLIC',
      requiresAccount: false,
      command: 'hours',
      commandDescription: 'Standard working hours',
    })

    const updateId = Math.floor(Math.random() * 1e9)
    await h.request('/telegram/internal', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: 424002, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: 424002, first_name: 'Stranger' },
          text: '/hours',
        },
      }),
    })

    const rows = await h.database.db.many<{ content: string }>(
      `SELECT m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_INTERNAL' AND m.role = 'assistant'
        ORDER BY m.created_at DESC LIMIT 1`,
      [h.seed.tenantId],
    )
    expect(rows[0]?.content ?? '').toContain('08:30 to 17:30')
  })
})
