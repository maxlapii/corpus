/**
 * Runtime configuration, resolved from Worker bindings/vars or `process.env`.
 *
 * Secrets never leave this object; nothing here is ever serialised to a
 * response, and `describeConfig()` exists for diagnostics without leaking them.
 */

import { parseLogLevel, type LogLevel } from './logger.js'

/**
 * `workers-ai` and `google` are the zero-cost options: Workers AI needs no
 * account at all (it runs on the Worker's own AI binding), Gemini needs a free
 * API key. `anthropic` / `openai` / `compatible` are paid opt-ins.
 */
export type AiProviderName =
  | 'mock'
  | 'workers-ai'
  | 'google'
  | 'anthropic'
  | 'openai'
  | 'compatible'

/** Providers that authenticate with a binding rather than an API key. */
const BINDING_PROVIDERS: readonly AiProviderName[] = ['workers-ai']

export function providerNeedsApiKey(provider: AiProviderName): boolean {
  return provider !== 'mock' && !BINDING_PROVIDERS.includes(provider)
}

export interface AppConfig {
  environment: 'development' | 'test' | 'staging' | 'production'
  logLevel: LogLevel
  publicAppUrl: string
  corsOrigins: string[]
  defaultTenantSlug: string

  sessionSecret: string

  telegram: {
    externalBotToken: string
    internalBotToken: string
    externalWebhookSecret: string
    internalWebhookSecret: string
  }

  ai: {
    provider: AiProviderName
    apiKey: string
    model: string
    baseUrl: string
    maxOutputTokens: number
    maxContextChunks: number
    requestsPerHour: number
  }

  limits: {
    maxUploadBytes: number
    maxRequestBodyBytes: number
    maxPageSize: number
    defaultPageSize: number
  }

  /**
   * Rate limits, all overridable per deployment (CLAUDE.md §45). Values are
   * "requests per window"; the window lengths are fixed per surface.
   */
  rateLimits: {
    telegramPerUserPerMinute: number
    aiPerUserPerHour: number
    loginPer15Minutes: number
    verificationPer15Minutes: number
    applicationsPerHour: number
    adminApiPerMinute: number
    publicApiPerMinute: number
  }
}

type RawEnv = Record<string, unknown>

