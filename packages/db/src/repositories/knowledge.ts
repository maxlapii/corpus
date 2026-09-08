/**
 * Knowledge base repository.
 *
 * The critical rule (CLAUDE.md §24) is implemented here: the *retrieval query
 * itself* filters by the caller's authorised classification set and by
 * effective dates. Unauthorised content is never loaded into memory, so it can
 * never reach a prompt even by mistake.
 */

import { nowIso, prefixedId, toFtsQuery, type DateOnly } from '@corpus/shared'
import type { Classification, DocumentChunk, DocumentVersion, KnowledgeDocument } from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { assertSameTenant, type TenantScope } from '../tenant.js'
import { mapDocument, mapDocumentChunk, mapDocumentVersion, type Row } from './mappers.js'

export interface ChunkSearchHit {
  chunkId: string
  documentId: string
  documentName: string
  documentCategory: string
  classification: Classification
  version: number
  section: string | null
  page: number | null
  content: string
  /** Lower is a better match (FTS5 bm25 convention). */
  rank: number
}

export class KnowledgeRepository {
  constructor(private readonly db: DatabaseService) {}

  // --- Documents

  async findDocumentById(scope: TenantScope, id: string): Promise<KnowledgeDocument | null> {
    const row = await this.db.one<Row>('SELECT * FROM documents WHERE tenant_id = ? AND id = ?', [
      scope.tenantId,
      id,
    ])
    assertSameTenant(scope, row as { tenant_id?: string } | null)
    return row ? mapDocument(row) : null
  }

  async findDocumentByName(scope: TenantScope, name: string): Promise<KnowledgeDocument | null> {
    const row = await this.db.one<Row>('SELECT * FROM documents WHERE tenant_id = ? AND name = ?', [
      scope.tenantId,
      name,
    ])
    return row ? mapDocument(row) : null
  }

  /**
   * List documents the caller may see. `allowedClassifications` is computed by
   * the backend from the identity's permissions.
   */
  async listDocuments(
    scope: TenantScope,
    allowedClassifications: readonly Classification[],
    options: { category?: string; status?: KnowledgeDocument['status']; limit: number; offset: number },
  ): Promise<{ items: KnowledgeDocument[]; total: number }> {
    if (allowedClassifications.length === 0) return { items: [], total: 0 }
    const where = [
      'tenant_id = ?',
      `classification IN (${allowedClassifications.map(() => '?').join(', ')})`,
    ]
    const params: (string | number)[] = [scope.tenantId, ...allowedClassifications]
    if (options.category) {
      where.push('category = ?')
      params.push(options.category)
    }
    if (options.status) {
      where.push('status = ?')
      params.push(options.status)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `SELECT * FROM documents WHERE ${clause} ORDER BY name LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM documents WHERE ${clause}`, params)
    return { items: rows.map(mapDocument), total }
  }

