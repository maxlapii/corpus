/**
 * Cloudflare Workers global-scope restrictions.
 *
 * The test suite runs on Node, where module-scope crypto, timers and I/O are
 * all legal — so it cannot reproduce workerd's rules. It missed a real bug:
 * `const DUMMY_HASH = hashPassword(...)` at module scope rejected in workerd,
 * turning every unknown-account login into a 500 while a wrong password still
 * returned 401 — an account-enumeration oracle.
 *
 * This scans the source that reaches the Worker bundle for the same pattern.
 * Node-only modules are excluded: they are never imported by the Worker.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

/** Imported only by scripts and tests, never bundled into the Worker. */
const NODE_ONLY = [
  'packages/db/src/sqlite-adapter.ts',
  'packages/db/src/migration-files.ts',
  'packages/db/src/test-support.ts',
]

function workerSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`
      if (statSync(join(root, rel)).isDirectory()) walk(rel)
      else if (entry.endsWith('.ts') && !NODE_ONLY.includes(rel)) out.push(rel)
    }
  }
  walk('packages')
  walk('apps/api/src')
  return out
}

/**
 * Statements at column 0 run at module evaluation. Anything indented is inside
 * a function or class body and therefore runs within a request handler.
 */
const TOP_LEVEL_BINDING = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*[^=]*=\s*(.+)$/

const FORBIDDEN_IN_GLOBAL_SCOPE: { pattern: RegExp; reason: string }[] = [
  { pattern: /crypto\.(subtle|getRandomValues|randomUUID)/, reason: 'generates random values' },
  { pattern: /\b(randomId|randomToken|randomNumericCode|prefixedId|newUuid)\s*\(/, reason: 'generates random values' },
  { pattern: /\b(hashPassword|sha256Hex|hmacSha256)\s*\(/, reason: 'uses WebCrypto' },
  { pattern: /\bfetch\s*\(/, reason: 'performs I/O' },
  { pattern: /\bset(Timeout|Interval)\s*\(/, reason: 'sets a timer' },
  { pattern: /\bDate\.now\s*\(\)/, reason: 'reads the clock' },
  { pattern: /\bnowIso\s*\(\)/, reason: 'reads the clock' },
]

describe('Workers global-scope restrictions', () => {
  it('performs no crypto, I/O, timers or clock reads at module scope', () => {
    const violations: string[] = []

    for (const file of workerSources()) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n')
      lines.forEach((line, index) => {
        const binding = TOP_LEVEL_BINDING.exec(line)
        if (!binding) return
        const initialiser = binding[1]!
        // An arrow function or `function` keyword defers the call to call time.
        if (/=>|function\b/.test(initialiser)) return

        for (const { pattern, reason } of FORBIDDEN_IN_GLOBAL_SCOPE) {
          if (pattern.test(initialiser)) {
            violations.push(`${relative('.', file)}:${index + 1} ${reason} — ${line.trim().slice(0, 70)}`)
          }
        }
      })
    }

    expect(
      violations,
      `Workers forbid these in global scope; move them inside a handler:\n  ${violations.join('\n  ')}`,
    ).toEqual([])
  })

  it('scans a meaningful number of files', () => {
    // Guards against the walk silently matching nothing.
    expect(workerSources().length).toBeGreaterThan(30)
  })

  it('would catch the DUMMY_HASH regression', () => {
    const offending = 'const DUMMY_HASH: Promise<string> = hashPassword(\'placeholder\')'
    const binding = TOP_LEVEL_BINDING.exec(offending)
    expect(binding).not.toBeNull()
    expect(FORBIDDEN_IN_GLOBAL_SCOPE.some((r) => r.pattern.test(binding![1]!))).toBe(true)
  })
})
