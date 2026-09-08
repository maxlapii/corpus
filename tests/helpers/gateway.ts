/** Builds a PolicyGateway backed by an in-memory audit sink. */

import { nullLogger } from '@corpus/shared'
import type { AuditEntry, SecurityEventInput } from '@corpus/db'
import { PolicyGateway, SecurityEventService } from '@corpus/security'

export interface GatewayHarness {
  gateway: PolicyGateway
  auditEntries: AuditEntry[]
  securityEvents: SecurityEventInput[]
  reset(): void
}

export function createGatewayHarness(): GatewayHarness {
  const auditEntries: AuditEntry[] = []
  const securityEvents: SecurityEventInput[] = []

  const auditRepo = {
    record: async (entry: AuditEntry) => {
      auditEntries.push(entry)
      return `aud_${auditEntries.length}`
    },
  }
  const securityRepo = {
    record: async (input: SecurityEventInput) => {
      securityEvents.push(input)
      return `sev_${securityEvents.length}`
    },
  }

  const gateway = new PolicyGateway({
    audit: auditRepo as never,
    securityEvents: new SecurityEventService(securityRepo as never, nullLogger),
    logger: nullLogger,
  })

  return {
    gateway,
    auditEntries,
    securityEvents,
    reset: () => {
      auditEntries.length = 0
      securityEvents.length = 0
    },
  }
}
