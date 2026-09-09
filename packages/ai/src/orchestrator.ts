/**
 * AI Orchestrator (CLAUDE.md §13). Sequences, budgets and frames a turn; holds
 * no authority of its own — every data access goes through the ToolRegistry,
 * and therefore the PolicyGateway.
 */

import {
  todayUtc,
  truncate,
  type DateOnly,
  type Logger,
} from '@corpus/shared'
import {
  DENY_MESSAGES,
  INTENT_DEFINITIONS,
  isIntentAllowedInZone,
  type Identity,
  type Intent,
} from '@corpus/domain'
import { tenantScope, type Repositories } from '@corpus/db'
import {
  filterAiResponse,
  injectionSeverity,
  INSUFFICIENT_KNOWLEDGE_REPLY,
  scanForInjection,
  wrapUntrusted,
  type RateLimiter,
  type RateLimitRule,
  type SecurityEventService,
} from '@corpus/security'
import type { AnswerSearchService, CuratedAnswer, KnowledgeSearchService } from '@corpus/knowledge'
import type { PolicyGateway } from '@corpus/security'
import type { IntentClassifier } from './intent-classifier.js'
import { systemPromptForZone } from './prompts.js'
import { AIProviderError, type AIMessage, type AIProvider } from './provider.js'
import type { ToolRegistry } from './tool-registry.js'
import type { ToolContext, ToolResultData } from './tool-types.js'

export interface OrchestratorDeps {
  provider: AIProvider
  classifier: IntentClassifier
  tools: ToolRegistry
  gateway: PolicyGateway
  repos: Repositories
  knowledgeSearch: KnowledgeSearchService
  /** Curated dashboard-authored answers, consulted before the model. */
  answerSearch: AnswerSearchService
  securityEvents: SecurityEventService
  rateLimiter: RateLimiter
  logger: Logger
  limits: {
    maxOutputTokens: number
    maxContextChunks: number
    maxHistoryTurns: number
    maxPageSize: number
    aiRule: RateLimitRule
    /** Query-stem coverage a curated answer needs to be served verbatim. */
    curatedAnswerMinCoverage?: number
  }
}

export interface AssistantRequest {
  identity: Identity
  message: string
  requestId: string
  /** Persist the exchange. Off for security tests that must not write. */
  persist?: boolean
  today?: DateOnly
}

export interface AssistantReply {
  text: string
  intent: Intent
  /** Tools that actually executed, with their decisions. */
  toolCalls: { name: string; decision: 'ALLOW' | 'DENY'; reasonCode: string | null }[]
  citations: { documentName: string; section: string | null; version: number }[]
  filterFindings: string[]
  injectionDetected: boolean
  usage: { inputTokens: number; outputTokens: number }
  /** Set when the request was refused before reaching the model. */
  refused: boolean
  /** Set when a dashboard-authored answer was served instead of model output. */
  curatedAnswerId?: string
}

const MAX_MESSAGE_CHARS = 2000

/** Two thirds of the query's stems must appear before an answer is reused. */
const DEFAULT_CURATED_MIN_COVERAGE = 0.67

/** Provider outage or a spent daily allowance — an operating state, not a crash. */
const PROVIDER_UNAVAILABLE_REPLY =
  'The assistant is temporarily unavailable. Please try again later, or contact HR directly.'

export class AIOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async handle(request: AssistantRequest): Promise<AssistantReply> {
    const today = request.today ?? todayUtc()
    const identity = request.identity
    const message = truncate(request.message.trim(), MAX_MESSAGE_CHARS)

    const empty: AssistantReply = {
      text: '',
      intent: 'UNKNOWN',
      toolCalls: [],
      citations: [],
      filterFindings: [],
      injectionDetected: false,
      usage: { inputTokens: 0, outputTokens: 0 },
      refused: false,
    }

    if (message.length === 0) {
      return { ...empty, text: 'Please tell me what you need.', refused: true }
    }

