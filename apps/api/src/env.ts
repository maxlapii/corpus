/** Worker bindings and vars. Mirrors apps/api/wrangler.toml. */

export interface WorkerEnv extends Record<string, unknown> {
  DB?: unknown
  DOCUMENTS?: unknown
  RATE_LIMIT?: unknown
  /** Workers AI — inference with no API key, on the Worker's free tier. */
  AI?: unknown

  ENVIRONMENT?: string
  LOG_LEVEL?: string
  PUBLIC_APP_URL?: string
  CORS_ORIGINS?: string
  DEFAULT_TENANT_SLUG?: string

  SESSION_SECRET?: string

  TELEGRAM_EXTERNAL_BOT_TOKEN?: string
  TELEGRAM_INTERNAL_BOT_TOKEN?: string
  TELEGRAM_EXTERNAL_WEBHOOK_SECRET?: string
  TELEGRAM_INTERNAL_WEBHOOK_SECRET?: string

  AI_PROVIDER?: string
  AI_API_KEY?: string
  AI_MODEL?: string
  AI_BASE_URL?: string
  AI_MAX_OUTPUT_TOKENS?: string
  AI_MAX_CONTEXT_CHUNKS?: string
  AI_REQUESTS_PER_HOUR?: string
}
