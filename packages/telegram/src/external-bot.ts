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
import { looksLikeAcceptedCv, MAX_CV_BYTES, type CvIntakeService } from '@corpus/knowledge'
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
  cvIntake: CvIntakeService
  logger: Logger
  tenantId: string
  messageRule: RateLimitRule
  /** Separate, tighter budget for file uploads. */
  uploadRule: RateLimitRule
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

    // 5. A CV upload. Handled before any model call: a file is not a question,
    //    and the candidate must already be identified for it to belong to
    //    anyone (§12 — a Telegram id is not an identity on its own).
    if (update.document) {
      await this.handleCvUpload(update, candidate, requestId)
      return
    }

    // 6. Commands that need no model call.
    if (update.command === 'start') {
      await this.deps.client.sendMessage(update.chatId, WELCOME)
      return
    }
    if (update.command === 'help') {
      await this.deps.client.sendMessage(update.chatId, HELP)
      return
    }

    const message = (await this.curatedQuestionFor(update)) ?? commandToNaturalLanguage(update)

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

  /**
   * The canonical question behind `/command`, when an author bound one.
   *
   * Returning the question rather than the answer is what keeps this safe: the
   * turn continues down the ordinary retrieval path, so audience,
   * classification and the account gate all still decide whether the text is
   * served. An unauthorised command therefore behaves exactly like an unknown
   * one, and does not reveal that it exists.
   */
  private async curatedQuestionFor(update: NormalisedUpdate): Promise<string | null> {
    if (!update.command) return null
    const answer = await this.deps.repos.knowledgeAnswers.findByCommand(
      tenantScope(this.deps.tenantId),
      update.command,
    )
    return answer ? answer.question : null
  }

  /**
   * Attach a CV to the candidate this Telegram id already belongs to.
   *
   * There is deliberately no "tell me your name" flow here: a file that is not
   * already tied to an application has no owner, and inventing one from a
   * Telegram profile is exactly the identity guess §12 forbids. The candidate
   * applies first, which captures a real name and e-mail, and then sends the CV.
   */
  private async handleCvUpload(
    update: NormalisedUpdate,
    candidate: { id: string; name: string } | null,
    requestId: string,
  ): Promise<void> {
    const file = update.document
    if (!file) return

    if (!candidate) {
      await this.deps.client.sendMessage(
        update.chatId,
        'Thanks — but I do not know who this belongs to yet. Apply for a job first ' +
          '(ask me to apply and give me your name and e-mail), then send your CV again.',
      )
      return
    }

    if (!looksLikeAcceptedCv(file.fileName, file.mimeType)) {
      await this.deps.client.sendMessage(
        update.chatId,
        'That file type is not accepted. Please send a PDF, DOCX, TXT or Markdown file.',
      )
      return
    }
    if (file.fileSize > MAX_CV_BYTES) {
      await this.deps.client.sendMessage(
        update.chatId,
        `That file is too large. Please send a CV under ${MAX_CV_BYTES / 1024 / 1024} MB.`,
      )
      return
    }

    // A separate, tighter budget: downloading a file costs far more than a
    // message, so the message limit alone is not enough of a brake.
    const budget = await this.deps.rateLimiter.consume(
      `tg:cv:${update.telegramUserId}`,
      this.deps.uploadRule,
    )
    if (!budget.allowed) {
      await this.deps.client.sendMessage(
        update.chatId,
        `You have sent several files already. Please try again in ${budget.resetSeconds}s.`,
      )
      return
    }

    await this.deps.client.sendChatAction(update.chatId, 'upload_document')
    const body = await this.deps.client.downloadFile(file.fileId, MAX_CV_BYTES)
    if (!body) {
      await this.deps.client.sendMessage(
        update.chatId,
        'I could not download that file. Please try sending it again.',
      )
      return
    }

    try {
      const stored = await this.deps.cvIntake.store({
        tenantId: this.deps.tenantId,
        candidateId: candidate.id,
        filename: file.fileName,
        contentType: file.mimeType || 'application/octet-stream',
        body,
        source: 'TELEGRAM_EXTERNAL',
        channel: 'TELEGRAM_EXTERNAL',
      })

      this.deps.logger.info('CV received over Telegram', {
        action: 'telegram.external',
        result: 'cv_stored',
        channel: 'TELEGRAM_EXTERNAL',
        requestId,
        bytes: stored.byteSize,
      })

      // The extraction outcome is not the candidate's problem — a scanned PDF
      // is still a received CV, and HR can read the original either way.
      await this.deps.client.sendMessage(
        update.chatId,
        `Thank you — I have attached "${stored.filename}" to your application. ` +
          'The recruitment team will see it with your details.',
      )
    } catch (e) {
      this.deps.logger.warn('CV intake failed', {
        action: 'telegram.external',
        result: 'cv_failed',
        channel: 'TELEGRAM_EXTERNAL',
        requestId,
        error: e instanceof Error ? e.name : 'unknown',
      })
      await this.deps.client.sendMessage(
        update.chatId,
        'Something went wrong storing that file. Please try again shortly.',
      )
    }
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