    // 1. AI budget. Enforced before any provider call (§37, §45).
    const budget = await this.deps.rateLimiter.consume(
      `ai:${identity.tenantId}:${identity.subjectKey}`,
      this.deps.limits.aiRule,
    )
    if (!budget.allowed) {
      await this.deps.securityEvents.record({
        tenantId: identity.tenantId,
        eventType: 'RATE_LIMIT',
        channel: identity.channel,
        subjectKey: identity.subjectKey,
        userId: identity.kind === 'USER' ? identity.userId : null,
        summary: 'AI request budget exhausted',
        requestId: request.requestId,
      })
      return { ...empty, text: DENY_MESSAGES.RATE_LIMITED, refused: true }
    }

    // Detection records the attempt; it never decides access (§26, §55).
    const scan = scanForInjection(message)
    if (scan.detected) {
      await this.deps.securityEvents.record({
        tenantId: identity.tenantId,
        eventType: scan.categories.includes('IDENTITY_ASSERTION') || scan.categories.includes('ROLE_CLAIM')
          ? 'IDENTITY_SPOOF_ATTEMPT'
          : 'PROMPT_INJECTION',
        severity: injectionSeverity(scan),
        channel: identity.channel,
        subjectKey: identity.subjectKey,
        userId: identity.kind === 'USER' ? identity.userId : null,
        telegramId: identity.telegramUserId ?? null,
        summary: `Injection-like input detected (${scan.categories.join(', ')})`,
        detail: { categories: scan.categories, score: scan.score, samples: scan.signals.slice(0, 3).map((s) => s.evidence) },
        requestId: request.requestId,
      })
    }

    const scope = tenantScope(identity.tenantId)
    let conversationId: string | null = null
    if (request.persist !== false) {
      const conversation = await this.deps.repos.conversations.findOrCreate(scope, {
        channel: identity.channel,
        subjectKey: identity.subjectKey,
        userId: identity.kind === 'USER' ? identity.userId : null,
        candidateId: identity.kind === 'ANONYMOUS' ? (identity.candidateId ?? null) : null,
      })
      conversationId = conversation.id
      await this.deps.repos.conversations.appendMessage(scope, {
        conversationId,
        role: 'user',
        content: message,
      })
    }

    const classified = await this.deps.classifier.classify(message, identity.zone)
    const intent = classified.definition.intent

    // Out-of-zone and RESTRICTED-risk intents are authorised before the model
    // sees a tool list, so a refusal is an audited decision. Without this a
    // salary question answered from prose alone would leave no trace.
    const definition = INTENT_DEFINITIONS[intent]
    const needsPreAuthorisation =
      !isIntentAllowedInZone(intent, identity.zone) || definition.risk === 'RESTRICTED'

    // A curated answer is text a human with `faq.manage` authored and approved
    // for this audience, so serving it verbatim is cheaper and more truthful
    // than asking a model to paraphrase it (§30, §37, §38). Authorisation still
    // comes first, from `knowledge.answer:search`: the gateway sets the
    // classification ceiling and the zone sets the audience.
    //
    // This runs *before* the intent gate below, because an approved PUBLIC
    // answer is not internal data — a candidate asking a policy-shaped question
    // should get the answer HR published for them rather than a zone refusal.
    //
    // Two kinds of intent are excluded. RESTRICTED-risk ones must reach the
    // gate and leave an audited DENY, which is the whole reason the gate
    // exists. Person-specific ones must come from the database (§38): "what is
    // my leave balance" has a different true answer for every asker, and a
    // broadly-worded curated answer must never be able to pre-empt the tool
    // that actually knows it.
    if (definition.risk !== 'RESTRICTED' && !isPersonSpecific(definition.target)) {
      const curated = await this.curatedAnswerFor(identity, message, today, request.requestId)
      if (curated) {
        const filtered = filterAiResponse(curated.answer, {
          groundedNumbers: figuresIn(curated.answer),
        })
        await this.persistAssistant(
          scope,
          conversationId,
          filtered.text,
          intent,
          request.persist !== false,
        )
        return {
          ...empty,
          text: filtered.text,
          intent,
          filterFindings: filtered.findings,
          injectionDetected: scan.detected,
          curatedAnswerId: curated.answerId,
        }
      }
    }


