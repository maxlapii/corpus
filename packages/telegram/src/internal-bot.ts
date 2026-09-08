/**
 * CORPUS Internal HR Bot (CLAUDE.md §32, §36).
 *
 * Requires a verified identity. An unlinked Telegram id can do exactly one
 * thing: start the e-mail verification flow. It cannot reach any HR tool, and
 * it never learns whether an e-mail it guessed belongs to a real employee.
 */

import { prefixedId, safeParse, email as emailValidator, type Logger } from '@corpus/shared'
import type { Repositories } from '@corpus/db'
import type { IdentityResolver, TelegramIdentityService } from '@corpus/auth'
import type { AIOrchestrator } from '@corpus/ai'
import type { RateLimiter, RateLimitRule, SecurityEventService } from '@corpus/security'
import type { TelegramClient } from './client.js'
import type { ReplayGuard } from './webhook.js'
import type { NormalisedUpdate } from './types.js'

export interface VerificationCodeDelivery {
  /**
   * Deliver a one-time code out of band (e-mail).
   *
   * The code must NEVER be sent back over Telegram: that would let anyone who
   * knows an employee's address link their own Telegram account. In development
   * there is no mail transport, so `LogOnlyCodeDelivery` writes it to the
   * server log only.
   */
  deliver(input: { email: string; code: string; expiresInMinutes: number }): Promise<void>
}

/**
 * Development delivery. Prints the code to the server console so a developer
 * with no mail transport can complete the flow.
 *
 * NEVER construct this outside development: it deliberately bypasses the
 * structured logger's redaction, and Worker logs are visible to anyone with
 * observability access. `selectCodeDelivery` enforces that.
 */
export class LogOnlyCodeDelivery implements VerificationCodeDelivery {
  constructor(private readonly logger: Logger) {}

  async deliver(input: { email: string; code: string; expiresInMinutes: number }): Promise<void> {
    console.warn(
      `[CORPUS dev] verification code for ${input.email}: ${input.code} ` +
        `(valid ${input.expiresInMinutes} minutes). Configure a mail transport for production.`,
    )
    this.logger.info('verification code delivered via development sink', {
      action: 'telegram.link.deliver',
      result: 'dev_sink',
    })
  }
}

/**
 * Fail-closed delivery for deployments with no mail transport configured.
 *
 * The code is discarded rather than logged, so the verification flow simply
 * cannot complete — which is the safe outcome. `/health` reports the missing
 * transport so the degradation is visible rather than silent.
 */
export class NullCodeDelivery implements VerificationCodeDelivery {
  constructor(private readonly logger: Logger) {}

  async deliver(_input: { email: string; code: string; expiresInMinutes: number }): Promise<void> {
    this.logger.error('verification code could not be delivered: no transport configured', {
      action: 'telegram.link.deliver',
      result: 'no_transport',
    })
  }
}

/**
 * Choose a delivery sink for the environment. Printing a one-time code to the
 * log is a development affordance only (CLAUDE.md §47: never log verification
 * codes), so production and staging get the fail-closed sink.
 */
export function selectCodeDelivery(
  environment: string,
  logger: Logger,
): VerificationCodeDelivery {
  return environment === 'production' || environment === 'staging'
    ? new NullCodeDelivery(logger)
    : new LogOnlyCodeDelivery(logger)
}

export interface InternalBotDeps {
  client: TelegramClient
  orchestrator: AIOrchestrator
  identityResolver: IdentityResolver
  telegramIdentity: TelegramIdentityService
  codeDelivery: VerificationCodeDelivery
  repos: Repositories
  securityEvents: SecurityEventService
  rateLimiter: RateLimiter
  replayGuard: ReplayGuard
  logger: Logger
  tenantId: string
  messageRule: RateLimitRule
  verificationRule: RateLimitRule
}

const UNVERIFIED_HELP = [
  'This assistant is for verified employees only.',
  '',
  'To link your Telegram account:',
  '1. Send /verify your.name@company.com (your company e-mail)',
  '2. You will receive a 6-digit code by e-mail',
  '3. Send /code 123456',
  '',
  'Your Telegram username alone does not identify you, so this step is required.',
].join('\n')

