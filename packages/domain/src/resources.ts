/**
 * Resource taxonomy used by the PolicyGateway. A "resource" names *what* is
 * being touched; ownership and classification are attached per request.
 */

export const RESOURCE_TYPES = [
  'employee',
  'employee.compensation',
  'department',
  'position',
  'leave.request',
  'leave.balance',
  'leave.type',
  'holiday',
  'job',
  'job.requirement',
  'candidate',
  'application',
  'interview',
  'offer',
  'knowledge.document',
  'knowledge.chunk',
  'report',
  'audit',
  'security.event',
  'conversation',
  'system',
  'user',
  'hr.ticket',
] as const

export type ResourceType = (typeof RESOURCE_TYPES)[number]

export interface ResourceRef {
  type: ResourceType
  id?: string
  /** Employee the resource belongs to, when applicable. Drives ownership checks. */
  ownerEmployeeId?: string | null
  /** Candidate the resource belongs to, for external self-service. */
  ownerCandidateId?: string | null
  /** Tenant the resource belongs to. Compared against the identity's tenant. */
  tenantId?: string | null
  classification?: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'
}

export const ACTIONS = ['read', 'list', 'create', 'update', 'delete', 'approve', 'reject', 'search', 'export'] as const
export type Action = (typeof ACTIONS)[number]
