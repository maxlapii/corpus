/**
 * Employee routes (CLAUDE.md §35).
 *
 *   GET  /employees            — scoped by permission (team vs all)
 *   GET  /employees/me
 *   GET  /employees/:id
 *   POST /employees
 *   PUT  /employees/:id
 *   GET  /employees/:id/compensation  — RESTRICTED
 *   GET  /departments
 *   GET  /positions
 *
 * Every handler asks the PolicyGateway first, and uses the decision's scope to
 * shape the query rather than filtering afterwards.
 */

import {
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
import { isUniqueViolation } from '@corpus/db'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { readJsonBody } from '../middleware/body.js'
import { identityOf, orNotFound, pageOf, parseQuery, scopeOf, userIdentityOf } from './helpers.js'

const searchQuery = object({
  query: optional(str({ max: 100 })),
  departmentId: optional(str({ max: 40 })),
  status: optional(str({ enum: ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'] })),
})

const createBody = object({
  employeeNo: str({ min: 1, max: 40 }),
  firstName: str({ min: 1, max: 80 }),
  lastName: str({ min: 1, max: 80 }),
  email: emailValidator(),
  phone: optional(str({ max: 40 })),
  departmentId: optional(str({ max: 40 })),
  positionId: optional(str({ max: 40 })),
  managerId: optional(str({ max: 40 })),
  hireDate: dateOnly(),
  employmentType: str({ enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] }),
})

const updateBody = object({
  firstName: optional(str({ min: 1, max: 80 })),
  lastName: optional(str({ min: 1, max: 80 })),
  phone: optional(str({ max: 40 })),
  departmentId: optional(str({ max: 40 })),
  positionId: optional(str({ max: 40 })),
  managerId: optional(str({ max: 40 })),
  employmentType: optional(str({ enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] })),
  status: optional(str({ enum: ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'] })),
})

const compensationBody = object({
  baseSalary: num({ min: 0, max: 100_000_000 }),
  currency: str({ min: 3, max: 3 }),
  effectiveFrom: dateOnly(),
})

export const employeeRoutes = new Hono<AppBindings>()

employeeRoutes.get('/me', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)

  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'employee',
      tenantId: identity.tenantId,
      ownerEmployeeId: identity.employeeId,
      classification: 'INTERNAL',
    },
    intent: 'MY_PROFILE',
    requestId: c.get('requestId'),
  })

  if (!identity.employeeId) {
    return c.json({ employee: null, note: 'This account is not linked to an employee record.' })
  }
  const employee = await orNotFound(
    container.repos.employees.findById(scope, identity.employeeId),
    'employee',
  )
  return c.json({ employee })
})

employeeRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const filters = parseQuery(c, searchQuery)
  const page = pageOf(c)

  const decision = await container.gateway.require({
    identity,
    action: 'search',
    resource: {
      type: 'employee',
      tenantId: identity.tenantId,
      // The probe target is the caller's first direct report, so a MANAGER
      // satisfies the TEAM grant and an HR user satisfies the ANY grant.
      ownerEmployeeId: identity.managedEmployeeIds[0] ?? identity.employeeId,
      classification: 'INTERNAL',
    },
    intent: 'EMPLOYEE_DIRECTORY',
    requestId: c.get('requestId'),
  })

  // The gateway tells us *which* grant was used; the query is narrowed to match.
  const restrictToIds =
    decision.ownership === 'ANY' ? undefined : identity.managedEmployeeIds

  const { items, total } = await container.repos.employees.search(
    scope,
    {
      ...(filters.query ? { query: filters.query } : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.status ? { status: filters.status as 'ACTIVE' } : {}),
      ...(restrictToIds ? { restrictToIds } : {}),
    },
    page.limit,
    page.offset,
  )
  return c.json(makePage(items, total, page))
})

employeeRoutes.get('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  // Load first so ownership is decided from the stored row, then authorise.
  // A missing row still goes through the gateway, so probing ids is audited.
  const employee = await container.repos.employees.findById(scope, id)
  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'employee',
      id,
      tenantId: employee?.tenantId ?? identity.tenantId,
      ownerEmployeeId: employee?.id ?? id,
      classification: 'INTERNAL',
    },
    intent: 'EMPLOYEE_PROFILE',
    requestId: c.get('requestId'),
  })

  return c.json({ employee: await orNotFound(Promise.resolve(employee), 'employee') })
})

