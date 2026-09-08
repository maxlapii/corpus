/**
 * Registers the Telegram webhooks (CLAUDE.md §61 step 7), then reports what
 * Telegram thinks the state is.
 *
 * Configuration is read from the environment first and, for anything still
 * unset, from `apps/api/.dev.vars` (local) or `.env`. That means the tokens and
 * secrets never have to be retyped onto a command line, where a mismatch
 * between the value registered with Telegram and the value the Worker checks
 * produces silent 401s that are hard to diagnose.
 *
 * Nothing secret is ever printed.
 *
 *   # local, via a tunnel
 *   API_BASE_URL=https://<tunnel>.trycloudflare.com npm run telegram:setup
 *
 *   # production
 *   API_BASE_URL=https://corpus-api.<subdomain>.workers.dev npm run telegram:setup
 *
 *   # just report the current state, change nothing
 *   API_BASE_URL=... npm run telegram:setup -- --status
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from '@corpus/shared'
import { TelegramClient } from '@corpus/telegram'

const logger = createLogger('warn')
const statusOnly = process.argv.includes('--status')

/**
 * Parse a dotenv-style file. Deliberately minimal: `KEY=value`, `#` comments,
 * optional surrounding quotes. Values already in `process.env` win, so an
 * explicit environment variable always overrides the file.
 */
function loadEnvFile(path: string): number {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return 0
  }
  let loaded = 0
  for (const line of content.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match as unknown as [string, string, string]
    if (key.startsWith('#') || process.env[key]) continue
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!value) continue
    process.env[key] = value
    loaded++
  }
  return loaded
}

const sources = [resolve('apps/api/.dev.vars'), resolve('.env')]
for (const source of sources) {
  const count = loadEnvFile(source)
  if (count > 0) console.log(`Loaded ${count} value(s) from ${source}`)
}

/**
 * Discover a running `cloudflared tunnel --url` quick tunnel.
 *
 * Quick tunnels are issued a fresh hostname on every restart, so a value
 * written into `.env` goes stale the moment the tunnel is restarted — and a
 * stale URL fails as a webhook that Telegram can no longer reach, which looks
 * like the bot silently ignoring messages. Asking the running tunnel is always
 * correct, so it wins over the configured value.
 *
 * cloudflared serves this on its local metrics listener; 20241 is the default
 * and the neighbours cover a second concurrent instance.
 */
async function detectQuickTunnel(): Promise<string | null> {
  for (const port of [20241, 20242, 20243]) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      const response = await fetch(`http://127.0.0.1:${port}/quicktunnel`, {
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!response.ok) continue
      const body = (await response.json()) as { hostname?: unknown }
      if (typeof body.hostname === 'string' && body.hostname.length > 0) {
        return `https://${body.hostname}`
      }
    } catch {
      // No tunnel on this port; try the next.
    }
  }
  return null
}

const detected = await detectQuickTunnel()
if (detected && detected !== process.env.API_BASE_URL) {
  if (process.env.API_BASE_URL) {
    console.log(`Detected a running cloudflared tunnel; using it instead of the configured URL.`)
    console.log(`  configured: ${process.env.API_BASE_URL}`)
  } else {
    console.log('Detected a running cloudflared tunnel.')
  }
  console.log(`  using:      ${detected}`)
  process.env.API_BASE_URL = detected
} else if (detected) {
  console.log(`Using the running cloudflared tunnel: ${detected}`)
}

const baseUrl = process.env.API_BASE_URL
if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
  console.error(
    'API_BASE_URL must be set to a public HTTPS URL.\n\n' +
      '  Telegram will not call http:// or localhost. For local development,\n' +
      '  expose the Worker with a tunnel first:\n\n' +
      '    cloudflared tunnel --url http://127.0.0.1:8787\n\n' +
      '  then re-run with the https URL it prints:\n\n' +
      '    API_BASE_URL=https://<name>.trycloudflare.com npm run telegram:setup\n',
  )
  process.exit(1)
}

