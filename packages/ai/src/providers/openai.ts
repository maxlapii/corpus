/**
 * OpenAI-compatible provider. Also serves self-hosted / gateway endpoints via
 * `AI_BASE_URL`, which is why it is called "compatible" in configuration.
 */

import {
  AIProviderError,
  fetchJson,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIToolRequest,
} from '../provider.js'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o-mini'

interface OpenAiToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }
    finish_reason?: string
  }[]
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class OpenAiProvider implements AIProvider {
  readonly name: string

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    name = 'openai',
  ) {
    if (!apiKey) throw new AIProviderError('AI_API_KEY is not configured', name)
    this.name = name
  }

  async generateResponse(input: AIRequest): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: this.model || DEFAULT_MODEL,
      max_tokens: input.maxOutputTokens,
      temperature: input.temperature ?? 0,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }
    if (input.responseFormat === 'json') body.response_format = { type: 'json_object' }
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }

    const json = (await fetchJson(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      input.timeoutMs ?? 20_000,
      this.name,
    )) as OpenAiResponse

    const choice = json.choices?.[0]
    const toolRequests: AIToolRequest[] = (choice?.message?.tool_calls ?? [])
      .filter((c) => typeof c.function?.name === 'string')
      .map((c) => ({
        name: c.function!.name as string,
        arguments: parseArgs(c.function?.arguments),
        ...(c.id ? { callId: c.id } : {}),
      }))

    return {
      text: (choice?.message?.content ?? '').trim(),
      toolRequests,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      model: json.model ?? this.model,
      stopReason: mapFinish(choice?.finish_reason),
    }
  }
}

/** Tool arguments arrive as a JSON *string*; malformed input becomes `{}`. */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function mapFinish(reason: string | undefined): AIResponse['stopReason'] {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'length'
    default:
      return 'stop'
  }
}
