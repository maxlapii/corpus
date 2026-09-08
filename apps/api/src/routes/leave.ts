/**
 * Leave routes (CLAUDE.md §22, §35).
 *
 * Working days are always recomputed server-side. A client-supplied day count
 * is ignored — there is no field for it in any request schema.
 */

import {
  conflict,
  dateOnly,
  makePage,
  num,
  object,
  optional,
  parse,
  str,
} from '@corpus/shared'
import { canCancelLeave, validateLeaveRequest, type LeaveStatus } from '@corpus/domain'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { readJsonBody } from '../middleware/body.js'
import { orNotFound, pageOf, parseQuery, scopeOf, sessionUserIdOf, userIdentityOf } from './helpers.js'

const listQuery = object({
  status: optional(str({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] })),
  /** `self` (default), `team`, or `all` — each gated by its own permission. */
  view: optional(str({ enum: ['self', 'team', 'all'] })),
})

const createBody = object({
  leaveTypeId: str({ min: 1, max: 40 }),
  startDate: dateOnly(),
  endDate: dateOnly(),
  reason: optional(str({ max: 500 })),
  // Deliberately no `workingDays` field: the backend computes it (§22).
})

const decisionBody = object({ comment: optional(str({ max: 500 })) })

const balanceBody = object({
  employeeId: str({ min: 1, max: 40 }),
  leaveTypeId: str({ min: 1, max: 40 }),
  year: num({ int: true, min: 2000, max: 2100 }),
  entitledDays: num({ min: 0, max: 400 }),
  carriedOverDays: optional(num({ min: 0, max: 400 })),
})

export const leaveRoutes = new Hono<AppBindings>()

leaveRoutes.get('/types', async (c) => {
  const container = c.get('container')
  await container.gateway.require({
    identity: userIdentityOf(c),
    action: 'list',
    resource: { type: 'leave.type', tenantId: userIdentityOf(c).tenantId },
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  return c.json({ leaveTypes: await container.repos.leaveTypes.listActive(scopeOf(c)) })
})

leaveRoutes.get('/balance/me', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)

  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'leave.balance',
      tenantId: identity.tenantId,
      ownerEmployeeId: identity.employeeId,
    },
    intent: 'MY_LEAVE_BALANCE',
    requestId: c.get('requestId'),
  })
  if (!identity.employeeId) return c.json({ year: null, balances: [] })

  const year = Number(c.req.query('year') ?? container.today.slice(0, 4))
  const balances = await container.repos.leaveBalances.listForEmployee(
    scopeOf(c),
    identity.employeeId,
    year,
  )
  return c.json({ year, balances })
})

leaveRoutes.get('/balance/:employeeId', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const employeeId = c.req.param('employeeId')

  const employee = await container.repos.employees.findById(scopeOf(c), employeeId)
  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'leave.balance',
      tenantId: employee?.tenantId ?? identity.tenantId,
      ownerEmployeeId: employee?.id ?? employeeId,
    },
    requestId: c.get('requestId'),
  })
  await orNotFound(Promise.resolve(employee), 'employee')

  const year = Number(c.req.query('year') ?? container.today.slice(0, 4))
  return c.json({
    year,
    balances: await container.repos.leaveBalances.listForEmployee(scopeOf(c), employeeId, year),
  })
})

leaveRoutes.put('/balance', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(balanceBody, await readJsonBody(c))

  await container.gateway.require({
    identity,
    action: 'update',
    resource: { type: 'leave.balance', tenantId: identity.tenantId },
    requestId: c.get('requestId'),
    metadata: { employeeId: body.employeeId, year: body.year },
  })

  await container.repos.leaveBalances.upsert(scopeOf(c), {
    employeeId: body.employeeId,
    leaveTypeId: body.leaveTypeId,
    year: body.year,
    entitledDays: body.entitledDays,
    carriedOverDays: body.carriedOverDays ?? 0,
  })
  return c.json({ ok: true })
})

leaveRoutes.get('/requests/me', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(c, listQuery)

  await container.gateway.require({
    identity,
    action: 'list',
    resource: {
      type: 'leave.request',
      tenantId: identity.tenantId,
      ownerEmployeeId: identity.employeeId,
    },
    intent: 'MY_LEAVE_REQUESTS',
    requestId: c.get('requestId'),
  })
  if (!identity.employeeId) return c.json(makePage([], 0, page))

  const { items, total } = await container.repos.leaveRequests.listForEmployee(
    scopeOf(c),
    identity.employeeId,
    {
      ...(filters.status ? { statuses: [filters.status as LeaveStatus] } : {}),
      limit: page.limit,
      offset: page.offset,
    },
  )
  return c.json(makePage(items, total, page))
})

