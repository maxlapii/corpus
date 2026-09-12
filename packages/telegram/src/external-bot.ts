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
import {
  CV_FORMATS_LABEL,
  looksLikeAcceptedCv,
  MAX_CV_BYTES,
  type CvIntakeService,
} from '@corpus/knowledge'
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
  '• /apply — apply for a job, one question at a time',
  '• /status — check an application using its reference',
  '• /cv — send us your CV once you have applied',
  '',
  'I can only discuss public recruitment information.',
].join('\n')

/** Pointer to the guided flow, shown wherever an application is required. */
const APPLY_FORMAT = [
  'Send /apply and I will ask you three short questions:',
  '',
  '  1. which job',
  '  2. your name',
  '  3. your e-mail',
  '',
  'Use /jobs to see what is open.',
].join('\n')

const ASK_JOB = [
  "Which job are you applying for? Send the job code on its own, like ENG-001.",
  '',
  'Use /jobs to see what is open, or /cancel to stop.',
].join('\n')

const ASK_NAME = 'Thanks. What is your full name?'
const ASK_EMAIL = 'And your e-mail address?'

const HELP = [
  'Commands:',
  '/jobs — list published openings',
  '/apply — apply for a job (I ask three short questions)',
  '/status <reference> — check an application',
  '/cv — attach your CV to your application',
  '/cancel — stop what we are in the middle of',
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
    if (update.unsupportedAttachment) {
      this.deps.logger.info('external bot received an unsupported attachment', {
        action: 'telegram.external',
        result: 'cv_wrong_attachment',
        channel: 'TELEGRAM_EXTERNAL',
        requestId,
      })
      await this.deps.client.sendMessage(
        update.chatId,
        'I can only read a CV sent as a file. In Telegram choose the paperclip → ' +
          `**File**, not Photo or Gallery, and send a ${CV_FORMATS_LABEL}.`,
      )
      return
    }

    // 6. Commands that need no model call.
    if (update.command === 'cancel') {
      await this.deps.repos.applicationDrafts.clear(scope, update.telegramUserId)
      await this.deps.client.sendMessage(update.chatId, 'Stopped. Send /apply to start again.')
      return
    }
    if (update.command === 'apply') {
      await this.handleApply(update, identity, requestId)
      return
    }

    // A plain message while an application is part-finished is an answer to the
    // last question, not a new topic. Only reached when a draft is open, so an
    // ordinary conversation is never captured.
    if (!update.command && (await this.deps.repos.applicationDrafts.find(scope, update.telegramUserId))) {
      await this.continueApplication(update, identity, requestId)
      return
    }
    if (update.command === 'cv') {
      await this.explainCvUpload(update, candidate, requestId)
      return
    }
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
   * `/apply` — parsed here rather than left to the model.
   *
   * Applying needs three exact fields, and a conversational flow that depends
   * on a model guessing them is a flow that breaks the moment the provider
   * changes. The bot extracts them deterministically and then hands the
   * orchestrator one canonical sentence, so the application still goes through
   * the registered tool and the PolicyGateway — the authorisation path is
   * unchanged, only the guessing is removed.
   */
  private async handleApply(
    update: NormalisedUpdate,
    identity: Parameters<AIOrchestrator['runTool']>[0]['identity'],
    requestId: string,
  ): Promise<void> {
    const scope = tenantScope(this.deps.tenantId)

    // Someone who already knows the three fields can still send them in one
    // go, in any order — the guided questions are for everyone else.
    const parsed = parseApplication(update.commandArgs)
    if (!parsed) {
      const draft = await this.deps.repos.applicationDrafts.upsert(
        scope,
        update.telegramUserId,
        seedDraftFrom(update.commandArgs),
      )
      await this.deps.client.sendMessage(update.chatId, nextQuestion(draft))
      return
    }

    await this.deps.repos.applicationDrafts.clear(scope, update.telegramUserId)

    await this.submitApplication(update, identity, requestId, parsed)
  }

  /**
   * One answer to the question the bot last asked.
   *
   * The field is chosen by what is still missing rather than by a stored step
   * number, so an out-of-order or corrected answer lands where it belongs.
   */
  private async continueApplication(
    update: NormalisedUpdate,
    identity: Parameters<AIOrchestrator['runTool']>[0]['identity'],
    requestId: string,
  ): Promise<void> {
    const scope = tenantScope(this.deps.tenantId)
    const answer = update.text.trim()

    const draft = await this.deps.repos.applicationDrafts.upsert(
      scope,
      update.telegramUserId,
      fieldFrom(answer),
    )

    if (!draft.jobCode || !draft.fullName || !draft.email) {
      await this.deps.client.sendMessage(update.chatId, nextQuestion(draft))
      return
    }

    await this.submitApplication(
      update,
      identity,
      requestId,
      { jobCode: draft.jobCode, fullName: draft.fullName, email: draft.email },
    )
    await this.deps.repos.applicationDrafts.clear(scope, update.telegramUserId)
  }

  /** Shared by the one-line and guided routes, so both audit identically. */
  private async submitApplication(
    update: NormalisedUpdate,
    identity: Parameters<AIOrchestrator['runTool']>[0]['identity'],
    requestId: string,
    fields: ParsedApplication,
  ): Promise<void> {
    await this.deps.client.sendChatAction(update.chatId)

    // Straight to the registered tool with the parsed fields. Still through
    // ToolRegistry, so the PolicyGateway decides and audits — but nothing
    // re-reads the values out of a sentence.
    const outcome = await this.deps.orchestrator.runTool({
      identity,
      toolName: 'submit_application',
      args: { jobCode: fields.jobCode, fullName: fields.fullName, email: fields.email },
      requestId,
      userMessage: update.text,
    })

    await this.deps.client.sendMessage(
      update.chatId,
      outcome.ok
        ? `${outcome.text}\n\nSend me your CV as a file and I will attach it.`
        : outcome.text ||
            'I could not submit that application. Check the job code with /jobs and try again.',
    )
  }

  /**
   * One line per refusal, with the reason.
   *
   * Every branch above ends in a message to the candidate and nothing in the
   * log, which made a failed upload impossible to diagnose from the outside:
   * the bot appeared to do nothing at all.
   */
  private refusedCv(reason: string, requestId: string, extra: Record<string, unknown> = {}): void {
    this.deps.logger.info('CV upload refused', {
      action: 'telegram.external',
      result: `cv_${reason}`,
      channel: 'TELEGRAM_EXTERNAL',
      requestId,
      ...extra,
    })
  }

  /**
   * `/cv` with nothing attached. Explains what to do, and — because the answer
   * differs entirely depending on whether they have applied — says which of the
   * two situations they are in rather than making them guess.
   */
  private async explainCvUpload(
    update: NormalisedUpdate,
    candidate: { id: string; name: string } | null,
    requestId: string,
  ): Promise<void> {
    if (!candidate) {
      this.refusedCv('explain_no_candidate', requestId)
      await this.deps.client.sendMessage(
        update.chatId,
        `I do not know whose CV this would be yet.\n\n${APPLY_FORMAT}`,
      )
      return
    }

    const existing = await this.deps.repos.candidateDocuments.countForCandidate(
      tenantScope(this.deps.tenantId),
      candidate.id,
    )
    await this.deps.client.sendMessage(
      update.chatId,
      [
        existing > 0
          ? `You already have ${existing} file(s) on your application.`
          : 'No CV on your application yet.',
        '',
        `Send it to me as a file attachment — ${CV_FORMATS_LABEL}, up to ` +
          `${MAX_CV_BYTES / 1024 / 1024} MB. You do not need to type anything with it.`,
      ].join('\n'),
    )
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
      this.refusedCv('no_candidate', requestId)
      await this.deps.client.sendMessage(
        update.chatId,
        `Thanks — but I do not know whose CV this is yet.\n\n${APPLY_FORMAT}\n\n` +
          'Then send the file again.',
      )
      return
    }

    if (!looksLikeAcceptedCv(file.fileName, file.mimeType)) {
      this.refusedCv('bad_format', requestId, { mimeType: file.mimeType })
      await this.deps.client.sendMessage(
        update.chatId,
        `I cannot read "${file.fileName}". Please send a ${CV_FORMATS_LABEL} file.`,
      )
      return
    }
    if (file.fileSize > MAX_CV_BYTES) {
      this.refusedCv('too_large', requestId, { bytes: file.fileSize })
      await this.deps.client.sendMessage(
        update.chatId,
        `That file is ${Math.ceil(file.fileSize / 1024 / 1024)} MB. Please send a CV under ` +
          `${MAX_CV_BYTES / 1024 / 1024} MB.`,
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
      this.refusedCv('rate_limited', requestId)
      await this.deps.client.sendMessage(
        update.chatId,
        `You have sent several files already. Please try again in ${budget.resetSeconds}s.`,
      )
      return
    }

    await this.deps.client.sendChatAction(update.chatId, 'upload_document')
    const body = await this.deps.client.downloadFile(file.fileId, MAX_CV_BYTES)
    if (!body) {
      this.refusedCv('download_failed', requestId, { bytes: file.fileSize })
      await this.deps.client.sendMessage(
        update.chatId,
        'I could not download that file from Telegram. Please try sending it again.',
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
/** The next thing still missing, asked one at a time. */
function nextQuestion(draft: {
  jobCode: string | null
  fullName: string | null
  email: string | null
}): string {
  if (!draft.jobCode) return ASK_JOB
  if (!draft.fullName) return ASK_NAME
  return ASK_EMAIL
}

/**
 * Classify one free-text answer by shape.
 *
 * An e-mail and a job code are each unmistakable, so an answer is only treated
 * as a name when it is neither — which means "ENG-001" typed at the name
 * question still lands on the job code rather than becoming somebody's name.
 */
const fieldFrom = extractFields

/** Anything typed alongside `/apply` is a head start, not a requirement. */
const seedDraftFrom = extractFields

export interface ParsedApplication {
  jobCode: string
  fullName: string
  email: string
}

const EMAIL_IN_TEXT = /[^\s@|,]+@[^\s@|,]+\.[^\s@|,]+/
const JOB_CODE_IN_TEXT = /\b([A-Za-z]{2,4}-\d{1,4})\b/
/** Labels people add out of habit; harmless, and stripping them costs nothing. */
const FIELD_LABEL = /^\s*(name|full\s*name|e-?mail|job|job\s*code|code)\s*[:=]\s*/i
/** A leftover label word once its colon has been split away by whitespace. */
const FIELD_WORD = /^(name|full|e-?mail|job|code)$/i

/**
 * Pull the three fields out of whatever the candidate typed.
 *
 * Order-tolerant on purpose: an e-mail and a job code are each unmistakable on
 * their own, so they are identified by shape and the remainder is the name.
 * That accepts the documented `code | name | email` line, the same three in any
 * order, and the "Name: …" labelling people reach for anyway — without asking
 * a model to guess any of it.
 */
export function parseApplication(raw: string): ParsedApplication | null {
  const fields = extractFields(raw)
  if (!fields.jobCode || !fields.email || !fields.fullName) return null
  return { jobCode: fields.jobCode, fullName: fields.fullName, email: fields.email }
}

/**
 * Pull whichever of the three fields are present out of free text.
 *
 * Works on the whole string rather than on separated parts, so `|`, newlines
 * and plain spaces all behave the same — "ENG-001 Dara Sok dara@x.test" reads
 * exactly like the piped form. The e-mail and job code are unmistakable by
 * shape; the name is whatever survives once they are removed.
 */
function extractFields(raw: string): {
  jobCode?: string
  fullName?: string
  email?: string
} {
  const text = raw.replace(/[|\n]+/g, ' ')
  const email = text.match(EMAIL_IN_TEXT)?.[0]
  const jobCode = text.match(JOB_CODE_IN_TEXT)?.[1]

  let remainder = text
  if (email) remainder = remainder.replace(email, ' ')
  if (jobCode) remainder = remainder.replace(new RegExp(jobCode, 'i'), ' ')

  const fullName = remainder
    .split(/\s+/)
    .map((word) => word.replace(FIELD_LABEL, '').replace(/^[,;:]+|[,;:]+$/g, ''))
    .filter((word) => word.length > 0 && !FIELD_WORD.test(word))
    .join(' ')
    .trim()
    .slice(0, 120)

  return {
    ...(jobCode ? { jobCode: jobCode.toUpperCase() } : {}),
    ...(email ? { email } : {}),
    ...(fullName.length >= 2 ? { fullName } : {}),
  }
}

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
