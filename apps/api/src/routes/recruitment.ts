/**
 * Recruitment routes (CLAUDE.md §21, §35).
 *
 * The public surface (`/public/*`) runs with an ANONYMOUS identity and can only
 * see PUBLISHED jobs and PUBLIC projections. The internal surface requires a
 * session and the recruitment permissions.
 */

import {
  bool,
  conflict,
  dateOnly,
  email as emailValidator,
  makePage,
  num,
  object,
  optional,
  parse,
  str,
} from '@corpus/shared'
import {
  canAttachToApplication,
  canExtendOffer,
  canTransition,
  canTransitionJob,
  isTerminalStage,
  publicStageLabel,
  type ApplicationStage,
} from '@corpus/domain'
import { isUniqueViolation } from '@corpus/db'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { readJsonBody } from '../middleware/body.js'
import { identityOf, orNotFound, pageOf, parseQuery, scopeOf, userIdentityOf } from './helpers.js'

const jobSearchQuery = object({
  query: optional(str({ max: 100 })),
  location: optional(str({ max: 80 })),
  employmentType: optional(str({ enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] })),
  remoteOnly: optional(bool()),
  status: optional(str({ enum: ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] })),
})

const jobBody = object({
  jobCode: str({ min: 2, max: 40 }),
  title: str({ min: 3, max: 150 }),
  departmentId: optional(str({ max: 40 })),
  location: optional(str({ max: 120 })),
  employmentType: str({ enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] }),
  description: str({ min: 10, max: 20_000 }),
  salaryMin: optional(num({ min: 0 })),
  salaryMax: optional(num({ min: 0 })),
  currency: optional(str({ min: 3, max: 3 })),
  remoteAllowed: optional(bool()),
  experienceMin: optional(num({ int: true, min: 0, max: 60 })),
  salaryPublic: optional(bool()),
  closingDate: optional(dateOnly()),
  status: optional(str({ enum: ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] })),
})

const applyBody = object({
  jobCode: str({ min: 2, max: 40 }),
  fullName: str({ min: 2, max: 120 }),
  email: emailValidator(),
  phone: optional(str({ max: 40 })),
  coverNote: optional(str({ max: 2000 })),
})

const stageBody = object({
  stage: str({
    enum: ['SCREENING', 'SHORTLISTED', 'INTERVIEW', 'TECHNICAL', 'FINAL', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'],
  }),
  note: optional(str({ max: 1000 })),
})

/** Public projection. Salary appears only when HR published the range. */
function toPublicJob(
  job: {
    jobCode: string
    title: string
    location: string | null
    employmentType: string
    description: string
    remoteAllowed: boolean
    experienceMin: number | null
    closingDate: string | null
    publishedAt: string | null
    salaryMin: number | null
    salaryMax: number | null
    currency: string | null
  },
  salaryPublic: boolean,
) {
  return {
    jobCode: job.jobCode,
    title: job.title,
    location: job.location,
    employmentType: job.employmentType,
    description: job.description,
    remoteAllowed: job.remoteAllowed,
    experienceMin: job.experienceMin,
    closingDate: job.closingDate,
    publishedAt: job.publishedAt,
    salaryRange: salaryPublic
      ? { min: job.salaryMin, max: job.salaryMax, currency: job.currency }
      : null,
  }
}
// Public surface

export const publicRecruitmentRoutes = new Hono<AppBindings>()

publicRecruitmentRoutes.get('/jobs', async (c) => {
  const container = c.get('container')
  const identity = identityOf(c)
  const filters = parseQuery(c, jobSearchQuery)
  const page = pageOf(c)

  await container.gateway.require({
    identity,
    action: 'search',
    resource: { type: 'job', tenantId: identity.tenantId, classification: 'PUBLIC' },
    intent: 'PUBLIC_JOB_SEARCH',
    requestId: c.get('requestId'),
    skipAudit: true,
  })

  // The status filter is fixed here, not taken from the query string.
  const { items, total } = await container.repos.jobs.search(
    scopeOf(c),
    {
      statuses: ['PUBLISHED'],
      ...(filters.query ? { query: filters.query } : {}),
      ...(filters.location ? { location: filters.location } : {}),
      ...(filters.employmentType ? { employmentType: filters.employmentType as 'FULL_TIME' } : {}),
      ...(filters.remoteOnly ? { remoteOnly: true } : {}),
    },
    page.limit,
    page.offset,
  )

  const scope = scopeOf(c)
  const jobs = await Promise.all(
    items.map(async (job) => toPublicJob(job, await container.repos.jobs.isSalaryPublic(scope, job.id))),
  )
  return c.json(makePage(jobs, total, page))
})

publicRecruitmentRoutes.get('/jobs/:jobCode', async (c) => {
  const container = c.get('container')
  const identity = identityOf(c)
  const scope = scopeOf(c)
  const job = await container.repos.jobs.findByIdOrCode(scope, c.req.param('jobCode'))

  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'job',
      ...(job ? { id: job.id } : {}),
      tenantId: job?.tenantId ?? identity.tenantId,
      classification: job?.status === 'PUBLISHED' ? 'PUBLIC' : 'INTERNAL',
    },
    intent: 'PUBLIC_JOB_DETAILS',
    requestId: c.get('requestId'),
  })
  const loaded = await orNotFound(Promise.resolve(job), 'job')

  const requirements = await container.repos.jobRequirements.listForJob(scope, loaded.id)
  return c.json({
    job: toPublicJob(loaded, await container.repos.jobs.isSalaryPublic(scope, loaded.id)),
    requirements: requirements.map((r) => ({
      type: r.requirementType,
      description: r.description,
      mandatory: r.mandatory,
    })),
  })
})