const s = (env: RawEnv, key: string, fallback = ''): string => {
  const v = env[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

const n = (env: RawEnv, key: string, fallback: number): number => {
  const v = Number(s(env, key, ''))
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function parseEnvironment(v: string): AppConfig['environment'] {
  return v === 'production' || v === 'staging' || v === 'test' ? v : 'development'
}

function parseProvider(v: string): AiProviderName {
  switch (v) {
    case 'workers-ai':
    case 'google':
    case 'anthropic':
    case 'openai':
    case 'compatible':
      return v
    default:
      return 'mock'
  }
}

export function loadConfig(env: RawEnv): AppConfig {
  const environment = parseEnvironment(s(env, 'ENVIRONMENT', 'development'))
  const publicAppUrl = s(env, 'PUBLIC_APP_URL', 'http://localhost:3000')

  const corsOrigins = s(env, 'CORS_ORIGINS', publicAppUrl)
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && !o.startsWith('TODO_'))

  const config: AppConfig = {
    environment,
    logLevel: parseLogLevel(s(env, 'LOG_LEVEL', environment === 'production' ? 'info' : 'debug')),
    publicAppUrl,
    corsOrigins,
    defaultTenantSlug: s(env, 'DEFAULT_TENANT_SLUG', 'default'),

    sessionSecret: s(env, 'SESSION_SECRET'),

    telegram: {
      externalBotToken: s(env, 'TELEGRAM_EXTERNAL_BOT_TOKEN'),
      internalBotToken: s(env, 'TELEGRAM_INTERNAL_BOT_TOKEN'),
      externalWebhookSecret: s(env, 'TELEGRAM_EXTERNAL_WEBHOOK_SECRET'),
      internalWebhookSecret: s(env, 'TELEGRAM_INTERNAL_WEBHOOK_SECRET'),
    },

    ai: {
      provider: parseProvider(s(env, 'AI_PROVIDER', 'mock')),
      apiKey: s(env, 'AI_API_KEY'),
      model: s(env, 'AI_MODEL'),
      baseUrl: s(env, 'AI_BASE_URL'),
      maxOutputTokens: n(env, 'AI_MAX_OUTPUT_TOKENS', 600),
      maxContextChunks: n(env, 'AI_MAX_CONTEXT_CHUNKS', 5),
      requestsPerHour: n(env, 'AI_REQUESTS_PER_HOUR', 60),
    },

    limits: {
      maxUploadBytes: n(env, 'MAX_UPLOAD_BYTES', 8 * 1024 * 1024),
      maxRequestBodyBytes: n(env, 'MAX_REQUEST_BODY_BYTES', 512 * 1024),
      maxPageSize: n(env, 'MAX_PAGE_SIZE', 100),
      defaultPageSize: n(env, 'DEFAULT_PAGE_SIZE', 25),
    },

    rateLimits: {
      telegramPerUserPerMinute: n(env, 'RATE_LIMIT_TELEGRAM_PER_MINUTE', 30),
      aiPerUserPerHour: n(env, 'AI_REQUESTS_PER_HOUR', 60),
      loginPer15Minutes: n(env, 'RATE_LIMIT_LOGIN_PER_15M', 10),
      verificationPer15Minutes: n(env, 'RATE_LIMIT_VERIFY_PER_15M', 5),
      applicationsPerHour: n(env, 'RATE_LIMIT_APPLICATIONS_PER_HOUR', 5),
      adminApiPerMinute: n(env, 'RATE_LIMIT_ADMIN_API_PER_MINUTE', 600),
      publicApiPerMinute: n(env, 'RATE_LIMIT_PUBLIC_API_PER_MINUTE', 120),
    },
  }

  return config
}

export interface ConfigProblem {
  key: string
  message: string
  severity: 'error' | 'warning'
}

/**
 * Validate configuration. Errors are fatal in production; in development we
 * degrade to warnings so the project runs without any external accounts.
 */
export function validateConfig(config: AppConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = []
  const prod = config.environment === 'production' || config.environment === 'staging'
  const level = (): 'error' | 'warning' => (prod ? 'error' : 'warning')

  if (config.sessionSecret.length < 32) {
    problems.push({
      key: 'SESSION_SECRET',
      message: 'must be set to at least 32 random characters',
      severity: prod ? 'error' : 'warning',
    })
  }
  if (!config.telegram.externalBotToken) {
    problems.push({ key: 'TELEGRAM_EXTERNAL_BOT_TOKEN', message: 'not set — external bot disabled', severity: 'warning' })
  }
  if (!config.telegram.internalBotToken) {
    problems.push({ key: 'TELEGRAM_INTERNAL_BOT_TOKEN', message: 'not set — internal bot disabled', severity: 'warning' })
  }
  if (config.telegram.externalBotToken && !config.telegram.externalWebhookSecret) {
    problems.push({
      key: 'TELEGRAM_EXTERNAL_WEBHOOK_SECRET',
      message: 'required whenever the external bot token is configured',
      severity: 'error',
    })
  }
  if (config.telegram.internalBotToken && !config.telegram.internalWebhookSecret) {
    problems.push({
      key: 'TELEGRAM_INTERNAL_WEBHOOK_SECRET',
      message: 'required whenever the internal bot token is configured',
      severity: 'error',
    })
  }
  if (providerNeedsApiKey(config.ai.provider) && !config.ai.apiKey) {
    problems.push({ key: 'AI_API_KEY', message: `required for AI_PROVIDER=${config.ai.provider}`, severity: 'error' })
  }
  if (config.telegram.internalBotToken && prod) {
    // There is no mail transport in this build, so the internal bot cannot
    // deliver a one-time code in production without logging it — which it
    // refuses to do. Surface that rather than failing silently at /verify time.
    problems.push({
      key: 'VERIFICATION_CODE_TRANSPORT',
      message:
        'no e-mail transport is configured, so Telegram verification codes cannot be delivered',
      severity: 'error',
    })
  }
  if (config.ai.provider === 'mock' && prod) {
    problems.push({ key: 'AI_PROVIDER', message: 'mock provider must not be used in production', severity: level() })
  }
  if (prod && config.corsOrigins.length === 0) {
    problems.push({ key: 'CORS_ORIGINS', message: 'must list the dashboard origin(s)', severity: 'error' })
  }
  return problems
}

/** Secret-free view of the configuration, safe for logs and /health output. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    logLevel: config.logLevel,
    corsOrigins: config.corsOrigins,
    defaultTenantSlug: config.defaultTenantSlug,
    aiProvider: config.ai.provider,
    aiModel: config.ai.model || '(provider default)',
    aiConfigured:
      config.ai.provider === 'mock' ||
      !providerNeedsApiKey(config.ai.provider) ||
      config.ai.apiKey.length > 0,
    externalBotConfigured: config.telegram.externalBotToken.length > 0,
    internalBotConfigured: config.telegram.internalBotToken.length > 0,
    sessionSecretConfigured: config.sessionSecret.length >= 32,
    limits: config.limits,
    rateLimits: config.rateLimits,
  }
}
