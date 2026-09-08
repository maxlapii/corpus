/**
 * Audit and security-event repositories (CLAUDE.md §28).
 *
 * Append-only by construction: no update or delete method is exposed other
 * than the retention pruner and security-event acknowledgement.
 */

import { nowIso, prefixedId, redact } from '@corpus/shared'
import type {
  AuditDecision,
  DenyReason,
  RiskLevel,
  SecurityEventType,
  SecuritySeverity,
} from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import type { TenantScope } from '../tenant.js'

export interface AuditEntry {
  tenantId: string | null
  userId?: string | null
  telegramId?: string | null
  channel: string
  bot?: string | null
  intent?: string | null
  resource: string
  resourceId?: string | null
  action: string
  decision: AuditDecision
  reasonCode?: DenyReason | string | null
  risk?: RiskLevel | null
  source?: string | null
  requestId?: string | null
  metadata?: Record<string, unknown>
}

export interface AuditRecord extends AuditEntry {
  id: string
  timestamp: string
}

export class AuditRepository {
  constructor(private readonly db: DatabaseService) {}

  async record(entry: AuditEntry): Promise<string> {
    const id = prefixedId('aud')
    // Metadata is redacted before storage: audit rows must never carry secrets,
    // verification codes or full document content (CLAUDE.md §29, §47).
    const metadata = entry.metadata ? JSON.stringify(redact(entry.metadata)).slice(0, 4000) : null
    await this.db.run(
      `INSERT INTO audit_logs
         (id, timestamp, tenant_id, user_id, telegram_id, channel, bot, intent, resource,
          resource_id, action, decision, reason_code, risk, source, request_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        nowIso(),
        entry.tenantId,
        entry.userId ?? null,
        entry.telegramId ?? null,
        entry.channel,
        entry.bot ?? null,
        entry.intent ?? null,
        entry.resource,
        entry.resourceId ?? null,
        entry.action,
        entry.decision,
        entry.reasonCode ?? null,
        entry.risk ?? null,
        entry.source ?? null,
        entry.requestId ?? null,
        metadata,
      ],
    )
    return id
  }

  async list(
    scope: TenantScope,
    filters: {
      decision?: AuditDecision
      resource?: string
      userId?: string
      since?: string
      limit: number
      offset: number
    },
  ): Promise<{ items: AuditRecord[]; total: number }> {
    const where = ['tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]
    if (filters.decision) {
      where.push('decision = ?')
      params.push(filters.decision)
    }
    if (filters.resource) {
      where.push('resource = ?')
      params.push(filters.resource)
    }
    if (filters.userId) {
      where.push('user_id = ?')
      params.push(filters.userId)
    }
    if (filters.since) {
      where.push('timestamp >= ?')
      params.push(filters.since)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Record<string, unknown>>(
      `SELECT * FROM audit_logs WHERE ${clause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
    )
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM audit_logs WHERE ${clause}`, params)
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        timestamp: String(r.timestamp),
        tenantId: r.tenant_id ? String(r.tenant_id) : null,
        userId: r.user_id ? String(r.user_id) : null,
        telegramId: r.telegram_id ? String(r.telegram_id) : null,
        channel: String(r.channel),
        bot: r.bot ? String(r.bot) : null,
        intent: r.intent ? String(r.intent) : null,
        resource: String(r.resource),
        resourceId: r.resource_id ? String(r.resource_id) : null,
        action: String(r.action),
        decision: String(r.decision) as AuditDecision,
        reasonCode: r.reason_code ? String(r.reason_code) : null,
        risk: r.risk ? (String(r.risk) as RiskLevel) : null,
        source: r.source ? String(r.source) : null,
        requestId: r.request_id ? String(r.request_id) : null,
        metadata: r.metadata ? safeJson(String(r.metadata)) : undefined,
      })),
      total,
    }
  }

  async countByDecision(scope: TenantScope, since: string): Promise<Record<string, number>> {
    const rows = await this.db.many<{ decision: string; c: number }>(
      `SELECT decision, COUNT(*) AS c FROM audit_logs
        WHERE tenant_id = ? AND timestamp >= ? GROUP BY decision`,
      [scope.tenantId, since],
    )
    return Object.fromEntries(rows.map((r) => [r.decision, Number(r.c)]))
  }

  async pruneOlderThan(before: string): Promise<number> {
    const res = await this.db.run('DELETE FROM audit_logs WHERE timestamp < ?', [before])
    return res.meta.changes
  }
}

export interface SecurityEventInput {
  tenantId: string | null
  eventType: SecurityEventType
  severity: SecuritySeverity
  userId?: string | null
  telegramId?: string | null
  subjectKey?: string | null
  channel: string
  summary: string
  detail?: Record<string, unknown>
  requestId?: string | null
}

export interface SecurityEventRecord {
  id: string
  timestamp: string
  tenantId: string | null
  eventType: SecurityEventType
  severity: SecuritySeverity
  userId: string | null
  telegramId: string | null
  subjectKey: string | null
  channel: string
  summary: string
  detail: Record<string, unknown> | null
  acknowledgedAt: string | null
}

export class SecurityEventRepository {
  constructor(private readonly db: DatabaseService) {}

  async record(input: SecurityEventInput): Promise<string> {
    const id = prefixedId('sev')
    const detail = input.detail ? JSON.stringify(redact(input.detail)).slice(0, 4000) : null
    await this.db.run(
      `INSERT INTO security_events
         (id, timestamp, tenant_id, event_type, severity, user_id, telegram_id, subject_key,
          channel, summary, detail, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        nowIso(),
        input.tenantId,
        input.eventType,
        input.severity,
        input.userId ?? null,
        input.telegramId ?? null,
        input.subjectKey ?? null,
        input.channel,
        input.summary.slice(0, 500),
        detail,
        input.requestId ?? null,
      ],
    )
    return id
  }

