/**
 * Anthropic Messages API provider.
 *
 * The API key is read from Worker secrets and never leaves this module; it is
 * not logged and not returned in any response (CLAUDE.md §14, §40).
 */

import {
  AIProviderError,
  fetchJson,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIToolRequest,
} from '../provider.js'

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  model?: string
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
  ) {
    if (!apiKey) throw new AIProviderError('AI_API_KEY is not configured', 'anthropic')
  }

  async generateResponse(input: AIRequest): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: this.model || DEFAULT_MODEL,
      max_tokens: input.maxOutputTokens,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: input.temperature ?? 0,
    }
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    const json = (await fetchJson(
      API_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      },
      input.timeoutMs ?? 20_000,
      'anthropic',
    )) as AnthropicResponse

    const blocks = json.content ?? []
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim()

    const toolRequests: AIToolRequest[] = blocks
      .filter((b) => b.type === 'tool_use' && typeof b.name === 'string')
      .map((b) => ({
        name: b.name as string,
        arguments: (b.input ?? {}) as Record<string, unknown>,
        ...(b.id ? { callId: b.id } : {}),
      }))

    return {
      text,
      toolRequests,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
      model: json.model ?? this.model,
      stopReason: mapStopReason(json.stop_reason),
    }
  }
}

function mapStopReason(reason: string | undefined): AIResponse['stopReason'] {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'length'
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    default:
      return 'stop'
  }
}
