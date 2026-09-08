/**
 * Manager / HR tools (CLAUDE.md §18).
 *
 * These may name another subject, because the *target* is a genuine business
 * input. The gateway still enforces the ownership relation — a MANAGER's TEAM
 * grant only matches their own direct reports, so passing an arbitrary employee
 * id yields NOT_MANAGER_OF_TARGET rather than data.
 */

import { object, optional, str } from '@corpus/shared'
import { canTransition, canTransitionJob, isTerminalStage, type ApplicationStage } from '@corpus/domain'
import { tenantScope } from '@corpus/db'
import type { ToolContext, ToolDefinition } from '../tool-types.js'

function actingUserId(ctx: ToolContext): string | null {
  return ctx.identity.kind === 'USER' ? ctx.identity.userId : null
}

export const getTeamLeaveRequestsTool: ToolDefinition<{ status?: string }> = {
  name: 'get_team_leave_requests',
  description: "List leave requests from the manager's direct reports.",
  scope: 'INTERNAL',
  permission: 'leave.read.team',
  risk: 'PERSONAL_DATA',
  resource: 'leave.request',
  action: 'list',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] } },
    additionalProperties: false,
  },
  validator: object({
    status: optional(str({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] })),
  }),
  async resolveResource(ctx) {
    // The manager's own first report is used as the ownership probe; the query
    // below is then restricted to exactly the managed set.
    const managed = ctx.identity.kind === 'USER' ? ctx.identity.managedEmployeeIds : []
    return {
      type: 'leave.request',
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: managed[0] ?? null,
    }
  },
  async handler(ctx, input) {
    if (ctx.identity.kind !== 'USER') {
      return { ok: false, reasonCode: 'NOT_AUTHENTICATED', message: 'You need to be signed in.' }
    }
    const scope = tenantScope(ctx.identity.tenantId)

    // HR with leave.read.all sees the whole tenant; a manager sees only their
    // direct reports. The set is computed here, not supplied by the model.
    const seesAll = ctx.identity.permissions.has('leave.read.all')
    const options = {
      ...(input.status ? { statuses: [input.status as 'PENDING'] } : { statuses: ['PENDING'] as const }),
      limit: 20,
      offset: 0,
    }
    const { items } = seesAll
      ? await ctx.repos.leaveRequests.listAll(scope, options)
      : await ctx.repos.leaveRequests.listForEmployees(
          scope,
          ctx.identity.managedEmployeeIds,
          options,
        )

    return {
      ok: true,
      result: {
        summary: `${items.length} leave request(s) ${seesAll ? 'across the organisation' : 'from your direct reports'}.`,
        data: {
          requests: items.map((r) => ({
            id: r.id,
            employee: r.employeeName,
            leaveType: r.leaveTypeName,
            from: r.startDate,
            to: r.endDate,
            days: r.workingDays,
            status: r.status,
          })),
        },
        groundedNumbers: items.map((r) => r.workingDays),
      },
    }
  },
}

function decisionTool(
  decision: 'APPROVED' | 'REJECTED',
): ToolDefinition<{ requestId: string; comment?: string }> {
  const approving = decision === 'APPROVED'
  return {
    name: approving ? 'approve_leave_request' : 'reject_leave_request',
    description: approving
      ? 'Approve a pending leave request belonging to a direct report.'
      : 'Reject a pending leave request belonging to a direct report.',
    scope: 'INTERNAL',
    permission: 'leave.approve.team',
    risk: 'SENSITIVE',
    resource: 'leave.request',
    action: approving ? 'approve' : 'reject',
    auditRequired: true,
    parameters: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        comment: { type: 'string' },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
    validator: object({ requestId: str({ min: 4, max: 40 }), comment: optional(str({ max: 500 })) }),
    async resolveResource(ctx, input) {
      const request = await ctx.repos.leaveRequests.findById(
        tenantScope(ctx.identity.tenantId),
        input.requestId,
      )
      return {
        type: 'leave.request',
        id: input.requestId,
        tenantId: ctx.identity.tenantId,
        // Owner comes from the stored row — this is what makes the TEAM check
        // meaningful rather than advisory.
        ownerEmployeeId: request?.employeeId ?? null,
      }
    },
    async handler(ctx, input) {
      const userId = actingUserId(ctx)
      if (!userId) {
        return { ok: false, reasonCode: 'NOT_AUTHENTICATED', message: 'You need to be signed in.' }
      }
      const scope = tenantScope(ctx.identity.tenantId)
      const request = await ctx.repos.leaveRequests.findByIdDetailed(scope, input.requestId)
      if (!request) {
        return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find that leave request.' }
      }
      if (request.status !== 'PENDING') {
        return {
          ok: false,
          reasonCode: 'BUSINESS_RULE',
          message: `That request is already ${request.status.toLowerCase()}.`,
        }
      }
      // A manager cannot decide their own request.
      if (ctx.identity.kind === 'USER' && request.employeeId === ctx.identity.employeeId) {
        return {
          ok: false,
          reasonCode: 'SELF_APPROVAL',
          message: 'You cannot decide your own leave request.',
        }
      }

      await ctx.repos.leaveRequests.decide(scope, {
        requestId: request.id,
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        workingDays: request.workingDays,
        year: Number(request.startDate.slice(0, 4)),
        decision,
        approverUserId: userId,
        comment: input.comment ?? null,
      })

      return {
        ok: true,
        result: {
          summary: `Leave request for ${request.employeeName} ${approving ? 'approved' : 'rejected'}.`,
          data: {
            requestId: request.id,
            employee: request.employeeName,
            decision,
            days: request.workingDays,
          },
          groundedNumbers: [request.workingDays],
        },
      }
    },
  }
}