  async list(
    scope: TenantScope,
    filters: {
      eventType?: SecurityEventType
      severity?: SecuritySeverity
      since?: string
      unacknowledgedOnly?: boolean
      limit: number
      offset: number
    },
  ): Promise<{ items: SecurityEventRecord[]; total: number }> {
    const where = ['tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]
    if (filters.eventType) {
      where.push('event_type = ?')
      params.push(filters.eventType)
    }
    if (filters.severity) {
      where.push('severity = ?')
      params.push(filters.severity)
    }
    if (filters.since) {
      where.push('timestamp >= ?')
      params.push(filters.since)
    }
    if (filters.unacknowledgedOnly) where.push('acknowledged_at IS NULL')

    const clause = where.join(' AND ')
    const rows = await this.db.many<Record<string, unknown>>(
      `SELECT * FROM security_events WHERE ${clause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM security_events WHERE ${clause}`,
      params,
    )
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        timestamp: String(r.timestamp),
        tenantId: r.tenant_id ? String(r.tenant_id) : null,
        eventType: String(r.event_type) as SecurityEventType,
        severity: String(r.severity) as SecuritySeverity,
        userId: r.user_id ? String(r.user_id) : null,
        telegramId: r.telegram_id ? String(r.telegram_id) : null,
        subjectKey: r.subject_key ? String(r.subject_key) : null,
        channel: String(r.channel),
        summary: String(r.summary),
        detail: r.detail ? safeJson(String(r.detail)) : null,
        acknowledgedAt: r.acknowledged_at ? String(r.acknowledged_at) : null,
      })),
      total,
    }
  }

  async acknowledge(scope: TenantScope, id: string, userId: string): Promise<void> {
    await this.db.run(
      `UPDATE security_events SET acknowledged_at = ?, acknowledged_by = ?
        WHERE tenant_id = ? AND id = ? AND acknowledged_at IS NULL`,
      [nowIso(), userId, scope.tenantId, id],
    )
  }

  async countByType(scope: TenantScope, since: string): Promise<{ eventType: string; count: number }[]> {
    const rows = await this.db.many<{ event_type: string; c: number }>(
      `SELECT event_type, COUNT(*) AS c FROM security_events
        WHERE tenant_id = ? AND timestamp >= ? GROUP BY event_type ORDER BY c DESC`,
      [scope.tenantId, since],
    )
    return rows.map((r) => ({ eventType: r.event_type, count: Number(r.c) }))
  }

  async pruneOlderThan(before: string): Promise<number> {
    const res = await this.db.run('DELETE FROM security_events WHERE timestamp < ?', [before])
    return res.meta.changes
  }
}

function safeJson(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
