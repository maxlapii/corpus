/**
 * Retrieval for curated bot answers (CLAUDE.md §24, §30).
 *
 * A curated answer outranks a retrieved policy passage because a human wrote
 * and approved it, so the caller may return it verbatim rather than asking the
 * model to summarise. That makes the permission filter the only thing standing
 * between an authored answer and a candidate, which is why the audience and the
 * classification set are both applied in SQL and re-asserted here.
 */

import { tokenise, type DateOnly, type Logger } from '@corpus/shared'
import type { AnswerAudience, Classification } from '@corpus/domain'
import {
  tenantScope,
  type AnswerCompartment,
  type AnswerSearchHit,
  type KnowledgeAnswerRepository,
} from '@corpus/db'
import { scanForInjection, type InjectionScan } from '@corpus/security'

export interface AnswerSearchRequest {
  tenantId: string
  query: string
  /** Which bot is asking, from the channel — not the caller's security zone. */
  compartment: AnswerCompartment
  allowedClassifications: readonly Classification[]
  /** Whether the reader holds a verified account. */
  verifiedAccount: boolean
  onDate: DateOnly
  limit: number
  category?: string
  /** Curated text is short, so one solid stem is enough. Defaults to 1. */
  minTermMatches?: number
}

export interface CuratedAnswer {
  answerId: string
  question: string
  answer: string
  category: string
  audience: AnswerAudience
  classification: Classification
  requiresAccount: boolean
  score: number
  termMatches: number
  /** Share of the query's distinct stems this answer covers, 0..1. */
  coverage: number
  injection: InjectionScan | null
}

export interface AnswerSearchResult {
  answers: CuratedAnswer[]
  empty: boolean
  strategy: 'fts' | 'like' | 'none'
}

export interface AnswerSearchService {
  search(request: AnswerSearchRequest): Promise<AnswerSearchResult>
}

export interface D1AnswerSearchDeps {
  answers: KnowledgeAnswerRepository
  logger: Logger
}

export class D1AnswerSearchService implements AnswerSearchService {
  constructor(private readonly deps: D1AnswerSearchDeps) {}

  async search(request: AnswerSearchRequest): Promise<AnswerSearchResult> {
    if (request.allowedClassifications.length === 0) {
      return { answers: [], empty: true, strategy: 'none' }
    }
    const terms = tokenise(request.query)
    if (terms.length === 0) return { answers: [], empty: true, strategy: 'none' }

    const scope = tenantScope(request.tenantId)
    let hits: AnswerSearchHit[] = []
    let strategy: 'fts' | 'like' = 'fts'

    try {
      hits = await this.deps.answers.search(scope, {
        query: request.query,
        compartment: request.compartment,
        verifiedAccount: request.verifiedAccount,
        allowedClassifications: request.allowedClassifications,
        onDate: request.onDate,
        limit: request.limit,
        ...(request.category ? { category: request.category } : {}),
      })
    } catch (e) {
      this.deps.logger.warn('answer FTS search failed; falling back to LIKE', {
        action: 'knowledge.answer.search',
        result: 'fts_error',
        error: e instanceof Error ? e.message : String(e),
      })
      hits = []
    }

    if (hits.length === 0) {
      strategy = 'like'
      hits = await this.deps.answers.searchFallback(scope, {
        terms,
        compartment: request.compartment,
        verifiedAccount: request.verifiedAccount,
        allowedClassifications: request.allowedClassifications,
        onDate: request.onDate,
        limit: request.limit,
      })
    }

    const allowed = new Set(request.allowedClassifications)
    const authorised = hits.filter((hit) => allowed.has(hit.classification))
    if (authorised.length !== hits.length) {
      this.deps.logger.error('answer search returned an unauthorised classification', {
        action: 'knowledge.answer.search',
        result: 'classification_mismatch',
        tenantId: request.tenantId,
      })
    }

    // Defence-in-depth restatements of the SQL filters. An EXTERNAL caller must
    // never see an INTERNAL-only row whatever its classification, and a reader
    // with no verified account must never see an account-gated row.
    const inCompartment = authorised.filter((hit) =>
      request.compartment === 'EXTERNAL'
        ? hit.audience !== 'INTERNAL'
        : hit.audience !== 'EXTERNAL',
    )
    if (inCompartment.length !== authorised.length) {
      this.deps.logger.error('answer search returned a row outside the caller compartment', {
        action: 'knowledge.answer.search',
        result: 'audience_mismatch',
        tenantId: request.tenantId,
      })
    }

    const inZone = request.verifiedAccount
      ? inCompartment
      : inCompartment.filter((hit) => !hit.requiresAccount)
    if (inZone.length !== inCompartment.length) {
      this.deps.logger.error('answer search returned an account-gated row to an unverified reader', {
        action: 'knowledge.answer.search',
        result: 'account_gate_mismatch',
        tenantId: request.tenantId,
      })
    }

    const floor = Math.min(request.minTermMatches ?? 1, terms.length)
    const stems = new Set(terms.map(stem))

    const answers = inZone
      .map((hit) => {
        const injection = scanForInjection(hit.answer)
        const termMatches = countTermMatches(`${hit.question} ${hit.answer}`, stems)
        return {
          answerId: hit.answerId,
          question: hit.question,
          answer: hit.answer,
          category: hit.category,
          audience: hit.audience,
          classification: hit.classification,
          requiresAccount: hit.requiresAccount,
          score: strategy === 'fts' ? -Number(hit.rank ?? 0) : 0,
          termMatches,
          coverage: stems.size === 0 ? 0 : termMatches / stems.size,
          injection: injection.detected ? injection : null,
        }
      })
      .filter((candidate) => candidate.termMatches >= floor)
      .sort((a, b) => b.coverage - a.coverage || b.termMatches - a.termMatches || b.score - a.score)
      .slice(0, request.limit)

    return { answers, empty: answers.length === 0, strategy }
  }
}

function stem(token: string): string {
  for (const suffix of ['ally', 'ing', 'edly', 'ly', 'es', 'ed', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

function countTermMatches(text: string, queryStems: ReadonlySet<string>): number {
  const present = new Set(tokenise(text).map(stem))
  let matches = 0
  for (const queryStem of queryStems) if (present.has(queryStem)) matches++
  return matches
}