    if (needsPreAuthorisation) {
      const decision = await this.deps.gateway.authorize({
        identity,
        action: 'read',
        resource: {
          type: intentResource(intent),
          tenantId: identity.tenantId,
          classification: definition.risk === 'RESTRICTED' ? 'RESTRICTED' : undefined,
        },
        intent,
        requestId: request.requestId,
      })

      if (!decision.allowed) {
        await this.persistAssistant(
          scope,
          conversationId,
          decision.message,
          intent,
          request.persist !== false,
        )
        return {
          ...empty,
          text: decision.message,
          intent,
          refused: true,
          injectionDetected: scan.detected,
        }
      }
      // Allowed but out of zone should be impossible; refuse defensively.
      if (!isIntentAllowedInZone(intent, identity.zone)) {
        const text = DENY_MESSAGES.INTENT_NOT_ALLOWED_IN_ZONE
        await this.persistAssistant(scope, conversationId, text, intent, request.persist !== false)
        return { ...empty, text, intent, refused: true, injectionDetected: scan.detected }
      }
    }

    // Only tools this identity may use are offered; the external bot is never
    // shown internal tool names (§16).
    const toolDescriptions = this.deps.tools.describeFor(identity)
    const history =
      conversationId && request.persist !== false
        ? await this.deps.repos.conversations.recentMessages(
            scope,
            conversationId,
            this.deps.limits.maxHistoryTurns * 2,
          )
        : []

