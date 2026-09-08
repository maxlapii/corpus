/**
 * EXTERNAL-zone tools (CLAUDE.md §16).
 *
 * These are the ONLY tools the public recruitment bot can reach — the registry
 * filters by `scope`, so internal HR tools are never even described to it.
 *
 * Note what is absent: no employee lookup, no policy search, no salary, no
 * other candidate's data.
 */

import { bool, email as emailValidator, object, optional, str } from '@corpus/shared'
import { publicStageLabel } from '@corpus/domain'
import { tenantScope } from '@corpus/db'
import type { ToolDefinition } from '../tool-types.js'

const MAX_PUBLIC_RESULTS = 8

export const searchJobsTool: ToolDefinition<{ query?: string; location?: string; remoteOnly?: boolean }> = {
  name: 'search_jobs',
  description: 'Search currently published job openings by keyword, location or remote flag.',
  scope: 'EXTERNAL',
  permission: 'job.read.public',
  risk: 'LOW',
  resource: 'job',
  action: 'search',
  auditRequired: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, e.g. "backend engineer"' },
      location: { type: 'string', description: 'City or country' },
      remoteOnly: { type: 'boolean', description: 'Only remote-friendly roles' },
    },
    additionalProperties: false,
  },
  validator: object({
    query: optional(str({ max: 120 })),
    location: optional(str({ max: 80 })),
    remoteOnly: optional(bool()),
  }),
  // Published jobs are PUBLIC; the classification is what the gateway checks.
  async resolveResource(ctx) {
    return { type: 'job', tenantId: ctx.identity.tenantId, classification: 'PUBLIC' }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const { items } = await ctx.repos.jobs.search(
      scope,
      {
        // The EXTERNAL zone can only ever see PUBLISHED jobs. This is not a
        // caller-supplied filter, so it cannot be widened.
        statuses: ['PUBLISHED'],
        ...(input.query ? { query: input.query } : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(input.remoteOnly ? { remoteOnly: true } : {}),
      },
      MAX_PUBLIC_RESULTS,
      0,
    )
    if (items.length === 0) {
      return {
        ok: true,
        result: { summary: 'There are no published openings matching that search right now.' },
      }
    }
    const jobs = items.map((job) => ({
      jobCode: job.jobCode,
      title: job.title,
      location: job.location ?? 'Not specified',
      employmentType: job.employmentType,
      remoteAllowed: job.remoteAllowed,
      closingDate: job.closingDate,
    }))
    return {
      ok: true,
      result: {
        summary: `${items.length} published opening(s) found.`,
        data: { jobs },
      },
    }
  },
}

export const getJobDetailsTool: ToolDefinition<{ jobCode: string }> = {
  name: 'get_job_details',
  description: 'Get the full description of one published job, identified by its job code.',
  scope: 'EXTERNAL',
  permission: 'job.read.public',
  risk: 'LOW',
  resource: 'job',
  action: 'read',
  auditRequired: false,
  parameters: {
    type: 'object',
    properties: { jobCode: { type: 'string', description: 'The job code, e.g. ENG-001' } },
    required: ['jobCode'],
    additionalProperties: false,
  },
  validator: object({ jobCode: str({ min: 2, max: 40 }) }),
  async resolveResource(ctx, input) {
    const job = await ctx.repos.jobs.findByIdOrCode(tenantScope(ctx.identity.tenantId), input.jobCode)
    // A DRAFT/CLOSED job is classified INTERNAL, so the gateway will refuse it
    // for an external caller without this tool having to special-case it.
    return {
      type: 'job',
      ...(job ? { id: job.id } : {}),
      tenantId: ctx.identity.tenantId,
      classification: job?.status === 'PUBLISHED' ? 'PUBLIC' : 'INTERNAL',
    }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const job = await ctx.repos.jobs.findByIdOrCode(scope, input.jobCode)
    if (!job || job.status !== 'PUBLISHED') {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find a published job with that code.' }
    }
    const salaryPublic = await ctx.repos.jobs.isSalaryPublic(scope, job.id)
    return {
      ok: true,
      result: {
        summary: `Details for ${job.title} (${job.jobCode}).`,
        data: {
          jobCode: job.jobCode,
          title: job.title,
          location: job.location ?? 'Not specified',
          employmentType: job.employmentType,
          remoteAllowed: job.remoteAllowed,
          experienceMin: job.experienceMin,
          closingDate: job.closingDate,
          description: job.description.slice(0, 2000),
          // Salary is only ever shown when HR explicitly published the range.
          salaryRange: salaryPublic
            ? { min: job.salaryMin, max: job.salaryMax, currency: job.currency }
            : null,
        },
        groundedNumbers: salaryPublic
          ? [job.salaryMin ?? '', job.salaryMax ?? ''].filter((v) => v !== '')
          : [],
      },
    }
  },
}