publicRecruitmentRoutes.post('/applications', async (c) => {
  const container = c.get('container')
  const identity = identityOf(c)
  const scope = scopeOf(c)
  const body = parse(applyBody, await readJsonBody(c))

  await container.gateway.require({
    identity,
    action: 'create',
    resource: { type: 'application', tenantId: identity.tenantId },
    intent: 'PUBLIC_APPLY',
    requestId: c.get('requestId'),
  })

  const limit = await container.rateLimiter.consume(
    `apply:${identity.subjectKey}`,
    container.rateLimits.applicationPerSubject,
  )
  if (!limit.allowed) {
    return c.json(
      { error: { code: 'RATE_LIMITED', message: 'Too many applications. Please try again later.' } },
      429,
    )
  }

  const job = await container.repos.jobs.findByIdOrCode(scope, body.jobCode)
  if (!job || job.status !== 'PUBLISHED') {
    throw conflict('That job is not open for applications.')
  }
  if (job.closingDate && job.closingDate < container.today) {
    throw conflict('Applications for that job have closed.')
  }

  const candidate = await container.repos.candidates.createOrGet(scope, {
    name: body.fullName,
    email: body.email,
    phone: body.phone ?? null,
    source: 'WEB',
  })

  try {
    const application = await container.repos.applications.create(scope, {
      candidateId: candidate.id,
      jobId: job.id,
      coverNote: body.coverNote ?? null,
    })
    return c.json(
      {
        application: {
          reference: application.reference,
          jobTitle: job.title,
          status: publicStageLabel(application.stage),
        },
      },
      201,
    )
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw conflict('You have already applied for that job.')
    }
    throw e
  }
})

/**
 * Public status check by reference.
 *
 * The 120-bit reference is the *credential* for this route: possession of it is
 * what establishes that the caller is the applicant. That is stated explicitly
 * here rather than left implicit — the identity presented to the PolicyGateway
 * is bound to the candidate the reference resolves to, and the audit row
 * records `credential: 'application_reference'` so the basis of access is
 * visible. Guessing is bounded by the per-IP public rate limit.
 *
 * The response is the coarse public label only — never the internal stage.
 */
publicRecruitmentRoutes.get('/applications/:reference', async (c) => {
  const container = c.get('container')
  const identity = identityOf(c)
  const scope = scopeOf(c)
  const reference = c.req.param('reference').toUpperCase()
  const application = await container.repos.applications.findByReference(scope, reference)

  // Bind the caller to the candidate the reference resolves to. When the
  // reference does not resolve, no binding happens and the SELF grant fails.
  const bearerIdentity =
    application && identity.kind === 'ANONYMOUS'
      ? await container.identityResolver.anonymous({
          tenantId: identity.tenantId,
          channel: identity.channel,
          rawSubject: identity.subjectKey,
          candidateId: application.candidateId,
        })
      : identity

  await container.gateway.require({
    identity: bearerIdentity,
    action: 'read',
    resource: {
      type: 'application',
      ...(application ? { id: application.id } : {}),
      tenantId: application?.tenantId ?? identity.tenantId,
      ownerCandidateId: application?.candidateId ?? null,
      classification: 'PUBLIC',
    },
    intent: 'PUBLIC_APPLICATION_STATUS',
    requestId: c.get('requestId'),
    metadata: { credential: 'application_reference' },
  })
  const loaded = await orNotFound(Promise.resolve(application), 'application')

  return c.json({
    application: {
      reference: loaded.reference,
      jobTitle: loaded.jobTitle,
      status: publicStageLabel(loaded.stage),
      submittedOn: loaded.appliedAt.slice(0, 10),
    },
  })
})
// Internal surface