    const messages: AIMessage[] = [
      ...history
        .slice(0, -1) // the current message is appended explicitly below
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: truncate(m.content, 600) })),
      { role: 'user', content: message },
    ]

    const system = systemPromptForZone(
      identity.zone,
      identity.kind === 'USER'
        ? { displayName: identity.displayName, roles: identity.roles }
        : undefined,
    )

    let usage = { inputTokens: 0, outputTokens: 0 }
    const toolCalls: AssistantReply['toolCalls'] = []
    const citations: AssistantReply['citations'] = []
    const grounded: (string | number)[] = []
    const contextBlocks: string[] = []
    const toolSummaries: string[] = []
    /** User-safe messages from tools that refused or failed. */
    const toolFailureMessages: string[] = []

    let planning
    try {
      planning = await this.deps.provider.generateResponse({
        system,
        messages,
        tools: toolDescriptions,
        maxOutputTokens: this.deps.limits.maxOutputTokens,
        temperature: 0,
      })
    } catch (e) {
      return this.providerUnavailable(e, {
        scope,
        conversationId,
        intent,
        identity,
        requestId: request.requestId,
        persist: request.persist !== false,
        injectionDetected: scan.detected,
        empty,
      })
    }
    usage = addUsage(usage, planning.usage)

    // Every tool runs through the registry, hence the gateway. Max 3/turn (§52).
    const requested = planning.toolRequests.slice(0, 3)
    const toolCtx: ToolContext = {
      identity,
      repos: this.deps.repos,
      gateway: this.deps.gateway,
      knowledgeSearch: this.deps.knowledgeSearch,
      logger: this.deps.logger,
      today,
      requestId: request.requestId,
      conversationId,
      allowedClassifications: [],
      limits: {
        maxContextChunks: this.deps.limits.maxContextChunks,
        maxPageSize: this.deps.limits.maxPageSize,
      },
    }

    for (const toolRequest of requested) {
      const execution = await this.deps.tools.execute(
        toolRequest.name,
        toolRequest.arguments,
        toolCtx,
      )
      toolCalls.push({
        name: execution.toolName,
        decision: execution.decision,
        reasonCode: execution.reasonCode,
      })
      if (request.persist !== false) {
        await this.deps.repos.conversations.recordToolCall(scope, {
          conversationId,
          toolName: execution.toolName,
          decision: execution.decision,
          reasonCode: execution.reasonCode,
          latencyMs: execution.latencyMs,
        })
      }

      if (!execution.outcome.ok) {
        toolFailureMessages.push(execution.outcome.message)
        continue
      }
      const result: ToolResultData = execution.outcome.result
      toolSummaries.push(`${execution.toolName}: ${result.summary}`)
      if (result.data) {
        toolSummaries.push(JSON.stringify(result.data).slice(0, 2000))
      }
      if (result.groundedNumbers) grounded.push(...result.groundedNumbers)
      if (result.citations) citations.push(...result.citations)
      // Retrieved passages are ALWAYS wrapped as untrusted data (§26).
      if (result.contextPassages) {
        contextBlocks.push(
          ...result.contextPassages.map((p) => wrapUntrusted(p.label, p.content)),
        )
      }
    }

    let text = planning.text

    // Answering these from model prose would fabricate policy with no source (§30).
    const requiresGrounding =
      intent === 'HR_POLICY_QUESTION' || (intent === 'UNKNOWN' && identity.zone === 'INTERNAL')

    // Never fall back to the prompt scaffold, nor to ungrounded prose.
    const anySucceeded = toolCalls.some((t) => t.decision === 'ALLOW')
    if ((requested.length > 0 || requiresGrounding) && !anySucceeded) {
      const messages =
        toolFailureMessages.length > 0
          ? toolFailureMessages
          : requiresGrounding
            ? [INSUFFICIENT_KNOWLEDGE_REPLY]
            : ["I can't help with that here. Please contact HR."]
      const refusal = [...new Set(messages)].join(' ')

      // Recorded for HR follow-up rather than quietly dropped.
      if (requiresGrounding && request.persist !== false) {
        await this.deps.repos.conversations.recordUnanswered(scope, {
          conversationId,
          question: message,
          channel: identity.channel,
          askedByUserId: identity.kind === 'USER' ? identity.userId : null,
        })
      }

      await this.persistAssistant(scope, conversationId, refusal, intent, request.persist !== false)
      return {
        ...empty,
        text: refusal,
        intent,
        toolCalls,
        usage,
        refused: true,
        injectionDetected: scan.detected,
      }
    }

    if (requested.length > 0) {
      // Tool results are authorised facts, but their strings can carry text a
      // third party wrote, so the payload is framed like retrieved passages.
      const authorisedContext = [
        contextBlocks.length > 0 ? `AUTHORISED CONTEXT:\n${contextBlocks.join('\n\n')}` : '',
        // Our label stays outside the fence; only the payload goes inside.
        `TOOL RESULTS:\n${wrapUntrusted('tool results', toolSummaries.join('\n'))}`,
      ]
        .filter(Boolean)
        .join('\n\n')

      const answerRequest = {
        system,
        messages: [
          ...messages,
          {
            role: 'user' as const,
            content:
              `${authorisedContext}\n\n` +
              'Answer the question using only the material above. Do not add figures ' +
              'or policy statements that are not present.',
          },
        ],
        maxOutputTokens: this.deps.limits.maxOutputTokens,
        temperature: 0,
      }

      try {
        const answer = await this.deps.provider.generateResponse(answerRequest)
        usage = addUsage(usage, answer.usage)
        text = answer.text || toolSummaries.join('\n')
      } catch (e) {
        // The tools already ran and were authorised, so their summaries are a
        // truthful, terser answer containing no figure a tool did not return.
        this.deps.logger.warn('provider unavailable while composing the answer', {
          action: 'ai.generate',
          result: 'provider_error',
          requestId: request.requestId,
          error: e instanceof Error ? e.message : String(e),
        })
        text = toolSummaries.join('\n')
      }
    }

    // No fabrication: an empty answer becomes the standard HR referral.
    if (!text.trim()) {
      text =
        intent === 'HR_POLICY_QUESTION' || intent === 'UNKNOWN'
          ? INSUFFICIENT_KNOWLEDGE_REPLY
          : "I can't help with that here. Please contact HR."
      if (intent === 'HR_POLICY_QUESTION' && request.persist !== false) {
        await this.deps.repos.conversations.recordUnanswered(scope, {
          conversationId,
          question: message,
          channel: identity.channel,
          askedByUserId: identity.kind === 'USER' ? identity.userId : null,
        })
      }
    }

    // Last line of defence, not the primary one (§54).
    const filtered = filterAiResponse(text, {
      groundedNumbers: grounded,
      allowMonetaryValues: grounded.length > 0,
      externalZone: identity.zone === 'EXTERNAL',
    })
    if (filtered.findings.length > 0) {
      await this.deps.securityEvents.record({
        tenantId: identity.tenantId,
        eventType: 'BLOCKED_REQUEST',
        severity: filtered.findings.includes('SYSTEM_PROMPT_LEAK') ? 'HIGH' : 'MEDIUM',
        channel: identity.channel,
        subjectKey: identity.subjectKey,
        userId: identity.kind === 'USER' ? identity.userId : null,
        summary: `Model output filtered: ${filtered.findings.join(', ')}`,
        detail: { findings: filtered.findings, intent },
        requestId: request.requestId,
      })
    }

    await this.persistAssistant(scope, conversationId, filtered.text, intent, request.persist !== false)

    return {
      text: filtered.text,
      intent,
      toolCalls,
      citations,
      filterFindings: filtered.findings,
      injectionDetected: scan.detected,
      usage,
      refused: false,
    }
  }

  /** Detail goes to the log only; the user gets a plain answer (§46). */
  private async providerUnavailable(
    error: unknown,
    context: {
      scope: { tenantId: string }
      conversationId: string | null
      intent: Intent
      identity: Identity
      requestId: string
      persist: boolean
      injectionDetected: boolean
      empty: AssistantReply
    },
  ): Promise<AssistantReply> {
    const retryable = error instanceof AIProviderError ? error.retryable : false
    this.deps.logger.error('AI provider unavailable', {
      action: 'ai.generate',
      result: 'provider_unavailable',
      requestId: context.requestId,
      provider: error instanceof AIProviderError ? error.provider : 'unknown',
      retryable,
      error: error instanceof Error ? error.message : String(error),
    })

    await this.persistAssistant(
      context.scope,
      context.conversationId,
      PROVIDER_UNAVAILABLE_REPLY,
      context.intent,
      context.persist,
    )

    return {
      ...context.empty,
      text: PROVIDER_UNAVAILABLE_REPLY,
      intent: context.intent,
      refused: true,
      injectionDetected: context.injectionDetected,
    }
  }

  /**
   * The best curated answer for this turn, or null to fall through to the
   * model. Returning null is always safe; returning a row the caller may not
   * read is not, so every filter is applied before the text is read.
   */
  private async curatedAnswerFor(
    identity: Identity,
    message: string,
    today: DateOnly,
    requestId: string,
  ): Promise<CuratedAnswer | null> {
    const decision = await this.deps.gateway.authorize({
      identity,
      action: 'search',
      resource: { type: 'knowledge.answer', tenantId: identity.tenantId },
      requestId,
      // A miss is the common case and writes no row; a hit is audited by the
      // tool-free path below, so the search itself stays off the audit log.
      skipAudit: true,
    })
    if (!decision.allowed) return null

    const result = await this.deps.answerSearch.search({
      tenantId: identity.tenantId,
      query: message,
      compartment: compartmentFor(identity.channel),
      verifiedAccount: identity.kind === 'USER',
      allowedClassifications: decision.allowedClassifications,
      onDate: today,
      limit: 3,
    })

    const best = result.answers[0]
    if (!best) return null

    const floor = this.deps.limits.curatedAnswerMinCoverage ?? DEFAULT_CURATED_MIN_COVERAGE
    // Below the floor the question is merely adjacent, and answering it with
    // someone else's approved text would be a confident wrong answer (§30).
    if (best.coverage < floor || best.termMatches < 2) return null

    if (best.injection) {
      // Authored by a human with `faq.manage`, and served without a model turn,
      // so it cannot hijack a prompt — but an approved answer carrying
      // instruction-shaped text is worth an operator's attention.
      this.deps.logger.warn('curated answer contains instruction-like text', {
        action: 'knowledge.answer.serve',
        result: 'injection_markers',
        tenantId: identity.tenantId,
        requestId,
      })
    }

    return best
  }

  /**
   * Curated answers only — no tools, no provider call, no document retrieval.
   *
   * The internal bot uses this for a Telegram id that has not been linked to an
   * employee: general staff information does not need an account, but anything
   * personal or credential-bearing does, and this path structurally cannot
   * reach either. Returns null when nothing general matches, which is the
   * caller's cue to ask the person to verify.
   */
  async answerFromCuratedOnly(request: {
    identity: Identity
    message: string
    requestId: string
    today?: DateOnly
    persist?: boolean
  }): Promise<{ text: string; answerId: string } | null> {
    const identity = request.identity
    const message = truncate(request.message.trim(), MAX_MESSAGE_CHARS)
    if (message.length === 0) return null

    const budget = await this.deps.rateLimiter.consume(
      `ai:${identity.tenantId}:${identity.subjectKey}`,
      this.deps.limits.aiRule,
    )
    if (!budget.allowed) return null

    const curated = await this.curatedAnswerFor(
      identity,
      message,
      request.today ?? todayUtc(),
      request.requestId,
    )
    if (!curated) return null

    const filtered = filterAiResponse(curated.answer, {
      groundedNumbers: figuresIn(curated.answer),
    })

    // Recorded like any other turn (§29). The exchange is what an operator
    // needs when asking why a stranger was told something.
    if (request.persist !== false) {
      const scope = tenantScope(identity.tenantId)
      const conversation = await this.deps.repos.conversations.findOrCreate(scope, {
        channel: identity.channel,
        subjectKey: identity.subjectKey,
        userId: identity.kind === 'USER' ? identity.userId : null,
        candidateId: null,
      })
      await this.deps.repos.conversations.appendMessage(scope, {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      })
      await this.persistAssistant(scope, conversation.id, filtered.text, 'HR_POLICY_QUESTION', true)
    }

    return { text: filtered.text, answerId: curated.answerId }
  }

  private async persistAssistant(
    scope: { tenantId: string },
    conversationId: string | null,
    text: string,
    intent: Intent,
    persist: boolean,
  ): Promise<void> {
    if (!persist || !conversationId) return
    await this.deps.repos.conversations.appendMessage(scope, {
      conversationId,
      role: 'assistant',
      content: text,
      intent,
    })
  }
}

