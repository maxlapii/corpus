/** Provider factory driven entirely by configuration (CLAUDE.md §14). */

import type { AppConfig } from '@corpus/shared'
import { AIProviderError, type AIProvider } from '../provider.js'
import { AnthropicProvider } from './anthropic.js'
import { GoogleProvider } from './google.js'
import { MockAIProvider } from './mock.js'
import { OpenAiProvider } from './openai.js'
import { WorkersAiProvider, isWorkersAiBinding } from './workers-ai.js'

/** Runtime bindings a provider may need. Only Workers AI uses one today. */
export interface AIProviderBindings {
  /** The Cloudflare `AI` binding, when the Worker declares one. */
  workersAi?: unknown
}

export function createAIProvider(
  config: AppConfig,
  bindings: AIProviderBindings = {},
): AIProvider {
  switch (config.ai.provider) {
    case 'workers-ai':
      if (!isWorkersAiBinding(bindings.workersAi)) {
        throw new AIProviderError(
          'AI_PROVIDER=workers-ai requires the [ai] binding in wrangler.toml',
          'workers-ai',
        )
      }
      return new WorkersAiProvider(bindings.workersAi, config.ai.model)
    case 'google':
      return new GoogleProvider(config.ai.apiKey, config.ai.model, config.ai.baseUrl || undefined)
    case 'anthropic':
      return new AnthropicProvider(config.ai.apiKey, config.ai.model)
    case 'openai':
      return new OpenAiProvider(config.ai.apiKey, config.ai.model)
    case 'compatible':
      return new OpenAiProvider(config.ai.apiKey, config.ai.model, config.ai.baseUrl, 'compatible')
    case 'mock':
    default:
      return new MockAIProvider()
  }
}

export * from './anthropic.js'
export * from './google.js'
export * from './mock.js'
export * from './openai.js'
export * from './workers-ai.js'