  async createDocument(
    scope: TenantScope,
    input: {
      name: string
      category: string
      classification: Classification
      owner?: string | null
      status?: KnowledgeDocument['status']
    },
  ): Promise<KnowledgeDocument> {
    const id = prefixedId('doc')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO documents
         (id, tenant_id, name, category, classification, owner, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.name,
        input.category,
        input.classification,
        input.owner ?? null,
        input.status ?? 'DRAFT',
        ts,
        ts,
      ],
    )
    const created = await this.findDocumentById(scope, id)
    if (!created) throw new Error('document insert did not persist')
    return created
  }

  async updateDocument(
    scope: TenantScope,
    id: string,
    patch: Partial<{
      name: string
      category: string
      classification: Classification
      owner: string | null
      status: KnowledgeDocument['status']
    }>,
  ): Promise<KnowledgeDocument | null> {
    const columns: Record<string, string> = {
      name: 'name',
      category: 'category',
      classification: 'classification',
      owner: 'owner',
      status: 'status',
    }
    const sets: string[] = []
    const params: (string | null)[] = []
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue
      sets.push(`${column} = ?`)
      params.push(((patch as Record<string, string | null>)[key] ?? null))
    }
    if (sets.length === 0) return this.findDocumentById(scope, id)
    sets.push('updated_at = ?')
    const finalParams: (string | null)[] = [...params, nowIso(), scope.tenantId, id]
    await this.db.run(
      `UPDATE documents SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
      finalParams,
    )
    // Chunks carry a denormalised classification; keep them in step.
    if (patch.classification) {
      await this.db.run(
        'UPDATE document_chunks SET classification = ? WHERE tenant_id = ? AND document_id = ?',
        [patch.classification, scope.tenantId, id],
      )
    }
    return this.findDocumentById(scope, id)
  }

  // --- Versions

  async nextVersionNumber(scope: TenantScope, documentId: string): Promise<number> {
    const row = await this.db.one<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM document_versions WHERE tenant_id = ? AND document_id = ?',
      [scope.tenantId, documentId],
    )
    return Number(row?.v ?? 0) + 1
  }

  async listVersions(scope: TenantScope, documentId: string): Promise<DocumentVersion[]> {
    const rows = await this.db.many<Row>(
      `SELECT * FROM document_versions
        WHERE tenant_id = ? AND document_id = ? ORDER BY version DESC`,
      [scope.tenantId, documentId],
    )
    return rows.map(mapDocumentVersion)
  }

  /** The version in force on `onDate`. Never returns a superseded policy. */
  async findEffectiveVersion(
    scope: TenantScope,
    documentId: string,
    onDate: DateOnly,
  ): Promise<DocumentVersion | null> {
    const row = await this.db.one<Row>(
      `SELECT * FROM document_versions
        WHERE tenant_id = ? AND document_id = ? AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [scope.tenantId, documentId, onDate, onDate],
    )
    return row ? mapDocumentVersion(row) : null
  }

  /**
   * Add a version, close off the previous one and replace its chunks — all in
   * one transaction so a search can never see a half-indexed document.
   */
  async addVersionWithChunks(
    scope: TenantScope,
    input: {
      documentId: string
      classification: Classification
      effectiveFrom: DateOnly
      effectiveTo?: DateOnly | null
      filePath?: string | null
      contentType?: string | null
      byteSize?: number | null
      checksum?: string | null
      createdBy?: string | null
      chunks: { section: string | null; page: number | null; content: string; tokenEstimate: number }[]
      /** Close the previous version the day before this one becomes effective. */
      supersedePrevious: boolean
    },
  ): Promise<DocumentVersion> {
    const version = await this.nextVersionNumber(scope, input.documentId)
    const versionId = prefixedId('dvr')
    const ts = nowIso()

    await this.db.transaction((uow) => {
      if (input.supersedePrevious) {
        // effective_to is inclusive, so the previous version ends the day before.
        uow.add(
          `UPDATE document_versions
              SET effective_to = date(?, '-1 day')
            WHERE tenant_id = ? AND document_id = ? AND effective_to IS NULL AND version < ?`,
          [input.effectiveFrom, scope.tenantId, input.documentId, version],
        )
        uow.add(
          `UPDATE document_chunks
              SET effective_to = date(?, '-1 day')
            WHERE tenant_id = ? AND document_id = ? AND effective_to IS NULL AND version < ?`,
          [input.effectiveFrom, scope.tenantId, input.documentId, version],
        )
      }

      uow.add(
        `INSERT INTO document_versions
           (id, tenant_id, document_id, version, effective_from, effective_to, file_path,
            content_type, byte_size, checksum, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          scope.tenantId,
          input.documentId,
          version,
          input.effectiveFrom,
          input.effectiveTo ?? null,
          input.filePath ?? null,
          input.contentType ?? null,
          input.byteSize ?? null,
          input.checksum ?? null,
          ts,
          input.createdBy ?? null,
        ],
      )

      input.chunks.forEach((chunk, index) => {
        uow.add(
          `INSERT INTO document_chunks
             (id, tenant_id, document_id, document_version_id, version, classification,
              effective_from, effective_to, section, page, ordinal, content, token_estimate, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            prefixedId('chk'),
            scope.tenantId,
            input.documentId,
            versionId,
            version,
            input.classification,
            input.effectiveFrom,
            input.effectiveTo ?? null,
            chunk.section,
            chunk.page,
            index,
            chunk.content,
            chunk.tokenEstimate,
            ts,
          ],
        )
      })

      uow.add("UPDATE documents SET status = 'ACTIVE', updated_at = ? WHERE tenant_id = ? AND id = ?", [
        ts,
        scope.tenantId,
        input.documentId,
      ])
    })

    const versions = await this.listVersions(scope, input.documentId)
    const created = versions.find((v) => v.id === versionId)
    if (!created) throw new Error('document version insert did not persist')
    return created
  }

  async deleteChunksForDocument(scope: TenantScope, documentId: string): Promise<void> {
    await this.db.run('DELETE FROM document_chunks WHERE tenant_id = ? AND document_id = ?', [
      scope.tenantId,
      documentId,
    ])
  }

  // --- Permission-filtered retrieval

  /**
   * Full-text search over chunks, filtered *inside the query* by tenant,
   * authorised classification set, document status and effective date.
   *
   * `allowedClassifications` must come from the backend. Passing an empty array
   * returns nothing — it never degrades to "no filter".
   */
  async searchChunks(
    scope: TenantScope,
    input: {
      query: string
      allowedClassifications: readonly Classification[]
      onDate: DateOnly
      limit: number
      category?: string
    },
  ): Promise<ChunkSearchHit[]> {
    if (input.allowedClassifications.length === 0) return []
    const match = toFtsQuery(input.query)
    if (!match) return []

    const params: (string | number)[] = [
      match,
      scope.tenantId,
      ...input.allowedClassifications,
      input.onDate,
      input.onDate,
    ]
    let categoryClause = ''
    if (input.category) {
      categoryClause = 'AND d.category = ?'
      params.push(input.category)
    }
    params.push(input.limit)

    return this.db.many<ChunkSearchHit>(
      `SELECT c.id           AS chunkId,
              c.document_id  AS documentId,
              d.name         AS documentName,
              d.category     AS documentCategory,
              c.classification AS classification,
              c.version      AS version,
              c.section      AS section,
              c.page         AS page,
              c.content      AS content,
              bm25(document_chunks_fts) AS rank
         FROM document_chunks_fts f
         JOIN document_chunks c ON c.id = f.chunk_id
         JOIN documents       d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        WHERE document_chunks_fts MATCH ?
          AND c.tenant_id = ?
          AND c.classification IN (${input.allowedClassifications.map(() => '?').join(', ')})
          AND d.status = 'ACTIVE'
          AND c.effective_from <= ?
          AND (c.effective_to IS NULL OR c.effective_to >= ?)
          ${categoryClause}
        ORDER BY rank
        LIMIT ?`,
      params,
    )
  }

  /**
   * LIKE-based fallback for engines without FTS5, and for single-word queries
   * where bm25 ranking is unhelpful. Same filtering guarantees.
   */
  async searchChunksFallback(
    scope: TenantScope,
    input: {
      terms: readonly string[]
      allowedClassifications: readonly Classification[]
      onDate: DateOnly
      limit: number
    },
  ): Promise<ChunkSearchHit[]> {
    if (input.allowedClassifications.length === 0 || input.terms.length === 0) return []
    const termClauses = input.terms.map(() => "c.content LIKE ? ESCAPE '\\'").join(' OR ')
    const params: (string | number)[] = [
      scope.tenantId,
      ...input.allowedClassifications,
      input.onDate,
      input.onDate,
      ...input.terms.map((t) => `%${t}%`),
      input.limit,
    ]
    return this.db.many<ChunkSearchHit>(
      `SELECT c.id AS chunkId, c.document_id AS documentId, d.name AS documentName,
              d.category AS documentCategory, c.classification AS classification,
              c.version AS version, c.section AS section, c.page AS page,
              c.content AS content, 0 AS rank
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        WHERE c.tenant_id = ?
          AND c.classification IN (${input.allowedClassifications.map(() => '?').join(', ')})
          AND d.status = 'ACTIVE'
          AND c.effective_from <= ?
          AND (c.effective_to IS NULL OR c.effective_to >= ?)
          AND (${termClauses})
        ORDER BY c.document_id, c.ordinal
        LIMIT ?`,
      params,
    )
  }

  async listChunksForVersion(scope: TenantScope, documentVersionId: string): Promise<DocumentChunk[]> {
    const rows = await this.db.many<Row>(
      `SELECT * FROM document_chunks
        WHERE tenant_id = ? AND document_version_id = ? ORDER BY ordinal`,
      [scope.tenantId, documentVersionId],
    )
    return rows.map(mapDocumentChunk)
  }

  async countDocuments(scope: TenantScope): Promise<number> {
    return this.db.count('SELECT COUNT(*) AS c FROM documents WHERE tenant_id = ?', [scope.tenantId])
  }
}
