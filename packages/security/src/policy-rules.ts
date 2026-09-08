/**
 * The authorisation policy table (CLAUDE.md §11).
 *
 * Every protected operation in CORPUS is described here as (resource, action)
 * → an ordered ladder of grants. A grant is satisfied only when the identity
 * holds the permission AND the ownership relation holds AND the resource's
 * classification is within the identity's ceiling.
 *
 * Keeping this declarative means authorisation is auditable by reading one
 * file, and no route can invent its own rules.
 */

import type { Action, Classification, Permission, ResourceType, RiskLevel, SecurityZone } from '@corpus/domain'

/** How the subject must relate to the resource for a grant to apply. */
export type Ownership =
  /** No relationship required — the permission alone is sufficient. */
  | 'ANY'
  /** The resource must belong to the caller's own employee/candidate record. */
  | 'SELF'
  /** The resource must belong to one of the caller's direct reports. */
  | 'TEAM'
  | 'SELF_OR_TEAM'

export interface Grant {
  permission: Permission
  ownership: Ownership
  /** Highest resource classification this grant may reach. Defaults to INTERNAL. */
  maxClassification?: Classification
}

export interface PolicyRule {
  /** Zones from which this operation may be attempted at all. */
  zones: readonly SecurityZone[]
  /** Ordered ladder; the first satisfied grant allows the operation. */
  grants: readonly Grant[]
  /**
   * Highest risk this operation may carry on a *conversational* channel.
   * RESTRICTED-risk operations are never exposed through a bot.
   */
  maxRiskInChat?: RiskLevel
}

type RuleKey = `${ResourceType}:${Action}`

const INTERNAL_ONLY: readonly SecurityZone[] = ['INTERNAL']
const BOTH_ZONES: readonly SecurityZone[] = ['EXTERNAL', 'INTERNAL']

/**
 * Rule table. Absence of a key is a DENY — the gateway never falls back to a
 * permissive default.
 */