/**
 * Listing across other people. `view` selects the intended scope, and the
 * gateway decides whether that scope is permitted — it is not inferred from
 * the parameter alone.
 */
leaveRoutes.get('/requests', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(c, listQuery)
  const view = filters.view ?? 'team'

  const decision = await container.gateway.require({
    identity,
    action: 'list',
    resource: {
      type: 'leave.request',
      tenantId: identity.tenantId,
      // No self fallback: a caller who manages nobody must fail the TEAM
      // grant rather than silently satisfying the SELF one. `/requests/me` is
      // the route for reading one's own requests.
      ownerEmployeeId: view === 'all' ? null : (identity.managedEmployeeIds[0] ?? null),
    },
    intent: 'TEAM_LEAVE_REQUESTS',
    requestId: c.get('requestId'),
    metadata: { view },
  })

  const options = {
    ...(filters.status ? { statuses: [filters.status as LeaveStatus] } : {}),
    limit: page.limit,
    offset: page.offset,
  }
  const { items, total } =
    decision.ownership === 'ANY'
      ? await container.repos.leaveRequests.listAll(scopeOf(c), options)
      : await container.repos.leaveRequests.listForEmployees(
          scopeOf(c),
          identity.managedEmployeeIds,
          options,
        )
  return c.json(makePage(items, total, page))
})

leaveRoutes.post('/requests', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const body = parse(createBody, await readJsonBody(c))

  await container.gateway.require({
    identity,
    action: 'create',
    resource: {
      type: 'leave.request',
      tenantId: identity.tenantId,
      ownerEmployeeId: identity.employeeId,
    },
    intent: 'CREATE_LEAVE_REQUEST',
    requestId: c.get('requestId'),
  })

  const employeeId = identity.employeeId
  if (!employeeId) throw conflict('Your account is not linked to an employee record.')

  const employee = await orNotFound(container.repos.employees.findById(scope, employeeId), 'employee')
  const leaveType = await orNotFound(
    container.repos.leaveTypes.findById(scope, body.leaveTypeId),
    'leave type',
  )

  const year = Number(body.startDate.slice(0, 4))
  const [balance, holidays, existing] = await Promise.all([
    container.repos.leaveBalances.find(scope, employeeId, leaveType.id, year),
    container.repos.holidays.listBetween(scope, body.startDate, body.endDate),
    container.repos.leaveRequests.listOpenForEmployee(scope, employeeId),
  ])

  // Full deterministic validation, including the working-day computation.
  const validation = validateLeaveRequest({
    startDate: body.startDate,
    endDate: body.endDate,
    today: container.today,
    hireDate: employee.hireDate,
    employeeStatus: employee.status,
    leaveType,
    balance,
    holidays: holidays.map((h) => h.date),
    existingRequests: existing,
  })

  if (!validation.valid) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: validation.issues.map((i) => i.message).join(' '),
          details: { issues: validation.issues },
          requestId: c.get('requestId'),
        },
      },
      422,
    )
  }

  const request = await container.repos.leaveRequests.createWithReservation(scope, {
    employeeId,
    leaveTypeId: leaveType.id,
    startDate: body.startDate,
    endDate: body.endDate,
    workingDays: validation.chargeableDays,
    reason: body.reason ?? null,
    year,
    autoApprove: !leaveType.requiresApproval,
    approverUserId: leaveType.requiresApproval ? null : identity.userId,
  })

  return c.json(
    {
      request,
      breakdown: {
        totalDays: validation.breakdown?.totalDays ?? 0,
        weekendDays: validation.breakdown?.weekendDays ?? 0,
        holidayDays: validation.breakdown?.holidayDays ?? 0,
        chargeableDays: validation.chargeableDays,
        remainingAfter: validation.availableAfter,
      },
    },
    201,
  )
})

