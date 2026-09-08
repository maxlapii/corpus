/**
 * Knowledge / policy routes (CLAUDE.md §23, §24, §35).
 *
 *   GET  /policies                    — filtered by authorised classification
 *   POST /policies
 *   PUT  /policies/:id
 *   POST /policies/:id/versions       — text body
 *   POST /policies/upload             — multipart upload
 *   GET  /policies/:id/versions
 *   POST /policies/search             — permission-filtered retrieval
 */

import {
  badRequest,
  conflict,
  dateOnly,
  makePage,
  object,
  optional,
  parse,
  str,
  type AppError,
} from '@corpus/shared'
import { AppError as AppErrorClass } from '@corpus/shared'
import { isUniqueViolation } from '@corpus/db'
import type { Classification } from '@corpus/domain'
import { UnsupportedDocumentError } from '@corpus/knowledge'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { readJsonBody } from '../middleware/body.js'
import { orNotFound, pageOf, parseQuery, scopeOf, userIdentityOf } from './helpers.js'

const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const

const createBody = object({
  name: str({ min: 2, max: 200 }),
  category: str({ min: 2, max: 60 }),
  classification: str({ enum: CLASSIFICATIONS }),
  owner: optional(str({ max: 120 })),
})

const versionBody = object({
  text: str({ min: 20, max: 400_000 }),
  effectiveFrom: dateOnly(),
  effectiveTo: optional(dateOnly()),
  filename: optional(str({ max: 200 })),
})

const searchBody = object({
  question: str({ min: 3, max: 500 }),
  category: optional(str({ max: 60 })),
})

export const knowledgeRoutes = new Hono<AppBindings>()

knowledgeRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(
    c,
    object({
      category: optional(str({ max: 60 })),
      status: optional(str({ enum: ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'] })),
    }),
  )

  // The decision's classification set is what the listing is filtered by, so
  // a plain employee never sees that a RESTRICTED document exists.
  const decision = await container.gateway.require({
    identity,
    action: 'list',
    resource: { type: 'knowledge.document', tenantId: identity.tenantId, classification: 'INTERNAL' },
    requestId: c.get('requestId'),
    skipAudit: true,
  })

  const { items, total } = await container.repos.knowledge.listDocuments(
    scopeOf(c),
    decision.allowedClassifications,
    {
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.status ? { status: filters.status as 'ACTIVE' } : {}),
      limit: page.limit,
      offset: page.offset,
    },
  )
  return c.json(makePage(items, total, page))
})

knowledgeRoutes.get('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  const document = await container.repos.knowledge.findDocumentById(scope, id)
  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'knowledge.document',
      id,
      tenantId: document?.tenantId ?? identity.tenantId,
      // The stored classification is what is checked — not a request field.
      classification: document?.classification ?? 'RESTRICTED',
    },
    requestId: c.get('requestId'),
  })
  const loaded = await orNotFound(Promise.resolve(document), 'document')

  return c.json({
    document: loaded,
    versions: await container.repos.knowledge.listVersions(scope, id),
    effectiveVersion: await container.repos.knowledge.findEffectiveVersion(scope, id, container.today),
  })
})

knowledgeRoutes.post('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(createBody, await readJsonBody(c))

  await container.gateway.require({
    identity,
    action: 'create',
    resource: {
      type: 'knowledge.document',
      tenantId: identity.tenantId,
      classification: body.classification as Classification,
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
    metadata: { name: body.name, classification: body.classification },
  })

  try {
    const document = await container.repos.knowledge.createDocument(scopeOf(c), {
      name: body.name,
      category: body.category,
      classification: body.classification as Classification,
      owner: body.owner ?? null,
    })
    return c.json({ document }, 201)
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A document with that name already exists.')
    throw e
  }
})

knowledgeRoutes.put('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(
    object({
      name: optional(str({ min: 2, max: 200 })),
      category: optional(str({ min: 2, max: 60 })),
      classification: optional(str({ enum: CLASSIFICATIONS })),
      owner: optional(str({ max: 120 })),
      status: optional(str({ enum: ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'] })),
    }),
    await readJsonBody(c),
  )

  const existing = await container.repos.knowledge.findDocumentById(scope, id)
  // Authorise against BOTH the current and the proposed classification, so a
  // user cannot downgrade a RESTRICTED document they may not read.
  const ceiling = highestOf(existing?.classification, body.classification as Classification | undefined)
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'knowledge.document',
      id,
      tenantId: existing?.tenantId ?? identity.tenantId,
      classification: ceiling,
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
  })
  await orNotFound(Promise.resolve(existing), 'document')

  const document = await container.repos.knowledge.updateDocument(scope, id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.classification !== undefined
      ? { classification: body.classification as Classification }
      : {}),
    ...(body.owner !== undefined ? { owner: body.owner } : {}),
    ...(body.status !== undefined ? { status: body.status as 'ACTIVE' } : {}),
  })
  return c.json({ document })
})

/** Add a version from plain text (policy editor / seed data). */
knowledgeRoutes.post('/:id/versions', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(versionBody, await readJsonBody(c))

  const document = await container.repos.knowledge.findDocumentById(scope, id)
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'knowledge.document',
      id,
      tenantId: document?.tenantId ?? identity.tenantId,
      classification: document?.classification ?? 'RESTRICTED',
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
  })
  const loaded = await orNotFound(Promise.resolve(document), 'document')

  const result = await container.ingestion.ingestText({
    tenantId: identity.tenantId,
    documentId: loaded.id,
    classification: loaded.classification,
    effectiveFrom: body.effectiveFrom,
    effectiveTo: body.effectiveTo ?? null,
    filename: body.filename ?? `${loaded.name}.txt`,
    text: body.text,
    uploadedByUserId: identity.userId,
    supersedePrevious: true,
  })
  return c.json({ version: result }, 201)
})

