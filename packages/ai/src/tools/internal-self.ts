/**
 * INTERNAL self-service tools (CLAUDE.md §17).
 *
 * Every tool here derives the employee from `ctx.identity.employeeId`. None
 * accepts an employee identifier — `ToolRegistry.register` throws if one ever
 * does, so `get_leave_balance(employee_id)` cannot be added by accident.
 */

import { dateOnly, object, optional, str, type DateOnly } from '@corpus/shared'
import { availableDays, canCancelLeave, validateLeaveRequest } from '@corpus/domain'
import { tenantScope } from '@corpus/db'
import { INSUFFICIENT_KNOWLEDGE_REPLY } from '@corpus/security'
import type { ToolContext, ToolDefinition, ToolOutcome } from '../tool-types.js'

/**
 * Guard used by every self-service tool: the identity must be a verified
 * internal user with an employee record. Anything else fails closed.
 */
function requireEmployeeId(ctx: ToolContext): string | null {
  return ctx.identity.kind === 'USER' ? ctx.identity.employeeId : null
}

const NO_EMPLOYEE: ToolOutcome = {
  ok: false,
  reasonCode: 'NO_EMPLOYEE_RECORD',
  message: 'Your account is not linked to an employee record. Please contact HR.',
}

const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const

export const getMyProfileTool: ToolDefinition<Record<string, never>> = {
  name: 'get_my_profile',
  description: "Get the signed-in employee's own profile: department, position, manager, hire date.",
  scope: 'INTERNAL',
  permission: 'employee.read.self',
  risk: 'PERSONAL_DATA',
  resource: 'employee',
  action: 'read',
  auditRequired: false,
  parameters: EMPTY as unknown as Record<string, unknown>,
  validator: object({}) as never,
  async resolveResource(ctx) {
    // Ownership comes from the identity, never from arguments.
    return {
      type: 'employee',
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: requireEmployeeId(ctx),
      classification: 'INTERNAL',
    }
  },
  async handler(ctx) {
    const employeeId = requireEmployeeId(ctx)
    if (!employeeId) return NO_EMPLOYEE
    const scope = tenantScope(ctx.identity.tenantId)
    const employee = await ctx.repos.employees.findById(scope, employeeId)
    if (!employee) return NO_EMPLOYEE

    const [departments, positions] = await Promise.all([
      ctx.repos.departments.list(scope),
      ctx.repos.positions.list(scope),
    ])
    const manager = employee.managerId
      ? await ctx.repos.employees.findById(scope, employee.managerId)
      : null

    return {
      ok: true,
      result: {
        summary: `Profile for ${employee.firstName} ${employee.lastName}.`,
        data: {
          employeeNo: employee.employeeNo,
          name: `${employee.firstName} ${employee.lastName}`,
          email: employee.email,
          department: departments.find((d) => d.id === employee.departmentId)?.name ?? 'Unassigned',
          position: positions.find((p) => p.id === employee.positionId)?.title ?? 'Unassigned',
          manager: manager ? `${manager.firstName} ${manager.lastName}` : 'None',
          hireDate: employee.hireDate,
          employmentType: employee.employmentType,
          status: employee.status,
          // Note the absence of any salary field: compensation lives behind
          // employee.read.compensation and is not reachable from chat at all.
        },
      },
    }
  },
}

export const getMyLeaveBalanceTool: ToolDefinition<Record<string, never>> = {
  name: 'get_my_leave_balance',
  description: "Get the signed-in employee's own remaining leave balance for the current year.",
  scope: 'INTERNAL',
  permission: 'leave.read.self',
  risk: 'PERSONAL_DATA',
  resource: 'leave.balance',
  action: 'read',
  auditRequired: true,
  parameters: EMPTY as unknown as Record<string, unknown>,
  validator: object({}) as never,
  async resolveResource(ctx) {
    return {
      type: 'leave.balance',
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: requireEmployeeId(ctx),
    }
  },
  async handler(ctx) {
    const employeeId = requireEmployeeId(ctx)
    if (!employeeId) return NO_EMPLOYEE
    const scope = tenantScope(ctx.identity.tenantId)
    const year = Number(ctx.today.slice(0, 4))
    const balances = await ctx.repos.leaveBalances.listForEmployee(scope, employeeId, year)

    if (balances.length === 0) {
      return {
        ok: true,
        result: { summary: `No leave balances are recorded for ${year}. Please contact HR.` },
      }
    }

    const rows = balances.map((b) => ({
      leaveType: b.leaveTypeName,
      entitled: b.entitledDays + b.carriedOverDays,
      used: b.usedDays,
      pending: b.pendingDays,
      available: availableDays(b),
    }))

    return {
      ok: true,
      result: {
        summary: `Leave balances for ${year}.`,
        data: { year, balances: rows },
        // Every number the model may state, so invented figures get redacted.
        groundedNumbers: rows.flatMap((r) => [r.entitled, r.used, r.pending, r.available, year]),
      },
    }
  },
}