export const approveLeaveRequestTool = decisionTool('APPROVED')
export const rejectLeaveRequestTool = decisionTool('REJECTED')

export const searchEmployeesTool: ToolDefinition<{ query?: string; department?: string }> = {
  name: 'search_employees',
  description: 'Search the employee directory by name, e-mail or employee number.',
  scope: 'INTERNAL',
  permission: 'employee.read.team',
  risk: 'PERSONAL_DATA',
  resource: 'employee',
  action: 'search',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      department: { type: 'string' },
    },
    additionalProperties: false,
  },
  validator: object({ query: optional(str({ max: 100 })), department: optional(str({ max: 60 })) }),
  async resolveResource(ctx) {
    const managed = ctx.identity.kind === 'USER' ? ctx.identity.managedEmployeeIds : []
    return {
      type: 'employee',
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: managed[0] ?? null,
      classification: 'INTERNAL',
    }
  },
  async handler(ctx, input) {
    if (ctx.identity.kind !== 'USER') {
      return { ok: false, reasonCode: 'NOT_AUTHENTICATED', message: 'You need to be signed in.' }
    }
    const scope = tenantScope(ctx.identity.tenantId)
    const seesAll = ctx.identity.permissions.has('employee.read.all')
    const departments = await ctx.repos.departments.list(scope)
    const department = input.department
      ? departments.find((d) => d.name.toLowerCase() === input.department!.toLowerCase() || d.code.toLowerCase() === input.department!.toLowerCase())
      : undefined

    const { items } = await ctx.repos.employees.search(
      scope,
      {
        ...(input.query ? { query: input.query } : {}),
        ...(department ? { departmentId: department.id } : {}),
        // A manager's search is hard-restricted to their reports.
        ...(seesAll ? {} : { restrictToIds: ctx.identity.managedEmployeeIds }),
      },
      10,
      0,
    )
    return {
      ok: true,
      result: {
        summary: `${items.length} employee(s) found.`,
        data: {
          employees: items.map((e) => ({
            employeeNo: e.employeeNo,
            name: `${e.firstName} ${e.lastName}`,
            email: e.email,
            department: departments.find((d) => d.id === e.departmentId)?.name ?? 'Unassigned',
            status: e.status,
            // No compensation field: it is a different resource entirely.
          })),
        },
      },
    }
  },
}

export const getEmployeeProfileTool: ToolDefinition<{ employeeNo: string }> = {
  name: 'get_employee_profile',
  description: "Get one employee's profile by employee number. Excludes compensation.",
  scope: 'INTERNAL',
  permission: 'employee.read.team',
  risk: 'PERSONAL_DATA',
  resource: 'employee',
  action: 'read',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: { employeeNo: { type: 'string' } },
    required: ['employeeNo'],
    additionalProperties: false,
  },
  validator: object({ employeeNo: str({ min: 1, max: 40 }) }),
  async resolveResource(ctx, input) {
    const employee = await ctx.repos.employees.findByEmployeeNo(
      tenantScope(ctx.identity.tenantId),
      input.employeeNo,
    )
    return {
      type: 'employee',
      ...(employee ? { id: employee.id } : {}),
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: employee?.id ?? null,
      classification: 'INTERNAL',
    }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const employee = await ctx.repos.employees.findByEmployeeNo(scope, input.employeeNo)
    if (!employee) {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find that employee.' }
    }
    const departments = await ctx.repos.departments.list(scope)
    return {
      ok: true,
      result: {
        summary: `Profile for ${employee.firstName} ${employee.lastName}.`,
        data: {
          employeeNo: employee.employeeNo,
          name: `${employee.firstName} ${employee.lastName}`,
          email: employee.email,
          department: departments.find((d) => d.id === employee.departmentId)?.name ?? 'Unassigned',
          hireDate: employee.hireDate,
          employmentType: employee.employmentType,
          status: employee.status,
        },
      },
    }
  },
}

