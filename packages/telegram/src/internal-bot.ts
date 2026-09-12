/**
 * CORPUS Internal HR Bot (CLAUDE.md §32, §36).
 *
 * Anything personal, credential-bearing or classified requires a verified
 * identity: an unlinked Telegram id can reach no HR tool, no document and no
 * employee record, and it never learns whether an e-mail it guessed belongs to
 * a real employee.
 *
 * It can, however, be answered from curated answers an author has explicitly
 * published as general staff information ("who approves leave", "how do I
 * reach IT"). Those are PUBLIC-classified and flagged `requires_account = 0`,
 * so the concession is one an author makes per answer rather than a hole in the
 * zone. Everything else still ends at the verification prompt.
 */

import { prefixedId, safeParse, email as emailValidator, type Logger } from '@corpus/shared'
import { tenantScope, type Repositories } from '@corpus/db'
import type { IdentityResolver, TelegramIdentityService } from '@corpus/auth'
import type { UserIdentity } from '@corpus/domain'
import type { AIOrchestrator } from '@corpus/ai'
import type {
  PolicyGateway,
  RateLimiter,
  RateLimitRule,
  SecurityEventService,
} from '@corpus/security'
import {
  CV_FORMATS_LABEL,
  looksLikeAcceptedCv,
  MAX_CV_BYTES,
  type CvIntakeService,
} from '@corpus/knowledge'
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
  gateway: PolicyGateway
  cvIntake: CvIntakeService
  logger: Logger
  tenantId: string
  messageRule: RateLimitRule
  verificationRule: RateLimitRule
  /** Separate, tighter budget for file uploads. */
  uploadRule: RateLimitRule
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

const UNVERIFIED_FOOTER =
  'That is general information. For anything about your own record — leave, ' +
  'payslips, personal details — send /verify your.name@company.com to link your account.'

