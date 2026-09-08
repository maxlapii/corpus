/**
 * Google Gemini provider (CLAUDE.md §14).
 *
 * The second zero-cost option: Gemini's free tier needs an API key but no
 * billing account, and the Flash models are strong enough for intent
 * classification and grounded HR answers. Unlike Workers AI it is an external
 * dependency, so it is opt-in rather than the default.
 *
 * The key is a Worker secret. It appears only in the request URL to Google and
 * is never logged, returned, or exposed to the frontend (§40).
 */

import {
  AIProviderError,
  fetchJson,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIToolRequest,
} from '../provider.js'

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_MODEL = 'gemini-2.0-flash'

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  modelVersion?: string
}

export class GoogleProvider implements AIProvider {
  readonly name = 'google'

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {
    if (!apiKey) throw new AIProviderError('AI_API_KEY is not configured', 'google')
  }

  async generateResponse(input: AIRequest): Promise<AIResponse> {
    const model = this.model || DEFAULT_MODEL

    const body: Record<string, unknown> = {
      // Gemini keeps the system prompt separate from the turn history.
      systemInstruction: { parts: [{ text: input.system }] },
      contents: input.messages.map((m) => ({
        // Gemini calls the assistant role "model".
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.temperature ?? 0,
        ...(input.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
      },
    }

    if (input.tools && input.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: stripUnsupportedSchemaKeys(t.parameters),
          })),
        },
      ]
    }

    const json = (await fetchJson(
      `${this.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Header rather than a query parameter, so the key cannot leak into
          // an intermediary's request log.
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      },
      input.timeoutMs ?? 20_000,
      'google',
    )) as GeminiResponse

    const parts = json.candidates?.[0]?.content?.parts ?? []
    const text = parts
      .map((p) => p.text)
      .filter((t): t is string => typeof t === 'string')
      .join('\n')
      .trim()

    const toolRequests: AIToolRequest[] = parts
      .filter((p) => typeof p.functionCall?.name === 'string')
      .map((p) => ({
        name: p.functionCall!.name as string,
        arguments: p.functionCall!.args ?? {},
      }))

    return {
      text,
      toolRequests,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: json.modelVersion ?? model,
      stopReason: mapFinish(json.candidates?.[0]?.finishReason, toolRequests.length > 0),
    }
  }
}

/**
 * Gemini rejects JSON Schema keywords it does not implement. The tool schemas
 * are written for the OpenAI/Anthropic dialect, so the extras are dropped
 * rather than maintained twice — the backend validator is what actually
 * enforces the shape, so a looser advertised schema costs nothing.
 */
function stripUnsupportedSchemaKeys(schema: Record<string, unknown>): Record<string, unknown> {
  const unsupported = new Set(['additionalProperties', '$schema', 'default', 'examples'])
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (typeof value !== 'object' || value === null) return value
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsupported.has(key)) continue
      out[key] = walk(child)
    }
    return out
  }
  return walk(schema) as Record<string, unknown>
}

function mapFinish(reason: string | undefined, hasTools: boolean): AIResponse['stopReason'] {
  if (hasTools) return 'tool_use'
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
      // Treated as a normal stop: the orchestrator's own no-fabrication path
      // turns an empty answer into the standard HR referral.
      return 'stop'
    default:
      return 'stop'
  }
}
