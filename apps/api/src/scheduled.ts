/**
 * Scheduled maintenance (CLAUDE.md §29).
 *
 * `retention_policies` declares how long each table is kept; without something
 * that acts on it, the declaration is decorative and audit/conversation data
 * grows without bound — which also works against the free-tier D1 row budget.
 *
 * Runs on a Cloudflare Cron trigger. Every statement is bounded and idempotent,
 * so a missed or repeated run is harmless.
 */

import { nowIso, type Logger } from '@corpus/shared'
import type { DatabaseService, Repositories } from '@corpus/db'

export interface RetentionOutcome {
  table: string
  retainDays: number
  removed: number
}

const cutoff = (days: number, now: number): string =>
  new Date(now - days * 86_400_000).toISOString()

/**
 * Apply every declared retention policy. Unknown table names are reported
 * rather than ignored, so adding a policy row without a pruner is visible.
 */
export async function applyRetention(
  db: DatabaseService,
  repos: Repositories,
  logger: Logger,
  now: number = Date.now(),
): Promise<RetentionOutcome[]> {
  const policies = await db.many<{ table_name: string; retain_days: number }>(
    'SELECT table_name, retain_days FROM retention_policies',
  )

  const outcomes: RetentionOutcome[] = []

  for (const policy of policies) {
    const retainDays = Number(policy.retain_days)
    const before = cutoff(retainDays, now)
    let removed = 0

    switch (policy.table_name) {
      case 'audit_logs':
        removed = await repos.audit.pruneOlderThan(before)
        break
      case 'security_events':
        removed = await repos.securityEvents.pruneOlderThan(before)
        break
      case 'messages':
        removed = await repos.conversations.pruneMessagesOlderThan(before)
        break
      case 'tool_calls':
        removed = (await db.run('DELETE FROM tool_calls WHERE created_at < ?', [before])).meta.changes
        break
      case 'verification_codes':
        // One-time codes are useless once expired; delete on expiry, not age.
        removed = await repos.verificationCodes.deleteExpired(nowIso())
        break
      case 'application_drafts':
        // Unvalidated personal data from a conversation nobody finished.
        removed = (
          await db.run('DELETE FROM application_drafts WHERE updated_at < ?', [before])
        ).meta.changes
        break
      case 'rate_limit_counters':
        removed = (
          await db.run('DELETE FROM rate_limit_counters WHERE expires_at < ?', [
            Math.floor(now / 1000),
          ])
        ).meta.changes
        break
      default:
        logger.warn('retention policy has no pruner', {
          action: 'maintenance.retention',
          result: 'no_pruner',
          table: policy.table_name,
        })
        continue
    }

    outcomes.push({ table: policy.table_name, retainDays, removed })
  }

  // Expired sessions are always pruned: they are unusable and unbounded.
  const sessions = await repos.sessions.deleteExpired(nowIso())
  outcomes.push({ table: 'sessions', retainDays: 0, removed: sessions })

  // Orphaned conversations left behind once their messages have aged out.
  const conversations = await db.run(
    `DELETE FROM conversations
      WHERE last_message_at < ?
        AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)`,
    [cutoff(90, now)],
  )
  outcomes.push({ table: 'conversations', retainDays: 90, removed: conversations.meta.changes })

  logger.info('retention applied', {
    action: 'maintenance.retention',
    result: 'ok',
    removed: outcomes.reduce((total, o) => total + o.removed, 0),
    tables: outcomes.length,
  })

  return outcomes
}
