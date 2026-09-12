/**
 * Half-finished applications from the recruitment bot.
 *
 * A draft is scratch space for a conversation, not a record of anybody: the
 * values are unvalidated, nothing is bound to an identity, and holding one
 * grants nothing. It becomes real only when `submit_application` runs and the
 * PolicyGateway allows it.
 */

import { nowIso } from '@corpus/shared'
import type { DatabaseService } from '../database-service.js'
import type { TenantScope } from '../tenant.js'
import { asString, asStringOrNull, type Row } from './mappers.js'

export interface ApplicationDraft {
  telegramUserId: string
  jobCode: string | null
  fullName: string | null
  email: string | null
  updatedAt: string
}

/** Beyond this a "draft" is someone who wandered off, not a conversation. */
export const DRAFT_TTL_MINUTES = 60

const mapDraft = (row: Row): ApplicationDraft => ({
  telegramUserId: asString(row.telegram_user_id),
  jobCode: asStringOrNull(row.job_code),
  fullName: asStringOrNull(row.full_name),
  email: asStringOrNull(row.email),
  updatedAt: asString(row.updated_at),
})

export class ApplicationDraftRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Null once the draft is older than the TTL, so a stale one never resumes. */
  async find(scope: TenantScope, telegramUserId: string): Promise<ApplicationDraft | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM application_drafts WHERE tenant_id = ? AND telegram_user_id = ?',
      [scope.tenantId, telegramUserId],
    )
    if (!row) return null

    const draft = mapDraft(row)
    const ageMs = Date.now() - Date.parse(draft.updatedAt)
    if (Number.isFinite(ageMs) && ageMs > DRAFT_TTL_MINUTES * 60_000) return null
    return draft
  }

  /** Merge the fields supplied so far; absent ones keep their value. */
  async upsert(
    scope: TenantScope,
    telegramUserId: string,
    patch: { jobCode?: string | null; fullName?: string | null; email?: string | null },
  ): Promise<ApplicationDraft> {
    const existing = await this.find(scope, telegramUserId)
    const merged = {
      jobCode: patch.jobCode ?? existing?.jobCode ?? null,
      fullName: patch.fullName ?? existing?.fullName ?? null,
      email: patch.email ?? existing?.email ?? null,
    }
    const ts = nowIso()

    await this.db.run(
      `INSERT INTO application_drafts
         (tenant_id, telegram_user_id, job_code, full_name, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, telegram_user_id) DO UPDATE SET
         job_code = excluded.job_code,
         full_name = excluded.full_name,
         email = excluded.email,
         updated_at = excluded.updated_at`,
      [scope.tenantId, telegramUserId, merged.jobCode, merged.fullName, merged.email, ts, ts],
    )
    return { telegramUserId, ...merged, updatedAt: ts }
  }

  async clear(scope: TenantScope, telegramUserId: string): Promise<void> {
    await this.db.run(
      'DELETE FROM application_drafts WHERE tenant_id = ? AND telegram_user_id = ?',
      [scope.tenantId, telegramUserId],
    )
  }
}
