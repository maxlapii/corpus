/**
 * Contract check: every API path the dashboard calls must match a route the
 * Worker actually mounts.
 *
 * The dashboard is a separate build from the API, so a renamed or mistyped
 * endpoint is invisible to both typecheckers and only shows up as a 404 at
 * runtime. This script closes that gap and runs in CI.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/** Mount prefixes, mirroring `apps/api/src/app.ts`. */
const MOUNTS: Record<string, string> = {
  authRoutes: '/auth',
  employeeRoutes: '/employees',
  orgRoutes: '',
  leaveRoutes: '/leave',
  holidayRoutes: '/holidays',
  jobRoutes: '/jobs',
  candidateRoutes: '/candidates',
  applicationRoutes: '/applications',
  knowledgeRoutes: '/policies',
  knowledgeAnswerRoutes: '/knowledge/answers',
  reportRoutes: '/reports',
  auditRoutes: '/audit',
  securityRoutes: '/security',
  assistantRoutes: '/assistant',
  healthRoutes: '/health',
  publicRecruitmentRoutes: '/public',
  telegramRoutes: '/telegram',
}

/**
 * Replace `${...}` interpolations with a placeholder. Brace-balanced, because
 * an interpolation may itself contain object literals or calls, e.g.
 * `/reports/leave${buildQuery({ year })}`.
 */
function stripInterpolations(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '$' && input[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < input.length && depth > 0) {
        if (input[i] === '{') depth++
        else if (input[i] === '}') depth--
        i++
      }
      i--
      out += ':seg'
      continue
    }
    out += input[i]
  }
  return out
}

/** Replace path parameters and template holes with a single placeholder. */
function normalise(path: string): string {
  return (
    stripInterpolations(path)
      .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':seg')
      .replace(/\?.*$/, '')
      .replace(/\/+$/, '') || '/'
  )
}

/**
 * Read the balanced `{...}` object starting at `open` (the index of `{`).
 * Returns its inner text, so `method:` can be found however the call is
 * formatted or nested.
 */
function readObject(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return ''
}

/**
 * The HTTP method named in a call's options object, defaulting to GET.
 *
 * The options object must be the very next thing after the path argument
 * (ignoring whitespace and the separating comma) — a `{` further away belongs
 * to unrelated code.
 */
function methodAfter(source: string, from: number): string {
  let i = from
  while (i < source.length && /[\s,]/.test(source[i]!)) i++
  if (source[i] !== '{') return 'GET'
  return /method:\s*['"](\w+)['"]/.exec(readObject(source, i))?.[1]?.toUpperCase() ?? 'GET'
}

function collectRealRoutes(): Set<string> {
  const routes = new Set<string>()
  const dir = join(ROOT, 'apps/api/src/routes')
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(join(dir, file), 'utf8')
    const pattern = /\b(\w+Routes)\.(get|post|put|delete)\(\s*[`'"]([^`'"]*)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) {
      const prefix = MOUNTS[match[1]!]
      if (prefix === undefined) continue
      routes.add(`${match[2]!.toUpperCase()} ${normalise(prefix + match[3]!)}`)
    }
  }
  return routes
}

interface Call {
  key: string
  files: Set<string>
}

function collectDashboardCalls(): Map<string, Call> {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) files.push(full)
    }
  }
  walk(join(ROOT, 'apps/web/app'))
  walk(join(ROOT, 'apps/web/lib'))

  const calls = new Map<string, Call>()
  const add = (method: string, path: string, file: string): void => {
    const key = `${method} ${normalise(path)}`
    const existing = calls.get(key)
    if (existing) existing.files.add(file)
    else calls.set(key, { key, files: new Set([file]) })
  }

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const relative = file.replace(`${ROOT}/`, '')

    // api<T>('/path', { method: 'POST', ... })
    const apiCall = /\bapi(?:<[^>]*>)?\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*,?/g
    let match: RegExpExecArray | null
    while ((match = apiCall.exec(source))) {
      const path = match[1]!.slice(1, -1)
      // The generic wrapper in lib/api.ts interpolates the whole path.
      if (path.startsWith('${')) continue
      add(methodAfter(source, apiCall.lastIndex), path, relative)
    }

    // useApi<T>('/path') and useApi<T>(condition ? '/path' : null)
    const useApiCall = /\buseApi(?:<[^>]*>)?\(\s*([\s\S]{0,240}?)\)\s*(?:;|\n)/g
    while ((match = useApiCall.exec(source))) {
      for (const literal of match[1]!.matchAll(/(`\/[^`]*`|'\/[^']*'|"\/[^"]*")/g)) {
        add('GET', literal[1]!.slice(1, -1), relative)
      }
    }

    // Raw fetch against API_BASE (multipart upload, and /health which must
    // tolerate a 503 body that the shared helper would throw on).
    const rawFetch = /fetch\(\s*`\$\{API_BASE\}([^`]*)`\s*,?/g
    while ((match = rawFetch.exec(source))) {
      const path = match[1]!
      // The generic wrapper interpolates the whole path; nothing to check.
      if (path.startsWith('${')) continue
      add(methodAfter(source, rawFetch.lastIndex), path, relative)
    }
  }
  return calls
}

const real = collectRealRoutes()
const calls = collectDashboardCalls()

/**
 * A call matches when its normalised key is a mounted route. A trailing `:seg`
 * is also tried without it, because query strings are appended by helpers such
 * as `buildQuery({...})` and become a placeholder during normalisation.
 */
function matches(key: string): boolean {
  if (real.has(key)) return true
  // `/reports/leave${buildQuery({...})}` -> `/reports/leave:seg`, and
  // `/employees/${id}` -> `/employees/:seg`; try dropping the trailing
  // placeholder both with and without its separating slash.
  for (const candidate of [key.replace(/\/:seg$/, ''), key.replace(/:seg$/, '')]) {
    if (candidate !== key && real.has(candidate.replace(/\/$/, ''))) return true
  }
  return false
}

const missing = [...calls.values()]
  .filter((call) => !matches(call.key))
  .sort((a, b) => a.key.localeCompare(b.key))

console.log(
  `API contract: dashboard makes ${calls.size} distinct call(s); Worker mounts ${real.size} route(s).`,
)

if (missing.length === 0) {
  console.log('Every dashboard call matches a mounted route.')
  process.exit(0)
}

console.error(`\n${missing.length} dashboard call(s) do not match any mounted route:\n`)
for (const call of missing) {
  console.error(`  ${call.key}`)
  for (const file of call.files) console.error(`      called from ${file}`)
}
console.error('\nFix the path, or add the route in apps/api/src/routes and mount it in app.ts.')
process.exit(1)