const VERIFIED_HELP = [
  'I can help with:',
  '• /balance — your leave balance',
  '• /leave — your leave requests',
  '• /request — submit a leave request',
  '• /holidays — upcoming public holidays',
  '• /policy <question> — search HR policy',
  '• /approvals — leave awaiting your decision (managers)',
  '',
  'You can also just ask in your own words.',
].join('\n')

export class InternalBot {
  constructor(private readonly deps: InternalBotDeps) {}

  async handle(update: NormalisedUpdate): Promise<void> {
    if (await this.deps.replayGuard.seen('internal', update.updateId)) return

    // The internal bot refuses group chats outright: HR data must not be
    // rendered into a shared conversation.
    if (update.chatType !== 'private') {
      await this.deps.client.sendMessage(
        update.chatId,
        'For confidentiality I only respond in a direct message.',
      )
      return
    }

    const requestId = prefixedId('req')
    const limit = await this.deps.rateLimiter.consume(
      `tg:int:${update.telegramUserId}`,
      this.deps.messageRule,
    )
    if (!limit.allowed) {
      await this.deps.securityEvents.record({
        tenantId: this.deps.tenantId,
        eventType: 'RATE_LIMIT',
        channel: 'TELEGRAM_INTERNAL',
        telegramId: update.telegramUserId,
        summary: 'Internal bot message rate limit exceeded',
        requestId,
      })
      await this.deps.client.sendMessage(
        update.chatId,
        `Too many messages. Please wait ${limit.resetSeconds}s.`,
      )
      return
    }

    // --- Verification flow
    if (update.command === 'verify') {
      await this.handleVerifyRequest(update, requestId)
      return
    }
    if (update.command === 'code') {
      await this.handleCodeSubmission(update, requestId)
      return
    }

    // --- Identity resolution
    // This is the gate. Roles come from the database; nothing the user says
    // affects the outcome.
    const resolution = await this.deps.identityResolver.fromTelegramInternal({
      tenantId: this.deps.tenantId,
      telegramUserId: update.telegramUserId,
    })

    if (!resolution.ok) {
      await this.deps.securityEvents.record({
        tenantId: this.deps.tenantId,
        eventType: 'UNKNOWN_USER',
        channel: 'TELEGRAM_INTERNAL',
        telegramId: update.telegramUserId,
        summary: `Unverified Telegram user contacted the internal bot (${resolution.reason})`,
        requestId,
      })
      await this.deps.client.sendMessage(update.chatId, unverifiedMessage(resolution.reason))
      return
    }

    if (update.command === 'start' || update.command === 'help') {
      await this.deps.client.sendMessage(
        update.chatId,
        `Hello ${resolution.identity.displayName}.\n\n${VERIFIED_HELP}`,
      )
      return
    }

    const message = commandToNaturalLanguage(update)
    await this.deps.client.sendChatAction(update.chatId)

    const reply = await this.deps.orchestrator.handle({
      identity: resolution.identity,
      message,
      requestId,
    })

    const text = reply.citations.length > 0
      ? `${reply.text}\n\nSource: ${reply.citations
          .map((c) => `${c.documentName}${c.section ? ` — ${c.section}` : ''} (v${c.version})`)
          .join('; ')}`
      : reply.text

    await this.deps.client.sendMessage(
      update.chatId,
      text || 'I could not answer that. Please contact HR.',
    )

    this.deps.logger.info('internal bot turn handled', {
      action: 'telegram.internal',
      result: reply.refused ? 'refused' : 'ok',
      channel: 'TELEGRAM_INTERNAL',
      userId: resolution.identity.userId ?? undefined,
      requestId,
      intent: reply.intent,
      tools: reply.toolCalls.map((t) => `${t.name}:${t.decision}`).join(','),
    })
  }

