/**
 * E2E: HR trains a bot from the dashboard, and the bot answers with it.
 *
 * Covers the loop the feature exists for — a bot fails to answer, the question
 * lands in the backlog, HR writes an approved answer, and the next person to
 * ask gets that text rather than model prose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantScope } from '@corpus/db'
import { createHarness, seedEmail, TEST_WEBHOOK_SECRET, type Harness } from '../helpers/harness.js'

async function sendTelegram(
  h: Harness,
  bot: 'internal' | 'external',
  telegramUserId: number,
  text: string,
): Promise<number> {
  const updateId = Math.floor(Math.random() * 1e9)
  const response = await h.request(`/telegram/${bot}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: telegramUserId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        from: { id: telegramUserId, first_name: 'Tester' },
        text,
      },
    }),
  })
  return response.status
}

async function lastExternalReply(h: Harness): Promise<string> {
  const rows = await h.database.db.many<{ content: string }>(
    `SELECT m.content FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_EXTERNAL' AND m.role = 'assistant'
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
    [h.seed.tenantId],
  )
  return rows[0]?.content ?? ''
}

describe('E2E: bot training', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('HR publishes an answer and the external bot serves it verbatim', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))

    const created = await hr.post('/knowledge/answers', {
      question: 'Do you accept applications from graduates with no experience?',
      answer:
        'Yes. Roles marked "graduate" accept applications with no prior commercial experience.',
      category: 'RECRUITMENT',
      audience: 'EXTERNAL',
      classification: 'PUBLIC',
      status: 'DRAFT',
      phrases: ['graduate applications', 'can graduates apply with no experience'],
    })
    expect(created.status).toBe(201)
    const answerId = created.body.answer.id

    // A DRAFT is not served, which is the point of having a draft state.
    expect(await sendTelegram(h, 'external', 515151, 'can graduates apply with no experience?')).toBe(200)
    expect(await lastExternalReply(h)).not.toContain('no prior commercial experience')

    const published = await hr.post(`/knowledge/answers/${answerId}/status`, { status: 'ACTIVE' })
    expect(published.status).toBe(200)
    expect(published.body.answer.status).toBe('ACTIVE')

    expect(await sendTelegram(h, 'external', 515152, 'can graduates apply with no experience?')).toBe(200)
    expect(await lastExternalReply(h)).toContain('no prior commercial experience')
  })

  it('an unanswered internal question becomes the training backlog, then an answer', async () => {
    const employee = await h.login(seedEmail(h.seed, 'employee'))

    // Nothing approved covers this, so it is recorded rather than guessed at.
    const asked = await employee.post('/assistant/ask', {
      message: 'What is the company policy on sabbatical leave after ten years?',
    })
    expect(asked.status).toBe(200)

    const hrAdmin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const backlog = await hrAdmin.get('/knowledge/answers/unanswered?resolved=false')
    expect(backlog.status).toBe(200)
    const item = backlog.body.items.find((q: { question: string }) =>
      q.question.includes('sabbatical'),
    )
    expect(item, 'the unanswered question should reach the backlog').toBeTruthy()

    const created = await hrAdmin.post('/knowledge/answers', {
      question: 'What is the company policy on sabbatical leave after ten years?',
      answer: 'After ten years of service you may request up to three months of unpaid sabbatical.',
      audience: 'INTERNAL',
      classification: 'INTERNAL',
      status: 'ACTIVE',
      sourceUnansweredId: item.id,
    })
    expect(created.status).toBe(201)
    expect(created.body.answer.sourceUnansweredId).toBe(item.id)

    const resolved = await hrAdmin.post(`/knowledge/answers/unanswered/${item.id}/resolve`, {
      answerId: created.body.answer.id,
    })
    expect(resolved.status).toBe(200)

    const remaining = await hrAdmin.get('/knowledge/answers/unanswered?resolved=false')
    expect(
      remaining.body.items.some((q: { id: string }) => q.id === item.id),
      'the resolved question should leave the open backlog',
    ).toBe(false)

    // The same employee now gets the approved text back.
    const answered = await employee.post('/assistant/ask', {
      message: 'What is the company policy on sabbatical leave after ten years?',
    })
    expect(answered.status).toBe(200)
    expect(answered.body.reply).toContain('three months of unpaid sabbatical')
  })

  it('a new answer defaults to DRAFT, and a DRAFT is never served', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))

    // The dashboard form omits `status` on a plain save, so this is exactly
    // what "I filled the form and the bot ignored it" looks like.
    const created = await hr.post('/knowledge/answers', {
      question: 'What is the cycle-to-work allowance?',
      answer: 'The allowance is reimbursed once per calendar year.',
      audience: 'BOTH',
      classification: 'PUBLIC',
    })
    expect(created.status).toBe(201)
    expect(created.body.answer.status).toBe('DRAFT')

    const whileDraft = await hr.post('/knowledge/answers/preview', {
      question: 'What is the cycle-to-work allowance?',
      audience: 'EXTERNAL',
    })
    expect(whileDraft.body.matches).toHaveLength(0)

    await hr.post(`/knowledge/answers/${created.body.answer.id}/status`, { status: 'ACTIVE' })

    const published = await hr.post('/knowledge/answers/preview', {
      question: 'What is the cycle-to-work allowance?',
      audience: 'EXTERNAL',
    })
    expect(published.body.matches[0]?.wouldServe).toBe(true)
  })

  it('the preview shows an author what each bot would say, without publishing', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    await hr.post('/knowledge/answers', {
      question: 'What benefits do you offer new joiners?',
      answer: 'New joiners receive health cover from their first day.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      status: 'ACTIVE',
    })

    const preview = await hr.post('/knowledge/answers/preview', {
      question: 'What benefits do you offer new joiners?',
      audience: 'EXTERNAL',
    })
    expect(preview.status).toBe(200)
    expect(preview.body.matches[0].wouldServe).toBe(true)
    expect(preview.body.matches[0].answer).toContain('health cover')

    const miss = await hr.post('/knowledge/answers/preview', {
      question: 'How many parking spaces does the building have?',
      audience: 'EXTERNAL',
    })
    expect(miss.status).toBe(200)
    expect(miss.body.matches.every((m: { wouldServe: boolean }) => !m.wouldServe)).toBe(true)
  })

  it('editing an answer changes what the bot says on the next turn', async () => {
    const hrAdmin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const created = await hrAdmin.post('/knowledge/answers', {
      question: 'What is the notice period for a new joiner?',
      answer: 'The notice period during probation is one week.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      status: 'ACTIVE',
    })
    const id = created.body.answer.id

    expect(await sendTelegram(h, 'external', 616161, 'What is the notice period for a new joiner?')).toBe(200)
    expect(await lastExternalReply(h)).toContain('one week')

    const updated = await hrAdmin.put(`/knowledge/answers/${id}`, {
      question: 'What is the notice period for a new joiner?',
      answer: 'The notice period during probation is two weeks.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      status: 'ACTIVE',
    })
    expect(updated.status).toBe(200)

    expect(await sendTelegram(h, 'external', 616162, 'What is the notice period for a new joiner?')).toBe(200)
    expect(await lastExternalReply(h)).toContain('two weeks')
  })

  it('a served curated answer is recorded against the conversation', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    await hr.post('/knowledge/answers', {
      question: 'Which documents should I bring to an interview?',
      answer: 'Bring photo identification and your certificates.',
      audience: 'EXTERNAL',
      classification: 'PUBLIC',
      status: 'ACTIVE',
    })

    expect(await sendTelegram(h, 'external', 717171, 'Which documents should I bring to an interview?')).toBe(200)

    const scope = tenantScope(h.seed.tenantId)
    const messages = await h.database.db.many<{ role: string; content: string }>(
      `SELECT m.role, m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_EXTERNAL'
        ORDER BY m.created_at, m.rowid`,
      [scope.tenantId],
    )
    expect(messages.some((m) => m.role === 'user')).toBe(true)
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('photo identification'))).toBe(true)
  })
})
