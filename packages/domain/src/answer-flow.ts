/**
 * Curated bot answers (CLAUDE.md §23, §30) — the "training" unit an HR author
 * writes in the dashboard so a bot can answer from approved text instead of
 * model prose.
 *
 * Two rules live here because both are security properties, not presentation:
 * an answer reachable from the public zone must be PUBLIC, and only an ACTIVE,
 * in-date answer may ever be retrieved.
 */

import type { Classification } from './classification.js'

export const ANSWER_AUDIENCES = ['EXTERNAL', 'INTERNAL', 'BOTH'] as const
export type AnswerAudience = (typeof ANSWER_AUDIENCES)[number]

export function isAnswerAudience(v: unknown): v is AnswerAudience {
  return typeof v === 'string' && (ANSWER_AUDIENCES as readonly string[]).includes(v)
}

export const ANSWER_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export type AnswerStatus = (typeof ANSWER_STATUSES)[number]

export function isAnswerStatus(v: unknown): v is AnswerStatus {
  return typeof v === 'string' && (ANSWER_STATUSES as readonly string[]).includes(v)
}

/** Mirrors the CHECK constraint in migration 0007; both must agree. */
export function audienceReachesExternalZone(audience: AnswerAudience): boolean {
  return audience === 'EXTERNAL' || audience === 'BOTH'
}

export interface AnswerValidationIssue {
  field: string
  code: string
  message: string
}

export interface AnswerDraft {
  question: string
  answer: string
  audience: AnswerAudience
  classification: Classification
  /**
   * Whether the reader must hold a verified account. False lets an unverified
   * person on the internal bot receive general staff information — "who
   * approves leave", "how do I reach IT" — without linking an account first.
   * Only PUBLIC text may drop the requirement.
   */
  requiresAccount?: boolean
  phrases?: readonly string[]
  effectiveFrom: string
  effectiveTo?: string | null
}

/**
 * An external-audience answer is written for candidates, who have no account
 * to verify, so the requirement is meaningless there and always resolves off.
 */
export function resolveRequiresAccount(
  audience: AnswerAudience,
  requested: boolean | undefined,
): boolean {
  if (audienceReachesExternalZone(audience)) return false
  return requested ?? true
}

export const MAX_TRAINING_PHRASES = 20
const MAX_QUESTION = 300
const MAX_ANSWER = 4000
const MAX_PHRASE = 300

/**
 * Backend validation for an authored answer. The classification rule is the
 * important one: a candidate talking to the public bot has no role and no
 * ceiling, so anything the public bot can reach must be PUBLIC at rest.
 */
export function validateAnswerDraft(draft: AnswerDraft): AnswerValidationIssue[] {
  const issues: AnswerValidationIssue[] = []

  const question = draft.question.trim()
  if (question.length < 3) {
    issues.push({ field: 'question', code: 'TOO_SHORT', message: 'Question must be at least 3 characters.' })
  }
  if (question.length > MAX_QUESTION) {
    issues.push({ field: 'question', code: 'TOO_LONG', message: `Question must be at most ${MAX_QUESTION} characters.` })
  }

  const answer = draft.answer.trim()
  if (answer.length < 3) {
    issues.push({ field: 'answer', code: 'TOO_SHORT', message: 'Answer must be at least 3 characters.' })
  }
  if (answer.length > MAX_ANSWER) {
    issues.push({ field: 'answer', code: 'TOO_LONG', message: `Answer must be at most ${MAX_ANSWER} characters.` })
  }

  if (audienceReachesExternalZone(draft.audience) && draft.classification !== 'PUBLIC') {
    issues.push({
      field: 'classification',
      code: 'EXTERNAL_MUST_BE_PUBLIC',
      message:
        'An answer the external bot can serve must be classified PUBLIC. ' +
        'Set the audience to INTERNAL, or reclassify the answer as PUBLIC.',
    })
  }

  if (
    resolveRequiresAccount(draft.audience, draft.requiresAccount) === false &&
    draft.classification !== 'PUBLIC'
  ) {
    issues.push({
      field: 'requiresAccount',
      code: 'UNGATED_MUST_BE_PUBLIC',
      message:
        'Only a PUBLIC answer can be given to someone without a verified account. ' +
        'Reclassify it as PUBLIC, or leave the account requirement in place.',
    })
  }

  const phrases = draft.phrases ?? []
  if (phrases.length > MAX_TRAINING_PHRASES) {
    issues.push({
      field: 'phrases',
      code: 'TOO_MANY',
      message: `At most ${MAX_TRAINING_PHRASES} training phrases per answer.`,
    })
  }
  if (phrases.some((p) => p.trim().length < 3 || p.trim().length > MAX_PHRASE)) {
    issues.push({
      field: 'phrases',
      code: 'INVALID',
      message: `Each training phrase must be 3–${MAX_PHRASE} characters.`,
    })
  }

  if (!isDateOnly(draft.effectiveFrom)) {
    issues.push({ field: 'effectiveFrom', code: 'INVALID', message: 'effectiveFrom must be YYYY-MM-DD.' })
  }
  if (draft.effectiveTo != null) {
    if (!isDateOnly(draft.effectiveTo)) {
      issues.push({ field: 'effectiveTo', code: 'INVALID', message: 'effectiveTo must be YYYY-MM-DD.' })
    } else if (draft.effectiveTo < draft.effectiveFrom) {
      issues.push({ field: 'effectiveTo', code: 'BEFORE_START', message: 'effectiveTo cannot precede effectiveFrom.' })
    }
  }

  return issues
}

/** ARCHIVED is terminal: re-publishing would resurrect text nobody re-approved. */
export function canTransitionAnswer(from: AnswerStatus, to: AnswerStatus): boolean {
  if (from === to) return false
  if (from === 'ARCHIVED') return false
  return true
}

/**
 * Normalises question and phrases into the single indexed string. Retrieval
 * matches on this, so a phrasing that is not here is a phrasing the bot cannot
 * recognise.
 */
export function buildAnswerSearchText(question: string, phrases: readonly string[]): string {
  return [question, ...phrases].map((s) => s.trim()).filter(Boolean).join('\n')
}

function isDateOnly(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v)
}