export const searchCandidatesTool: ToolDefinition<{ query?: string; jobCode?: string }> = {
  name: 'search_candidates',
  description: 'Search recruitment candidates and their applications.',
  scope: 'INTERNAL',
  permission: 'candidate.read',
  risk: 'SENSITIVE',
  resource: 'candidate',
  action: 'search',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, jobCode: { type: 'string' } },
    additionalProperties: false,
  },
  validator: object({ query: optional(str({ max: 100 })), jobCode: optional(str({ max: 40 })) }),
  async resolveResource(ctx) {
    return { type: 'candidate', tenantId: ctx.identity.tenantId, classification: 'CONFIDENTIAL' }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    if (input.jobCode) {
      const job = await ctx.repos.jobs.findByIdOrCode(scope, input.jobCode)
      if (!job) {
        return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find that job code.' }
      }
      const { items } = await ctx.repos.applications.search(scope, { jobId: job.id }, 15, 0)
      return {
        ok: true,
        result: {
          summary: `${items.length} application(s) for ${job.title}.`,
          data: {
            applications: items.map((a) => ({
              reference: a.reference,
              candidate: a.candidateName,
              stage: a.stage,
              appliedOn: a.appliedAt.slice(0, 10),
            })),
          },
        },
      }
    }
    const { items } = await ctx.repos.candidates.search(
      scope,
      input.query ? { query: input.query } : {},
      10,
      0,
    )
    return {
      ok: true,
      result: {
        summary: `${items.length} candidate(s) found.`,
        data: {
          candidates: items.map((c) => ({ name: c.name, email: c.email, source: c.source })),
        },
      },
    }
  },
}

export const getCandidateTool: ToolDefinition<{ reference: string }> = {
  name: 'get_candidate',
  description: 'Get one application in full, including its stage history, by reference.',
  scope: 'INTERNAL',
  permission: 'application.read',
  risk: 'SENSITIVE',
  resource: 'application',
  action: 'read',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: { reference: { type: 'string' } },
    required: ['reference'],
    additionalProperties: false,
  },
  validator: object({ reference: str({ min: 4, max: 40 }) }),
  async resolveResource(ctx) {
    return { type: 'application', tenantId: ctx.identity.tenantId, classification: 'CONFIDENTIAL' }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const application = await ctx.repos.applications.findByReference(
      scope,
      input.reference.trim().toUpperCase(),
    )
    if (!application) {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find that application.' }
    }
    const events = await ctx.repos.applications.listEvents(scope, application.id)
    return {
      ok: true,
      result: {
        summary: `Application ${application.reference}: ${application.candidateName} for ${application.jobTitle}.`,
        data: {
          reference: application.reference,
          candidate: application.candidateName,
          candidateEmail: application.candidateEmail,
          job: application.jobTitle,
          stage: application.stage,
          status: application.status,
          history: events.map((e) => ({
            to: e.toStage,
            at: e.createdAt.slice(0, 10),
            note: e.note,
          })),
        },
      },
    }
  },
}

