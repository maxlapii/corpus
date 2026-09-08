/**
 * Curated bot answers — the dashboard's bot-training surface (CLAUDE.md §33).
 *
 *   GET    /knowledge/answers               — authoring list
 *   POST   /knowledge/answers
 *   GET    /knowledge/answers/:id
 *   PUT    /knowledge/answers/:id
 *   POST   /knowledge/answers/:id/status    — publish / archive
 *   DELETE /knowledge/answers/:id
 *   POST   /knowledge/answers/preview       — what a bot would return, unsaved
 *   GET    /knowledge/answers/unanswered    — the training backlog
 *   POST   /knowledge/answers/unanswered/:id/resolve
 *
 * Every route resolves the *stored* audience and classification before the
 * gateway call, so a request body can never talk its way into a wider audience
 * than the row it is editing.
 */

import {
  arrayOf,
  badRequest,
  conflict,
  dateOnly,
  makePage,
  notFound,
  object,
  optional,
  parse,
  str,
  withDefault,
} from '@corpus/shared'
import { isUniqueViolation } from '@corpus/db'
import {
  ANSWER_AUDIENCES,
  ANSWER_STATUSES,
  MAX_TRAINING_PHRASES,
  canTransitionAnswer,
  validateAnswerDraft,
  type AnswerAudience,
  type AnswerStatus,
  type Classification,
} from '@corpus/domain'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { readJsonBody } from '../middleware/body.js'
import { pageOf, parseQuery, scopeOf, userIdentityOf } from './helpers.js'

const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const

const writeBody = object({
  question: str({ min: 3, max: 300 }),
  answer: str({ min: 3, max: 4000 }),
  category: withDefault(str({ min: 2, max: 60 }), 'GENERAL'),
  audience: str({ enum: ANSWER_AUDIENCES }),
  classification: str({ enum: CLASSIFICATIONS }),
  status: optional(str({ enum: ANSWER_STATUSES })),
  phrases: optional(arrayOf(str({ min: 3, max: 300 }), { max: MAX_TRAINING_PHRASES })),
  effectiveFrom: optional(dateOnly()),
  effectiveTo: optional(dateOnly()),
  sourceUnansweredId: optional(str({ max: 64 })),
})

const statusBody = object({ status: str({ enum: ANSWER_STATUSES }) })

const previewBody = object({
  question: str({ min: 3, max: 500 }),
  audience: str({ enum: ['EXTERNAL', 'INTERNAL'] }),
})

const resolveBody = object({ answerId: optional(str({ max: 64 })) })

export const knowledgeAnswerRoutes = new Hono<AppBindings>()

/**
 * The backlog of questions a bot could not answer. Listed before `/:id` so the
 * literal path is not captured by the parameter route.
 */
knowledgeAnswerRoutes.get('/unanswered', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(c, object({ resolved: optional(str({ enum: ['true', 'false'] })) }))

  await container.gateway.require({
    identity,
    action: 'list',
    resource: { type: 'knowledge.answer', tenantId: identity.tenantId },
    requestId: c.get('requestId'),
    skipAudit: true,
  })

  const { items, total } = await container.repos.conversations.listUnanswered(scopeOf(c), {
    ...(filters.resolved ? { resolved: filters.resolved === 'true' } : {}),
    limit: page.limit,
    offset: page.offset,
  })
  return c.json(makePage(items, total, page))
})

knowledgeAnswerRoutes.post('/unanswered/:id/resolve', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const body = parse(resolveBody, await readJsonBody(c))

  await container.gateway.require({
    identity,
    action: 'update',
    resource: { type: 'knowledge.answer', tenantId: identity.tenantId },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
  })

  if (body.answerId) {
    const linked = await container.repos.knowledgeAnswers.findById(scope, body.answerId)
    if (!linked) throw badRequest('That answer does not exist.')
  }

  const resolved = await container.repos.conversations.resolveUnanswered(scope, c.req.param('id'), {
    answerId: body.answerId ?? null,
    actorUserId: identity.userId,
  })
  if (!resolved) throw notFound('unanswered question')
  return c.json({ resolved: true })
})

/**
 * Dry run: what the named bot would reply to this question right now. Runs the
 * real retrieval path with the *caller's* ceiling, so an author cannot preview
 * an answer they could not otherwise read.
 */
knowledgeAnswerRoutes.post('/preview', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(previewBody, await readJsonBody(c))

  const decision = await container.gateway.require({
    identity,
    action: 'search',
    resource: { type: 'knowledge.answer', tenantId: identity.tenantId },
    requestId: c.get('requestId'),
    skipAudit: true,
  })

  // An EXTERNAL preview is capped at PUBLIC regardless of who is previewing,
  // so the dashboard shows what a candidate sees, not what HR sees.
  const allowedClassifications =
    body.audience === 'EXTERNAL'
      ? (['PUBLIC'] as const)
      : decision.allowedClassifications

  const result = await container.answerSearch.search({
    tenantId: identity.tenantId,
    query: body.question,
    zone: body.audience as 'EXTERNAL' | 'INTERNAL',
    allowedClassifications,
    onDate: container.today,
    limit: 3,
  })

  return c.json({
    audience: body.audience,
    strategy: result.strategy,
    matches: result.answers.map((a) => ({
      answerId: a.answerId,
      question: a.question,
      answer: a.answer,
      classification: a.classification,
      coverage: Number(a.coverage.toFixed(2)),
      termMatches: a.termMatches,
      wouldServe: a.coverage >= 0.67 && a.termMatches >= 2,
    })),
  })
})

knowledgeAnswerRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(
    c,
    object({
      audience: optional(str({ enum: ANSWER_AUDIENCES })),
      status: optional(str({ enum: ANSWER_STATUSES })),
      category: optional(str({ max: 60 })),
      q: optional(str({ max: 200 })),
    }),
  )

  await container.gateway.require({
    identity,
    action: 'list',
    resource: { type: 'knowledge.answer', tenantId: identity.tenantId },
    requestId: c.get('requestId'),
    skipAudit: true,
  })

  const { items, total } = await container.repos.knowledgeAnswers.list(scopeOf(c), {
    ...(filters.audience ? { audience: filters.audience as AnswerAudience } : {}),
    ...(filters.status ? { status: filters.status as AnswerStatus } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.q ? { query: filters.q } : {}),
    limit: page.limit,
    offset: page.offset,
  })
  return c.json(makePage(items, total, page))
})

knowledgeAnswerRoutes.get('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const answer = await container.repos.knowledgeAnswers.findById(scopeOf(c), c.req.param('id'))

  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'knowledge.answer',
      id: c.req.param('id'),
      tenantId: answer?.tenantId ?? identity.tenantId,
      classification: answer?.classification ?? 'RESTRICTED',
    },
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  if (!answer) throw notFound('answer')
  return c.json({ answer })
})

knowledgeAnswerRoutes.post('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(writeBody, await readJsonBody(c))
  const draft = toDraft(body, container.today)

  const issues = validateAnswerDraft(draft)
  if (issues.length > 0) throw badRequest(issues[0]!.message, { details: { issues } })

  await container.gateway.require({
    identity,
    action: 'create',
    resource: {
      type: 'knowledge.answer',
      tenantId: identity.tenantId,
      classification: draft.classification,
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
    metadata: { audience: draft.audience, classification: draft.classification },
  })

  try {
    const answer = await container.repos.knowledgeAnswers.create(scopeOf(c), {
      ...draft,
      category: body.category,
      status: (body.status as AnswerStatus | undefined) ?? 'DRAFT',
      effectiveTo: draft.effectiveTo ?? null,
      phrases: draft.phrases ?? [],
      sourceUnansweredId: body.sourceUnansweredId ?? null,
      actorUserId: identity.userId,
    })
    return c.json({ answer }, 201)
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('An answer for that question already exists.')
    throw e
  }
})

knowledgeAnswerRoutes.put('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(writeBody, await readJsonBody(c))
  const draft = toDraft(body, container.today)

  const issues = validateAnswerDraft(draft)
  if (issues.length > 0) throw badRequest(issues[0]!.message, { details: { issues } })

  const existing = await container.repos.knowledgeAnswers.findById(scope, id)

  // Checked against the higher of the two classifications so that neither
  // widening nor narrowing an answer can be done from below its own ceiling.
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'knowledge.answer',
      id,
      tenantId: existing?.tenantId ?? identity.tenantId,
      classification: higherOf(existing?.classification ?? 'RESTRICTED', draft.classification),
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
    metadata: { audience: draft.audience, classification: draft.classification },
  })
  if (!existing) throw notFound('answer')

  const status = (body.status as AnswerStatus | undefined) ?? existing.status
  if (status !== existing.status && !canTransitionAnswer(existing.status, status)) {
    throw conflict(`An ${existing.status} answer cannot become ${status}.`)
  }

  try {
    const answer = await container.repos.knowledgeAnswers.update(scope, id, {
      ...draft,
      category: body.category,
      status,
      effectiveTo: draft.effectiveTo ?? null,
      phrases: draft.phrases ?? [],
      actorUserId: identity.userId,
    })
    if (!answer) throw notFound('answer')
    return c.json({ answer })
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('An answer for that question already exists.')
    throw e
  }
})

knowledgeAnswerRoutes.post('/:id/status', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(statusBody, await readJsonBody(c))

  const existing = await container.repos.knowledgeAnswers.findById(scope, id)
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'knowledge.answer',
      id,
      tenantId: existing?.tenantId ?? identity.tenantId,
      classification: existing?.classification ?? 'RESTRICTED',
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
    metadata: { status: body.status },
  })
  if (!existing) throw notFound('answer')

  const next = body.status as AnswerStatus
  if (!canTransitionAnswer(existing.status, next)) {
    throw conflict(`An ${existing.status} answer cannot become ${next}.`)
  }

  await container.repos.knowledgeAnswers.setStatus(scope, id, next, identity.userId)
  return c.json({ answer: await container.repos.knowledgeAnswers.findById(scope, id) })
})

knowledgeAnswerRoutes.delete('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  const existing = await container.repos.knowledgeAnswers.findById(scope, id)
  await container.gateway.require({
    identity,
    action: 'delete',
    resource: {
      type: 'knowledge.answer',
      id,
      tenantId: existing?.tenantId ?? identity.tenantId,
      classification: existing?.classification ?? 'RESTRICTED',
    },
    intent: 'POLICY_MANAGE',
    requestId: c.get('requestId'),
  })
  if (!existing) throw notFound('answer')

  await container.repos.knowledgeAnswers.delete(scope, id)
  return c.json({ deleted: true })
})

interface WriteBody {
  question: string
  answer: string
  audience: string
  classification: string
  phrases?: string[]
  effectiveFrom?: string
  effectiveTo?: string
}

function toDraft(body: WriteBody, today: string) {
  return {
    question: body.question,
    answer: body.answer,
    audience: body.audience as AnswerAudience,
    classification: body.classification as Classification,
    phrases: body.phrases ?? [],
    effectiveFrom: body.effectiveFrom ?? today,
    effectiveTo: body.effectiveTo ?? null,
  }
}

const RANK: Record<Classification, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
}

function higherOf(a: Classification, b: Classification): Classification {
  return RANK[a] >= RANK[b] ? a : b
}