leaveRoutes.post('/requests/:id/cancel', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  const request = await container.repos.leaveRequests.findById(scope, id)
  // Shared with the cancel_leave_request tool, so both paths enforce the same
  // rule: approved leave that has already started is not refundable.
  const cancellable = request
    ? canCancelLeave(request, container.today)
    : { ok: false, reason: 'That leave request cannot be cancelled.' }

  await container.gateway.require({
    identity,
    action: 'delete',
    resource: {
      type: 'leave.request',
      id,
      tenantId: request?.tenantId ?? identity.tenantId,
      ownerEmployeeId: request?.employeeId ?? null,
    },
    intent: 'CANCEL_LEAVE_REQUEST',
    requestId: c.get('requestId'),
    businessRules: [
      {
        code: 'CANCELLABLE',
        message: cancellable.reason ?? 'That leave request cannot be cancelled.',
        satisfied: cancellable.ok,
      },
    ],
  })
  const loaded = await orNotFound(Promise.resolve(request), 'leave request')

  await container.repos.leaveRequests.cancel(scope, {
    requestId: loaded.id,
    employeeId: loaded.employeeId,
    leaveTypeId: loaded.leaveTypeId,
    workingDays: loaded.workingDays,
    year: Number(loaded.startDate.slice(0, 4)),
    previousStatus: loaded.status as 'PENDING' | 'APPROVED',
  })
  return c.json({ ok: true, daysReturned: loaded.workingDays })
})

for (const [path, decision] of [
  ['approve', 'APPROVED'],
  ['reject', 'REJECTED'],
] as const) {
  leaveRoutes.post(`/requests/:id/${path}`, async (c) => {
    const container = c.get('container')
    const identity = userIdentityOf(c)
    const scope = scopeOf(c)
    const id = c.req.param('id')
    const body = parse(decisionBody, await readJsonBody(c))

    const request = await container.repos.leaveRequests.findByIdDetailed(scope, id)

    await container.gateway.require({
      identity,
      action: decision === 'APPROVED' ? 'approve' : 'reject',
      resource: {
        type: 'leave.request',
        id,
        tenantId: request?.tenantId ?? identity.tenantId,
        ownerEmployeeId: request?.employeeId ?? null,
      },
      intent: decision === 'APPROVED' ? 'APPROVE_LEAVE_REQUEST' : 'REJECT_LEAVE_REQUEST',
      requestId: c.get('requestId'),
      businessRules: [
        {
          code: 'STATUS_PENDING',
          message: 'Only a pending request can be decided.',
          satisfied: request?.status === 'PENDING',
        },
        {
          // Separation of duties: nobody decides their own request.
          code: 'NOT_SELF',
          message: 'You cannot decide your own leave request.',
          satisfied: request ? request.employeeId !== identity.employeeId : false,
        },
      ],
    })
    const loaded = await orNotFound(Promise.resolve(request), 'leave request')

    await container.repos.leaveRequests.decide(scope, {
      requestId: loaded.id,
      employeeId: loaded.employeeId,
      leaveTypeId: loaded.leaveTypeId,
      workingDays: loaded.workingDays,
      year: Number(loaded.startDate.slice(0, 4)),
      decision,
      approverUserId: sessionUserIdOf(c),
      comment: body.comment ?? null,
    })
    return c.json({ ok: true, decision, requestId: loaded.id })
  })
}

export const holidayRoutes = new Hono<AppBindings>()

holidayRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  await container.gateway.require({
    identity,
    action: 'list',
    resource: { type: 'holiday', tenantId: identity.tenantId, classification: 'INTERNAL' },
    intent: 'HOLIDAYS',
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  const year = Number(c.req.query('year') ?? container.today.slice(0, 4))
  return c.json({ year, holidays: await container.repos.holidays.listForYear(scopeOf(c), year) })
})

holidayRoutes.post('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const body = parse(
    object({ date: dateOnly(), name: str({ min: 1, max: 120 }), region: optional(str({ max: 40 })) }),
    await readJsonBody(c),
  )
  await container.gateway.require({
    identity,
    action: 'create',
    resource: { type: 'holiday', tenantId: identity.tenantId },
    requestId: c.get('requestId'),
  })
  try {
    const holiday = await container.repos.holidays.create(scopeOf(c), {
      date: body.date,
      name: body.name,
      region: body.region ?? null,
    })
    return c.json({ holiday }, 201)
  } catch {
    throw conflict('A holiday already exists on that date.')
  }
})