employeeRoutes.post('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const body = parse(createBody, await readJsonBody(c))

  await container.gateway.require({
    identity,
    action: 'create',
    resource: { type: 'employee', tenantId: identity.tenantId, classification: 'INTERNAL' },
    requestId: c.get('requestId'),
    metadata: { employeeNo: body.employeeNo },
  })

  try {
    const employee = await container.repos.employees.create(scope, {
      employeeNo: body.employeeNo,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone ?? null,
      departmentId: body.departmentId ?? null,
      positionId: body.positionId ?? null,
      managerId: body.managerId ?? null,
      hireDate: body.hireDate,
      employmentType: body.employmentType as 'FULL_TIME',
    })
    return c.json({ employee }, 201)
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw conflict('An employee with that number or e-mail already exists.')
    }
    throw e
  }
})

employeeRoutes.put('/:id', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(updateBody, await readJsonBody(c))

  const existing = await container.repos.employees.findById(scope, id)
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'employee',
      id,
      tenantId: existing?.tenantId ?? identity.tenantId,
      ownerEmployeeId: existing?.id ?? id,
      classification: 'INTERNAL',
    },
    requestId: c.get('requestId'),
  })
  await orNotFound(Promise.resolve(existing), 'employee')

  const employee = await container.repos.employees.update(scope, id, {
    ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
    ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
    ...(body.positionId !== undefined ? { positionId: body.positionId } : {}),
    ...(body.managerId !== undefined ? { managerId: body.managerId } : {}),
    ...(body.employmentType !== undefined ? { employmentType: body.employmentType as 'FULL_TIME' } : {}),
    ...(body.status !== undefined ? { status: body.status as 'ACTIVE' } : {}),
  })
  return c.json({ employee })
})

/**
 * Compensation — RESTRICTED (CLAUDE.md §9).
 *
 * A separate route and a separate resource type, so no employee read can ever
 * include salary by accident, and the gateway blocks it on chat channels.
 */
employeeRoutes.get('/:id/compensation', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')

  const employee = await container.repos.employees.findById(scope, id)
  await container.gateway.require({
    identity,
    action: 'read',
    resource: {
      type: 'employee.compensation',
      id,
      tenantId: employee?.tenantId ?? identity.tenantId,
      ownerEmployeeId: employee?.id ?? id,
      classification: 'RESTRICTED',
    },
    intent: 'EMPLOYEE_SALARY',
    requestId: c.get('requestId'),
  })
  await orNotFound(Promise.resolve(employee), 'employee')

  const compensation = await container.repos.compensation.currentForEmployee(
    scope,
    id,
    container.today,
  )
  return c.json({ compensation })
})

employeeRoutes.put('/:id/compensation', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const scope = scopeOf(c)
  const id = c.req.param('id')
  const body = parse(compensationBody, await readJsonBody(c))

  const employee = await container.repos.employees.findById(scope, id)
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'employee.compensation',
      id,
      tenantId: employee?.tenantId ?? identity.tenantId,
      ownerEmployeeId: employee?.id ?? id,
      classification: 'RESTRICTED',
    },
    requestId: c.get('requestId'),
  })
  await orNotFound(Promise.resolve(employee), 'employee')

  await container.repos.compensation.upsert(scope, {
    employeeId: id,
    baseSalary: body.baseSalary,
    currency: body.currency.toUpperCase(),
    effectiveFrom: body.effectiveFrom,
    createdBy: identity.userId,
  })
  return c.json({ ok: true })
})

export const orgRoutes = new Hono<AppBindings>()

orgRoutes.get('/departments', async (c) => {
  const container = c.get('container')
  await container.gateway.require({
    identity: identityOf(c),
    action: 'list',
    resource: { type: 'department', tenantId: identityOf(c).tenantId },
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  return c.json({ departments: await container.repos.departments.list(scopeOf(c)) })
})

orgRoutes.get('/positions', async (c) => {
  const container = c.get('container')
  await container.gateway.require({
    identity: identityOf(c),
    action: 'list',
    resource: { type: 'position', tenantId: identityOf(c).tenantId },
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  return c.json({ positions: await container.repos.positions.list(scopeOf(c)) })
})
