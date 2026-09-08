/**
 * Ingestion (CLAUDE.md §24): upload → extract → clean → chunk → index.
 *
 * Injection-like content is flagged, not rejected — a legitimate policy may
 * quote such text, and the protection is the untrusted framing at prompt time.
 */

import { normaliseWhitespace, sha256Hex, type DateOnly, type Logger } from '@corpus/shared'
import type { Classification } from '@corpus/domain'
import { documentKey, tenantScope, type KnowledgeRepository, type StorageService } from '@corpus/db'
import { injectionSeverity, scanForInjection, type SecurityEventService } from '@corpus/security'
import { chunkDocument, type Chunk } from './chunking.js'
import { extractText } from './extraction.js'

export interface IngestionDeps {
  knowledge: KnowledgeRepository
  storage: StorageService
  securityEvents: SecurityEventService
  logger: Logger
}

export interface IngestRequest {
  tenantId: string
  documentId: string
  classification: Classification
  effectiveFrom: DateOnly
  effectiveTo?: DateOnly | null
  filename: string
  contentType: string
  body: ArrayBuffer
  uploadedByUserId: string | null
  /** Close the previous version off the day before this becomes effective. */
  supersedePrevious?: boolean
}

export interface IngestResult {
  versionId: string
  version: number
  chunkCount: number
  storageKey: string | null
  byteSize: number
  /** True when the extracted text contained injection-like instructions. */
  injectionFlagged: boolean
}

export class DocumentIngestionService {
  constructor(private readonly deps: IngestionDeps) {}

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const scope = tenantScope(request.tenantId)

    // Anything in the file is data, never instruction.
    const extraction = await extractText(request.body, request.contentType, request.filename)
    const text = normaliseWhitespace(extraction.text)
    if (text.length === 0) {
      throw new Error('The uploaded document produced no extractable text.')
    }

    const scan = scanForInjection(text)
    if (scan.detected) {
      await this.deps.securityEvents.record({
        tenantId: request.tenantId,
        eventType: 'DOCUMENT_INJECTION',
        severity: injectionSeverity(scan),
        userId: request.uploadedByUserId,
        channel: 'WEB',
        summary: `Uploaded document "${request.filename}" contains instruction-like text`,
        detail: {
          documentId: request.documentId,
          categories: scan.categories,
          score: scan.score,
          samples: scan.signals.slice(0, 5).map((s) => s.evidence),
        },
      })
    }

    const chunks: Chunk[] = chunkDocument(text)
    if (chunks.length === 0) throw new Error('The uploaded document could not be chunked.')

    const version = await this.deps.knowledge.nextVersionNumber(scope, request.documentId)
    const key = documentKey(request.tenantId, request.documentId, version, request.filename)
    let storageKey: string | null = null
    try {
      const stored = await this.deps.storage.put(key, request.body, request.contentType)
      storageKey = stored.key
    } catch (e) {
      // Indexing proceeds so search works; the missing original is logged.
      this.deps.logger.error('failed to store document original', {
        action: 'knowledge.ingest',
        result: 'storage_error',
        error: e instanceof Error ? e.message : String(e),
      })
    }

    // Atomic, superseding the previous version.
    const created = await this.deps.knowledge.addVersionWithChunks(scope, {
      documentId: request.documentId,
      classification: request.classification,
      effectiveFrom: request.effectiveFrom,
      effectiveTo: request.effectiveTo ?? null,
      filePath: storageKey,
      contentType: request.contentType,
      byteSize: request.body.byteLength,
      checksum: await sha256Hex(text).then((h) => h.slice(0, 32)),
      createdBy: request.uploadedByUserId,
      chunks: chunks.map((c) => ({
        section: c.section,
        page: c.page,
        content: c.content,
        tokenEstimate: c.tokenEstimate,
      })),
      supersedePrevious: request.supersedePrevious ?? true,
    })

    this.deps.logger.info('document indexed', {
      action: 'knowledge.ingest',
      result: 'ok',
      tenantId: request.tenantId,
      documentId: request.documentId,
      version: created.version,
      chunks: chunks.length,
    })

    return {
      versionId: created.id,
      version: created.version,
      chunkCount: chunks.length,
      storageKey,
      byteSize: request.body.byteLength,
      injectionFlagged: scan.detected,
    }
  }

  async ingestText(
    request: Omit<IngestRequest, 'body' | 'contentType'> & { text: string },
  ): Promise<IngestResult> {
    const body = new TextEncoder().encode(request.text).buffer as ArrayBuffer
    return this.ingest({ ...request, body, contentType: 'text/plain' })
  }
}
