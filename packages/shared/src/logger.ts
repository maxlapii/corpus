/**
 * Lightweight structured logger (CLAUDE.md §47).
 *
 * Emits single-line JSON so Cloudflare's log stream stays queryable, and
 * *redacts* keys that look like credentials before anything is written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Keys whose values are never logged, regardless of nesting depth. */
const REDACT_KEY = /(pass|password|secret|token|api[_-]?key|authorization|cookie|code|otp|hash|salt|cv_text|content)/i

const MAX_STRING = 512
const MAX_DEPTH = 4

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (depth >= MAX_DEPTH) return '[depth]'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  return '[unserialisable]'
}

export interface LogFields {
  requestId?: string
  route?: string
  method?: string
  userId?: string
  tenantId?: string
  channel?: string
  action?: string
  result?: string
  latencyMs?: number
  errorCode?: string
  [key: string]: unknown
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

export interface LoggerSink {
  write(line: string): void
}

const consoleSink: LoggerSink = {
  write: (line) => {
    console.log(line)
  },
}

export function createLogger(
  level: LogLevel = 'info',
  base: LogFields = {},
  sink: LoggerSink = consoleSink,
): Logger {
  const min = LEVEL_ORDER[level]

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[lvl] < min) return
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...(redact({ ...base, ...fields }) as Record<string, unknown>),
    }
    try {
      sink.write(JSON.stringify(record))
    } catch {
      sink.write(JSON.stringify({ ts: record.ts, level: lvl, msg, note: 'log serialisation failed' }))
    }
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  }
}

/** Silent logger for tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
}

export function parseLogLevel(v: unknown, fallback: LogLevel = 'info'): LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : fallback
}
