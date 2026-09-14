/**
 * The bots as an FAQ desk (CLAUDE.md §31, §32).
 *
 * Common questions have to get the approved answer rather than a command menu
 * or a failed attempt to act, while a question about someone's own figures must
 * still come from a tool. All of it arrives as ordinary chat, so these drive the
 * real webhooks end to end rather than calling the orchestrator directly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tenantScope } from '@corpus/db'
import { createHarness, TEST_WEBHOOK_SECRET, type Harness } from '../helpers/harness.js'

const EMPLOYEE_TELEGRAM_ID = 991_001

describe('the bots answer common questions', () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness()
    const employee = h.seed.employees.employee!
    await h.database.repos.telegramAccounts.link(tenantScope(h.seed.tenantId), {
      telegramUserId: String(EMPLOYEE_TELEGRAM_ID),
      scope: 'INTERNAL',
      employeeId: employee.id,
      userId: employee.userId,
    })
  })
  afterAll(() => h.close())

  /** Send one chat message and read back what the bot replied. */
  async function ask(bot: 'external' | 'internal', from: number, text: string): Promise<string> {
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
          chat: { id: from, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: from, first_name: 'Asker' },
          text,
        },
      }),
    })
    expect(response.status).toBe(200)

    const rows = await h.database.db.many<{ content: string }>(
      `SELECT m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND m.role = 'assistant'
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
      [h.seed.tenantId],
    )
    return rows[0]?.content ?? ''
  }

  describe('a candidate, on the public bot', () => {
    it.each([
      ['What is the working location?', /Phnom Penh/i],
      ['What documents do I need?', /CV/i],
      ['Can I apply for two positions?', /as many open roles/i],
      ['How long does the hiring process take?', /four weeks/i],
      ['Do you offer remote or hybrid work?', /remote/i],
    ])('answers %j', async (question, expected) => {
      const reply = await ask('external', 990_100 + question.length, question)
      expect(reply).toMatch(expected)
      // The menu is what they used to get instead of an answer.
      expect(reply, 'a command menu is not an answer').not.toContain('/apply —')
    })

    it('does not read a question about applying as an application', async () => {
      // "Can I apply for two positions?" once reached submit_application, which
      // failed for want of a name and an e-mail address.
      const reply = await ask('external', 990_200, 'How do I apply for a job?')
      expect(reply).toMatch(/job code|search for openings/i)
      expect(reply).not.toMatch(/could not|rephrase/i)
    })
  })

  describe('an employee, on the internal bot', () => {
    it('answers how to request sick leave with the approved process', async () => {
      const reply = await ask('internal', EMPLOYEE_TELEGRAM_ID, 'How do I request sick leave?')
      expect(reply).toMatch(/medical certificate/i)
      // Not an attempt to book leave with no dates, which is what it used to be.
      expect(reply).not.toMatch(/rephrase/i)
    })

    it('answers who approves leave from the approved process, not from their balances', async () => {
      const reply = await ask('internal', EMPLOYEE_TELEGRAM_ID, 'Who approves my leave request?')
      expect(reply).toMatch(/direct manager/i)
      expect(reply).not.toMatch(/day\(s\) available/)
    })

    it('answers their own balance from HRIS data', async () => {
      const reply = await ask(
        'internal',
        EMPLOYEE_TELEGRAM_ID,
        'How many annual leave days do I have?',
      )
      expect(reply).toMatch(/Annual Leave/i)
      expect(reply).toMatch(/\d+ day\(s\) available/)
      // Their own figures come from the tool, never from approved static text.
      expect(reply, 'a raw payload is not an answer').not.toContain('{')
      expect(reply, 'tool names are internal architecture').not.toContain('get_my_leave_balance')
    })
  })

  describe('the answers stay inside their audience', () => {
    it('refuses a candidate asking what an employee earns', async () => {
      const reply = await ask('external', 990_300, 'How much does the HR manager earn?')
      expect(reply).not.toMatch(/\d{4,}/)
    })

    it('does not serve an internal process answer to a candidate', async () => {
      // The same question an employee may ask, from outside the company.
      const reply = await ask('external', 990_301, 'How do I request sick leave?')
      expect(reply).not.toMatch(/medical certificate/i)
    })

    it('does not serve an account-gated answer to an unverified Telegram user', async () => {
      const reply = await ask('internal', 995_999, 'How do I reset my payroll portal password?')
      expect(reply).not.toMatch(/Forgot password/i)
    })
  })
})