export const updateApplicationStageTool: ToolDefinition<{
  reference: string
  stage: string
  note?: string
}> = {
  name: 'update_application_stage',
  description: 'Move an application to the next recruitment stage.',
  scope: 'INTERNAL',
  permission: 'application.update',
  risk: 'SENSITIVE',
  resource: 'application',
  action: 'update',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: {
      reference: { type: 'string' },
      stage: {
        type: 'string',
        enum: ['SCREENING', 'SHORTLISTED', 'INTERVIEW', 'TECHNICAL', 'FINAL', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'],
      },
      note: { type: 'string' },
    },
    required: ['reference', 'stage'],
    additionalProperties: false,
  },
  validator: object({
    reference: str({ min: 4, max: 40 }),
    stage: str({
      enum: ['SCREENING', 'SHORTLISTED', 'INTERVIEW', 'TECHNICAL', 'FINAL', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'],
    }),
    note: optional(str({ max: 500 })),
  }),
  async resolveResource(ctx) {
    return { type: 'application', tenantId: ctx.identity.tenantId, classification: 'CONFIDENTIAL' }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const application = await ctx.repos.applications.findByReference(
      scope,
      input.reference.trim().toUpperCase(),
    )
    if (!application) {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find that application.' }
    }
    const toStage = input.stage as ApplicationStage
    // Stage legality is a deterministic backend rule (§21), not a model choice.
    const transition = canTransition(application.stage, toStage)
    if (!transition.ok) {
      return { ok: false, reasonCode: 'INVALID_TRANSITION', message: transition.reason ?? 'That stage change is not allowed.' }
    }
    await ctx.repos.applications.transition(scope, {
      applicationId: application.id,
      fromStage: application.stage,
      toStage,
      note: input.note ?? null,
      actorUserId: actingUserId(ctx),
      closeApplication: isTerminalStage(toStage),
    })
    return {
      ok: true,
      result: {
        summary: `Application ${application.reference} moved from ${application.stage} to ${toStage}.`,
        data: { reference: application.reference, from: application.stage, to: toStage },
      },
    }
  },
}

export const createJobTool: ToolDefinition<{
  title: string
  jobCode: string
  employmentType: string
  description: string
  location?: string
}> = {
  name: 'create_job',
  description: 'Create a new job in DRAFT status.',
  scope: 'INTERNAL',
  permission: 'job.create',
  risk: 'SENSITIVE',
  resource: 'job',
  action: 'create',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      jobCode: { type: 'string' },
      employmentType: {
        type: 'string',
        enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'],
      },
      description: { type: 'string' },
      location: { type: 'string' },
    },
    required: ['title', 'jobCode', 'employmentType', 'description'],
    additionalProperties: false,
  },
  validator: object({
    title: str({ min: 3, max: 150 }),
    jobCode: str({ min: 2, max: 40 }),
    employmentType: str({ enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] }),
    description: str({ min: 10, max: 8000 }),
    location: optional(str({ max: 120 })),
  }),
  async resolveResource(ctx) {
    return { type: 'job', tenantId: ctx.identity.tenantId, classification: 'INTERNAL' }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const existing = await ctx.repos.jobs.findByIdOrCode(scope, input.jobCode)
    if (existing) {
      return { ok: false, reasonCode: 'CONFLICT', message: 'A job with that code already exists.' }
    }
    const job = await ctx.repos.jobs.create(scope, {
      jobCode: input.jobCode,
      title: input.title,
      employmentType: input.employmentType as 'FULL_TIME',
      description: input.description,
      location: input.location ?? null,
      status: 'DRAFT',
    })
    return {
      ok: true,
      result: {
        summary: `Job ${job.jobCode} created as DRAFT.`,
        data: { jobCode: job.jobCode, title: job.title, status: job.status },
      },
    }
  },
}

export const closeJobTool: ToolDefinition<{ jobCode: string }> = {
  name: 'close_job',
  description: 'Close a job so it stops accepting applications.',
  scope: 'INTERNAL',
  permission: 'job.update',
  risk: 'SENSITIVE',
  resource: 'job',
  action: 'update',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: { jobCode: { type: 'string' } },
    required: ['jobCode'],
    additionalProperties: false,
  },
  validator: object({ jobCode: str({ min: 2, max: 40 }) }),
  async resolveResource(ctx) {
    return { type: 'job', tenantId: ctx.identity.tenantId, classification: 'INTERNAL' }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const job = await ctx.repos.jobs.findByIdOrCode(scope, input.jobCode)
    if (!job) return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find that job.' }
    if (job.status === 'CLOSED') {
      return { ok: false, reasonCode: 'BUSINESS_RULE', message: 'That job is already closed.' }
    }
    const transition = canTransitionJob(job.status, 'CLOSED')
    if (!transition.ok) {
      return {
        ok: false,
        reasonCode: 'BUSINESS_RULE',
        message: transition.reason ?? 'That job cannot be closed.',
      }
    }
    await ctx.repos.jobs.update(scope, job.id, { status: 'CLOSED' })
    return {
      ok: true,
      result: { summary: `Job ${job.jobCode} closed.`, data: { jobCode: job.jobCode, status: 'CLOSED' } },
    }
  },
}

export const INTERNAL_MANAGEMENT_TOOLS = [
  getTeamLeaveRequestsTool,
  approveLeaveRequestTool,
  rejectLeaveRequestTool,
  searchEmployeesTool,
  getEmployeeProfileTool,
  searchCandidatesTool,
  getCandidateTool,
  updateApplicationStageTool,
  createJobTool,
  closeJobTool,
] as const