export const jobRoutes = new Hono<AppBindings>()

jobRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const filters = parseQuery(c, jobSearchQuery)
  const page = pageOf(c)

  await container.gateway.require({
    identity,
    action: 'search',
    resource: { type: 'job', tenantId: identity.tenantId, classification: 'INTERNAL' },
    requestId: c.get('requestId'),
    skipAudit: true,
  })

  const { items, total } = await container.repos.jobs.search(
    scopeOf(c),
    {
      statuses: filters.status
        ? [filters.status as 'DRAFT']
        : ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'],
      ...(filters.query ? { query: filters.query } : {}),
      ...(filters.location ? { location: filters.location } : {}),
    },
    page.limit,
    page.offset,
  )
  return c.json(makePage(items, total, page))
})

jobRoutes.get('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const job = await container.repos.jobs.findByIdOrCode(scope, c.req.param('id'))

  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'job',
      ...(job ? { id: job.id } : {}),
      tenantId: job?.tenantId ?? identity.tenantId,
      classification: 'INTERNAL',
    },
    requestId: c.get('requestId'),
  })
  const loaded = await orNotFound(Promise.resolve(job), 'job')
  return c.json({
    job: loaded,
    // Whether the salary range is shown on the public listing; the entity
    // omits it, and the dashboard needs it to render the current setting.
    salaryPublic: await container.repos.jobs.isSalaryPublic(scope, loaded.id),
    requirements: await container.repos.jobRequirements.listForJob(scope, loaded.id),
  })
})

jobRoutes.post('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(jobBody, await readJsonBody(c))

  await container.gateway.require({
    identity,
    action: 'create',
    resource: { type: 'job', tenantId: identity.tenantId, classification: 'INTERNAL' },
    intent: 'JOB_MANAGE',
    requestId: c.get('requestId'),
    metadata: { jobCode: body.jobCode },
  })

  try {
    const job = await container.repos.jobs.create(scopeOf(c), {
      jobCode: body.jobCode,
      title: body.title,
      departmentId: body.departmentId ?? null,
      location: body.location ?? null,
      employmentType: body.employmentType as 'FULL_TIME',
      description: body.description,
      salaryMin: body.salaryMin ?? null,
      salaryMax: body.salaryMax ?? null,
      currency: body.currency ?? null,
      remoteAllowed: body.remoteAllowed ?? false,
      experienceMin: body.experienceMin ?? null,
      salaryPublic: body.salaryPublic ?? false,
      closingDate: body.closingDate ?? null,
      status: (body.status as 'DRAFT') ?? 'DRAFT',
    })
    return c.json({ job }, 201)
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A job with that code already exists.')
    throw e
  }
})

jobRoutes.put('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(
    object({
      title: optional(str({ min: 3, max: 150 })),
      location: optional(str({ max: 120 })),
      description: optional(str({ min: 10, max: 20_000 })),
      salaryMin: optional(num({ min: 0 })),
      salaryMax: optional(num({ min: 0 })),
      currency: optional(str({ min: 3, max: 3 })),
      remoteAllowed: optional(bool()),
      experienceMin: optional(num({ int: true, min: 0, max: 60 })),
      salaryPublic: optional(bool()),
      closingDate: optional(dateOnly()),
      status: optional(str({ enum: ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] })),
    }),
    await readJsonBody(c),
  )

  const existing = await container.repos.jobs.findById(scope, id)
  const statusChange =
    body.status !== undefined && existing
      ? canTransitionJob(existing.status, body.status as 'DRAFT')
      : { ok: true }

  await container.gateway.require({
    identity,
    action: 'update',
    resource: { type: 'job', id, tenantId: identity.tenantId, classification: 'INTERNAL' },
    intent: 'JOB_MANAGE',
    requestId: c.get('requestId'),
    businessRules: [
      {
        code: 'JOB_STATUS_TRANSITION',
        message: statusChange.reason ?? 'That status change is not allowed.',
        satisfied: statusChange.ok,
      },
    ],
  })
  await orNotFound(Promise.resolve(existing), 'job')

  const job = await container.repos.jobs.update(scope, id, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.location !== undefined ? { location: body.location } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.salaryMin !== undefined ? { salaryMin: body.salaryMin } : {}),
    ...(body.salaryMax !== undefined ? { salaryMax: body.salaryMax } : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    ...(body.remoteAllowed !== undefined ? { remoteAllowed: body.remoteAllowed } : {}),
    ...(body.experienceMin !== undefined ? { experienceMin: body.experienceMin } : {}),
    ...(body.salaryPublic !== undefined ? { salaryPublic: body.salaryPublic } : {}),
    ...(body.closingDate !== undefined ? { closingDate: body.closingDate } : {}),
    ...(body.status !== undefined ? { status: body.status as 'DRAFT' } : {}),
  })
  return c.json({ job })
})