export const getJobRequirementsTool: ToolDefinition<{ jobCode: string }> = {
  name: 'get_job_requirements',
  description: 'List the requirements and qualifications for one published job.',
  scope: 'EXTERNAL',
  permission: 'job.read.public',
  risk: 'LOW',
  resource: 'job.requirement',
  action: 'list',
  auditRequired: false,
  parameters: {
    type: 'object',
    properties: { jobCode: { type: 'string' } },
    required: ['jobCode'],
    additionalProperties: false,
  },
  validator: object({ jobCode: str({ min: 2, max: 40 }) }),
  async resolveResource(ctx, input) {
    const job = await ctx.repos.jobs.findByIdOrCode(tenantScope(ctx.identity.tenantId), input.jobCode)
    return {
      type: 'job.requirement',
      tenantId: ctx.identity.tenantId,
      classification: job?.status === 'PUBLISHED' ? 'PUBLIC' : 'INTERNAL',
    }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const job = await ctx.repos.jobs.findByIdOrCode(scope, input.jobCode)
    if (!job || job.status !== 'PUBLISHED') {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find a published job with that code.' }
    }
    const requirements = await ctx.repos.jobRequirements.listForJob(scope, job.id)
    return {
      ok: true,
      result: {
        summary: `${requirements.length} requirement(s) for ${job.title}.`,
        data: {
          jobCode: job.jobCode,
          title: job.title,
          requirements: requirements.map((r) => ({
            type: r.requirementType,
            description: r.description,
            mandatory: r.mandatory,
          })),
        },
      },
    }
  },
}

export const getHiringProcessTool: ToolDefinition<Record<string, never>> = {
  name: 'get_hiring_process',
  description: 'Explain the standard hiring stages and how to apply.',
  scope: 'EXTERNAL',
  permission: 'job.read.public',
  risk: 'LOW',
  resource: 'job',
  action: 'read',
  auditRequired: false,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validator: object({}) as never,
  async resolveResource(ctx) {
    return { type: 'job', tenantId: ctx.identity.tenantId, classification: 'PUBLIC' }
  },
  async handler() {
    // Static, non-confidential process description. Deliberately not sourced
    // from the knowledge base, which is INTERNAL and off-limits externally.
    return {
      ok: true,
      result: {
        summary: 'The hiring process has five stages.',
        data: {
          stages: [
            { step: 1, name: 'Application received', detail: 'Submit your details and CV for a published role.' },
            { step: 2, name: 'Screening', detail: 'The recruitment team reviews your application.' },
            { step: 3, name: 'Interview', detail: 'One or more interviews, remote or on site.' },
            { step: 4, name: 'Final review', detail: 'A hiring decision is made.' },
            { step: 5, name: 'Offer', detail: 'Successful candidates receive an offer.' },
          ],
          howToApply:
            'Ask me to apply for a job code, then provide your full name and e-mail address.',
        },
      },
    }
  },
}

