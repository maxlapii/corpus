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
    zone: 'EXTERNAL',
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
      zone: 'INTERNAL',
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
        zone,
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
        zone: 'EXTERNAL',
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
        zone: 'INTERNAL',
        allowedClassifications: ['PUBLIC', 'INTERNAL'],
        onDate: '2026-06-01',
        limit: 10,
      },
    )
    expect(asEmployee).toHaveLength(0)

    const asHr = await h.database.repos.knowledgeAnswers.search(tenantScope(h.seed.tenantId), {
      query: 'disciplinary escalation path',
      zone: 'INTERNAL',
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
      zone: 'EXTERNAL',
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
      zone: 'EXTERNAL',
      allowedClassifications: ['PUBLIC'],
      onDate: '2025-06-01',
      limit: 10,
    })
    expect(whileEffective).toHaveLength(1)

    const afterExpiry = await h.database.repos.knowledgeAnswers.search(scope, {
      query: 'old parking arrangement',
      zone: 'EXTERNAL',
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
        zone: 'EXTERNAL',
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
      zone: 'INTERNAL',
      allowedClassifications: ['PUBLIC', 'INTERNAL'],
      onDate: '2026-06-01',
      limit: 3,
    })
    for (const answer of adjacent.answers) expect(answer.coverage).toBeLessThan(0.67)

    const onTopic = await service.search({
      tenantId: h.seed.tenantId,
      query: 'How do I reset my expenses portal password?',
      zone: 'INTERNAL',
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
