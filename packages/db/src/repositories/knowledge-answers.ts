/**
 * Curated bot answers.
 *
 * Same §24 contract as the chunk repository: audience, classification, status
 * and effective dates are all applied inside the retrieval query, so an answer
 * the caller may not see is never materialised.
 */

import { nowIso, prefixedId, toFtsQuery, type DateOnly } from '@corpus/shared'
import {
  buildAnswerSearchText,
  resolveRequiresAccount,
  type AnswerAudience,
  type AnswerStatus,
  type Classification,
  type KnowledgeAnswer,
} from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { assertSameTenant, type TenantScope } from '../tenant.js'
import { asNumber, asString, asStringOrNull, type Row } from './mappers.js'

export interface AnswerSearchHit {
  answerId: string
  question: string
  answer: string
  category: string
  audience: AnswerAudience
  classification: Classification
  requiresAccount: boolean
  /** Lower is a better match (FTS5 bm25 convention). */
  rank: number
}

/** SQLite has no boolean type, so the 0/1 column is normalised on the way out. */
type RawAnswerHit = Omit<AnswerSearchHit, 'requiresAccount'> & { requiresAccount: number }

const normaliseHit = (row: RawAnswerHit): AnswerSearchHit => ({
  ...row,
  requiresAccount: Number(row.requiresAccount) === 1,
})

export interface AnswerListFilter {
  audience?: AnswerAudience
  status?: AnswerStatus
  category?: string
  query?: string
  limit: number
  offset: number
}

export interface AnswerWriteInput {
  question: string
  answer: string
  category: string
  audience: AnswerAudience
  classification: Classification
  status: AnswerStatus
  requiresAccount?: boolean
  effectiveFrom: DateOnly
  effectiveTo: DateOnly | null
  phrases: readonly string[]
  sourceUnansweredId?: string | null
  actorUserId: string | null
}

const mapAnswer = (row: Row, phrases: string[]): KnowledgeAnswer => ({
  id: asString(row.id),
  tenantId: asString(row.tenant_id),
  question: asString(row.question),
  answer: asString(row.answer),
  category: asString(row.category),
  audience: asString(row.audience) as AnswerAudience,
  classification: asString(row.classification) as Classification,
  status: asString(row.status) as AnswerStatus,
  requiresAccount: asNumber(row.requires_account) === 1,
  effectiveFrom: asString(row.effective_from),
  effectiveTo: asStringOrNull(row.effective_to),
  phrases,
  sourceUnansweredId: asStringOrNull(row.source_unanswered_id),
  createdAt: asString(row.created_at),
  updatedAt: asString(row.updated_at),
  createdBy: asStringOrNull(row.created_by),
  updatedBy: asStringOrNull(row.updated_by),
})

/**
 * Audiences a compartment may retrieve. EXTERNAL deliberately cannot reach an
 * INTERNAL row even if that row were somehow classified PUBLIC.
 *
 * The compartment comes from the *channel* the person is talking on, not from
 * their security zone: an unverified person messaging the internal bot is in
 * the internal compartment with no clearance, which is a different thing from
 * a candidate on the public bot.
 */
const AUDIENCES_FOR_COMPARTMENT: Record<AnswerCompartment, readonly AnswerAudience[]> = {
  EXTERNAL: ['EXTERNAL', 'BOTH'],
  INTERNAL: ['INTERNAL', 'BOTH'],
}

export type AnswerCompartment = 'EXTERNAL' | 'INTERNAL'

export interface AnswerRetrievalScope {
  /** Which bot is asking. Derived from the channel, never from the caller. */
  compartment: AnswerCompartment
  /** From a gateway ALLOW decision. */
  allowedClassifications: readonly Classification[]
  /** Whether the reader holds a verified account. */
  verifiedAccount: boolean
}

