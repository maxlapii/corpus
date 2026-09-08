/**
 * Cloudflare Workers AI — the zero-cost default (CLAUDE.md §3, §14).
 *
 * No API key and no external account: inference runs through the `AI` binding
 * on the same free tier as the Worker. The limit is a daily quota rather than a
 * bill, so exhaustion is an operating state — the binding throws and the caller
 * degrades to a refusal.
 */

import {
  AIProviderError,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIToolRequest,
} from '../provider.js'

/** Tool-calling support at a small neuron cost; override with AI_MODEL. */
export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct'

/** Declared structurally to avoid depending on the Workers AI types package. */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
}

interface WorkersAiResult {
  response?: string | null
  tool_calls?: unknown
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export function isWorkersAiBinding(binding: unknown): binding is WorkersAiBinding {
  return (
    typeof binding === 'object' &&
    binding !== null &&
    typeof (binding as { run?: unknown }).run === 'function'
  )
}

export class WorkersAiProvider implements AIProvider {
  readonly name = 'workers-ai'

  constructor(
    private readonly binding: WorkersAiBinding,
    private readonly model: string = DEFAULT_WORKERS_AI_MODEL,
  ) {
    if (!isWorkersAiBinding(binding)) {
      throw new AIProviderError('the AI binding is not configured', 'workers-ai')
    }
  }

  async generateResponse(input: AIRequest): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      // Workers AI has no separate system field.
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: input.maxOutputTokens,
      temperature: input.temperature ?? 0,
    }

    if (input.tools && input.tools.length > 0) {
      // Flat native format, not the OpenAI `{type:'function'}` envelope.
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    }

    const model = this.model || DEFAULT_WORKERS_AI_MODEL

    let raw: unknown
    try {
      raw = await withTimeout(
        this.binding.run(model, body),
        input.timeoutMs ?? 20_000,
        'workers-ai',
      )
    } catch (e) {
      if (e instanceof AIProviderError) throw e
      // Quota and capacity failures are retryable; the message is only logged.
      const message = e instanceof Error ? e.message : String(e)
      throw new AIProviderError(
        `Workers AI inference failed: ${message}`,
        'workers-ai',
        undefined,
        /capacity|quota|rate|timeout|503|429/i.test(message),
      )
    }

    const result = (typeof raw === 'object' && raw !== null ? raw : {}) as WorkersAiResult
    const toolRequests = parseToolCalls(result.tool_calls)

    return {
      text: (result.response ?? '').trim(),
      toolRequests,
      usage: {
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
      },
      model,
      stopReason: toolRequests.length > 0 ? 'tool_use' : 'stop',
    }
  }
}

/**
 * Accepts both shapes the binding returns — native `{name, arguments}` and
 * OpenAI-style `{function:{name, arguments}}` with a JSON string — so changing
 * AI_MODEL cannot silently stop tool use. Unrecognised entries are dropped.
 */
function parseToolCalls(value: unknown): AIToolRequest[] {
  if (!Array.isArray(value)) return []

  const requests: AIToolRequest[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as {
      name?: unknown
      arguments?: unknown
      id?: unknown
      function?: { name?: unknown; arguments?: unknown }
    }

    const name =
      typeof candidate.name === 'string'
        ? candidate.name
        : typeof candidate.function?.name === 'string'
          ? candidate.function.name
          : null
    if (!name) continue

    const rawArguments = candidate.arguments ?? candidate.function?.arguments
    requests.push({
      name,
      arguments: coerceArguments(rawArguments),
      ...(typeof candidate.id === 'string' ? { callId: candidate.id } : {}),
    })
  }
  return requests
}

function coerceArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Empty arguments let the tool's own validator refuse the call.
    }
  }
  return {}
}

/** The binding takes no abort signal, so the timeout is a race. */
async function withTimeout<T>(promise: Promise<T>, ms: number, provider: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AIProviderError('provider request timed out', provider, undefined, true)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