export const getMyLeaveRequestsTool: ToolDefinition<{ status?: string }> = {
  name: 'get_my_leave_requests',
  description: "List the signed-in employee's own leave requests. Optionally filter by status.",
  scope: 'INTERNAL',
  permission: 'leave.read.self',
  risk: 'PERSONAL_DATA',
  resource: 'leave.request',
  action: 'list',
  auditRequired: false,
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
    },
    additionalProperties: false,
  },
  validator: object({
    status: optional(str({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] })),
  }),
  async resolveResource(ctx) {
    return {
      type: 'leave.request',
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: requireEmployeeId(ctx),
    }
  },
  async handler(ctx, input) {
    const employeeId = requireEmployeeId(ctx)
    if (!employeeId) return NO_EMPLOYEE
    const scope = tenantScope(ctx.identity.tenantId)
    const { items } = await ctx.repos.leaveRequests.listForEmployee(scope, employeeId, {
      ...(input.status ? { statuses: [input.status as 'PENDING'] } : {}),
      limit: 10,
      offset: 0,
    })
    return {
      ok: true,
      result: {
        summary: `${items.length} leave request(s) found.`,
        data: {
          requests: items.map((r) => ({
            id: r.id,
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

export const getMyLeaveHistoryTool: ToolDefinition<Record<string, never>> = {
  name: 'get_my_leave_history',
  description: "List the signed-in employee's own approved leave taken this year.",
  scope: 'INTERNAL',
  permission: 'leave.read.self',
  risk: 'PERSONAL_DATA',
  resource: 'leave.request',
  action: 'list',
  auditRequired: false,
  parameters: EMPTY as unknown as Record<string, unknown>,
  validator: object({}) as never,
  async resolveResource(ctx) {
    return {
      type: 'leave.request',
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: requireEmployeeId(ctx),
    }
  },
  async handler(ctx) {
    const employeeId = requireEmployeeId(ctx)
    if (!employeeId) return NO_EMPLOYEE
    const scope = tenantScope(ctx.identity.tenantId)
    const { items } = await ctx.repos.leaveRequests.listForEmployee(scope, employeeId, {
      statuses: ['APPROVED'],
      limit: 20,
      offset: 0,
    })
    const thisYear = items.filter((r) => r.startDate.startsWith(ctx.today.slice(0, 4)))
    const total = thisYear.reduce((sum, r) => sum + r.workingDays, 0)
    return {
      ok: true,
      result: {
        summary: `${thisYear.length} approved leave period(s) this year, ${total} day(s) total.`,
        data: {
          totalDays: total,
          periods: thisYear.map((r) => ({
            leaveType: r.leaveTypeName,
            from: r.startDate,
            to: r.endDate,
            days: r.workingDays,
          })),
        },
        groundedNumbers: [total, ...thisYear.map((r) => r.workingDays)],
      },
    }
  },
}

export const getHolidaysTool: ToolDefinition<Record<string, never>> = {
  name: 'get_holidays',
  description: 'List upcoming company public holidays.',
  scope: 'INTERNAL',
  permission: 'leave.read.self',
  risk: 'LOW',
  resource: 'holiday',
  action: 'list',
  auditRequired: false,
  parameters: EMPTY as unknown as Record<string, unknown>,
  validator: object({}) as never,
  async resolveResource(ctx) {
    return { type: 'holiday', tenantId: ctx.identity.tenantId, classification: 'INTERNAL' }
  },
  async handler(ctx) {
    const holidays = await ctx.repos.holidays.listUpcoming(
      tenantScope(ctx.identity.tenantId),
      ctx.today,
      12,
    )
    return {
      ok: true,
      result: {
        summary: `${holidays.length} upcoming holiday(s).`,
        data: { holidays: holidays.map((h) => ({ date: h.date, name: h.name })) },
      },
    }
  },
}

export const createLeaveRequestTool: ToolDefinition<{
  leaveTypeCode: string
  startDate: DateOnly
  endDate: DateOnly
  reason?: string
}> = {
  name: 'create_leave_request',
  description:
    'Submit a leave request for the signed-in employee. The backend computes the working days.',
  scope: 'INTERNAL',
  permission: 'leave.create.self',
  risk: 'PERSONAL_DATA',
  resource: 'leave.request',
  action: 'create',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: {
      leaveTypeCode: { type: 'string', description: 'Leave type code, e.g. ANNUAL or SICK' },
      startDate: { type: 'string', description: 'YYYY-MM-DD' },
      endDate: { type: 'string', description: 'YYYY-MM-DD' },
      reason: { type: 'string' },
    },
    required: ['leaveTypeCode', 'startDate', 'endDate'],
    additionalProperties: false,
  },
  validator: object({
    leaveTypeCode: str({ min: 2, max: 30 }),
    startDate: dateOnly(),
    endDate: dateOnly(),
    reason: optional(str({ max: 500 })),
  }),
  async resolveResource(ctx) {
    return {
      type: 'leave.request',
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: requireEmployeeId(ctx),
    }
  },
  async handler(ctx, input) {
    const employeeId = requireEmployeeId(ctx)
    if (!employeeId) return NO_EMPLOYEE
    const scope = tenantScope(ctx.identity.tenantId)

    const [employee, leaveType] = await Promise.all([
      ctx.repos.employees.findById(scope, employeeId),
      ctx.repos.leaveTypes.findByCode(scope, input.leaveTypeCode),
    ])
    if (!employee) return NO_EMPLOYEE
    if (!leaveType) {
      const available = await ctx.repos.leaveTypes.listActive(scope)
      return {
        ok: false,
        reasonCode: 'UNKNOWN_LEAVE_TYPE',
        message: `I do not recognise that leave type. Available: ${available.map((t) => t.code).join(', ')}.`,
      }
    }

    const year = Number(input.startDate.slice(0, 4))
    const [balance, holidays, existing] = await Promise.all([
      ctx.repos.leaveBalances.find(scope, employeeId, leaveType.id, year),
      ctx.repos.holidays.listBetween(scope, input.startDate, input.endDate),
      ctx.repos.leaveRequests.listOpenForEmployee(scope, employeeId),
    ])

    // Deterministic backend validation — never delegated to the model (§38).
    const validation = validateLeaveRequest({
      startDate: input.startDate,
      endDate: input.endDate,
      today: ctx.today,
      hireDate: employee.hireDate,
      employeeStatus: employee.status,
      leaveType,
      balance,
      holidays: holidays.map((h) => h.date),
      existingRequests: existing,
    })

    if (!validation.valid) {
      return {
        ok: false,
        reasonCode: validation.issues[0]?.code ?? 'INVALID',
        message: validation.issues.map((i) => i.message).join(' '),
      }
    }

    const created = await ctx.repos.leaveRequests.createWithReservation(scope, {
      employeeId,
      leaveTypeId: leaveType.id,
      startDate: input.startDate,
      endDate: input.endDate,
      workingDays: validation.chargeableDays,
      reason: input.reason ?? null,
      year,
      autoApprove: !leaveType.requiresApproval,
      approverUserId: null,
    })

    return {
      ok: true,
      result: {
        summary: `Leave request submitted: ${validation.chargeableDays} working day(s) of ${leaveType.name}.`,
        data: {
          requestId: created.id,
          leaveType: leaveType.name,
          from: created.startDate,
          to: created.endDate,
          workingDays: created.workingDays,
          status: created.status,
          remainingAfter: validation.availableAfter,
        },
        groundedNumbers: [created.workingDays, validation.availableAfter, validation.availableBefore],
      },
    }
  },
}

export const cancelLeaveRequestTool: ToolDefinition<{ requestId: string }> = {
  name: 'cancel_leave_request',
  description: "Cancel one of the signed-in employee's own leave requests.",
  scope: 'INTERNAL',
  permission: 'leave.cancel.self',
  risk: 'PERSONAL_DATA',
  resource: 'leave.request',
  action: 'delete',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false,
  },
  validator: object({ requestId: str({ min: 4, max: 40 }) }),
  /**
   * The owner is read from the stored request, so passing someone else's
   * request id is caught by the gateway's SELF ownership check.
   */
  async resolveResource(ctx, input) {
    const request = await ctx.repos.leaveRequests.findById(
      tenantScope(ctx.identity.tenantId),
      input.requestId,
    )
    return {
      type: 'leave.request',
      id: input.requestId,
      tenantId: ctx.identity.tenantId,
      ownerEmployeeId: request?.employeeId ?? null,
    }
  },
  async handler(ctx, input) {
    const scope = tenantScope(ctx.identity.tenantId)
    const request = await ctx.repos.leaveRequests.findById(scope, input.requestId)
    if (!request) {
      return { ok: false, reasonCode: 'NOT_FOUND', message: 'I could not find that leave request.' }
    }
    const cancellable = canCancelLeave(request, ctx.today)
    if (!cancellable.ok) {
      return {
        ok: false,
        reasonCode: 'BUSINESS_RULE',
        message: cancellable.reason ?? 'That leave request cannot be cancelled.',
      }
    }
    await ctx.repos.leaveRequests.cancel(scope, {
      requestId: request.id,
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      workingDays: request.workingDays,
      year: Number(request.startDate.slice(0, 4)),
      previousStatus: request.status as 'PENDING' | 'APPROVED',
    })
    return {
      ok: true,
      result: {
        summary: `Leave request for ${request.startDate} to ${request.endDate} cancelled.`,
        data: { requestId: request.id, status: 'CANCELLED', daysReturned: request.workingDays },
        groundedNumbers: [request.workingDays],
      },
    }
  },
}

export const searchHrPolicyTool: ToolDefinition<{ question: string; category?: string }> = {
  name: 'search_hr_policy',
  description:
    'Search approved HR policy documents to answer a policy question. Returns cited passages only.',
  scope: 'INTERNAL',
  permission: 'policy.read',
  risk: 'LOW',
  resource: 'knowledge.chunk',
  action: 'search',
  auditRequired: false,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: "The employee's policy question" },
      category: { type: 'string', description: 'Optional document category filter' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  validator: object({
    question: str({ min: 3, max: 500 }),
    category: optional(str({ max: 60 })),
  }),
  async resolveResource(ctx) {
    // The gateway's grant ladder decides the classification ceiling; the tool
    // asks for the *lowest* tier so an EMPLOYEE is not denied outright, and
    // then uses the returned allowedClassifications to filter retrieval.
    return {
      type: 'knowledge.chunk',
      tenantId: ctx.identity.tenantId,
      classification: 'INTERNAL',
    }
  },
  async handler(ctx, input) {
    const result = await ctx.knowledgeSearch.search({
      tenantId: ctx.identity.tenantId,
      query: input.question,
      // Straight from the gateway decision — this is the §24 filter.
      allowedClassifications: ctx.allowedClassifications as never,
      onDate: ctx.today,
      limit: ctx.limits.maxContextChunks,
      ...(input.category ? { category: input.category } : {}),
    })

    if (result.empty) {
      // No fabrication (CLAUDE.md §30).
      return { ok: false, reasonCode: 'NO_KNOWLEDGE', message: INSUFFICIENT_KNOWLEDGE_REPLY }
    }

    // Effective-date filtering already happened in SQL (§23): the retrieval
    // query excludes superseded versions, so an old policy can never be cited.
    const effective = result.passages

    return {
      ok: true,
      result: {
        summary: `${effective.length} authorised policy passage(s) found.`,
        citations: effective.map((p) => ({
          documentName: p.documentName,
          section: p.section,
          version: p.version,
        })),
        contextPassages: effective.map((p) => ({
          label: `${p.documentName}${p.section ? ` — ${p.section}` : ''} (v${p.version})`,
          content: p.content,
        })),
      },
    }
  },
}

export const raiseHrTicketTool: ToolDefinition<{ subject: string; details: string }> = {
  name: 'raise_hr_ticket',
  description: 'Raise a ticket for HR when a question cannot be answered from policy documents.',
  scope: 'INTERNAL',
  permission: 'employee.read.self',
  risk: 'LOW',
  resource: 'hr.ticket',
  action: 'create',
  auditRequired: true,
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      details: { type: 'string' },
    },
    required: ['subject', 'details'],
    additionalProperties: false,
  },
  validator: object({ subject: str({ min: 3, max: 150 }), details: str({ min: 3, max: 2000 }) }),
  async resolveResource(ctx) {
    return { type: 'hr.ticket', tenantId: ctx.identity.tenantId, classification: 'INTERNAL' }
  },
  async handler(ctx, input) {
    const ticket = await ctx.repos.conversations.createTicket(tenantScope(ctx.identity.tenantId), {
      subject: input.subject,
      body: input.details,
      raisedByUserId: ctx.identity.kind === 'USER' ? ctx.identity.userId : null,
    })
    return {
      ok: true,
      result: {
        summary: 'A ticket has been raised with HR.',
        data: { ticketId: ticket.id, status: ticket.status },
      },
    }
  },
}

export const INTERNAL_SELF_TOOLS = [
  getMyProfileTool,
  getMyLeaveBalanceTool,
  getMyLeaveRequestsTool,
  getMyLeaveHistoryTool,
  getHolidaysTool,
  createLeaveRequestTool,
  cancelLeaveRequestTool,
  searchHrPolicyTool,
  raiseHrTicketTool,
] as const
