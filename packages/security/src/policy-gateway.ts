/**
 * The single authorisation authority (CLAUDE.md §11), evaluated in the order
 * the spec gives: tenant → zone → intent → risk → permission → ownership →
 * classification → business rules → ALLOW/DENY → audit.
 *
 * The AI can request an operation. Only this class decides.
 */

import { forbidden, type Logger } from '@corpus/shared'
import {
  classificationCovers,
  classificationsUpTo,
  DENY_MESSAGES,
  INTENT_DEFINITIONS,
  isIntentAllowedInZone,
  maxReadableClassification,
  type Action,
  type Classification,
  type DenyReason,
  type Identity,
  type Intent,
  type Permission,
  type ResourceRef,
  type RiskLevel,
} from '@corpus/domain'
import type { AuditRepository } from '@corpus/db'
import { findRule, type Grant, type Ownership, type PolicyRule } from './policy-rules.js'
import type { SecurityEventService } from './security-events.js'

export interface AuthorizationRequest {
  identity: Identity
  action: Action
  resource: ResourceRef
  intent?: Intent
  businessRules?: readonly BusinessRule[]
  requestId?: string
  metadata?: Record<string, unknown>
  /**
   * Request that no audit row be written. Honoured only for genuinely
   * low-sensitivity read pre-checks — see `maySkipAudit`. A mutation, or a read of
   * a CONFIDENTIAL/RESTRICTED resource, is always audited regardless.
   */
  skipAudit?: boolean
}

export interface BusinessRule {
  code: string
  message: string
  satisfied: boolean
}

export interface AllowDecision {
  allowed: true
  allowedClassifications: Classification[]
  maxClassification: Classification
  viaPermission: Permission
  ownership: Ownership
  risk: RiskLevel
  auditId?: string
}

export interface DenyDecision {
  allowed: false
  reason: DenyReason
  message: string
  risk: RiskLevel
  auditId?: string
}

export type PolicyDecision = AllowDecision | DenyDecision

export interface PolicyGatewayDeps {
  audit: AuditRepository
  securityEvents: SecurityEventService
  logger: Logger
}

/** Always audited, whatever the caller requests. */
const MUTATING_ACTIONS: readonly Action[] = ['create', 'update', 'delete', 'approve', 'reject', 'export']

/**
 * `skipAudit` lets a UI ask "would this be allowed?" without filling the trail
 * with noise. It must never silence a state change or a classified read (§28),
 * so a route that sets it by mistake cannot create a blind spot.
 */
function maySkipAudit(request: AuthorizationRequest): boolean {
  if (!request.skipAudit) return false
  if (MUTATING_ACTIONS.includes(request.action)) return false
  const classification = request.resource.classification
  if (classification === 'CONFIDENTIAL' || classification === 'RESTRICTED') return false
  return true
}

/** Report the closest miss when several grants fail. */
const REASON_PRECEDENCE: DenyReason[] = [
  'CLASSIFICATION_TOO_HIGH',
  'NOT_MANAGER_OF_TARGET',
  'NOT_OWNER',
  'MISSING_PERMISSION',
]

export class PolicyGateway {
  constructor(private readonly deps: PolicyGatewayDeps) {}