  private async handleVerifyRequest(update: NormalisedUpdate, requestId: string): Promise<void> {
    const budget = await this.deps.rateLimiter.consume(
      `tg:verify:${update.telegramUserId}`,
      this.deps.verificationRule,
    )
    if (!budget.allowed) {
      await this.deps.securityEvents.record({
        tenantId: this.deps.tenantId,
        eventType: 'RATE_LIMIT',
        channel: 'TELEGRAM_INTERNAL',
        telegramId: update.telegramUserId,
        summary: 'Verification request rate limit exceeded',
        requestId,
      })
      await this.deps.client.sendMessage(
        update.chatId,
        'Too many verification attempts. Please try again later.',
      )
      return
    }

    const parsed = safeParse(emailValidator(), update.commandArgs)
    if (!parsed.ok) {
      await this.deps.client.sendMessage(
        update.chatId,
        'Please send /verify followed by your company e-mail address, e.g.\n/verify jane.doe@company.com',
      )
      return
    }

    const result = await this.deps.telegramIdentity.requestLink({
      tenantId: this.deps.tenantId,
      telegramUserId: update.telegramUserId,
      claimedEmail: parsed.value,
    })

    if (result.deliverTo) {
      await this.deps.codeDelivery.deliver({
        email: result.deliverTo.email,
        code: result.deliverTo.code,
        expiresInMinutes: 10,
      })
    }

    // Identical reply whether or not the address matched an employee, so the
    // bot cannot be used to enumerate staff e-mail addresses.
    await this.deps.client.sendMessage(
      update.chatId,
      'If that address belongs to an active employee, a 6-digit code has been sent to it. ' +
        'Reply with /code followed by the digits. The code expires in 10 minutes.',
    )
  }

  private async handleCodeSubmission(update: NormalisedUpdate, requestId: string): Promise<void> {
    const code = update.commandArgs.replace(/\D/g, '')
    if (code.length !== 6) {
      await this.deps.client.sendMessage(update.chatId, 'Please send /code followed by the 6 digits.')
      return
    }

    const outcome = await this.deps.telegramIdentity.verifyLink({
      tenantId: this.deps.tenantId,
      telegramUserId: update.telegramUserId,
      code,
    })

    if (!outcome.ok) {
      await this.deps.securityEvents.record({
        tenantId: this.deps.tenantId,
        eventType: 'AUTH_FAILURE',
        channel: 'TELEGRAM_INTERNAL',
        telegramId: update.telegramUserId,
        summary: `Telegram verification failed (${outcome.reason})`,
        requestId,
      })
      await this.deps.client.sendMessage(update.chatId, verificationFailureMessage(outcome.reason))
      return
    }

    await this.deps.client.sendMessage(
      update.chatId,
      `Your account is verified.\n\n${VERIFIED_HELP}`,
    )
  }
}

function unverifiedMessage(reason: string): string {
  switch (reason) {
    case 'LINK_REVOKED':
      return 'Your Telegram link has been revoked. Please contact HR.'
    case 'EMPLOYEE_INACTIVE':
    case 'USER_DISABLED':
      return 'Your account is not active. Please contact HR.'
    default:
      return UNVERIFIED_HELP
  }
}

function verificationFailureMessage(reason: string): string {
  switch (reason) {
    case 'NO_ACTIVE_CODE':
      return 'I do not have a pending code for you. Send /verify your.name@company.com first.'
    case 'TOO_MANY_ATTEMPTS':
      return 'Too many incorrect attempts. Please request a new code with /verify.'
    case 'EXPIRED':
      return 'That code has expired. Please request a new one with /verify.'
    default:
      return 'That code is not correct. Please check and try again.'
  }
}

function commandToNaturalLanguage(update: NormalisedUpdate): string {
  switch (update.command) {
    case 'balance':
      return 'What is my remaining leave balance?'
    case 'leave':
      return 'Show my leave requests'
    case 'request':
      return update.commandArgs
        ? `I want to request leave: ${update.commandArgs}`
        : 'I want to request leave. What details do you need?'
    case 'holidays':
      return 'What are the upcoming public holidays?'
    case 'policy':
      return update.commandArgs || 'What HR policies can you tell me about?'
    case 'approvals':
      return 'Show pending leave requests from my team'
    default:
      return update.text
  }
}