jobRoutes.delete('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  await container.gateway.require({
    identity,
    action: 'delete',
    resource: { type: 'job', id, tenantId: identity.tenantId, classification: 'INTERNAL' },
    intent: 'JOB_MANAGE',
    requestId: c.get('requestId'),
  })
  await orNotFound(container.repos.jobs.findById(scope, id), 'job')

  // Archive rather than hard delete: applications reference the job, and the
  // audit trail must remain resolvable.
  const job = await container.repos.jobs.update(scope, id, { status: 'ARCHIVED' })
  return c.json({ job })
})

jobRoutes.post('/:id/requirements', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(
    object({
      requirementType: str({
        enum: ['SKILL', 'EDUCATION', 'EXPERIENCE', 'CERTIFICATION', 'LANGUAGE', 'OTHER'],
      }),
      description: str({ min: 2, max: 500 }),
      mandatory: optional(bool()),
      priority: optional(num({ int: true, min: 1, max: 999 })),
    }),
    await readJsonBody(c),
  )

  await container.gateway.require({
    identity,
    action: 'create',
    resource: { type: 'job.requirement', tenantId: identity.tenantId, classification: 'INTERNAL' },
    requestId: c.get('requestId'),
  })
  await orNotFound(container.repos.jobs.findById(scope, id), 'job')

  const requirement = await container.repos.jobRequirements.create(scope, {
    jobId: id,
    requirementType: body.requirementType as 'SKILL',
    description: body.description,
    mandatory: body.mandatory ?? true,
    priority: body.priority ?? 100,
  })
  return c.json({ requirement }, 201)
})

export const candidateRoutes = new Hono<AppBindings>()

candidateRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(c, object({ query: optional(str({ max: 100 })) }))

  await container.gateway.require({
    identity,
    action: 'search',
    resource: { type: 'candidate', tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    intent: 'CANDIDATE_SEARCH',
    requestId: c.get('requestId'),
  })

  const { items, total } = await container.repos.candidates.search(
    scopeOf(c),
    filters.query ? { query: filters.query } : {},
    page.limit,
    page.offset,
  )
  return c.json(makePage(items, total, page))
})

candidateRoutes.get('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  await container.gateway.require({
    identity,
    action: 'read',
    resource: { type: 'candidate', id, tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    intent: 'CANDIDATE_DETAILS',
    requestId: c.get('requestId'),
  })
  const candidate = await orNotFound(container.repos.candidates.findById(scope, id), 'candidate')
  return c.json({
    candidate,
    applications: await container.repos.applications.listForCandidate(scope, id),
  })
})

export const applicationRoutes = new Hono<AppBindings>()

applicationRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(
    c,
    object({
      jobId: optional(str({ max: 40 })),
      stage: optional(
        str({
          enum: ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'TECHNICAL', 'FINAL', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'],
        }),
      ),
      status: optional(str({ enum: ['OPEN', 'CLOSED'] })),
    }),
  )

  await container.gateway.require({
    identity,
    action: 'list',
    resource: { type: 'application', tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    // Audited: a bulk listing exposes candidate PII across the pipeline.
    requestId: c.get('requestId'),
  })

  const { items, total } = await container.repos.applications.search(
    scopeOf(c),
    {
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.stage ? { stage: filters.stage as ApplicationStage } : {}),
      ...(filters.status ? { status: filters.status as 'OPEN' } : {}),
    },
    page.limit,
    page.offset,
  )
  return c.json(makePage(items, total, page))
})