  async authorize(request: AuthorizationRequest): Promise<PolicyDecision> {
    const { identity, action, resource } = request
    const risk = request.intent ? INTENT_DEFINITIONS[request.intent].risk : inferRisk(resource)

    const deny = async (reason: DenyReason, detail?: Record<string, unknown>): Promise<DenyDecision> => {
      const auditId = maySkipAudit(request)
        ? undefined
        : await this.deps.audit.record({
            tenantId: identity.tenantId,
            userId: identity.kind === 'USER' ? identity.userId : null,
            telegramId: identity.telegramUserId ?? null,
            channel: identity.channel,
            intent: request.intent ?? null,
            resource: resource.type,
            resourceId: resource.id ?? null,
            action,
            decision: 'DENY',
            reasonCode: reason,
            risk,
            source: 'PolicyGateway',
            requestId: request.requestId ?? null,
            metadata: { ...request.metadata, ...detail },
          })

      await this.emitSecurityEvent(reason, request, risk)

      this.deps.logger.warn('authorisation denied', {
        action: `${resource.type}:${action}`,
        result: 'DENY',
        errorCode: reason,
        userId: (identity.kind === 'USER' ? identity.userId : null) ?? undefined,
        tenantId: identity.tenantId,
        channel: identity.channel,
        requestId: request.requestId,
      })

      return { allowed: false, reason, message: DENY_MESSAGES[reason], risk, auditId }
    }

    if (resource.tenantId && resource.tenantId !== identity.tenantId) {
      return deny('TENANT_MISMATCH', {
        expectedTenant: identity.tenantId,
        resourceTenant: resource.tenantId,
      })
    }

    // No rule means no access; there is no permissive default.
    const rule: PolicyRule | null = findRule(resource.type, action)
    if (!rule) {
      return deny('MISSING_PERMISSION', { note: 'no policy rule defined for this operation' })
    }

    if (!rule.zones.includes(identity.zone)) {
      return deny('WRONG_SECURITY_ZONE', { zone: identity.zone, allowedZones: [...rule.zones] })
    }

    if (request.intent && !isIntentAllowedInZone(request.intent, identity.zone)) {
      return deny('INTENT_NOT_ALLOWED_IN_ZONE', { intent: request.intent })
    }

    // A RESTRICTED-risk operation is never exposed over a chat channel, even
    // to an otherwise-authorised user.
    const isChat = identity.channel === 'TELEGRAM_INTERNAL' || identity.channel === 'TELEGRAM_EXTERNAL'
    if (isChat && rule.maxRiskInChat && riskRank(risk) > riskRank(rule.maxRiskInChat)) {
      return deny('RISK_TOO_HIGH', { risk, channel: identity.channel })
    }

    // Grant ladder: permission → ownership → classification.
    const misses: DenyReason[] = []
    let satisfied: { grant: Grant; ceiling: Classification } | null = null

    for (const grant of rule.grants) {
      if (!identity.permissions.has(grant.permission)) {
        misses.push('MISSING_PERMISSION')
        continue
      }
      const ownershipReason = checkOwnership(identity, resource, grant.ownership)
      if (ownershipReason) {
        misses.push(ownershipReason)
        continue
      }
      const ceiling = grant.maxClassification ?? 'INTERNAL'
      if (resource.classification && !classificationCovers(ceiling, resource.classification)) {
        misses.push('CLASSIFICATION_TOO_HIGH')
        continue
      }
      satisfied = { grant, ceiling }
      break
    }

    if (!satisfied) {
      const reason =
        REASON_PRECEDENCE.find((r) => misses.includes(r)) ?? 'MISSING_PERMISSION'
      return deny(reason, { attemptedGrants: rule.grants.map((g) => g.permission) })
    }

    // Deterministic backend checks, evaluated only after permissions pass.
    const failedRule = request.businessRules?.find((r) => !r.satisfied)
    if (failedRule) {
      const auditId = maySkipAudit(request)
        ? undefined
        : await this.deps.audit.record({
            tenantId: identity.tenantId,
            userId: identity.kind === 'USER' ? identity.userId : null,
            telegramId: identity.telegramUserId ?? null,
            channel: identity.channel,
            intent: request.intent ?? null,
            resource: resource.type,
            resourceId: resource.id ?? null,
            action,
            decision: 'DENY',
            reasonCode: 'BUSINESS_RULE',
            risk,
            source: 'PolicyGateway',
            requestId: request.requestId ?? null,
            metadata: { ...request.metadata, ruleCode: failedRule.code },
          })
      return {
        allowed: false,
        reason: 'BUSINESS_RULE',
        message: failedRule.message,
        risk,
        auditId,
      }
    }

    // Intersecting the grant ceiling with the identity's overall ceiling closes
    // a gap the ladder leaves open: `policy.create` must not let HR create a
    // RESTRICTED document it cannot read.
    const permissionCeiling = maxReadableClassification(identity.permissions)
    const effectiveCeiling = lowerOf(satisfied.ceiling, permissionCeiling, resource.type)

    if (resource.classification && !classificationCovers(effectiveCeiling, resource.classification)) {
      return deny('CLASSIFICATION_TOO_HIGH', {
        resourceClassification: resource.classification,
        effectiveCeiling,
      })
    }

    const auditId = maySkipAudit(request)
      ? undefined
      : await this.deps.audit.record({
          tenantId: identity.tenantId,
          userId: identity.kind === 'USER' ? identity.userId : null,
          telegramId: identity.telegramUserId ?? null,
          channel: identity.channel,
          intent: request.intent ?? null,
          resource: resource.type,
          resourceId: resource.id ?? null,
          action,
          decision: 'ALLOW',
          reasonCode: satisfied.grant.permission,
          risk,
          source: 'PolicyGateway',
          requestId: request.requestId ?? null,
          metadata: request.metadata,
        })

    return {
      allowed: true,
      allowedClassifications: classificationsUpTo(effectiveCeiling),
      maxClassification: effectiveCeiling,
      viaPermission: satisfied.grant.permission,
      ownership: satisfied.grant.ownership,
      risk,
      auditId,
    }
  }

  /**
   * Convenience wrapper for routes: authorise or throw a safe AppError.
   * Returns the allow decision so callers can use `allowedClassifications`.
   */
  async require(request: AuthorizationRequest): Promise<AllowDecision> {
    const decision = await this.authorize(request)
    if (!decision.allowed) {
      throw forbidden(decision.message, {
        details: { reason: decision.reason },
        internal: `PolicyGateway denied ${request.resource.type}:${request.action} (${decision.reason})`,
      })
    }
    return decision
  }

