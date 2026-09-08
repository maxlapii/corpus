/**
 * Retention enforcement (CLAUDE.md §29).
 *
 * Reads `retention_policies` and prunes each table accordingly. Intended to run
 * on a Cloudflare Cron trigger in production; run manually in development.
 */

import { openLocalDb } from './local-db.js'

const local = await openLocalDb({ migrate: false })

const policies = await local.db.many<{ table_name: string; retain_days: number }>(
  'SELECT table_name, retain_days FROM retention_policies',
)

const cutoffFor = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

for (const policy of policies) {
  const cutoff = cutoffFor(policy.retain_days)
  let removed = 0
  switch (policy.table_name) {
    case 'audit_logs':
      removed = await local.repos.audit.pruneOlderThan(cutoff)
      break
    case 'security_events':
      removed = await local.repos.securityEvents.pruneOlderThan(cutoff)
      break
    case 'messages':
      removed = await local.repos.conversations.pruneMessagesOlderThan(cutoff)
      break
    case 'tool_calls':
      removed = (await local.db.run('DELETE FROM tool_calls WHERE created_at < ?', [cutoff])).meta.changes
      break
    case 'verification_codes':
      removed = await local.repos.verificationCodes.deleteExpired(cutoff)
      break
    case 'rate_limit_counters':
      removed = (
        await local.db.run('DELETE FROM rate_limit_counters WHERE expires_at < ?', [
          Math.floor(Date.now() / 1000),
        ])
      ).meta.changes
      break
    default:
      console.log(`  ! no pruner implemented for ${policy.table_name}`)
      continue
  }
  console.log(`  • ${policy.table_name}: removed ${removed} row(s) older than ${policy.retain_days}d`)
}

// Expired sessions are pruned unconditionally.
console.log(`  • sessions: removed ${await local.repos.sessions.deleteExpired(new Date().toISOString())} expired`)

local.close()