export const submitApplicationTool: ToolDefinition<{
  jobCode: string
  fullName: string
  email: string
  phone?: string
}> = {
  name: 'submit_application',
  description: 'Submit an application for a published job. Requires the applicant name and e-mail.',
  scope: 'EXTERNAL',
  permission: 'application.create.public',
  risk: 'PERSONAL_DATA',
  resource: 'application',
  action: 'create',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: {
      jobCode: { type: 'string' },
      fullName: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
    },
    required: ['jobCode', 'fullName', 'email'],
    additionalProperties: false,
  },
  validator: object({
    jobCode: str({ min: 2, max: 40 }),
    fullName: str({ min: 2, max: 120 }),
    email: emailValidator(),
    phone: optional(str({ max: 40 })),
  }),
  async resolveResource(ctx) {
    return { type: 'application', tenantId: ctx.identity.tenantId }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const job = await ctx.repos.jobs.findByIdOrCode(scope, input.jobCode)
    if (!job || job.status !== 'PUBLISHED') {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'That job is not open for applications.' }
    }
    if (job.closingDate && job.closingDate < ctx.today) {
      return { ok: false, reasonCode: 'CLOSED', message: 'Applications for that job have closed.' }
    }

    const candidate = await ctx.repos.candidates.createOrGet(scope, {
      name: input.fullName,
      email: input.email,
      phone: input.phone ?? null,
      telegramUserId: ctx.identity.telegramUserId ?? null,
      source: ctx.identity.channel === 'TELEGRAM_EXTERNAL' ? 'TELEGRAM' : 'WEB',
    })

    const existing = (await ctx.repos.applications.listForCandidate(scope, candidate.id)).find(
      (a) => a.jobId === job.id,
    )
    if (existing) {
      // An e-mail address is an assertion, not proof of ownership. Echoing the
      // reference and status here would disclose another applicant's record to
      // anyone who knows their address, so it is returned only when this caller
      // is already bound to that candidate.
      const ownsCandidate =
        ctx.identity.kind === 'ANONYMOUS' && ctx.identity.candidateId === candidate.id
      if (!ownsCandidate) {
        return {
          ok: true,
          result: {
            summary:
              'If an application already exists for that address, we will be in touch by e-mail.',
            data: { jobTitle: job.title },
          },
        }
      }
      return {
        ok: true,
        result: {
          summary: 'You already have an application for that job.',
          data: {
            reference: existing.reference,
            status: publicStageLabel(existing.stage),
            jobTitle: existing.jobTitle,
          },
        },
      }
    }

    const application = await ctx.repos.applications.create(scope, {
      candidateId: candidate.id,
      jobId: job.id,
    })
    return {
      ok: true,
      result: {
        summary: `Application submitted for ${job.title}.`,
        data: {
          reference: application.reference,
          jobTitle: job.title,
          status: publicStageLabel(application.stage),
          note: 'Keep your reference — you can use it to check your status.',
        },
      },
    }
  },
}

export const getApplicationStatusTool: ToolDefinition<{ reference: string }> = {
  name: 'get_application_status',
  description: "Check the status of an application using its reference code.",
  scope: 'EXTERNAL',
  permission: 'application.read.self',
  risk: 'PERSONAL_DATA',
  resource: 'application',
  action: 'read',
  auditRequired: true,
  // Possession of the reference is the credential (see ToolDefinition).
  bearerCredential: 'application_reference',
  parameters: {
    type: 'object',
    properties: { reference: { type: 'string', description: 'Application reference, e.g. SPA-XXXX' } },
    required: ['reference'],
    additionalProperties: false,
  },
  validator: object({ reference: str({ min: 6, max: 40 }) }),
  /**
   * Ownership is resolved from the database: the application's candidate must
   * be the one this Telegram/session subject is linked to. A stolen reference
   * alone is not enough.
   */
  async resolveResource(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const application = await ctx.repos.applications.findByReference(scope, input.reference.trim().toUpperCase())
    return {
      type: 'application',
      ...(application ? { id: application.id } : {}),
      tenantId: ctx.identity.tenantId,
      ownerCandidateId: application?.candidateId ?? null,
      classification: 'PUBLIC',
    }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const application = await ctx.repos.applications.findByReference(
      scope,
      input.reference.trim().toUpperCase(),
    )
    if (!application) {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find an application with that reference.' }
    }
    return {
      ok: true,
      result: {
        summary: `Application ${application.reference} for ${application.jobTitle}.`,
        data: {
          reference: application.reference,
          jobTitle: application.jobTitle,
          // The coarse public label, never the internal stage name.
          status: publicStageLabel(application.stage),
          submittedOn: application.appliedAt.slice(0, 10),
        },
      },
    }
  },
}

export const EXTERNAL_TOOLS = [
  searchJobsTool,
  getJobDetailsTool,
  getJobRequirementsTool,
  getHiringProcessTool,
  submitApplicationTool,
  getApplicationStatusTool,
] as const

/** Kept for the registry's zone report; also asserted by the security tests. */
export const EXTERNAL_TOOL_NAMES = EXTERNAL_TOOLS.map((t) => t.name)