  private async emitSecurityEvent(
    reason: DenyReason,
    request: AuthorizationRequest,
    risk: RiskLevel,
  ): Promise<void> {
    const { identity, resource, action } = request
    const base = {
      tenantId: identity.tenantId,
      userId: identity.kind === 'USER' ? identity.userId : null,
      telegramId: identity.telegramUserId ?? null,
      subjectKey: identity.subjectKey,
      channel: identity.channel,
      requestId: request.requestId ?? null,
      detail: { resource: resource.type, action, reason, risk, intent: request.intent ?? null },
    }

    switch (reason) {
      case 'TENANT_MISMATCH':
        await this.deps.securityEvents.record({
          ...base,
          eventType: 'TENANT_ACCESS_VIOLATION',
          summary: `Cross-tenant access attempt on ${resource.type}`,
        })
        return
      case 'NOT_OWNER':
      case 'NOT_MANAGER_OF_TARGET':
        await this.deps.securityEvents.record({
          ...base,
          eventType: 'CROSS_USER_ACCESS',
          summary: `Attempt to access another subject's ${resource.type}`,
        })
        return
      case 'CLASSIFICATION_TOO_HIGH':
        await this.deps.securityEvents.record({
          ...base,
          eventType: 'RESTRICTED_DATA_REQUEST',
          summary: `Attempt to read ${resource.classification ?? 'classified'} ${resource.type}`,
        })
        return
      case 'WRONG_SECURITY_ZONE':
      case 'INTENT_NOT_ALLOWED_IN_ZONE':
        await this.deps.securityEvents.record({
          ...base,
          eventType: 'SCOPE_VIOLATION',
          summary: `${identity.zone} caller attempted ${resource.type}:${action}`,
        })
        return
      case 'RISK_TOO_HIGH':
        await this.deps.securityEvents.record({
          ...base,
          eventType: 'RESTRICTED_DATA_REQUEST',
          summary: `High-risk operation ${resource.type}:${action} refused on ${identity.channel}`,
        })
        return
      default:
        await this.deps.securityEvents.record({
          ...base,
          eventType: 'BLOCKED_REQUEST',
          summary: `Denied ${resource.type}:${action}`,
        })
    }
  }
}

/** Returns a deny reason, or null when ownership is satisfied. */
function checkOwnership(
  identity: Identity,
  resource: ResourceRef,
  ownership: Ownership,
): DenyReason | null {
  if (ownership === 'ANY') return null

  const ownsEmployee =
    identity.kind === 'USER' &&
    identity.employeeId !== null &&
    resource.ownerEmployeeId === identity.employeeId

  const ownsCandidate =
    resource.ownerCandidateId != null &&
    ((identity.kind === 'ANONYMOUS' && identity.candidateId === resource.ownerCandidateId) ||
      (identity.kind === 'USER' && false))

  const managesTarget =
    identity.kind === 'USER' &&
    resource.ownerEmployeeId != null &&
    identity.managedEmployeeIds.includes(resource.ownerEmployeeId)

  switch (ownership) {
    case 'SELF':
      // A missing owner is a programming error, never an implicit match.
      if (resource.ownerEmployeeId == null && resource.ownerCandidateId == null) return 'NOT_OWNER'
      return ownsEmployee || ownsCandidate ? null : 'NOT_OWNER'
    case 'TEAM':
      return managesTarget ? null : 'NOT_MANAGER_OF_TARGET'
    case 'SELF_OR_TEAM':
      if (ownsEmployee || ownsCandidate || managesTarget) return null
      return resource.ownerEmployeeId ? 'NOT_MANAGER_OF_TARGET' : 'NOT_OWNER'
  }
}

const RISK_RANK: Record<RiskLevel, number> = {
  LOW: 0,
  PERSONAL_DATA: 1,
  SENSITIVE: 2,
  RESTRICTED: 3,
}

function riskRank(risk: RiskLevel): number {
  return RISK_RANK[risk]
}

/** Fallback when no intent was classified. */
function inferRisk(resource: ResourceRef): RiskLevel {
  if (resource.classification === 'RESTRICTED') return 'RESTRICTED'
  if (resource.type === 'employee.compensation' || resource.type === 'offer') return 'RESTRICTED'
  if (resource.classification === 'CONFIDENTIAL') return 'SENSITIVE'
  if (resource.type === 'job' || resource.type === 'job.requirement' || resource.type === 'holiday') {
    return 'LOW'
  }
  return 'PERSONAL_DATA'
}

/**
 * The overall ceiling comes from `policy.read.*`, which governs only knowledge
 * documents; elsewhere the grant's own ceiling is authoritative.
 */
function lowerOf(
  grantCeiling: Classification,
  permissionCeiling: Classification,
  resourceType: string,
): Classification {
  if (!resourceType.startsWith('knowledge.')) return grantCeiling
  return classificationCovers(grantCeiling, permissionCeiling) ? permissionCeiling : grantCeiling
}