function addUsage(
  a: { inputTokens: number; outputTokens: number },
  b: { inputTokens: number; outputTokens: number },
): { inputTokens: number; outputTokens: number } {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
}

/**
 * Whether the answer depends on who is asking. Approved static text can never
 * be right for these, however well it matches the words.
 */
function isPersonSpecific(target: (typeof INTENT_DEFINITIONS)[Intent]['target']): boolean {
  return target === 'SELF' || target === 'OTHER_EMPLOYEE'
}

/**
 * Which set of curated answers the caller is talking to, taken from the channel
 * rather than the security zone. An unverified person messaging the internal
 * bot is in the internal compartment with no clearance — a different situation
 * from a candidate on the public bot, and the two must not be conflated.
 */
function compartmentFor(channel: Identity['channel']): 'EXTERNAL' | 'INTERNAL' {
  return channel === 'TELEGRAM_EXTERNAL' ? 'EXTERNAL' : 'INTERNAL'
}

/**
 * Figures inside an approved answer are grounded by definition — a human wrote
 * them — so the response filter must not redact the very numbers HR published.
 */
function figuresIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0])
}

/** Keeps the audit row coherent when refusing an out-of-zone intent. */
function intentResource(intent: Intent) {
  switch (INTENT_DEFINITIONS[intent].risk) {
    case 'RESTRICTED':
      return 'employee.compensation' as const
    case 'SENSITIVE':
      return 'candidate' as const
    default:
      return 'employee' as const
  }
}