/**
 * Multipart upload (CLAUDE.md §35 `POST /policies/upload`).
 *
 * Size is capped, the content type must be in the supported list, and the
 * extracted text is treated as untrusted data throughout.
 */
knowledgeRoutes.post('/upload', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)

  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.includes('multipart/form-data')) {
    throw badRequest('This endpoint expects a multipart/form-data upload.')
  }
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > container.config.limits.maxUploadBytes) {
    throw tooLarge(container.config.limits.maxUploadBytes)
  }

  const form = await c.req.formData()
  const documentId = String(form.get('documentId') ?? '')
  const effectiveFrom = String(form.get('effectiveFrom') ?? container.today)

  // FormData entries are typed differently across the Workers and DOM lib
  // definitions, so the file part is duck-typed rather than instanceof-checked.
  const file = asUploadedFile(form.get('file'))
  if (!file) throw badRequest('A "file" part is required.')
  if (file.size > container.config.limits.maxUploadBytes) {
    throw tooLarge(container.config.limits.maxUploadBytes)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw badRequest('"effectiveFrom" must be a date in YYYY-MM-DD format.')
  }

  const document = await container.repos.knowledge.findDocumentById(scope, documentId)
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'knowledge.document',
      id: documentId,
      tenantId: document?.tenantId ?? identity.tenantId,
      classification: document?.classification ?? 'RESTRICTED',
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
    metadata: { filename: file.name, bytes: file.size },
  })
  const loaded = await orNotFound(Promise.resolve(document), 'document')

  try {
    const result = await container.ingestion.ingest({
      tenantId: identity.tenantId,
      documentId: loaded.id,
      classification: loaded.classification,
      effectiveFrom,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      body: await file.arrayBuffer(),
      uploadedByUserId: identity.userId,
      supersedePrevious: true,
    })
    return c.json(
      {
        version: result,
        // The operator is told a flag was raised, without the payload.
        injectionFlagged: result.injectionFlagged,
        storageDurable: container.storageDurable,
      },
      201,
    )
  } catch (e) {
    if (e instanceof UnsupportedDocumentError) {
      throw new AppErrorClass('UNSUPPORTED_MEDIA_TYPE', e.message)
    }
    throw e
  }
})

knowledgeRoutes.get('/:id/versions', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  const document = await container.repos.knowledge.findDocumentById(scope, id)
  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'knowledge.document',
      id,
      tenantId: document?.tenantId ?? identity.tenantId,
      classification: document?.classification ?? 'RESTRICTED',
    },
    requestId: c.get('requestId'),
    // Audited: the version history of a CONFIDENTIAL or RESTRICTED policy is a
    // classified read.
  })
  await orNotFound(Promise.resolve(document), 'document')
  return c.json({ versions: await container.repos.knowledge.listVersions(scope, id) })
})

/**
 * Retrieval endpoint. Mirrors exactly what the AI path does, so the dashboard
 * shows an HR user the same permission-filtered results the bot would use.
 */
knowledgeRoutes.post('/search', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(searchBody, await readJsonBody(c))

  const decision = await container.gateway.require({
    identity,
    action: 'search',
    resource: { type: 'knowledge.chunk', tenantId: identity.tenantId, classification: 'INTERNAL' },
    intent: 'HR_POLICY_QUESTION',
    requestId: c.get('requestId'),
  })

  const result = await container.knowledgeSearch.search({
    tenantId: identity.tenantId,
    query: body.question,
    allowedClassifications: decision.allowedClassifications,
    onDate: container.today,
    limit: container.config.ai.maxContextChunks,
    ...(body.category ? { category: body.category } : {}),
  })

  return c.json({
    strategy: result.strategy,
    maxClassification: decision.maxClassification,
    passages: result.passages.map((p) => ({
      documentName: p.documentName,
      section: p.section,
      page: p.page,
      version: p.version,
      classification: p.classification,
      content: p.content,
      // Surfaced so HR can see that a stored document contains suspicious text.
      injectionFlagged: p.injection !== null,
    })),
  })
})

interface UploadedFile {
  name: string
  type: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

function asUploadedFile(entry: unknown): UploadedFile | null {
  if (typeof entry !== 'object' || entry === null) return null
  const candidate = entry as Partial<UploadedFile>
  if (typeof candidate.arrayBuffer !== 'function' || typeof candidate.size !== 'number') return null
  return {
    name: typeof candidate.name === 'string' ? candidate.name : 'upload',
    type: typeof candidate.type === 'string' ? candidate.type : 'application/octet-stream',
    size: candidate.size,
    arrayBuffer: candidate.arrayBuffer.bind(entry) as () => Promise<ArrayBuffer>,
  }
}

function tooLarge(max: number): AppError {
  return new AppErrorClass('PAYLOAD_TOO_LARGE', `Uploads must be at most ${max} bytes.`)
}

/** The more sensitive of two classifications, defaulting to RESTRICTED. */
function highestOf(
  a: Classification | undefined,
  b: Classification | undefined,
): Classification {
  const order: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']
  const rank = (c: Classification | undefined) => (c ? order.indexOf(c) : order.length - 1)
  return order[Math.max(rank(a), rank(b))] ?? 'RESTRICTED'
}
