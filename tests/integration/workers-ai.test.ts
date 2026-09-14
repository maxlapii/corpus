/**
 * The Workers AI provider driving the real application.
 *
 * The `AI` binding is injected into the Worker environment exactly as
 * Cloudflare would, so this exercises the whole path — container wiring,
 * provider translation, tool registry, PolicyGateway — with no API key and no
 * network. What it cannot prove is Cloudflare's own response shape; the
 * provider's tolerance for both documented shapes is covered in
 * `tests/unit/ai-providers.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, seedEmail, type Harness } from '../helpers/harness.js'

interface Recorded {
  model: string
  body: Record<string, unknown>
}

/**
 * A stand-in for the Cloudflare AI binding: replies with a tool call the first
 * time it is asked, then with prose once tool results are in context.
 */
function fakeBinding(options: { tool?: string; answer?: string; fail?: Error } = {}) {
  const calls: Recorded[] = []
  return {
    calls,
    binding: {
      run: async (model: string, body: Record<string, unknown>) => {
        calls.push({ model, body })
        if (options.fail) throw options.fail

        const messages = (body.messages ?? []) as { role: string; content: string }[]
        const hasToolResults = messages.some((m) => m.content.includes('TOOL RESULTS'))
        const offered = new Set(
          ((body.tools ?? []) as { name: string }[]).map((t) => t.name),
        )

        if (!hasToolResults && options.tool && offered.has(options.tool)) {
          return { tool_calls: [{ name: options.tool, arguments: {} }] }
        }
        return {
          response: options.answer ?? 'Answer from Workers AI.',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }
      },
    },
  }
}

describe('Workers AI end to end', () => {
  let h: Harness
  afterEach(() => h?.close())

  it('reports itself configured with no API key', async () => {
    const { binding } = fakeBinding()
    h = await createHarness({ env: { AI_PROVIDER: 'workers-ai', AI: binding } })

    const { status, body } = await h.json('/health')
    expect(status).toBe(200)
    expect(body.config.aiProvider).toBe('workers-ai')
    expect(body.config.aiConfigured).toBe(true)
    expect(body.configErrors).toEqual([])
  })

  it('runs an authorised tool and answers from its result', async () => {
    const { binding, calls } = fakeBinding({ tool: 'get_my_leave_balance' })
    h = await createHarness({ env: { AI_PROVIDER: 'workers-ai', AI: binding } })
    const employee = await h.login(seedEmail(h.seed, 'employee'))

    const asked = await employee.post('/assistant/ask', {
      message: 'How many annual leave days do I have left?',
    })
    expect(asked.status).toBe(200)
    expect(asked.body.toolCalls).toEqual([
      { name: 'get_my_leave_balance', decision: 'ALLOW', reasonCode: 'leave.read.self' },
    ])
    expect(asked.body.reply).toBe('Answer from Workers AI.')

    // The binding saw the system prompt first and the tool list, and the
    // second call carried the authorised results.
    const planning = calls.find((c) => Array.isArray(c.body.tools))!
    expect((planning.body.messages as any[])[0].role).toBe('system')
    expect(planning.model).toBe('@cf/meta/llama-3.1-8b-instruct')
    const answering = calls.at(-1)!
    expect(JSON.stringify(answering.body.messages)).toContain('TOOL RESULTS')
  })

  it('offers an external caller only recruitment tools', async () => {
    const { binding, calls } = fakeBinding({ tool: 'search_jobs' })
    h = await createHarness({ env: { AI_PROVIDER: 'workers-ai', AI: binding } })

    const response = await h.request('/telegram/external', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret-value-0123456789abcdef',
      },
      body: JSON.stringify({
        update_id: 505001,
        message: {
          message_id: 1,
          chat: { id: 505001, type: 'private' },
          date: 1,
          from: { id: 505001, first_name: 'Candidate' },
          text: 'What jobs are available?',
        },
      }),
    })
    expect(response.status).toBe(200)

    const offered = calls
      .flatMap((c) => ((c.body.tools ?? []) as { name: string }[]).map((t) => t.name))
    expect(offered.length).toBeGreaterThan(0)
    // The public bot must never even be told internal tools exist.
    for (const name of offered) {
      expect(name).not.toMatch(/leave|employee|policy|candidate|approve/)
    }
  })

  it('still refuses a restricted request, whatever the model returns', async () => {
    // The binding is told to answer with a salary figure; the backend refuses
    // before the model is ever consulted.
    const { binding, calls } = fakeBinding({ answer: 'Their salary is USD 4,500 per month.' })
    h = await createHarness({ env: { AI_PROVIDER: 'workers-ai', AI: binding } })
    const employee = await h.login(seedEmail(h.seed, 'employee'))

    const asked = await employee.post('/assistant/ask', {
      message: "What is Sam Coder's salary?",
    })
    expect(asked.status).toBe(200)
    expect(asked.body.refused).toBe(true)
    expect(asked.body.reply).not.toMatch(/4,?500|USD/)
    // Not a single call reached the model: the intent is pre-authorised.
    expect(calls).toEqual([])
  })

  it('degrades to a plain refusal when the daily allowance is exhausted', async () => {
    const { binding } = fakeBinding({ fail: new Error('Too many requests: quota exceeded') })
    h = await createHarness({ env: { AI_PROVIDER: 'workers-ai', AI: binding } })
    const employee = await h.login(seedEmail(h.seed, 'employee'))

    const asked = await employee.post('/assistant/ask', { message: 'What are the holidays?' })
    // Exhausting a daily free allowance is an operating state, not a crash.
    expect(asked.status).toBe(200)
    expect(asked.body.refused).toBe(true)
    expect(asked.body.reply).toMatch(/temporarily unavailable/i)
    // The provider's own message never reaches the user.
    expect(JSON.stringify(asked.body)).not.toContain('quota exceeded')
  })

  it('keeps answering from authorised tool results if the model dies mid-turn', async () => {
    // Succeeds on the planning call (requesting a tool), then fails.
    let call = 0
    const binding = {
      run: async (_model: string, body: Record<string, unknown>) => {
        call++
        if (call === 1) return { tool_calls: [{ name: 'get_holidays', arguments: {} }] }
        void body
        throw new Error('upstream capacity')
      },
    }
    h = await createHarness({ env: { AI_PROVIDER: 'workers-ai', AI: binding } })
    const employee = await h.login(seedEmail(h.seed, 'employee'))

    const asked = await employee.post('/assistant/ask', { message: 'What are the holidays?' })
    expect(asked.status).toBe(200)
    // The tool ran and was authorised, so its result is still reported rather
    // than discarded — and it contains only backend-returned facts.
    expect(asked.body.toolCalls).toEqual([
      { name: 'get_holidays', decision: 'ALLOW', reasonCode: 'leave.read.self' },
    ])
    // What the tool returned, written for a person: the fallback answer is the
    // holiday list itself, not the payload and not the tool's internal name.
    expect(asked.body.reply).toMatch(/upcoming holiday/i)
    expect(asked.body.reply).not.toContain('get_holidays')
    expect(asked.body.reply).not.toContain('{')
  })
})
