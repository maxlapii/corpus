/**
 * Conversation, tool-call and HR-ticket persistence (CLAUDE.md §29).
 *
 * Message content is stored truncated; retention is documented in
 * `retention_policies` and enforced by `scripts/prune.ts`.
 */

import { nowIso, prefixedId, truncate } from '@corpus/shared'
import type { Conversation, HrTicket, UnansweredQuestion } from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import type { TenantScope } from '../tenant.js'

const MAX_STORED_MESSAGE_CHARS = 4000

export class ConversationRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Find the most recent conversation for a channel+subject, or start one. */
  async findOrCreate(
    scope: TenantScope,
    input: {
      channel: string
      subjectKey: string
      userId: string | null
      candidateId: string | null
      /** Reuse a conversation only if it was active within this many minutes. */
      staleAfterMinutes?: number
    },
  ): Promise<Conversation> {
    const cutoff = new Date(
      Date.now() - (input.staleAfterMinutes ?? 120) * 60_000,
    ).toISOString()
    const existing = await this.db.one<Record<string, unknown>>(
      `SELECT * FROM conversations
        WHERE tenant_id = ? AND channel = ? AND subject_key = ? AND last_message_at >= ?
        ORDER BY last_message_at DESC LIMIT 1`,
      [scope.tenantId, input.channel, input.subjectKey, cutoff],
    )
    if (existing) return hydrateConversation(existing)

    const id = prefixedId('cnv')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO conversations
         (id, tenant_id, channel, subject_key, user_id, candidate_id, started_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, scope.tenantId, input.channel, input.subjectKey, input.userId, input.candidateId, ts, ts],
    )
    return {
      id,
      tenantId: scope.tenantId,
      channel: input.channel,
      subjectKey: input.subjectKey,
      userId: input.userId,
      candidateId: input.candidateId,
      startedAt: ts,
      lastMessageAt: ts,
    }
  }

  async appendMessage(
    scope: TenantScope,
    input: {
      conversationId: string
      role: 'user' | 'assistant' | 'system' | 'tool'
      content: string
      intent?: string | null
    },
  ): Promise<void> {
    const ts = nowIso()
    await this.db.transaction((uow) => {
      uow.add(
        `INSERT INTO messages (id, tenant_id, conversation_id, role, content, intent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          prefixedId('msg'),
          scope.tenantId,
          input.conversationId,
          input.role,
          truncate(input.content, MAX_STORED_MESSAGE_CHARS),
          input.intent ?? null,
          ts,
        ],
      )
      uow.add('UPDATE conversations SET last_message_at = ? WHERE tenant_id = ? AND id = ?', [
        ts,
        scope.tenantId,
        input.conversationId,
      ])
    })
  }

  /**
   * Recent turns for context. Bounded hard (CLAUDE.md §37): history is
   * truncated so a long conversation cannot inflate the prompt.
   */
  async recentMessages(
    scope: TenantScope,
    conversationId: string,
    limit: number,
  ): Promise<{ role: string; content: string; createdAt: string }[]> {
    const rows = await this.db.many<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at FROM messages
        WHERE tenant_id = ? AND conversation_id = ? AND role IN ('user','assistant')
        ORDER BY created_at DESC LIMIT ?`,
      [scope.tenantId, conversationId, limit],
    )
    return rows.reverse().map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }))
  }

  async recordToolCall(
    scope: TenantScope,
    input: {
      conversationId: string | null
      toolName: string
      decision: 'ALLOW' | 'DENY'
      reasonCode: string | null
      latencyMs: number | null
    },
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO tool_calls
         (id, tenant_id, conversation_id, tool_name, decision, reason_code, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prefixedId('tlc'),
        scope.tenantId,
        input.conversationId,
        input.toolName,
        input.decision,
        input.reasonCode,
        input.latencyMs,
        nowIso(),
      ],
    )
  }

  async recordUnanswered(
    scope: TenantScope,
    input: {
      conversationId: string | null
      question: string
      channel: string
      askedByUserId: string | null
    },
  ): Promise<string> {
    const id = prefixedId('unq')
    await this.db.run(
      `INSERT INTO unanswered_questions
         (id, tenant_id, conversation_id, question, channel, asked_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.conversationId,
        truncate(input.question, 1000),
        input.channel,
        input.askedByUserId,
        nowIso(),
      ],
    )
    return id
  }

  async listUnanswered(
    scope: TenantScope,
    options: { resolved?: boolean; limit: number; offset: number },
  ): Promise<{ items: UnansweredQuestion[]; total: number }> {
    const where = ['tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]
    if (options.resolved === true) where.push('resolved_at IS NOT NULL')
    if (options.resolved === false) where.push('resolved_at IS NULL')
    const clause = where.join(' AND ')
    const rows = await this.db.many<Record<string, unknown>>(
      `SELECT * FROM unanswered_questions WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM unanswered_questions WHERE ${clause}`,
      params,
    )
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        conversationId: r.conversation_id ? String(r.conversation_id) : null,
        question: String(r.question),
        channel: String(r.channel),
        askedByUserId: r.asked_by_user_id ? String(r.asked_by_user_id) : null,
        resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
        resolvedAnswerId: r.resolved_answer_id ? String(r.resolved_answer_id) : null,
        resolvedByUserId: r.resolved_by_user_id ? String(r.resolved_by_user_id) : null,
        createdAt: String(r.created_at),
      })),
      total,
    }
  }

  /** `answerId` links the gap to the curated answer that now covers it. */
  async resolveUnanswered(
    scope: TenantScope,
    id: string,
    link: { answerId?: string | null; actorUserId?: string | null } = {},
  ): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE unanswered_questions
          SET resolved_at = ?, resolved_answer_id = ?, resolved_by_user_id = ?
        WHERE tenant_id = ? AND id = ?`,
      [nowIso(), link.answerId ?? null, link.actorUserId ?? null, scope.tenantId, id],
    )
    return result.meta.changes === 1
  }

  async createTicket(
    scope: TenantScope,
    input: { subject: string; body: string; raisedByUserId: string | null },
  ): Promise<HrTicket> {
    const id = prefixedId('tkt')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO hr_tickets (id, tenant_id, subject, body, raised_by_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
      [
        id,
        scope.tenantId,
        truncate(input.subject, 200),
        truncate(input.body, 4000),
        input.raisedByUserId,
        ts,
        ts,
      ],
    )
    return {
      id,
      tenantId: scope.tenantId,
      subject: input.subject,
      body: input.body,
      raisedByUserId: input.raisedByUserId,
      status: 'OPEN',
      createdAt: ts,
      updatedAt: ts,
    }
  }

  async listTickets(
    scope: TenantScope,
    options: { status?: HrTicket['status']; limit: number; offset: number },
  ): Promise<{ items: HrTicket[]; total: number }> {
    const where = ['tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]
    if (options.status) {
      where.push('status = ?')
      params.push(options.status)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Record<string, unknown>>(
      `SELECT * FROM hr_tickets WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM hr_tickets WHERE ${clause}`, params)
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        subject: String(r.subject),
        body: String(r.body),
        raisedByUserId: r.raised_by_user_id ? String(r.raised_by_user_id) : null,
        status: String(r.status) as HrTicket['status'],
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      })),
      total,
    }
  }

  /** Bot analytics for the dashboard: volume and denial rate by tool. */
  async toolCallStats(
    scope: TenantScope,
    since: string,
  ): Promise<{ toolName: string; allowed: number; denied: number }[]> {
    const rows = await this.db.many<{ tool_name: string; decision: string; c: number }>(
      `SELECT tool_name, decision, COUNT(*) AS c FROM tool_calls
        WHERE tenant_id = ? AND created_at >= ? GROUP BY tool_name, decision`,
      [scope.tenantId, since],
    )
    const map = new Map<string, { toolName: string; allowed: number; denied: number }>()
    for (const r of rows) {
      const entry = map.get(r.tool_name) ?? { toolName: r.tool_name, allowed: 0, denied: 0 }
      if (r.decision === 'ALLOW') entry.allowed += Number(r.c)
      else entry.denied += Number(r.c)
      map.set(r.tool_name, entry)
    }
    return [...map.values()].sort((a, b) => b.allowed + b.denied - (a.allowed + a.denied))
  }

  async questionVolume(scope: TenantScope, since: string): Promise<{ day: string; count: number }[]> {
    const rows = await this.db.many<{ day: string; c: number }>(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c FROM messages
        WHERE tenant_id = ? AND role = 'user' AND created_at >= ?
        GROUP BY day ORDER BY day`,
      [scope.tenantId, since],
    )
    return rows.map((r) => ({ day: r.day, count: Number(r.c) }))
  }

  async pruneMessagesOlderThan(before: string): Promise<number> {
    const res = await this.db.run('DELETE FROM messages WHERE created_at < ?', [before])
    return res.meta.changes
  }
}

function hydrateConversation(r: Record<string, unknown>): Conversation {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    channel: String(r.channel),
    subjectKey: String(r.subject_key),
    userId: r.user_id ? String(r.user_id) : null,
    candidateId: r.candidate_id ? String(r.candidate_id) : null,
    startedAt: String(r.started_at),
    lastMessageAt: String(r.last_message_at),
  }
}
