/**
 * Documentation freshness (CLAUDE.md §48, §57).
 *
 * Docs are the operator's runbook here — a wrong command or an undocumented
 * configuration key causes real failures during deployment. Prose can only be
 * kept honest by writing it, but the *mechanical* kinds of drift can be caught,
 * so they are:
 *
 *   • an npm script nobody documented
 *   • a configuration key the code reads but `.env.example` never mentions
 *   • a test file missing from the testing inventory
 *   • a required doc file that does not exist
 *
 * When one of these fails, the fix is to update the documentation, not to relax
 * the assertion.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(join(root, current))) {
      const relative = `${current}/${entry}`
      if (statSync(join(root, relative)).isDirectory()) walk(relative)
      else if (entry.endsWith(suffix)) out.push(relative)
    }
  }
  walk(dir)
  return out.sort()
}

/** README plus every doc, concatenated — where a reader could plausibly look. */
function documentation(): string {
  const docs = readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => read(`docs/${f}`))
  return [read('README.md'), ...docs].join('\n')
}

describe('documentation freshness', () => {
  it('documents every required file (CLAUDE.md §48)', () => {
    for (const file of [
      'docs/architecture.md',
      'docs/security.md',
      'docs/database.md',
      'docs/rbac.md',
      'docs/ai.md',
      'docs/rag.md',
      'docs/telegram.md',
      'docs/deployment.md',
      'docs/testing.md',
      'docs/roadmap.md',
      'README.md',
      'CLAUDE.md',
    ]) {
      expect(() => read(file), `${file} is missing`).not.toThrow()
    }
  })

  it('documents every npm script', () => {
    const scripts = Object.keys(
      (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
    )
    const allDocs = documentation()
    const undocumented = scripts.filter((name) => !allDocs.includes(name))
    expect(
      undocumented,
      `these npm scripts appear in no doc: ${undocumented.join(', ')}`,
    ).toEqual([])
  })

  it('documents every configuration key the code reads', () => {
    const config = read('packages/shared/src/config.ts')
    // `s(env, 'KEY', …)` and `n(env, 'KEY', …)` are the only readers.
    const keys = [...new Set([...config.matchAll(/env,\s*'([A-Z_]+)'/g)].map((m) => m[1]!))].sort()
    expect(keys.length).toBeGreaterThan(10)

    const example = read('.env.example')
    const undocumented = keys.filter((key) => !example.includes(key))
    expect(
      undocumented,
      `these keys are read by config.ts but absent from .env.example: ${undocumented.join(', ')}`,
    ).toEqual([])
  })

  it('lists every test file in the testing inventory', () => {
    const inventory = read('docs/testing.md')
    const missing = listFiles('tests', '.test.ts')
      .map((path) => path.split('/').pop()!)
      .filter((name) => !inventory.includes(name))
    expect(
      missing,
      `these test files are absent from docs/testing.md: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('documents every AI provider the factory can build', () => {
    const factory = read('packages/ai/src/providers/index.ts')
    const providers = [...factory.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]!)
    expect(providers).toContain('workers-ai')

    const ai = read('docs/ai.md')
    const example = read('.env.example')
    for (const provider of providers) {
      expect(ai.includes(provider), `docs/ai.md does not mention "${provider}"`).toBe(true)
      expect(example.includes(provider), `.env.example does not mention "${provider}"`).toBe(true)
    }
  })

  it('keeps the wrangler bindings the container expects documented', () => {
    const wrangler = read('apps/api/wrangler.toml')
    const deployment = read('docs/deployment.md')
    for (const binding of ['DB', 'DOCUMENTS', 'RATE_LIMIT', 'AI']) {
      expect(wrangler.includes(binding), `wrangler.toml declares no ${binding} binding`).toBe(true)
      expect(
        deployment.includes(binding),
        `docs/deployment.md does not mention the ${binding} binding`,
      ).toBe(true)
    }
  })
})