const VERIFIED_HELP = [
  'I can help with:',
  '• /balance — your leave balance',
  '• /leave — your leave requests',
  '• /request — submit a leave request',
  '• /holidays — upcoming public holidays',
  '• /policy <question> — search HR policy',
  '• /approvals — leave awaiting your decision (managers)',
  '• /cv <e-mail> — forward a candidate CV (HR)',
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
      const general =
        update.command === 'start' || update.command === 'help'
          ? null
          : await this.generalAnswerFor(update, requestId)

      await this.deps.securityEvents.record({
        tenantId: this.deps.tenantId,
        eventType: 'UNKNOWN_USER',
        channel: 'TELEGRAM_INTERNAL',
        telegramId: update.telegramUserId,
        summary: general
          ? 'Unverified Telegram user answered from general staff information'
          : `Unverified Telegram user contacted the internal bot (${resolution.reason})`,
        requestId,
      })

      await this.deps.client.sendMessage(
        update.chatId,
        general
          ? `${general}\n\n${UNVERIFIED_FOOTER}`
          : unverifiedMessage(resolution.reason),
      )
      return
    }

    // A forwarded CV. Handled before any model call, and only for staff who
    // may write to a candidate record — the gateway decides that, not the bot.
    if (update.document) {
      await this.handleCvForward(update, resolution.identity, requestId)
      return
    }
    if (update.command === 'cv') {
      await this.explainCvForward(update, resolution.identity, requestId)
      return
    }

    if (update.command === 'start' || update.command === 'help') {
      await this.deps.client.sendMessage(
        update.chatId,
        `Hello ${resolution.identity.displayName}.\n\n${VERIFIED_HELP}`,
      )
      return
    }

    const message = (await this.curatedQuestionFor(update)) ?? commandToNaturalLanguage(update)
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

  /**
   * The general-information path for an unlinked Telegram id.
   *
   * The identity is anonymous, so the gateway hands back a PUBLIC ceiling, and
   * `answerFromCuratedOnly` reaches nothing but curated answers. A personal
   * question therefore falls through to null and gets the verification prompt,
   * which is the behaviour we want without having to enumerate "personal".
   */
  private async generalAnswerFor(
    update: NormalisedUpdate,
    requestId: string,
  ): Promise<string | null> {
    const identity = await this.deps.identityResolver.anonymous({
      tenantId: this.deps.tenantId,
      channel: 'TELEGRAM_INTERNAL',
      rawSubject: update.telegramUserId,
      telegramUserId: update.telegramUserId,
    })

    const curated = await this.deps.orchestrator.answerFromCuratedOnly({
      identity,
      message: (await this.curatedQuestionFor(update)) ?? commandToNaturalLanguage(update),
      requestId,
    })
    if (!curated) return null

    this.deps.logger.info('internal bot answered an unverified user from general information', {
      action: 'telegram.internal',
      result: 'general',
      channel: 'TELEGRAM_INTERNAL',
      requestId,
    })
    return curated.text
  }

  /**
   * The canonical question behind `/command`, when an author bound one.
   *
   * The question is returned, not the answer: the turn continues down the
   * ordinary retrieval path, so classification and the verified-account gate
   * still decide whether anything is served. An unverified user running a
   * command bound to a gated answer therefore gets the verification prompt,
   * not the text.
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
   * Attach a CV a member of staff forwarded to a candidate already on file.
   *
   * The candidate is named in the message caption — `/cv <e-mail>`, or a bare
   * e-mail or application reference — because the sender is an employee, not
   * the person the CV describes, so there is nothing in the Telegram identity
   * to attach it to. An unknown address is refused rather than turned into a
   * new candidate: creating recruitment records from a caption is more than a
   * caption can carry, and the dashboard already does it properly.
   */
  private async handleCvForward(
    update: NormalisedUpdate,
    identity: UserIdentity,
    requestId: string,
  ): Promise<void> {
    const file = update.document
    if (!file) return

    // Who may write to a candidate record is a gateway decision, and a DENY
    // here is audited like any other.
    const decision = await this.deps.gateway.authorize({
      identity,
      action: 'create',
      resource: {
        type: 'candidate.document',
        tenantId: this.deps.tenantId,
        classification: 'CONFIDENTIAL',
      },
      requestId,
    })
    if (!decision.allowed) {
      await this.deps.client.sendMessage(update.chatId, decision.message)
      return
    }

    const reference = (update.command === 'cv' ? update.commandArgs : update.text).trim()
    if (reference.length === 0) {
      await this.deps.client.sendMessage(
        update.chatId,
        'Send the file again with a caption naming the candidate, for example ' +
          '"/cv jordan.applicant@example.test" or an application reference.',
      )
      return
    }

    const candidate = await this.findCandidate(reference)
    if (!candidate) {
      await this.deps.client.sendMessage(
        update.chatId,
        `I could not find a candidate matching "${reference.slice(0, 80)}". ` +
          'Use their e-mail address or application reference, and create the candidate in the ' +
          'dashboard first if they are new.',
      )
      return
    }

    if (!looksLikeAcceptedCv(file.fileName, file.mimeType)) {
      await this.deps.client.sendMessage(
        update.chatId,
        `That file type is not accepted. Send a ${CV_FORMATS_LABEL} file.`,
      )
      return
    }
    if (file.fileSize > MAX_CV_BYTES) {
      await this.deps.client.sendMessage(
        update.chatId,
        `That file is too large. The limit is ${MAX_CV_BYTES / 1024 / 1024} MB.`,
      )
      return
    }

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
        source: 'TELEGRAM_INTERNAL',
        channel: 'TELEGRAM_INTERNAL',
        uploadedByUserId: identity.userId,
      })

      this.deps.logger.info('CV forwarded over Telegram', {
        action: 'telegram.internal',
        result: 'cv_stored',
        channel: 'TELEGRAM_INTERNAL',
        userId: identity.userId ?? undefined,
        requestId,
        bytes: stored.byteSize,
      })

      await this.deps.client.sendMessage(
        update.chatId,
        `Attached "${stored.filename}" to ${candidate.name}. ` +
          (stored.extractionStatus === 'OK'
            ? 'The text was read and can be matched against a job.'
            : 'The text could not be read automatically — open it in the dashboard to enter it.'),
      )
    } catch (e) {
      this.deps.logger.warn('CV forward failed', {
        action: 'telegram.internal',
        result: 'cv_failed',
        channel: 'TELEGRAM_INTERNAL',
        requestId,
        error: e instanceof Error ? e.name : 'unknown',
      })
      await this.deps.client.sendMessage(
        update.chatId,
        'Something went wrong storing that file. Please try again shortly.',
      )
    }
  }

  /**
   * `/cv` with nothing attached. Checks the permission first, so someone who
   * may not forward a CV learns that immediately rather than after preparing a
   * file, and confirms the candidate exists before they send anything.
   */
  private async explainCvForward(
    update: NormalisedUpdate,
    identity: UserIdentity,
    requestId: string,
  ): Promise<void> {
    const decision = await this.deps.gateway.authorize({
      identity,
      action: 'create',
      resource: {
        type: 'candidate.document',
        tenantId: this.deps.tenantId,
        classification: 'CONFIDENTIAL',
      },
      requestId,
      skipAudit: true,
    })
    if (!decision.allowed) {
      await this.deps.client.sendMessage(update.chatId, decision.message)
      return
    }

    const reference = update.commandArgs.trim()
    if (reference.length === 0) {
      await this.deps.client.sendMessage(
        update.chatId,
        [
          'To attach a CV to a candidate, send the file with a caption naming them:',
          '',
          '  /cv jordan.applicant@example.test',
          '  /cv SPA-XXXXXXXX   (an application reference)',
          '',
          `${CV_FORMATS_LABEL}, up to ${MAX_CV_BYTES / 1024 / 1024} MB. The candidate must ` +
            'already exist — create them in the dashboard first if not.',
        ].join('\n'),
      )
      return
    }

    const candidate = await this.findCandidate(reference)
    await this.deps.client.sendMessage(
      update.chatId,
      candidate
        ? `Found ${candidate.name}. Send the CV as a file with the same caption and I will attach it.`
        : `I could not find a candidate matching "${reference.slice(0, 80)}". ` +
            'Use their e-mail address or application reference.',
    )
  }

  /** Resolve a caption to a candidate by e-mail or application reference. */
  private async findCandidate(reference: string): Promise<{ id: string; name: string } | null> {
    const scope = tenantScope(this.deps.tenantId)

    if (reference.includes('@')) {
      const byEmail = await this.deps.repos.candidates.findByEmail(scope, reference.toLowerCase())
      return byEmail ? { id: byEmail.id, name: byEmail.name } : null
    }

    const application = await this.deps.repos.applications.findByReference(
      scope,
      reference.toUpperCase(),
    )
    if (!application) return null
    const candidate = await this.deps.repos.candidates.findById(scope, application.candidateId)
    return candidate ? { id: candidate.id, name: candidate.name } : null
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
