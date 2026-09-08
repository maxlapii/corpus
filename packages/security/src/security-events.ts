/**
 * Security event recording (CLAUDE.md §28).
 *
 * A thin service over the repository so every emitter goes through the same
 * severity defaults and redaction, and so failures to record never break the
 * request that triggered them.
 */

import { type Logger } from '@corpus/shared'
import {
  DEFAULT_SEVERITY,
  type SecurityEventType,
  type SecuritySeverity,
} from '@corpus/domain'
import type { SecurityEventRepository } from '@corpus/db'

export interface RecordSecurityEventInput {
  tenantId: string | null
  eventType: SecurityEventType
  /** Defaults to the type's standard severity. */
  severity?: SecuritySeverity
  userId?: string | null
  telegramId?: string | null
  subjectKey?: string | null
  channel: string
  summary: string
  detail?: Record<string, unknown>
  requestId?: string | null
}

export class SecurityEventService {
  constructor(
    private readonly repo: SecurityEventRepository,
    private readonly logger: Logger,
  ) {}

  async record(input: RecordSecurityEventInput): Promise<string | null> {
    const severity = input.severity ?? DEFAULT_SEVERITY[input.eventType]
    try {
      const id = await this.repo.record({
        tenantId: input.tenantId,
        eventType: input.eventType,
        severity,
        userId: input.userId ?? null,
        telegramId: input.telegramId ?? null,
        subjectKey: input.subjectKey ?? null,
        channel: input.channel,
        summary: input.summary,
        detail: input.detail,
        requestId: input.requestId ?? null,
      })
      this.logger.warn('security event', {
        action: 'security.event',
        errorCode: input.eventType,
        result: severity,
        tenantId: input.tenantId ?? undefined,
        requestId: input.requestId ?? undefined,
      })
      return id
    } catch (e) {
      // Never let telemetry failure change the outcome of a request; the
      // authorisation decision itself has already been made.
      this.logger.error('failed to persist security event', {
        action: 'security.event',
        errorCode: input.eventType,
        error: e instanceof Error ? e.message : String(e),
      })
      return null
    }
  }
}
