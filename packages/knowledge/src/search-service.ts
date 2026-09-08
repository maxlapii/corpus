/**
 * Knowledge retrieval (CLAUDE.md §25) — D1/FTS5 today, vector or hybrid later.
 *
 * The security contract holds for any backend: the authorised classification
 * set comes from a PolicyGateway ALLOW decision, and filtering happens inside
 * the query (§24) — never afterwards, and never by asking the model to withhold.
 */

import { tokenise, type DateOnly, type Logger } from '@corpus/shared'
import type { Classification } from '@corpus/domain'
import type { ChunkSearchHit, KnowledgeRepository } from '@corpus/db'
import { tenantScope } from '@corpus/db'
import { scanForInjection, type InjectionScan } from '@corpus/security'

export interface KnowledgeSearchRequest {
  tenantId: string
  query: string
  allowedClassifications: readonly Classification[]
  onDate: DateOnly
  limit: number
  category?: string
  /** Without a floor, one common word looks like an answer. Defaults to 2. */
  minTermMatches?: number
}

export interface KnowledgePassage {
  chunkId: string
  documentId: string
  documentName: string
  section: string | null
  page: number | null
  classification: Classification
  version: number
  content: string
  score: number
  termMatches: number
  injection: InjectionScan | null
}

export interface KnowledgeSearchResult {
  passages: KnowledgePassage[]
  empty: boolean
  strategy: 'fts' | 'like' | 'none'
}

export interface KnowledgeSearchService {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>
}

export interface D1KnowledgeSearchDeps {
  knowledge: KnowledgeRepository
  logger: Logger
}

/** FTS5 with a LIKE fallback, both permission-filtered in SQL. */
export class D1KnowledgeSearchService implements KnowledgeSearchService {
  constructor(private readonly deps: D1KnowledgeSearchDeps) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
    if (request.allowedClassifications.length === 0) {
      return { passages: [], empty: true, strategy: 'none' }
    }
    const terms = tokenise(request.query)
    if (terms.length === 0) return { passages: [], empty: true, strategy: 'none' }

    const scope = tenantScope(request.tenantId)
    let hits: ChunkSearchHit[] = []
    let strategy: 'fts' | 'like' = 'fts'

    try {
      hits = await this.deps.knowledge.searchChunks(scope, {
        query: request.query,
        allowedClassifications: request.allowedClassifications,
        onDate: request.onDate,
        limit: request.limit,
        ...(request.category ? { category: request.category } : {}),
      })
    } catch (e) {
      this.deps.logger.warn('FTS search failed; falling back to LIKE', {
        action: 'knowledge.search',
        result: 'fts_error',
        error: e instanceof Error ? e.message : String(e),
      })
      hits = []
    }

    if (hits.length === 0) {
      strategy = 'like'
      hits = await this.deps.knowledge.searchChunksFallback(scope, {
        terms,
        allowedClassifications: request.allowedClassifications,
        onDate: request.onDate,
        limit: request.limit,
      })
    }

    const allowed = new Set(request.allowedClassifications)

    // The SQL already guarantees this; a mismatch means a regression, so it is
    // logged rather than silently corrected.
    const authorised = hits.filter((hit) => allowed.has(hit.classification))
    if (authorised.length !== hits.length) {
      this.deps.logger.error('knowledge search returned an unauthorised classification', {
        action: 'knowledge.search',
        result: 'classification_mismatch',
        tenantId: request.tenantId,
      })
    }

    const floor = Math.min(request.minTermMatches ?? 2, terms.length)
    const stems = new Set(terms.map(stem))

    const passages = authorised
      .map((hit) => {
        const injection = scanForInjection(hit.content)
        return {
          chunkId: hit.chunkId,
          documentId: hit.documentId,
          documentName: hit.documentName,
          section: hit.section,
          page: hit.page,
          classification: hit.classification,
          version: hit.version,
          content: hit.content,
          score: strategy === 'fts' ? -Number(hit.rank ?? 0) : keywordScore(hit.content, terms),
          termMatches: countTermMatches(hit.content, hit.section, stems),
          injection: injection.detected ? injection : null,
        }
      })
      .filter((passage) => passage.termMatches >= floor)
      .sort((a, b) => b.termMatches - a.termMatches || b.score - a.score)
      .slice(0, request.limit)

    return { passages, empty: passages.length === 0, strategy }
  }
}

/** Not a real stemmer — just enough that "remotely" matches "remote". */
function stem(token: string): string {
  for (const suffix of ['ally', 'ing', 'edly', 'ly', 'es', 'ed', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

function countTermMatches(
  content: string,
  section: string | null,
  queryStems: ReadonlySet<string>,
): number {
  const passageStems = new Set(tokenise(`${section ?? ''} ${content}`).map(stem))
  let matches = 0
  for (const queryStem of queryStems) if (passageStems.has(queryStem)) matches++
  return matches
}

function keywordScore(content: string, terms: readonly string[]): number {
  const tokens = tokenise(content)
  if (tokens.length === 0) return 0
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  let score = 0
  for (const term of terms) score += (counts.get(term) ?? 0) / Math.sqrt(tokens.length)
  return score
}
