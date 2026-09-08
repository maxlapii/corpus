/**
 * Reports and analytics (CLAUDE.md §33, §35).
 *
 * Everything here is aggregate. No report returns an individual salary, and
 * every endpoint requires `report.read`.
 */

import { makePage, object, optional, str } from '@corpus/shared'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { pageOf, parseQuery, scopeOf, userIdentityOf } from './helpers.js'

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

export const reportRoutes = new Hono<AppBindings>()

/** Authorise every report route the same way, once. */
reportRoutes.use('*', async (c, next) => {
  const container = c.get('container')
  await container.gateway.require({
    identity: userIdentityOf(c),
    action: 'read',
    resource: {
      type: 'report',
      tenantId: userIdentityOf(c).tenantId,
      classification: 'CONFIDENTIAL',
    },
    intent: 'REPORTING',
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  await next()
})

/** Dashboard KPI tiles. */
reportRoutes.get('/summary', async (c) => {
  const container = c.get('container')
  const scope = scopeOf(c)

  const [employees, jobs, candidates, applications, leave, documents] = await Promise.all([
    container.repos.employees.countByStatus(scope),
    container.repos.jobs.countByStatus(scope),
    container.repos.candidates.countAll(scope),
    container.repos.applications.countAll(scope),
    container.repos.leaveRequests.countByStatus(scope),
    container.repos.knowledge.countDocuments(scope),
  ])

  return c.json({
    employees: {
      active: employees.ACTIVE ?? 0,
      onLeave: employees.ON_LEAVE ?? 0,
      total: Object.values(employees).reduce((a, b) => a + b, 0),
    },
    jobs: { open: jobs.PUBLISHED ?? 0, draft: jobs.DRAFT ?? 0, closed: jobs.CLOSED ?? 0 },
    candidates,
    applications,
    leave: { pending: leave.PENDING ?? 0, approved: leave.APPROVED ?? 0 },
    hiresLast90Days: await container.repos.offers.countHiredSince(scope, sinceIso(90)),
    documents,
  })
})

reportRoutes.get('/headcount', async (c) => {
  const container = c.get('container')
  const scope = scopeOf(c)
  return c.json({
    byDepartment: await container.repos.employees.headcountByDepartment(scope),
    byStatus: await container.repos.employees.countByStatus(scope),
  })
})

reportRoutes.get('/recruitment', async (c) => {
  const container = c.get('container')
  const scope = scopeOf(c)
  return c.json({
    funnel: await container.repos.applications.funnel(scope),
    applicationsOverTime: await container.repos.applications.overTime(scope, sinceIso(90)),
    bySource: await container.repos.applications.bySource(scope),
  })
})

reportRoutes.get('/leave', async (c) => {
  const container = c.get('container')
  const scope = scopeOf(c)
  const year = Number(c.req.query('year') ?? container.today.slice(0, 4))
  return c.json({
    year,
    utilisation: await container.repos.leaveBalances.utilisationByType(scope, year),
    requestsByStatus: await container.repos.leaveRequests.countByStatus(scope),
  })
})

/** Bot analytics: volume, tool decisions, unanswered questions. */
reportRoutes.get('/bot', async (c) => {
  const container = c.get('container')
  const scope = scopeOf(c)
  const since = sinceIso(30)
  const unanswered = await container.repos.conversations.listUnanswered(scope, {
    resolved: false,
    limit: 10,
    offset: 0,
  })
  return c.json({
    questionVolume: await container.repos.conversations.questionVolume(scope, since),
    toolCalls: await container.repos.conversations.toolCallStats(scope, since),
    unansweredCount: unanswered.total,
    unanswered: unanswered.items,
    authorisationDecisions: await container.repos.audit.countByDecision(scope, since),
  })
})

reportRoutes.get('/unanswered', async (c) => {
  const container = c.get('container')
  const page = pageOf(c)
  const filters = parseQuery(c, object({ resolved: optional(str({ enum: ['true', 'false'] })) }))
  const { items, total } = await container.repos.conversations.listUnanswered(scopeOf(c), {
    ...(filters.resolved ? { resolved: filters.resolved === 'true' } : {}),
    limit: page.limit,
    offset: page.offset,
  })
  return c.json(makePage(items, total, page))
})

reportRoutes.post('/unanswered/:id/resolve', async (c) => {
  const container = c.get('container')
  // The blanket middleware above authorises a *read*. A state change needs its
  // own decision, and it is audited (maySkipAudit refuses to silence mutations).
  await container.gateway.require({
    identity: userIdentityOf(c),
    action: 'update',
    resource: {
      type: 'conversation',
      id: c.req.param('id'),
      tenantId: userIdentityOf(c).tenantId,
      classification: 'CONFIDENTIAL',
    },
    requestId: c.get('requestId'),
  })
  await container.repos.conversations.resolveUnanswered(scopeOf(c), c.req.param('id'))
  return c.json({ ok: true })
})

reportRoutes.get('/tickets', async (c) => {
  const container = c.get('container')
  const page = pageOf(c)
  const filters = parseQuery(
    c,
    object({ status: optional(str({ enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] })) }),
  )
  const { items, total } = await container.repos.conversations.listTickets(scopeOf(c), {
    ...(filters.status ? { status: filters.status as 'OPEN' } : {}),
    limit: page.limit,
    offset: page.offset,
  })
  return c.json(makePage(items, total, page))
})
