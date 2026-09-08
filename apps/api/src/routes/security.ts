/**
 * Audit and security-event routes (CLAUDE.md §28, §35).
 *
 * Read-only for HR_ADMIN / SYSTEM_ADMIN. The audit trail itself is append-only;
 * there is no route that mutates a past decision.
 */

import { makePage, object, optional, str } from '@corpus/shared'
import type { AuditDecision, SecurityEventType, SecuritySeverity } from '@corpus/domain'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { pageOf, parseQuery, scopeOf, sessionUserIdOf, userIdentityOf } from './helpers.js'

export const auditRoutes = new Hono<AppBindings>()

auditRoutes.get('/', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(
    c,
    object({
      decision: optional(str({ enum: ['ALLOW', 'DENY', 'ERROR'] })),
      resource: optional(str({ max: 60 })),
      userId: optional(str({ max: 40 })),
      since: optional(str({ max: 40 })),
    }),
  )

  await container.gateway.require({
    identity,
    action: 'read',
    resource: { type: 'audit', tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    requestId: c.get('requestId'),
    // Reading the audit trail is itself audited, so no skipAudit here.
  })

  const { items, total } = await container.repos.audit.list(scopeOf(c), {
    ...(filters.decision ? { decision: filters.decision as AuditDecision } : {}),
    ...(filters.resource ? { resource: filters.resource } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.since ? { since: filters.since } : {}),
    limit: page.limit,
    offset: page.offset,
  })
  return c.json(makePage(items, total, page))
})

export const securityRoutes = new Hono<AppBindings>()

securityRoutes.get('/events', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  const page = pageOf(c)
  const filters = parseQuery(
    c,
    object({
      eventType: optional(str({ max: 40 })),
      severity: optional(str({ enum: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })),
      since: optional(str({ max: 40 })),
      unacknowledgedOnly: optional(str({ enum: ['true', 'false'] })),
    }),
  )

  await container.gateway.require({
    identity,
    action: 'read',
    resource: { type: 'security.event', tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    requestId: c.get('requestId'),
  })

  const { items, total } = await container.repos.securityEvents.list(scopeOf(c), {
    ...(filters.eventType ? { eventType: filters.eventType as SecurityEventType } : {}),
    ...(filters.severity ? { severity: filters.severity as SecuritySeverity } : {}),
    ...(filters.since ? { since: filters.since } : {}),
    ...(filters.unacknowledgedOnly === 'true' ? { unacknowledgedOnly: true } : {}),
    limit: page.limit,
    offset: page.offset,
  })
  return c.json(makePage(items, total, page))
})

securityRoutes.get('/events/summary', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  await container.gateway.require({
    identity,
    action: 'read',
    resource: { type: 'security.event', tenantId: identity.tenantId, classification: 'CONFIDENTIAL' },
    requestId: c.get('requestId'),
    skipAudit: true,
  })
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  return c.json({
    byType: await container.repos.securityEvents.countByType(scopeOf(c), since),
    authorisation: await container.repos.audit.countByDecision(scopeOf(c), since),
  })
})

securityRoutes.post('/events/:id/acknowledge', async (c) => {
  const container = c.get('container')
  const identity = userIdentityOf(c)
  await container.gateway.require({
    identity,
    action: 'update',
    resource: {
      type: 'security.event',
      id: c.req.param('id'),
      tenantId: identity.tenantId,
      classification: 'CONFIDENTIAL',
    },
    requestId: c.get('requestId'),
  })
  await container.repos.securityEvents.acknowledge(scopeOf(c), c.req.param('id'), sessionUserIdOf(c))
  return c.json({ ok: true })
})
