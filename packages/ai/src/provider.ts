/**
 * AI provider abstraction (CLAUDE.md §14).
 *
 * Nothing above this interface knows which vendor is configured. Providers are
 * given a prompt and a *description* of tools; they never receive credentials
 * for anything else, and they cannot reach the database.
 */

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Tool description handed to the model. Note: no handler, no SQL, no secrets. */
export interface AIToolDescription {
  name: string
  description: string
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>
}

export interface AIRequest {
  system: string
  messages: AIMessage[]
  tools?: AIToolDescription[]
  maxOutputTokens: number
  temperature?: number
  /** Ask the provider for a JSON object matching the given shape. */
  responseFormat?: 'text' | 'json'
  /** Abort budget in milliseconds. */
  timeoutMs?: number
}

export interface AIToolRequest {
  name: string
  /** Raw, UNVALIDATED arguments from the model. Always schema-checked later. */
  arguments: Record<string, unknown>
  callId?: string
}

export interface AIResponse {
  text: string
  /** Tools the model asked for. Requesting is not the same as executing. */
  toolRequests: AIToolRequest[]
  usage: { inputTokens: number; outputTokens: number }
  model: string
  stopReason: 'stop' | 'length' | 'tool_use' | 'error'
}

export interface AIProvider {
  readonly name: string
  generateResponse(input: AIRequest): Promise<AIResponse>
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}

/** Shared fetch helper with a hard timeout, so a Worker never hangs. */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: string,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      // The body may echo the request; never surface it to a user.
      throw new AIProviderError(
        `provider responded ${response.status}`,
        provider,
        response.status,
        response.status === 429 || response.status >= 500,
      )
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new AIProviderError('provider returned a non-JSON body', provider)
    }
  } catch (e) {
    if (e instanceof AIProviderError) throw e
    if (e instanceof Error && e.name === 'AbortError') {
      throw new AIProviderError('provider request timed out', provider, undefined, true)
    }
    throw new AIProviderError('provider request failed', provider, undefined, true)
  } finally {
    clearTimeout(timer)
  }
}
