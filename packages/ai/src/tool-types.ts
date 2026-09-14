/**
 * AI tool contracts (CLAUDE.md §15). Two rules are structural, not conventional:
 * tools run only via ToolRegistry.execute (which calls the PolicyGateway first),
 * and self-service tools declare no subject parameter — the registry rejects one
 * at construction, so `get_leave_balance(employee_id)` cannot exist (§17, §53).
 */

import type { Validator, Logger, DateOnly } from '@corpus/shared'
import type {
  Action,
  Identity,
  Permission,
  ResourceRef,
  ResourceType,
  RiskLevel,
  SecurityZone,
  UserIdentity,
} from '@corpus/domain'
import type { Repositories } from '@corpus/db'
import type { KnowledgeSearchService } from '@corpus/knowledge'
import type { PolicyGateway } from '@corpus/security'

/** Everything a handler may touch. No raw SQL, no D1. */
export interface ToolContext {
  identity: Identity
  repos: Repositories
  gateway: PolicyGateway
  knowledgeSearch: KnowledgeSearchService
  logger: Logger
  today: DateOnly
  requestId: string
  conversationId: string | null
  /** Classifications the caller may read, from the gateway decision. */
  allowedClassifications: readonly string[]
  limits: { maxContextChunks: number; maxPageSize: number }
}

export interface InternalToolContext extends ToolContext {
  identity: UserIdentity & { employeeId: string }
}

export interface ToolResultData {
  summary: string
  data?: Record<string, unknown>
  /**
   * The payload written out for a person to read. When a tool supplies it the
   * orchestrator sends this instead of the JSON, which keeps a chat reply
   * readable if the model is unavailable and the backend has to answer from
   * tool output alone (§38, §46).
   */
  display?: string
  /** Figures the backend returned; the response filter redacts any others (§54). */
  groundedNumbers?: (string | number)[]
  citations?: { documentName: string; section: string | null; version: number }[]
  /** Already permission-filtered (§24). */
  contextPassages?: { label: string; content: string }[]
}

export type ToolOutcome =
  | { ok: true; result: ToolResultData }
  | { ok: false; reasonCode: string; message: string }

export interface ToolDefinition<TInput = unknown> {
  name: string
  /** Billed on every turn — keep short (§37). */
  description: string
  scope: SecurityZone
  permission: Permission
  risk: RiskLevel
  resource: ResourceType
  action: Action
  parameters: Record<string, unknown>
  validator: Validator<TInput>
  /** Ownership must come from the identity or the database, never from `input`. */
  resolveResource(ctx: ToolContext, input: TInput): Promise<ResourceRef>
  handler(ctx: ToolContext, input: TInput): Promise<ToolOutcome>
  auditRequired: boolean
  /**
   * An unguessable argument that itself proves ownership. For an ANONYMOUS
   * caller the registry binds the identity to the resolved candidate and audits
   * `credential`; guessing is bounded by the channel rate limit.
   */
  bearerCredential?: 'application_reference'
}

/** Accepting any of these would let the model choose whose data to read (§17). */
export const FORBIDDEN_PARAMETER_NAMES: readonly string[] = [
  'employee_id',
  'employeeId',
  'employee_no',
  'employeeNo',
  'user_id',
  'userId',
  'tenant_id',
  'tenantId',
  'role',
  'roles',
  'permission',
  'permissions',
  'classification',
  'sql',
  'query_sql',
  'table',
]

/** Manager/HR tools where the target is a business input; ownership still applies. */
export const TOOLS_ALLOWED_TO_TARGET_OTHERS: readonly string[] = [
  'get_employee_profile',
  'search_employees',
  'approve_leave_request',
  'reject_leave_request',
  'get_team_leave_requests',
  'search_candidates',
  'get_candidate',
  'update_application_stage',
  'create_job',
  'update_job',
  'close_job',
]
