/**
 * Provider abstraction (CLAUDE.md §14), with emphasis on the two zero-cost
 * options: Workers AI (a binding, no account) and Google Gemini (free tier).
 *
 * The provider layer is where a vendor's response shape meets ours, so these
 * tests pin the translation in both directions and the failure behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, providerNeedsApiKey, validateConfig } from '@corpus/shared'
import {
  AIProviderError,
  GoogleProvider,
  MockAIProvider,
  WorkersAiProvider,
  createAIProvider,
  isWorkersAiBinding,
} from '@corpus/ai'

const REQUEST = {
  system: 'You are CORPUS.',
  messages: [{ role: 'user' as const, content: 'What is my leave balance?' }],
  maxOutputTokens: 200,
}

describe('provider selection', () => {
  it('treats binding-authenticated providers as needing no API key', () => {
    expect(providerNeedsApiKey('workers-ai')).toBe(false)
    expect(providerNeedsApiKey('mock')).toBe(false)
    expect(providerNeedsApiKey('google')).toBe(true)
    expect(providerNeedsApiKey('anthropic')).toBe(true)
    expect(providerNeedsApiKey('openai')).toBe(true)
  })

  it('does not demand an API key for workers-ai in production', () => {
    const problems = validateConfig(
      loadConfig({
        ENVIRONMENT: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        CORS_ORIGINS: 'https://hr.example',
        AI_PROVIDER: 'workers-ai',
      }),
    )
    expect(problems.find((p) => p.key === 'AI_API_KEY')).toBeUndefined()
    expect(problems.find((p) => p.key === 'AI_PROVIDER')).toBeUndefined()
  })

  it('still demands an API key for Google', () => {
    const problems = validateConfig(
      loadConfig({
        ENVIRONMENT: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        CORS_ORIGINS: 'https://hr.example',
        AI_PROVIDER: 'google',
      }),
    )
    expect(problems.find((p) => p.key === 'AI_API_KEY')?.severity).toBe('error')
  })

  it('rejects the mock provider in production', () => {
    const problems = validateConfig(
      loadConfig({
        ENVIRONMENT: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        CORS_ORIGINS: 'https://hr.example',
        AI_PROVIDER: 'mock',
      }),
    )
    expect(problems.find((p) => p.key === 'AI_PROVIDER')?.severity).toBe('error')
  })

  it('builds each provider from configuration', () => {
    const base = { SESSION_SECRET: 'x'.repeat(40), AI_API_KEY: 'k'.repeat(20) }
    const binding = { run: async () => ({ response: 'ok' }) }

    expect(createAIProvider(loadConfig({ ...base, AI_PROVIDER: 'mock' })).name).toBe('mock')
    expect(
      createAIProvider(loadConfig({ ...base, AI_PROVIDER: 'workers-ai' }), { workersAi: binding }).name,
    ).toBe('workers-ai')
    expect(createAIProvider(loadConfig({ ...base, AI_PROVIDER: 'google' })).name).toBe('google')
    expect(createAIProvider(loadConfig({ ...base, AI_PROVIDER: 'anthropic' })).name).toBe('anthropic')
    expect(createAIProvider(loadConfig({ ...base, AI_PROVIDER: 'openai' })).name).toBe('openai')
  })

  it('fails loudly when workers-ai is selected without the binding', () => {
    expect(() =>
      createAIProvider(loadConfig({ SESSION_SECRET: 'x'.repeat(40), AI_PROVIDER: 'workers-ai' })),
    ).toThrow(/requires the \[ai\] binding/)
  })

  it('falls back to the mock provider for an unknown provider name', () => {
    expect(createAIProvider(loadConfig({ AI_PROVIDER: 'definitely-not-real' })).name).toBe('mock')
  })
})

describe('WorkersAiProvider', () => {
  const bindingReturning = (result: unknown) => ({
    run: vi.fn(async (_model: string, _body: Record<string, unknown>) => result),
  })

  it('recognises a usable binding', () => {
    expect(isWorkersAiBinding({ run: () => {} })).toBe(true)
    expect(isWorkersAiBinding({})).toBe(false)
    expect(isWorkersAiBinding(null)).toBe(false)
    expect(isWorkersAiBinding(undefined)).toBe(false)
  })

  it('sends the system prompt as the first message and returns the text', async () => {
    const binding = bindingReturning({
      response: 'You have 12 days remaining.',
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    })
    const response = await new WorkersAiProvider(binding).generateResponse(REQUEST)

    expect(response.text).toBe('You have 12 days remaining.')
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 8 })
    expect(response.stopReason).toBe('stop')

    const [model, body] = binding.run.mock.calls[0]!
    expect(model).toBe('@cf/meta/llama-3.1-8b-instruct')
    expect((body as any).messages[0]).toEqual({ role: 'system', content: 'You are CORPUS.' })
    expect((body as any).messages[1]).toEqual({ role: 'user', content: REQUEST.messages[0]!.content })
    expect((body as any).max_tokens).toBe(200)
    expect((body as any).temperature).toBe(0)
  })

  it('honours a configured model', async () => {
    const binding = bindingReturning({ response: 'x' })
    await new WorkersAiProvider(binding, '@cf/meta/llama-3.3-70b-instruct-fp8-fast').generateResponse(
      REQUEST,
    )
    expect(binding.run.mock.calls[0]![0]).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  })

  it("advertises tools in Workers AI's flat format", async () => {
    const binding = bindingReturning({ response: '' })
    await new WorkersAiProvider(binding).generateResponse({
      ...REQUEST,
      tools: [
        {
          name: 'get_my_leave_balance',
          description: 'Own leave balance',
          parameters: { type: 'object', properties: {} },
        },
      ],
    })
    const body = binding.run.mock.calls[0]![1] as any
    // Flat, not the OpenAI `{ type: 'function', function: {...} }` envelope.
    expect(body.tools).toEqual([
      {
        name: 'get_my_leave_balance',
        description: 'Own leave balance',
        parameters: { type: 'object', properties: {} },
      },
    ])
  })

  it('omits the tools field entirely when none are offered', async () => {
    const binding = bindingReturning({ response: 'x' })
    await new WorkersAiProvider(binding).generateResponse(REQUEST)
    expect(binding.run.mock.calls[0]![1]).not.toHaveProperty('tools')
  })

  it('parses native tool calls, where arguments are already an object', async () => {
    const binding = bindingReturning({
      response: null,
      tool_calls: [{ name: 'get_job_details', arguments: { jobCode: 'ENG-001' } }],
    })
    const response = await new WorkersAiProvider(binding).generateResponse(REQUEST)
    expect(response.stopReason).toBe('tool_use')
    expect(response.toolRequests).toEqual([
      { name: 'get_job_details', arguments: { jobCode: 'ENG-001' } },
    ])
  })

  it('parses OpenAI-shaped tool calls, where arguments are a JSON string', async () => {
    const binding = bindingReturning({
      tool_calls: [
        { id: 'call_1', function: { name: 'search_jobs', arguments: '{"query":"backend"}' } },
      ],
    })
    const response = await new WorkersAiProvider(binding).generateResponse(REQUEST)
    expect(response.toolRequests).toEqual([
      { name: 'search_jobs', arguments: { query: 'backend' }, callId: 'call_1' },
    ])
  })

  it('drops malformed tool calls rather than guessing', async () => {
    const binding = bindingReturning({
      response: 'text',
      tool_calls: [
        { arguments: { a: 1 } }, // no name
        'not-an-object',
        { name: 'search_jobs', arguments: 'not json' },
      ],
    })
    const response = await new WorkersAiProvider(binding).generateResponse(REQUEST)
    // Only the named call survives; its unusable arguments become empty, so the
    // tool's own validator refuses it downstream.
    expect(response.toolRequests).toEqual([{ name: 'search_jobs', arguments: {} }])
  })

  it('tolerates an unexpected response shape without throwing', async () => {
    for (const result of [null, undefined, 'a string', 42, {}]) {
      const response = await new WorkersAiProvider(bindingReturning(result)).generateResponse(REQUEST)
      expect(response.text).toBe('')
      expect(response.toolRequests).toEqual([])
    }
  })

  it('marks a quota or capacity failure as retryable', async () => {
    const binding = {
      run: async () => {
        throw new Error('Too many requests: quota exceeded')
      },
    }
    await expect(new WorkersAiProvider(binding).generateResponse(REQUEST)).rejects.toMatchObject({
      name: 'AIProviderError',
      provider: 'workers-ai',
      retryable: true,
    })
  })

  it('marks an unexpected failure as not retryable', async () => {
    const binding = {
      run: async () => {
        throw new Error('model not found')
      },
    }
    await expect(new WorkersAiProvider(binding).generateResponse(REQUEST)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it('times out rather than hanging the Worker', async () => {
    const binding = { run: () => new Promise(() => {}) }
    await expect(
      new WorkersAiProvider(binding).generateResponse({ ...REQUEST, timeoutMs: 30 }),
    ).rejects.toMatchObject({ name: 'AIProviderError', retryable: true })
  })

  it('refuses to construct without a binding', () => {
    expect(() => new WorkersAiProvider(undefined as never)).toThrow(AIProviderError)
  })
})

describe('GoogleProvider', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(payload: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
      }
    }) as never
    return calls
  }

  it('requires an API key', () => {
    expect(() => new GoogleProvider('')).toThrow(AIProviderError)
  })

  it('sends the key in a header, never in the URL', async () => {
    const calls = stubFetch({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })
    await new GoogleProvider('secret-key-value').generateResponse(REQUEST)

    const call = calls[0]!
    expect(call.url).not.toContain('secret-key-value')
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key-value')
  })

  it('maps roles and the system prompt to the Gemini shape', async () => {
    const calls = stubFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    await new GoogleProvider('k').generateResponse({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
    })
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.systemInstruction.parts[0].text).toBe('You are CORPUS.')
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model'])
  })

  it('requests JSON when the classifier asks for it', async () => {
    const calls = stubFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })
    await new GoogleProvider('k').generateResponse({ ...REQUEST, responseFormat: 'json' })
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
  })

  it('strips schema keywords Gemini rejects', async () => {
    const calls = stubFetch({ candidates: [{ content: { parts: [{ text: '' }] } }] })
    await new GoogleProvider('k').generateResponse({
      ...REQUEST,
      tools: [
        {
          name: 'search_jobs',
          description: 'Search jobs',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { query: { type: 'string', default: '' } },
          },
        },
      ],
    })
    const body = JSON.parse(calls[0]!.init.body as string)
    const schema = body.tools[0].functionDeclarations[0].parameters
    expect(schema).not.toHaveProperty('additionalProperties')
    expect(schema.properties.query).not.toHaveProperty('default')
    expect(schema.properties.query.type).toBe('string')
  })

  it('extracts text and function calls', async () => {
    stubFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: 'Looking that up.' },
              { functionCall: { name: 'get_holidays', args: {} } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12 },
      modelVersion: 'gemini-2.0-flash-001',
    })
    const response = await new GoogleProvider('k').generateResponse(REQUEST)
    expect(response.text).toBe('Looking that up.')
    expect(response.toolRequests).toEqual([{ name: 'get_holidays', arguments: {} }])
    expect(response.stopReason).toBe('tool_use')
    expect(response.usage).toEqual({ inputTokens: 90, outputTokens: 12 })
    expect(response.model).toBe('gemini-2.0-flash-001')
  })

  it('reports length truncation, and treats a safety stop as a normal stop', async () => {
    stubFetch({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] })
    expect((await new GoogleProvider('k').generateResponse(REQUEST)).stopReason).toBe('length')

    stubFetch({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })
    const blocked = await new GoogleProvider('k').generateResponse(REQUEST)
    expect(blocked.stopReason).toBe('stop')
    // Empty text becomes the standard HR referral upstream, never a guess.
    expect(blocked.text).toBe('')
  })

  it('does not leak the provider body on an HTTP error', async () => {
    stubFetch({ error: { message: 'API key not valid: AIzaSyExample' } }, 400)
    await expect(new GoogleProvider('k').generateResponse(REQUEST)).rejects.toMatchObject({
      name: 'AIProviderError',
      provider: 'google',
      status: 400,
    })
    await expect(new GoogleProvider('k').generateResponse(REQUEST)).rejects.not.toMatchObject({
      message: expect.stringContaining('AIzaSy'),
    })
  })
})

describe('MockAIProvider remains the offline default', () => {
  it('needs no key, no binding and no network', async () => {
    const response = await new MockAIProvider().generateResponse({
      ...REQUEST,
      tools: [{ name: 'get_my_leave_balance', description: '', parameters: {} }],
    })
    expect(response.toolRequests.map((t) => t.name)).toEqual(['get_my_leave_balance'])
  })
})