export const POLICY_RULES: Readonly<Record<RuleKey, PolicyRule>> = {
  // --- Employees
  'employee:read': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'employee.read.self', ownership: 'SELF' },
      { permission: 'employee.read.team', ownership: 'TEAM' },
      { permission: 'employee.read.all', ownership: 'ANY' },
    ],
  },
  'employee:list': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'employee.read.team', ownership: 'TEAM' },
      { permission: 'employee.read.all', ownership: 'ANY' },
    ],
  },
  'employee:search': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'employee.read.team', ownership: 'TEAM' },
      { permission: 'employee.read.all', ownership: 'ANY' },
    ],
  },
  'employee:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'employee.create', ownership: 'ANY' }],
  },
  'employee:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'employee.update', ownership: 'ANY' }],
  },

  // Compensation is RESTRICTED and never reachable from a chat channel.
  'employee.compensation:read': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'employee.read.compensation', ownership: 'ANY', maxClassification: 'RESTRICTED' },
    ],
    maxRiskInChat: 'LOW',
  },
  'employee.compensation:update': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'employee.read.compensation', ownership: 'ANY', maxClassification: 'RESTRICTED' },
    ],
    maxRiskInChat: 'LOW',
  },

  'department:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'employee.read.self', ownership: 'ANY' }],
  },
  'position:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'employee.read.self', ownership: 'ANY' }],
  },

  // --- Leave
  'leave.balance:read': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'leave.read.self', ownership: 'SELF' },
      { permission: 'leave.read.team', ownership: 'TEAM' },
      { permission: 'leave.read.all', ownership: 'ANY' },
    ],
  },
  'leave.request:read': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'leave.read.self', ownership: 'SELF' },
      { permission: 'leave.read.team', ownership: 'TEAM' },
      { permission: 'leave.read.all', ownership: 'ANY' },
    ],
  },
  'leave.request:list': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'leave.read.self', ownership: 'SELF' },
      { permission: 'leave.read.team', ownership: 'TEAM' },
      { permission: 'leave.read.all', ownership: 'ANY' },
    ],
  },
  'leave.request:create': {
    zones: INTERNAL_ONLY,
    // Self-service only: there is deliberately no "create on behalf of" grant.
    grants: [{ permission: 'leave.create.self', ownership: 'SELF' }],
  },
  'leave.request:delete': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'leave.cancel.self', ownership: 'SELF' }],
  },
  'leave.request:approve': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'leave.approve.team', ownership: 'TEAM' },
      { permission: 'leave.approve.all', ownership: 'ANY' },
    ],
  },
  'leave.request:reject': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'leave.approve.team', ownership: 'TEAM' },
      { permission: 'leave.approve.all', ownership: 'ANY' },
    ],
  },
  'leave.type:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'leave.read.self', ownership: 'ANY' }],
  },
  'leave.type:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'leave.manage', ownership: 'ANY' }],
  },
  'leave.balance:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'leave.manage', ownership: 'ANY' }],
  },
  'holiday:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'leave.read.self', ownership: 'ANY' }],
  },
  'holiday:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'leave.manage', ownership: 'ANY' }],
  },

  // --- Recruitment: public surface
  'job:read': {
    zones: BOTH_ZONES,
    grants: [
      // Published jobs are PUBLIC and readable by anyone, including anonymous.
      { permission: 'job.read.public', ownership: 'ANY', maxClassification: 'PUBLIC' },
      { permission: 'job.read.internal', ownership: 'ANY' },
    ],
  },
  'job:search': {
    zones: BOTH_ZONES,
    grants: [
      { permission: 'job.read.public', ownership: 'ANY', maxClassification: 'PUBLIC' },
      { permission: 'job.read.internal', ownership: 'ANY' },
    ],
  },
  'job:create': { zones: INTERNAL_ONLY, grants: [{ permission: 'job.create', ownership: 'ANY' }] },
  'job:update': { zones: INTERNAL_ONLY, grants: [{ permission: 'job.update', ownership: 'ANY' }] },
  'job:delete': { zones: INTERNAL_ONLY, grants: [{ permission: 'job.delete', ownership: 'ANY' }] },
  'job.requirement:list': {
    zones: BOTH_ZONES,
    grants: [
      { permission: 'job.read.public', ownership: 'ANY', maxClassification: 'PUBLIC' },
      { permission: 'job.read.internal', ownership: 'ANY' },
    ],
  },
  'job.requirement:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'job.update', ownership: 'ANY' }],
  },

  'candidate:create': {
    zones: BOTH_ZONES,
    grants: [
      { permission: 'candidate.create.public', ownership: 'ANY' },
      { permission: 'candidate.update', ownership: 'ANY' },
    ],
  },
  'candidate:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'candidate.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'candidate:search': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'candidate.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'candidate:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'candidate.update', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },

  'application:create': {
    zones: BOTH_ZONES,
    grants: [
      { permission: 'application.create.public', ownership: 'ANY' },
      { permission: 'application.update', ownership: 'ANY' },
    ],
  },
  'application:read': {
    zones: BOTH_ZONES,
    grants: [
      // A candidate may read only their own application, and only the public
      // projection — enforced by the calling tool/route.
      { permission: 'application.read.self', ownership: 'SELF', maxClassification: 'PUBLIC' },
      { permission: 'application.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' },
    ],
  },
  'application:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'application.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'application:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'application.update', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },

  'interview:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'interview.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'interview:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'interview.manage', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'interview:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'interview.manage', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'offer:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'offer.read', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
    maxRiskInChat: 'LOW',
  },
  'offer:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'offer.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
    maxRiskInChat: 'LOW',
  },
  'offer:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'offer.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
    maxRiskInChat: 'LOW',
  },

  // --- Knowledge
  // The classification ceiling per grant is what implements §9 enforcement.
  'knowledge.document:read': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'policy.read', ownership: 'ANY', maxClassification: 'INTERNAL' },
      { permission: 'policy.read.confidential', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' },
      { permission: 'policy.read.restricted', ownership: 'ANY', maxClassification: 'RESTRICTED' },
    ],
  },
  'knowledge.document:list': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'policy.read', ownership: 'ANY', maxClassification: 'INTERNAL' },
      { permission: 'policy.read.confidential', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' },
      { permission: 'policy.read.restricted', ownership: 'ANY', maxClassification: 'RESTRICTED' },
    ],
  },
  'knowledge.chunk:search': {
    zones: INTERNAL_ONLY,
    grants: [
      { permission: 'policy.read', ownership: 'ANY', maxClassification: 'INTERNAL' },
      { permission: 'policy.read.confidential', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' },
      { permission: 'policy.read.restricted', ownership: 'ANY', maxClassification: 'RESTRICTED' },
    ],
  },
  'knowledge.document:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'policy.create', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },
  'knowledge.document:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'policy.update', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },
  'knowledge.document:delete': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'policy.delete', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },

  // --- Curated bot answers
  // Reachable from EXTERNAL, so the anonymous grant is capped at PUBLIC. That
  // ceiling — not the audience column alone — is what stops a misfiled answer
  // reaching a candidate.
  // Ordered widest-first, unlike the chunk ladder above. The gateway stops at
  // the first satisfied grant, so an ascending ladder would cap SYSTEM_ADMIN at
  // PUBLIC — it holds every permission, `faq.read.public` included.
  'knowledge.answer:search': {
    zones: BOTH_ZONES,
    grants: [
      { permission: 'policy.read.restricted', ownership: 'ANY', maxClassification: 'RESTRICTED' },
      { permission: 'policy.read.confidential', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' },
      { permission: 'faq.read', ownership: 'ANY', maxClassification: 'INTERNAL' },
      { permission: 'faq.read.public', ownership: 'ANY', maxClassification: 'PUBLIC' },
    ],
  },
  'knowledge.answer:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'faq.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },
  'knowledge.answer:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'faq.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },
  'knowledge.answer:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'faq.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },
  'knowledge.answer:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'faq.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },
  'knowledge.answer:delete': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'faq.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
  },

  // --- Oversight
  'report:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'report.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'audit:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'audit.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
    maxRiskInChat: 'LOW',
  },
  'security.event:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'security.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
    maxRiskInChat: 'LOW',
  },
  'security.event:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'security.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
    maxRiskInChat: 'LOW',
  },
  'conversation:read': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'report.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  // Resolving an unanswered question is a state change on conversation data.
  'conversation:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'report.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'hr.ticket:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'employee.read.self', ownership: 'ANY' }],
  },
  'hr.ticket:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'report.read', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'user:list': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'system.manage', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'user:create': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'system.manage', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'user:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'system.manage', ownership: 'ANY', maxClassification: 'CONFIDENTIAL' }],
  },
  'system:update': {
    zones: INTERNAL_ONLY,
    grants: [{ permission: 'system.manage', ownership: 'ANY', maxClassification: 'RESTRICTED' }],
    maxRiskInChat: 'LOW',
  },
} as unknown as Readonly<Record<RuleKey, PolicyRule>>

export function findRule(resource: ResourceType, action: Action): PolicyRule | null {
  return POLICY_RULES[`${resource}:${action}` as RuleKey] ?? null
}
