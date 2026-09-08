/**
 * CORPUS External Bot (CLAUDE.md §31, §36).
 *
 * Public candidates only. The identity is always ANONYMOUS/EXTERNAL, which
 * means the tool registry offers it exactly six recruitment tools and the
 * PolicyGateway refuses every internal resource by zone before any query runs.
 *
 * This bot has no path to the internal bot's capabilities: they are separate
 * handlers, separate tokens, separate webhook secrets, and the zone is fixed
 * here in code rather than derived from anything in the request.
 */

import { prefixedId, type Logger } from '@corpus/shared'
import { tenantScope, type Repositories } from '@corpus/db'
import type { IdentityResolver } from '@corpus/auth'
import type { AIOrchestrator } from '@corpus/ai'
import type { RateLimiter, RateLimitRule, SecurityEventService } from '@corpus/security'
import type { TelegramClient } from './client.js'
import type { ReplayGuard } from './webhook.js'
import type { NormalisedUpdate } from './types.js'

export interface ExternalBotDeps {
  client: TelegramClient
  orchestrator: AIOrchestrator
  identityResolver: IdentityResolver
  repos: Repositories
  securityEvents: SecurityEventService
  rateLimiter: RateLimiter
  replayGuard: ReplayGuard
  logger: Logger
  tenantId: string
  messageRule: RateLimitRule
}

const WELCOME = [
  'Hello — I am the CORPUS recruitment assistant.',
  '',
  'I can help you with:',
  '• /jobs — browse current openings',
  '• Details and requirements for a specific job code',
  '• /apply — submit an application',
  '• /status — check an application using its reference',
  '',
  'I can only discuss public recruitment information.',
].join('\n')

const HELP = [
  'Commands:',
  '/jobs — list published openings',
  '/apply — start an application',
  '/status <reference> — check an application',
  '/help — this message',
  '',
  'You can also just ask in your own words, e.g. "any backend roles in Phnom Penh?"',
].join('\n')

export class ExternalBot {
  constructor(private readonly deps: ExternalBotDeps) {}

  async handle(update: NormalisedUpdate): Promise<void> {
    // 1. Replay protection: Telegram retries until it sees a 200.
    if (await this.deps.replayGuard.seen('external', update.updateId)) {
      this.deps.logger.debug('duplicate telegram update ignored', {
        action: 'telegram.external',
        result: 'duplicate',
      })
      return
    }

    // 2. Group chats are refused: a public group is the wrong place to collect
    //    a candidate's personal details.
    if (update.chatType !== 'private') {
      await this.deps.client.sendMessage(
        update.chatId,
        'Please message me directly so we can keep your application details private.',
      )
      return
    }

    const requestId = prefixedId('req')

    // 3. Per-user rate limit.
    const limit = await this.deps.rateLimiter.consume(
      `tg:ext:${update.telegramUserId}`,
      this.deps.messageRule,
    )
    if (!limit.allowed) {
      await this.deps.securityEvents.record({
        tenantId: this.deps.tenantId,
        eventType: 'RATE_LIMIT',
        channel: 'TELEGRAM_EXTERNAL',
        telegramId: update.telegramUserId,
        summary: 'External bot message rate limit exceeded',
        requestId,
      })
      await this.deps.client.sendMessage(
        update.chatId,
        `You are sending messages very quickly. Please wait ${limit.resetSeconds}s.`,
      )
      return
    }

    // 4. Identity. Always anonymous/EXTERNAL — a Telegram id is not identity.
    //    If the id matches a known candidate we attach that candidate so the
    //    candidate can see *their own* application, and nobody else's.
    const scope = tenantScope(this.deps.tenantId)
    const candidate = await this.deps.repos.candidates.findByTelegramUserId(
      scope,
      update.telegramUserId,
    )
    const identity = await this.deps.identityResolver.anonymous({
      tenantId: this.deps.tenantId,
      channel: 'TELEGRAM_EXTERNAL',
      rawSubject: update.telegramUserId,
      telegramUserId: update.telegramUserId,
      ...(candidate ? { candidateId: candidate.id } : {}),
    })

    // 5. Commands that need no model call.
    if (update.command === 'start') {
      await this.deps.client.sendMessage(update.chatId, WELCOME)
      return
    }
    if (update.command === 'help') {
      await this.deps.client.sendMessage(update.chatId, HELP)
      return
    }

    const message = commandToNaturalLanguage(update)

    await this.deps.client.sendChatAction(update.chatId)
    const reply = await this.deps.orchestrator.handle({
      identity,
      message,
      requestId,
    })

    await this.deps.client.sendMessage(
      update.chatId,
      reply.text || 'I could not find an answer for that. Please try rephrasing.',
    )

    this.deps.logger.info('external bot turn handled', {
      action: 'telegram.external',
      result: reply.refused ? 'refused' : 'ok',
      channel: 'TELEGRAM_EXTERNAL',
      requestId,
      intent: reply.intent,
      tools: reply.toolCalls.map((t) => `${t.name}:${t.decision}`).join(','),
    })
  }
}

/** Map slash commands onto the natural-language phrasings the classifier knows. */
function commandToNaturalLanguage(update: NormalisedUpdate): string {
  switch (update.command) {
    case 'jobs':
      return update.commandArgs
        ? `What jobs are available matching ${update.commandArgs}?`
        : 'What jobs are available?'
    case 'apply':
      return update.commandArgs
        ? `I want to apply for job ${update.commandArgs}`
        : 'I want to apply for a job. What do you need from me?'
    case 'status':
      return update.commandArgs
        ? `What is the status of my application with reference ${update.commandArgs}?`
        : 'What is the status of my application? I need to give you my reference.'
    default:
      return update.text
  }
}
