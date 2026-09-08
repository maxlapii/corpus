/**
 * Secret scanner (CLAUDE.md §58.16, §62). Fails CI on anything that looks like
 * a live credential, with an allowlist for documented placeholders.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

const scanIgnored = process.argv.includes('--all')

/**
 * A gitignored file cannot be committed, and local development legitimately
 * holds real tokens in `.dev.vars` — scanning those makes the gate cry wolf.
 * Without git, everything is scanned, so a non-repo checkout fails safe.
 */
function gitIgnoredPrefixes(): string[] {
  if (scanIgnored) return []
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  } catch {
    console.warn('Secret scan: git unavailable, scanning ignored files too.')
    return []
  }
}

const IGNORED = gitIgnoredPrefixes()

function isGitIgnored(relativePath: string): boolean {
  const normalised = relativePath.split(sep).join('/')
  return IGNORED.some(
    (prefix) => normalised === prefix.replace(/\/$/, '') || normalised.startsWith(prefix),
  )
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.wrangler', 'coverage', 'data', '.turbo',
])

const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])

interface Rule {
  name: string
  regex: RegExp
}

const RULES: Rule[] = [
  { name: 'Telegram bot token', regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9-]{20,}/ },
  { name: 'OpenAI API key', regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: 'Assigned secret literal',
    // Quoted only: an unquoted value in code is an identifier reference.
    regex:
      /\b(?:SESSION_SECRET|AI_API_KEY|TELEGRAM_[A-Z_]*(?:TOKEN|SECRET))\s*[=:]\s*['"`]([A-Za-z0-9_\-+/=]{16,})['"`]/,
  },
]

/** Config files only, where an unquoted value is a literal. */
const CONFIG_RULES: Rule[] = [
  {
    name: 'Assigned secret in configuration',
    regex:
      /^\s*(?:export\s+)?(?:SESSION_SECRET|AI_API_KEY|TELEGRAM_[A-Z_]*(?:TOKEN|SECRET))\s*[=:]\s*['"]?([A-Za-z0-9_\-+/=]{16,})['"]?\s*$/,
  },
]

/**
 * Files where an unquoted `KEY=value` is a literal secret. Backup suffixes are
 * stripped first: `.dev.vars.bak` is as sensitive as `.dev.vars`.
 */
const CONFIG_BASENAME =
  /^(\.env|\.dev\.vars|.*\.(?:env|vars|toml|ini|cfg|conf|ya?ml|sh|bash|zsh|properties))$/

const BACKUP_SUFFIX = /(\.(?:bak|backup|orig|old|save|copy|local|example|sample)|\.\d{6,})+$/

function isConfigFile(relativePath: string): boolean {
  const basename = relativePath.split('/').pop() ?? relativePath
  return CONFIG_BASENAME.test(basename) || CONFIG_BASENAME.test(basename.replace(BACKUP_SUFFIX, ''))
}

const ALLOWLIST = [
  /replace-me/i,
  /^TODO_/,
  /your[-_]?(api[-_]?key|token|secret)/i,
  /^changeme/i,
  /example/i,
  /placeholder/i,
  /unused-placeholder/i,
  /DevPassword123!/,
  /^\$\{/,
  /at-least-32-random-characters/i,
]

interface Finding {
  file: string
  line: number
  rule: string
  excerpt: string
}

const findings: Finding[] = []

/** A NUL byte means the file is binary. */
const NUL = String.fromCharCode(0)

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(full)
      continue
    }
    if (SKIP_FILES.has(entry)) continue
    if (stats.size > 2_000_000) continue
    scan(full)
  }
}

function scan(file: string): void {
  const relativePath = relative(ROOT, file)
  if (relativePath === 'scripts/check-secrets.ts') return
  if (isGitIgnored(relativePath)) return

  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (content.includes(NUL)) return

  const rules = isConfigFile(relativePath) ? [...RULES, ...CONFIG_RULES] : RULES

  content.split('\n').forEach((line, index) => {
    for (const rule of rules) {
      const match = rule.regex.exec(line)
      if (!match) continue
      const captured = match[1] ?? match[0]
      if (ALLOWLIST.some((allowed) => allowed.test(captured))) continue
      findings.push({
        file: relativePath,
        line: index + 1,
        rule: rule.name,
        excerpt: `${captured.slice(0, 6)}…(${captured.length} chars)`,
      })
    }
  })
}

walk(ROOT)

if (findings.length === 0) {
  const scope = scanIgnored ? 'all files' : 'committable files'
  console.log(`Secret scan: no credential-like strings found (${scope}).`)
  process.exit(0)
}

console.error(`Secret scan: ${findings.length} potential secret(s) found:\n`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  ${finding.rule}  ${finding.excerpt}`)
}
console.error('\nRemove the value and use a Worker secret instead (see docs/deployment.md).')
process.exit(1)