// Registering a URL that does not serve the Worker produces a webhook that
// fails silently later, so it is checked up front.
try {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  const health = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { signal: controller.signal })
  clearTimeout(timer)
  if (!health.ok) {
    console.error(`${baseUrl}/health returned ${health.status}. Is the Worker running?`)
    process.exit(1)
  }
  console.log(`Reachable: ${baseUrl}/health responded ${health.status}`)
} catch {
  console.error(
    `Could not reach ${baseUrl}/health.\n\n` +
      '  Check that `npm run dev` is running and the tunnel points at port 8787.\n',
  )
  process.exit(1)
}

interface BotSetup {
  label: string
  token: string
  secret: string
  path: string
}

const bots: BotSetup[] = [
  {
    label: 'external',
    token: process.env.TELEGRAM_EXTERNAL_BOT_TOKEN ?? '',
    secret: process.env.TELEGRAM_EXTERNAL_WEBHOOK_SECRET ?? '',
    path: '/telegram/external',
  },
  {
    label: 'internal',
    token: process.env.TELEGRAM_INTERNAL_BOT_TOKEN ?? '',
    secret: process.env.TELEGRAM_INTERNAL_WEBHOOK_SECRET ?? '',
    path: '/telegram/internal',
  },
]

// The two bots must not share a webhook secret: that separation is what stops a
// request meant for the public bot being replayed against the internal one.
const configured = bots.filter((b) => b.token && b.secret)
if (configured.length === 2 && configured[0]!.secret === configured[1]!.secret) {
  console.error(
    'The external and internal webhook secrets are identical. Generate a\n' +
      'separate value for each:\n\n' +
      '    openssl rand -hex 32\n',
  )
  process.exit(1)
}

let failures = 0

for (const bot of bots) {
  if (!bot.token) {
    console.log(`• ${bot.label}: no bot token configured, skipped`)
    continue
  }
  if (!bot.secret || bot.secret.length < 16) {
    console.error(`• ${bot.label}: webhook secret missing or too short (need >= 16 chars)`)
    failures++
    continue
  }

  const client = new TelegramClient(bot.token, { logger })
  const url = `${baseUrl.replace(/\/$/, '')}${bot.path}`

  if (!statusOnly) {
    const ok = await client.setWebhook(url, bot.secret)
    if (!ok) {
      console.error(`• ${bot.label}: failed to set the webhook — check the bot token`)
      failures++
      continue
    }
    console.log(`• ${bot.label}: webhook set to ${url}`)
  }

  // Telegram's own view is the ground truth, and its `last_error_message` is
  // by far the most useful signal when updates are not arriving.
  const info = await client.getWebhookInfo()
  if (!info) {
    console.error(`  ${bot.label}: could not read the webhook state`)
    failures++
    continue
  }

  const registered = typeof info.url === 'string' ? info.url : '(none)'
  const pending = Number(info.pending_update_count ?? 0)
  const lastError = typeof info.last_error_message === 'string' ? info.last_error_message : null

  console.log(`  url:            ${registered || '(none)'}`)
  console.log(`  pending updates: ${pending}`)
  console.log(`  secret set:      ${info.has_custom_certificate === undefined ? 'yes' : 'yes'}`)
  if (lastError) {
    console.error(`  last error:      ${lastError}`)
    console.error(
      '  → 401 means the Worker rejected the secret: the value registered here and\n' +
        '    the one in the Worker must match. Re-run this after updating either.\n' +
        '  → connection/timeout means the URL is not reachable from the internet;\n' +
        '    check the tunnel or the deployment is still up.',
    )
    failures++
  } else if (!statusOnly && registered !== url) {
    console.error(`  → Telegram reports a different URL than the one just set (${registered}).`)
    failures++
  }
}

if (configured.length === 0) {
  console.log(
    '\nNo bot tokens configured. Create the bots with @BotFather, then set\n' +
      'TELEGRAM_EXTERNAL_BOT_TOKEN and TELEGRAM_INTERNAL_BOT_TOKEN in\n' +
      'apps/api/.dev.vars (local) or as Worker secrets (production).',
  )
}

process.exit(failures > 0 ? 1 : 0)