applicationRoutes.get('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  await container.gateway.require({
    identity,
    action: 'read',
    resource: { type: 'application', id, tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    intent: 'CANDIDATE_DETAILS',
    requestId: c.get('requestId'),
  })
  const application = await orNotFound(
    container.repos.applications.findDetailById(scope, id),
    'application',
  )
  return c.json({
    application,
    events: await container.repos.applications.listEvents(scope, id),
    interviews: await container.repos.interviews.listForApplication(scope, id),
  })
})

applicationRoutes.post('/:id/stage', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(stageBody, await readJsonBody(c))
  const toStage = body.stage as ApplicationStage

  const application = await container.repos.applications.findById(scope, id)
  const transition = application
    ? canTransition(application.stage, toStage)
    : { ok: false, reason: 'The requested application was not found.' }

  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'application',
      id,
      tenantId: application?.tenantId ?? identity.tenantId,
      classification: 'CONFIDENTIAL',
    },
    intent: 'APPLICATION_STAGE_UPDATE',
    requestId: c.get('requestId'),
    businessRules: [
      {
        code: 'VALID_TRANSITION',
        message: transition.reason ?? 'That stage change is not allowed.',
        satisfied: transition.ok,
      },
    ],
  })
  const loaded = await orNotFound(Promise.resolve(application), 'application')

  await container.repos.applications.transition(scope, {
    applicationId: loaded.id,
    fromStage: loaded.stage,
    toStage,
    note: body.note ?? null,
    actorUserId: identity.userId,
    closeApplication: isTerminalStage(toStage),
  })
  return c.json({ ok: true, from: loaded.stage, to: toStage })
})

applicationRoutes.post('/:id/interviews', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(
    object({
      scheduledAt: str({ min: 10, max: 40 }),
      durationMinutes: optional(num({ int: true, min: 15, max: 480 })),
      mode: optional(str({ enum: ['ONSITE', 'REMOTE', 'PHONE'] })),
      interviewerEmployeeId: optional(str({ max: 40 })),
    }),
    await readJsonBody(c),
  )

  const application = await container.repos.applications.findById(scope, id)
  const attachable = application
    ? canAttachToApplication(application)
    : { ok: false, reason: 'The requested application was not found.' }

  await container.gateway.require({
    identity,
    action: 'create',
    resource: { type: 'interview', tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    requestId: c.get('requestId'),
    businessRules: [
      {
        code: 'APPLICATION_OPEN',
        message: attachable.reason ?? 'That application can no longer be changed.',
        satisfied: attachable.ok,
      },
    ],
  })
  await orNotFound(Promise.resolve(application), 'application')

  const interview = await container.repos.interviews.create(scope, {
    applicationId: id,
    scheduledAt: new Date(body.scheduledAt).toISOString(),
    durationMinutes: body.durationMinutes ?? 60,
    mode: (body.mode as 'REMOTE') ?? 'REMOTE',
    interviewerEmployeeId: body.interviewerEmployeeId ?? null,
  })
  return c.json({ interview }, 201)
})

applicationRoutes.post('/:id/offers', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(
    object({
      baseSalary: num({ min: 0, max: 100_000_000 }),
      currency: str({ min: 3, max: 3 }),
      startDate: dateOnly(),
      expiresAt: optional(dateOnly()),
    }),
    await readJsonBody(c),
  )

  const application = await container.repos.applications.findById(scope, id)
  const extendable = application
    ? canExtendOffer(application)
    : { ok: false, reason: 'The requested application was not found.' }

  // Offers carry compensation, so they are RESTRICTED and chat-blocked.
  await container.gateway.require({
    identity,
    action: 'create',
    resource: { type: 'offer', tenantId: identity.tenantId, classification: 'RESTRICTED' },
    requestId: c.get('requestId'),
    businessRules: [
      {
        code: 'OFFER_STAGE',
        message: extendable.reason ?? 'An offer cannot be made for that application.',
        satisfied: extendable.ok,
      },
    ],
  })
  await orNotFound(Promise.resolve(application), 'application')

  const offer = await container.repos.offers.create(scope, {
    applicationId: id,
    baseSalary: body.baseSalary,
    currency: body.currency.toUpperCase(),
    startDate: body.startDate,
    expiresAt: body.expiresAt ?? null,
  })
  return c.json({ offer }, 201)
})
