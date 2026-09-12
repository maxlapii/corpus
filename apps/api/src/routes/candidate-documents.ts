/**
 * Candidate CVs (CLAUDE.md §9, §21, §38).
 *
 *   GET    /cvs                      — filtered listing, with facet counts
 *   GET    /cvs/:id                  — metadata plus the extracted text
 *   GET    /cvs/:id/download         — the original file
 *   PUT    /cvs/:id/text             — paste text a parser could not read
 *   DELETE /cvs/:id
 *   GET    /cvs/:id/match/:jobId     — deterministic match report
 *
 * A CV is CONFIDENTIAL, so every route resolves the document first and lets the
 * gateway judge the stored classification rather than anything in the request.
 *
 * There is deliberately no upload route: CVs arrive on the Telegram bots — the
 * candidate's own on the recruitment bot, a forwarded one on the employee bot —
 * so this surface reads, filters and matches, and never ingests.
 */

import {
  makePage,
  notFound,
  object,
  optional,
  parse,
  str,
} from '@corpus/shared'
import { analyseCv, type MatchableRequirement } from '@corpus/domain'
import { MAX_CV_BYTES } from '@corpus/knowledge'
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../context.js'
import { readJsonBody } from '../middleware/body.js'
import { pageOf, parseQuery, scopeOf, userIdentityOf } from './helpers.js'

const textBody = object({ text: str({ min: 20, max: 200_000 }) })

export const candidateDocumentRoutes = new Hono<AppBindings>()

/** Every read of a CV is judged against its stored CONFIDENTIAL classification. */
const CV_RESOURCE = 'candidate.document' as const

candidateDocumentRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(
    c,
    object({
      q: optional(str({ max: 120 })),
      kind: optional(str({ enum: ['CV', 'COVER_LETTER', 'OTHER'] })),
      source: optional(str({ enum: ['TELEGRAM_EXTERNAL', 'TELEGRAM_INTERNAL', 'DASHBOARD'] })),
      extraction: optional(str({ enum: ['OK', 'EMPTY', 'UNSUPPORTED', 'FAILED'] })),
      flagged: optional(str({ enum: ['true', 'false'] })),
    }),
  )

  await container.gateway.require({
    identity,
    action: 'list',
    resource: { type: CV_RESOURCE, tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    requestId: c.get('requestId'),
    skipAudit: true,
  })

  const { items, total } = await container.repos.candidateDocuments.list(scopeOf(c), {
    ...(filters.q ? { query: filters.q } : {}),
    ...(filters.kind ? { kind: filters.kind as 'CV' } : {}),
    ...(filters.source ? { source: filters.source as 'TELEGRAM_EXTERNAL' } : {}),
    ...(filters.extraction ? { extractionStatus: filters.extraction as 'OK' } : {}),
    ...(filters.flagged ? { injectionFlagged: filters.flagged === 'true' } : {}),
    limit: page.limit,
    offset: page.offset,
  })

  // Unfiltered counts, so the filter chips describe what is there rather than
  // what survived the filter.
  const facets = await container.repos.candidateDocuments.facets(scopeOf(c))
  return c.json({ ...makePage(items, total, page), facets })
})

candidateDocumentRoutes.get('/:id', async (c) => {
  const container = c.get('container')
  const { document } = await requireDocument(c)

  const candidate = await container.repos.candidates.findById(scopeOf(c), document.candidateId)
  return c.json({
    document,
    candidate: candidate
      ? { id: candidate.id, name: candidate.name, email: candidate.email, phone: candidate.phone }
      : null,
    limits: { maxBytes: MAX_CV_BYTES },
  })
})

candidateDocumentRoutes.get('/:id/download', async (c) => {
  const container = c.get('container')
  const { document } = await requireDocument(c)

  const object_ = await container.storage.get(document.storageKey)
  if (!object_) throw notFound('file')

  // `attachment` and a quoted, sanitised filename: the name came from a
  // candidate, so it must not be able to steer the browser.
  const safeName = document.filename.replace(/["\\\r\n]/g, '_')
  return new Response(object_.body, {
    headers: {
      'content-type': object_.contentType ?? document.contentType,
      'content-disposition': `attachment; filename="${safeName}"`,
      'content-length': String(document.byteSize),
      // A CV must never be cached by a shared proxy.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
})

candidateDocumentRoutes.put('/:id/text', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const { document } = await requireDocument(c, 'update')
  const body = parse(textBody, await readJsonBody(c))

  const updated = await container.repos.candidateDocuments.setExtractedText(
    scopeOf(c),
    document.id,
    body.text,
    identity.userId,
  )
  if (!updated) throw notFound('document')
  return c.json({ document: await container.repos.candidateDocuments.findById(scopeOf(c), document.id) })
})

candidateDocumentRoutes.delete('/:id', async (c) => {
  const container = c.get('container')
  const { document } = await requireDocument(c, 'delete')

  await container.repos.candidateDocuments.delete(scopeOf(c), document.id)
  // Best effort: a stranded object is preferable to a failed delete that
  // leaves the row pointing at a file nobody can reach.
  try {
    await container.storage.delete(document.storageKey)
  } catch {
    container.logger.warn('CV row deleted but its stored file remains', {
      action: 'cv.delete',
      result: 'orphan_object',
    })
  }
  return c.json({ deleted: true })
})

/**
 * The match report. Computed on demand and never stored: job requirements
 * change, and a cached score would quietly go stale against them.
 */
candidateDocumentRoutes.get('/:id/match/:jobId', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const { document } = await requireDocument(c)

  const jobId = c.req.param('jobId')
  const job = await container.repos.jobs.findById(scope, jobId)
  await container.gateway.require({
    identity,
    action: 'read',
    resource: { type: 'job', id: jobId, tenantId: job?.tenantId ?? identity.tenantId },
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  if (!job) throw notFound('job')

  const requirements = await container.repos.jobRequirements.listForJob(scope, jobId)
  const report = analyseCv({
    cvText: document.extractedText ?? '',
    requirements: requirements.map(
      (r): MatchableRequirement => ({
        id: r.id,
        requirementType: r.requirementType,
        description: r.description,
        mandatory: r.mandatory,
        priority: r.priority,
      }),
    ),
    experienceMin: job.experienceMin ?? null,
  })

  return c.json({
    job: { id: job.id, jobCode: job.jobCode, title: job.title, experienceMin: job.experienceMin },
    document: { id: document.id, filename: document.filename, extractionStatus: document.extractionStatus },
    report,
    // Stated in the payload, not just the UI: any consumer of this endpoint
    // should know the report does not decide anything.
    advisory:
      'Advisory only. This is a keyword match over the CV text, not an assessment of the ' +
      'candidate. Every match shows the sentence it came from so a person can check it.',
  })
})

/** Load the document and let the gateway judge its stored classification. */
async function requireDocument(
  c: Context<AppBindings>,
  action: 'read' | 'update' | 'delete' = 'read',
) {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const id = c.req.param('id') ?? ''

  const document = await container.repos.candidateDocuments.findById(scopeOf(c), id)
  await container.gateway.require({
    identity,
    action,
    resource: {
      type: CV_RESOURCE,
      id,
      tenantId: document?.tenantId ?? identity.tenantId,
      classification: 'CONFIDENTIAL',
    },
    ...(action === 'read' ? { skipAudit: true } : { intent: 'APPLICATION_STAGE_UPDATE' as const }),
    requestId: c.get('requestId'),
  })
  if (!document) throw notFound('document')
  return { document }
}
