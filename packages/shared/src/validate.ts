/**
 * Minimal dependency-free schema validation (CLAUDE.md §58.2 — avoid needless
 * dependencies). Every external input crosses one of these validators before it
 * reaches business logic.
 */

import { validationFailed } from './errors.js'

export interface FieldIssue {
  path: string
  message: string
}

export class ValidationError extends Error {
  constructor(readonly issues: FieldIssue[]) {
    super('Validation failed')
    this.name = 'ValidationError'
  }
}

export type Validator<T> = (value: unknown, path: string, issues: FieldIssue[]) => T | undefined

const push = (issues: FieldIssue[], path: string, message: string) => {
  issues.push({ path, message })
  return undefined
}

export interface StringOptions {
  min?: number
  max?: number
  pattern?: RegExp
  trim?: boolean
  lower?: boolean
  enum?: readonly string[]
}

export function str(opts: StringOptions = {}): Validator<string> {
  const { min = 0, max = 10_000, pattern, trim = true, lower = false } = opts
  return (value, path, issues) => {
    if (typeof value !== 'string') return push(issues, path, 'must be a string')
    let v = trim ? value.trim() : value
    if (lower) v = v.toLowerCase()
    if (v.length < min) return push(issues, path, `must be at least ${min} characters`)
    if (v.length > max) return push(issues, path, `must be at most ${max} characters`)
    if (pattern && !pattern.test(v)) return push(issues, path, 'has an invalid format')
    if (opts.enum && !opts.enum.includes(v)) {
      return push(issues, path, `must be one of: ${opts.enum.join(', ')}`)
    }
    return v
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/

export function email(): Validator<string> {
  return (value, path, issues) => {
    const s = str({ min: 3, max: 254, lower: true })(value, path, issues)
    if (s === undefined) return undefined
    if (!EMAIL.test(s)) return push(issues, path, 'must be a valid e-mail address')
    return s
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function dateOnly(): Validator<string> {
  return (value, path, issues) => {
    if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
      return push(issues, path, 'must be a date in YYYY-MM-DD format')
    }
    const [y, m, d] = value.split('-').map(Number) as [number, number, number]
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return push(issues, path, 'is not a real calendar date')
    }
    return value
  }
}

export interface NumberOptions {
  min?: number
  max?: number
  int?: boolean
}

export function num(opts: NumberOptions = {}): Validator<number> {
  return (value, path, issues) => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    if (typeof n !== 'number' || !Number.isFinite(n)) return push(issues, path, 'must be a number')
    if (opts.int && !Number.isInteger(n)) return push(issues, path, 'must be an integer')
    if (opts.min !== undefined && n < opts.min) return push(issues, path, `must be >= ${opts.min}`)
    if (opts.max !== undefined && n > opts.max) return push(issues, path, `must be <= ${opts.max}`)
    return n
  }
}

export function bool(): Validator<boolean> {
  return (value, path, issues) => {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1 || value === '1') return true
    if (value === 'false' || value === 0 || value === '0') return false
    return push(issues, path, 'must be a boolean')
  }
}

export function oneOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return (value, path, issues) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      return push(issues, path, `must be one of: ${values.join(', ')}`) as undefined
    }
    return value as T[number]
  }
}

export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, path, issues) => {
    if (value === undefined || value === null || value === '') return undefined
    return inner(value, path, issues)
  }
}

export function withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
  return (value, path, issues) => {
    if (value === undefined || value === null || value === '') return fallback
    const r = inner(value, path, issues)
    return r === undefined ? fallback : r
  }
}

export function arrayOf<T>(inner: Validator<T>, opts: { max?: number } = {}): Validator<T[]> {
  const max = opts.max ?? 100
  return (value, path, issues) => {
    if (!Array.isArray(value)) return push(issues, path, 'must be an array') as undefined
    if (value.length > max) return push(issues, path, `must contain at most ${max} items`) as undefined
    const out: T[] = []
    value.forEach((item, i) => {
      const r = inner(item, `${path}[${i}]`, issues)
      if (r !== undefined) out.push(r)
    })
    return out
  }
}

export type Shape = Record<string, Validator<any>>
export type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Validator<infer T> ? T : never }

export function object<S extends Shape>(shape: S): Validator<Infer<S>> {
  return (value, path, issues) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return push(issues, path || '$', 'must be an object') as undefined
    }
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, validator] of Object.entries(shape)) {
      const child = path ? `${path}.${key}` : key
      const r = validator(src[key], child, issues)
      if (r !== undefined) out[key] = r
    }
    return out as Infer<S>
  }
}

/** Run a validator, throwing an AppError with safe per-field messages. */
export function parse<T>(validator: Validator<T>, value: unknown): T {
  const issues: FieldIssue[] = []
  const result = validator(value, '', issues)
  if (issues.length > 0 || result === undefined) {
    throw validationFailed('The submitted data is invalid.', {
      details: { issues: issues.slice(0, 20) },
    })
  }
  return result
}

/** Non-throwing variant for callers that want to branch on failure. */
export function safeParse<T>(
  validator: Validator<T>,
  value: unknown,
): { ok: true; value: T } | { ok: false; issues: FieldIssue[] } {
  const issues: FieldIssue[] = []
  const result = validator(value, '', issues)
  if (issues.length > 0 || result === undefined) {
    return { ok: false, issues: issues.length ? issues : [{ path: '$', message: 'invalid' }] }
  }
  return { ok: true, value: result }
}
