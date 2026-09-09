/**
 * Candidate documents (CVs).
 *
 * The extracted text lives on the row so HR can read and match against a CV
 * without pulling the original out of object storage on every request. It is
 * untrusted data: nothing here interprets it, and every read is behind
 * `candidate.document:read`.
 */

import { nowIso, prefixedId } from '@corpus/shared'
import type { CandidateDocument } from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { assertSameTenant, type TenantScope } from '../tenant.js'
import { asNumber, asString, asStringOrNull, type Row } from './mappers.js'

export interface CandidateDocumentInput {
  candidateId: string
  kind: CandidateDocument['kind']
  filename: string
  contentType: string
  byteSize: number
  checksum: string | null
  storageKey: string
  extractedText: string | null
  extractionStatus: CandidateDocument['extractionStatus']
  extractor: string | null
  extractionWarnings: readonly string[]
  injectionFlagged: boolean
  source: CandidateDocument['source']
  uploadedByUserId: string | null
}

/** Row plus the candidate's name, for the dashboard list. */
export interface CandidateDocumentListItem extends CandidateDocument {
  candidateName: string
  candidateEmail: string
}

const mapDocument = (row: Row): CandidateDocument => ({
  id: asString(row.id),
  tenantId: asString(row.tenant_id),
  candidateId: asString(row.candidate_id),
  kind: asString(row.kind) as CandidateDocument['kind'],
  filename: asString(row.filename),
  contentType: asString(row.content_type),
  byteSize: asNumber(row.byte_size),
  checksum: asStringOrNull(row.checksum),
  storageKey: asString(row.storage_key),
  extractedText: asStringOrNull(row.extracted_text),
  extractionStatus: asString(row.extraction_status) as CandidateDocument['extractionStatus'],
  extractor: asStringOrNull(row.extractor),
  extractionWarnings: parseWarnings(row.extraction_warnings),
  injectionFlagged: asNumber(row.injection_flagged) === 1,
  source: asString(row.source) as CandidateDocument['source'],
  uploadedAt: asString(row.uploaded_at),
  uploadedByUserId: asStringOrNull(row.uploaded_by_user_id),
})

function parseWarnings(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export class CandidateDocumentRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(scope: TenantScope, id: string): Promise<CandidateDocument | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM candidate_documents WHERE tenant_id = ? AND id = ?',
      [scope.tenantId, id],
    )
    assertSameTenant(scope, row as { tenant_id?: string } | null)
    return row ? mapDocument(row) : null
  }

  async listForCandidate(scope: TenantScope, candidateId: string): Promise<CandidateDocument[]> {
    const rows = await this.db.many<Row>(
      `SELECT * FROM candidate_documents
        WHERE tenant_id = ? AND candidate_id = ? ORDER BY uploaded_at DESC`,
      [scope.tenantId, candidateId],
    )
    return rows.map(mapDocument)
  }

  /**
   * The dashboard listing. `extracted_text` is deliberately not selected: the
   * list shows metadata, and the body is fetched one document at a time.
   */
  async list(
    scope: TenantScope,
    options: { query?: string; kind?: CandidateDocument['kind']; limit: number; offset: number },
  ): Promise<{ items: CandidateDocumentListItem[]; total: number }> {
    const where = ['d.tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]

    if (options.kind) {
      where.push('d.kind = ?')
      params.push(options.kind)
    }
    if (options.query) {
      where.push("(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR d.filename LIKE ? ESCAPE '\\')")
      const like = `%${escapeLike(options.query)}%`
      params.push(like, like, like)
    }
    const clause = where.join(' AND ')

    const rows = await this.db.many<Row>(
      `SELECT d.id, d.tenant_id, d.candidate_id, d.kind, d.filename, d.content_type,
              d.byte_size, d.checksum, d.storage_key, NULL AS extracted_text,
              d.extraction_status, d.extractor, d.extraction_warnings, d.injection_flagged,
              d.source, d.uploaded_at, d.uploaded_by_user_id,
              c.name AS candidate_name, c.email AS candidate_email
         FROM candidate_documents d
         JOIN candidates c ON c.id = d.candidate_id AND c.tenant_id = d.tenant_id
        WHERE ${clause}
        ORDER BY d.uploaded_at DESC
        LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM candidate_documents d
         JOIN candidates c ON c.id = d.candidate_id AND c.tenant_id = d.tenant_id
        WHERE ${clause}`,
      params,
    )

    return {
      items: rows.map((row) => ({
        ...mapDocument(row),
        candidateName: asString(row.candidate_name),
        candidateEmail: asString(row.candidate_email),
      })),
      total,
    }
  }

  async create(scope: TenantScope, input: CandidateDocumentInput): Promise<CandidateDocument> {
    const id = prefixedId('cvd')
    await this.db.run(
      `INSERT INTO candidate_documents
         (id, tenant_id, candidate_id, kind, filename, content_type, byte_size, checksum,
          storage_key, extracted_text, extraction_status, extractor, extraction_warnings,
          injection_flagged, source, uploaded_at, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.candidateId,
        input.kind,
        input.filename,
        input.contentType,
        input.byteSize,
        input.checksum,
        input.storageKey,
        input.extractedText,
        input.extractionStatus,
        input.extractor,
        JSON.stringify([...input.extractionWarnings]),
        input.injectionFlagged ? 1 : 0,
        input.source,
        nowIso(),
        input.uploadedByUserId,
      ],
    )
    const created = await this.findById(scope, id)
    if (!created) throw new Error('candidate document disappeared immediately after insert')
    return created
  }

  /**
   * Replace the extracted text by hand.
   *
   * The escape hatch for a scanned PDF: without it a CV that has no text layer
   * could never be matched, and HR would have no way to fix that themselves.
   */
  async setExtractedText(
    scope: TenantScope,
    id: string,
    text: string,
    actorUserId: string | null,
  ): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE candidate_documents
          SET extracted_text = ?, extraction_status = 'OK', extractor = 'manual',
              extraction_warnings = ?, uploaded_by_user_id = COALESCE(uploaded_by_user_id, ?)
        WHERE tenant_id = ? AND id = ?`,
      [text, JSON.stringify(['Text was entered by hand.']), actorUserId, scope.tenantId, id],
    )
    return result.meta.changes === 1
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    const result = await this.db.run(
      'DELETE FROM candidate_documents WHERE tenant_id = ? AND id = ?',
      [scope.tenantId, id],
    )
    return result.meta.changes === 1
  }

  async countForCandidate(scope: TenantScope, candidateId: string): Promise<number> {
    return this.db.count(
      'SELECT COUNT(*) AS c FROM candidate_documents WHERE tenant_id = ? AND candidate_id = ?',
      [scope.tenantId, candidateId],
    )
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}
