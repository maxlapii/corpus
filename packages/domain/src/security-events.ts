/** Security event and audit taxonomy (CLAUDE.md §28). */

export const SECURITY_EVENT_TYPES = [
  'BLOCKED_REQUEST',
  'PROMPT_INJECTION',
  'CROSS_USER_ACCESS',
  'RESTRICTED_DATA_REQUEST',
  'UNKNOWN_USER',
  'RATE_LIMIT',
  'AUTH_FAILURE',
  'TOOL_DENIED',
  'TENANT_ACCESS_VIOLATION',
  'DOCUMENT_INJECTION',
  'IDENTITY_SPOOF_ATTEMPT',
  'SCOPE_VIOLATION',
] as const

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number]

export const SECURITY_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number]

export const DEFAULT_SEVERITY: Record<SecurityEventType, SecuritySeverity> = {
  BLOCKED_REQUEST: 'LOW',
  PROMPT_INJECTION: 'HIGH',
  CROSS_USER_ACCESS: 'HIGH',
  RESTRICTED_DATA_REQUEST: 'MEDIUM',
  UNKNOWN_USER: 'LOW',
  RATE_LIMIT: 'LOW',
  AUTH_FAILURE: 'MEDIUM',
  TOOL_DENIED: 'MEDIUM',
  TENANT_ACCESS_VIOLATION: 'CRITICAL',
  DOCUMENT_INJECTION: 'HIGH',
  IDENTITY_SPOOF_ATTEMPT: 'HIGH',
  SCOPE_VIOLATION: 'HIGH',
}

export const AUDIT_DECISIONS = ['ALLOW', 'DENY', 'ERROR'] as const
export type AuditDecision = (typeof AUDIT_DECISIONS)[number]

/** Reason codes returned by the PolicyGateway. Stable and log-safe. */
export const DENY_REASONS = [
  'NOT_AUTHENTICATED',
  'IDENTITY_NOT_LINKED',
  'NO_EMPLOYEE_RECORD',
  'WRONG_SECURITY_ZONE',
  'MISSING_PERMISSION',
  'NOT_OWNER',
  'NOT_MANAGER_OF_TARGET',
  'CLASSIFICATION_TOO_HIGH',
  'TENANT_MISMATCH',
  'RESOURCE_NOT_FOUND',
  'BUSINESS_RULE',
  'RISK_TOO_HIGH',
  'TOOL_NOT_AVAILABLE_IN_ZONE',
  'RATE_LIMITED',
  'ACCOUNT_DISABLED',
  'INTENT_NOT_ALLOWED_IN_ZONE',
] as const

export type DenyReason = (typeof DENY_REASONS)[number]

/** User-facing text for each deny reason. Never exposes internal structure. */
export const DENY_MESSAGES: Record<DenyReason, string> = {
  NOT_AUTHENTICATED: 'You need to be signed in and verified to do that.',
  IDENTITY_NOT_LINKED: 'This Telegram account is not linked to a verified employee record yet.',
  NO_EMPLOYEE_RECORD: 'Your account is not linked to an employee record.',
  WRONG_SECURITY_ZONE: 'That information is not available through this channel.',
  MISSING_PERMISSION: 'You do not have permission to access that.',
  NOT_OWNER: 'You can only access your own records.',
  NOT_MANAGER_OF_TARGET: 'You can only access records for your own direct reports.',
  CLASSIFICATION_TOO_HIGH: 'That information is restricted.',
  TENANT_MISMATCH: 'The requested resource is not available.',
  RESOURCE_NOT_FOUND: 'The requested resource was not found.',
  BUSINESS_RULE: 'That action is not allowed in the current state.',
  RISK_TOO_HIGH: 'That request cannot be completed through this channel.',
  TOOL_NOT_AVAILABLE_IN_ZONE: 'That capability is not available here.',
  RATE_LIMITED: 'Too many requests. Please try again shortly.',
  ACCOUNT_DISABLED: 'This account is not active. Please contact HR.',
  INTENT_NOT_ALLOWED_IN_ZONE: 'I can only help with public recruitment questions here.',
}