export class KnowledgeAnswerRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(scope: TenantScope, id: string): Promise<KnowledgeAnswer | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM knowledge_answers WHERE tenant_id = ? AND id = ?',
      [scope.tenantId, id],
    )
    assertSameTenant(scope, row as { tenant_id?: string } | null)
    if (!row) return null
    return mapAnswer(row, await this.phrasesFor(scope, id))
  }

  async findByQuestion(scope: TenantScope, question: string): Promise<KnowledgeAnswer | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM knowledge_answers WHERE tenant_id = ? AND question = ?',
      [scope.tenantId, question.trim()],
    )
    if (!row) return null
    return mapAnswer(row, await this.phrasesFor(scope, asString(row.id)))
  }

  /** Authoring view. Gated by `faq.manage`, so it is not classification-filtered. */
  async list(
    scope: TenantScope,
    filter: AnswerListFilter,
  ): Promise<{ items: KnowledgeAnswer[]; total: number }> {
    const where = ['tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]

    if (filter.audience) {
      where.push('audience = ?')
      params.push(filter.audience)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.category) {
      where.push('category = ?')
      params.push(filter.category)
    }
    if (filter.query) {
      where.push("(search_text LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')")
      const like = `%${escapeLike(filter.query)}%`
      params.push(like, like)
    }

    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `SELECT * FROM knowledge_answers WHERE ${clause}
        ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, filter.limit, filter.offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM knowledge_answers WHERE ${clause}`,
      params,
    )

    const items: KnowledgeAnswer[] = []
    for (const row of rows) {
      items.push(mapAnswer(row, await this.phrasesFor(scope, asString(row.id))))
    }
    return { items, total }
  }

  /**
   * Retrieval for the bots. `allowedClassifications` comes from a gateway ALLOW
   * decision and `zone` from the verified channel — neither is caller-supplied.
   */
  async search(
    scope: TenantScope,
    input: AnswerRetrievalScope & {
      query: string
      onDate: DateOnly
      limit: number
      category?: string
    },
  ): Promise<AnswerSearchHit[]> {
    if (input.allowedClassifications.length === 0) return []
    const match = toFtsQuery(input.query)
    if (!match) return []

    const audiences = AUDIENCES_FOR_COMPARTMENT[input.compartment]
    const params: (string | number)[] = [
      match,
      scope.tenantId,
      ...audiences,
      ...input.allowedClassifications,
      input.verifiedAccount ? 1 : 0,
      input.onDate,
      input.onDate,
    ]
    let categoryClause = ''
    if (input.category) {
      categoryClause = 'AND a.category = ?'
      params.push(input.category)
    }
    params.push(input.limit)

    const rows = await this.db.many<RawAnswerHit>(
      `SELECT a.id             AS answerId,
              a.question       AS question,
              a.answer         AS answer,
              a.category       AS category,
              a.audience       AS audience,
              a.classification AS classification,
              a.requires_account AS requiresAccount,
              bm25(knowledge_answers_fts) AS rank
         FROM knowledge_answers_fts f
         JOIN knowledge_answers a ON a.id = f.answer_id
        WHERE knowledge_answers_fts MATCH ?
          AND a.tenant_id = ?
          AND a.audience IN (${audiences.map(() => '?').join(', ')})
          AND a.classification IN (${input.allowedClassifications.map(() => '?').join(', ')})
          AND a.status = 'ACTIVE'
          AND (? = 1 OR a.requires_account = 0)
          AND a.effective_from <= ?
          AND (a.effective_to IS NULL OR a.effective_to >= ?)
          ${categoryClause}
        ORDER BY rank
        LIMIT ?`,
      params,
    )
    return rows.map(normaliseHit)
  }

  /** LIKE fallback for the same filter set, used when FTS is unavailable. */
  async searchFallback(
    scope: TenantScope,
    input: AnswerRetrievalScope & {
      terms: readonly string[]
      onDate: DateOnly
      limit: number
    },
  ): Promise<AnswerSearchHit[]> {
    if (input.allowedClassifications.length === 0 || input.terms.length === 0) return []

    const audiences = AUDIENCES_FOR_COMPARTMENT[input.compartment]
    const termClauses = input.terms
      .map(() => "(a.search_text LIKE ? ESCAPE '\\' OR a.answer LIKE ? ESCAPE '\\')")
      .join(' OR ')
    const params: (string | number)[] = [
      scope.tenantId,
      ...audiences,
      ...input.allowedClassifications,
      input.verifiedAccount ? 1 : 0,
    ]
    for (const term of input.terms) {
      const like = `%${escapeLike(term)}%`
      params.push(like, like)
    }
    params.push(input.onDate, input.onDate, input.limit)

    const rows = await this.db.many<RawAnswerHit>(
      `SELECT a.id             AS answerId,
              a.question       AS question,
              a.answer         AS answer,
              a.category       AS category,
              a.audience       AS audience,
              a.classification AS classification,
              a.requires_account AS requiresAccount,
              0                AS rank
         FROM knowledge_answers a
        WHERE a.tenant_id = ?
          AND a.audience IN (${audiences.map(() => '?').join(', ')})
          AND a.classification IN (${input.allowedClassifications.map(() => '?').join(', ')})
          AND a.status = 'ACTIVE'
          AND (? = 1 OR a.requires_account = 0)
          AND (${termClauses})
          AND a.effective_from <= ?
          AND (a.effective_to IS NULL OR a.effective_to >= ?)
        ORDER BY a.updated_at DESC
        LIMIT ?`,
      params,
    )
    return rows.map(normaliseHit)
  }

  async create(scope: TenantScope, input: AnswerWriteInput): Promise<KnowledgeAnswer> {
    const id = prefixedId('kba')
    const now = nowIso()
    const phrases = normalisePhrases(input.phrases)

    await this.db.run(
      `INSERT INTO knowledge_answers
         (id, tenant_id, question, answer, category, audience, classification, status,
          requires_account, effective_from, effective_to, search_text, source_unanswered_id,
          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.question.trim(),
        input.answer.trim(),
        input.category,
        input.audience,
        input.classification,
        input.status,
        resolveRequiresAccount(input.audience, input.requiresAccount) ? 1 : 0,
        input.effectiveFrom,
        input.effectiveTo,
        buildAnswerSearchText(input.question, phrases),
        input.sourceUnansweredId ?? null,
        now,
        now,
        input.actorUserId,
        input.actorUserId,
      ],
    )

    await this.replacePhrases(scope, id, phrases)
    const created = await this.findById(scope, id)
    if (!created) throw new Error('answer disappeared immediately after insert')
    return created
  }

  async update(
    scope: TenantScope,
    id: string,
    input: AnswerWriteInput,
  ): Promise<KnowledgeAnswer | null> {
    const phrases = normalisePhrases(input.phrases)
    const result = await this.db.run(
      `UPDATE knowledge_answers
          SET question = ?, answer = ?, category = ?, audience = ?, classification = ?,
              status = ?, requires_account = ?, effective_from = ?, effective_to = ?,
              search_text = ?, updated_at = ?, updated_by = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        input.question.trim(),
        input.answer.trim(),
        input.category,
        input.audience,
        input.classification,
        input.status,
        resolveRequiresAccount(input.audience, input.requiresAccount) ? 1 : 0,
        input.effectiveFrom,
        input.effectiveTo,
        buildAnswerSearchText(input.question, phrases),
        nowIso(),
        input.actorUserId,
        scope.tenantId,
        id,
      ],
    )
    if (result.meta.changes === 0) return null

    await this.replacePhrases(scope, id, phrases)
    return this.findById(scope, id)
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    status: AnswerStatus,
    actorUserId: string | null,
  ): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE knowledge_answers SET status = ?, updated_at = ?, updated_by = ?
        WHERE tenant_id = ? AND id = ?`,
      [status, nowIso(), actorUserId, scope.tenantId, id],
    )
    return result.meta.changes === 1
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const result = await this.db.run(
      'DELETE FROM knowledge_answers WHERE tenant_id = ? AND id = ?',
      [scope.tenantId, id],
    )
    return result.meta.changes === 1
  }

  async countByAudience(scope: TenantScope): Promise<Record<string, number>> {
    const rows = await this.db.many<Row>(
      `SELECT audience, status, COUNT(*) AS c FROM knowledge_answers
        WHERE tenant_id = ? GROUP BY audience, status`,
      [scope.tenantId],
    )
    const out: Record<string, number> = {}
    for (const row of rows) {
      out[`${asString(row.audience)}:${asString(row.status)}`] = asNumber(row.c)
    }
    return out
  }

  private async phrasesFor(scope: TenantScope, answerId: string): Promise<string[]> {
    const rows = await this.db.many<Row>(
      `SELECT phrase FROM knowledge_answer_phrases
        WHERE tenant_id = ? AND answer_id = ? ORDER BY created_at, phrase`,
      [scope.tenantId, answerId],
    )
    return rows.map((row) => asString(row.phrase))
  }

  private async replacePhrases(
    scope: TenantScope,
    answerId: string,
    phrases: readonly string[],
  ): Promise<void> {
    await this.db.run(
      'DELETE FROM knowledge_answer_phrases WHERE tenant_id = ? AND answer_id = ?',
      [scope.tenantId, answerId],
    )
    const now = nowIso()
    for (const phrase of phrases) {
      await this.db.run(
        `INSERT INTO knowledge_answer_phrases (id, tenant_id, answer_id, phrase, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [prefixedId('kbp'), scope.tenantId, answerId, phrase, now],
      )
    }
  }
}

function normalisePhrases(phrases: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of phrases) {
    const phrase = raw.trim()
    if (!phrase) continue
    const key = phrase.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(phrase)
  }
  return out
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}
