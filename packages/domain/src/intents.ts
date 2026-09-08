/**
 * Structured intents (CLAUDE.md §19).
 *
 * The AI proposes an intent. `scope`, `risk` and `target` in an AI-produced
 * intent are *hints for routing only* — the backend recomputes them from the
 * canonical table below before any authorisation decision is made.
 */

import type { SecurityZone } from './identity.js'

export const RISK_LEVELS = ['LOW', 'PERSONAL_DATA', 'SENSITIVE', 'RESTRICTED'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export const INTENT_TARGETS = ['NONE', 'SELF', 'TEAM', 'OTHER_EMPLOYEE', 'ORGANISATION'] as const
export type IntentTarget = (typeof INTENT_TARGETS)[number]

export const INTENTS = [
  // External / candidate
  'PUBLIC_JOB_SEARCH',
  'PUBLIC_JOB_DETAILS',
  'PUBLIC_JOB_REQUIREMENTS',
  'PUBLIC_HIRING_PROCESS',
  'PUBLIC_APPLY',
  'PUBLIC_APPLICATION_STATUS',

  // Internal self-service
  'MY_PROFILE',
  'MY_LEAVE_BALANCE',
  'MY_LEAVE_HISTORY',
  'MY_LEAVE_REQUESTS',
  'CREATE_LEAVE_REQUEST',
  'CANCEL_LEAVE_REQUEST',
  'HOLIDAYS',
  'HR_POLICY_QUESTION',

  // Manager / HR
  'TEAM_LEAVE_REQUESTS',
  'APPROVE_LEAVE_REQUEST',
  'REJECT_LEAVE_REQUEST',
  'EMPLOYEE_DIRECTORY',
  'EMPLOYEE_PROFILE',
  'EMPLOYEE_SALARY',
  'CANDIDATE_SEARCH',
  'CANDIDATE_DETAILS',
  'APPLICATION_STAGE_UPDATE',
  'JOB_MANAGE',
  'POLICY_MANAGE',
  'REPORTING',

  // Meta
  'SMALL_TALK',
  'HELP',
  'OUT_OF_SCOPE',
  'UNKNOWN',
] as const

export type Intent = (typeof INTENTS)[number]

export function isIntent(v: unknown): v is Intent {
  return typeof v === 'string' && (INTENTS as readonly string[]).includes(v)
}

export interface IntentDefinition {
  intent: Intent
  /** Zone in which this intent may be *considered at all*. */
  zone: SecurityZone | 'ANY'
  target: IntentTarget
  risk: RiskLevel
  /** Fed to the classifier prompt, so keep it short. */
  description: string
}

/**
 * Canonical intent metadata. This is the authority — an LLM response claiming
 * `risk: "LOW"` for `EMPLOYEE_SALARY` is overwritten from this table.
 */
export const INTENT_DEFINITIONS: Record<Intent, IntentDefinition> = {
  PUBLIC_JOB_SEARCH: { intent: 'PUBLIC_JOB_SEARCH', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'Browse or search published job openings' },
  PUBLIC_JOB_DETAILS: { intent: 'PUBLIC_JOB_DETAILS', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'Details of a specific published job' },
  PUBLIC_JOB_REQUIREMENTS: { intent: 'PUBLIC_JOB_REQUIREMENTS', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'Requirements or qualifications for a job' },
  PUBLIC_HIRING_PROCESS: { intent: 'PUBLIC_HIRING_PROCESS', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'How the hiring or application process works' },
  PUBLIC_APPLY: { intent: 'PUBLIC_APPLY', zone: 'EXTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: 'Submit a job application' },
  PUBLIC_APPLICATION_STATUS: { intent: 'PUBLIC_APPLICATION_STATUS', zone: 'EXTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: "Status of the caller's own application" },

  MY_PROFILE: { intent: 'MY_PROFILE', zone: 'INTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: "The employee's own profile details" },
  MY_LEAVE_BALANCE: { intent: 'MY_LEAVE_BALANCE', zone: 'INTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: "The employee's own leave balance" },
  MY_LEAVE_HISTORY: { intent: 'MY_LEAVE_HISTORY', zone: 'INTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: "The employee's own past leave" },
  MY_LEAVE_REQUESTS: { intent: 'MY_LEAVE_REQUESTS', zone: 'INTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: "The employee's own leave requests" },
  CREATE_LEAVE_REQUEST: { intent: 'CREATE_LEAVE_REQUEST', zone: 'INTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: 'Request leave for oneself' },
  CANCEL_LEAVE_REQUEST: { intent: 'CANCEL_LEAVE_REQUEST', zone: 'INTERNAL', target: 'SELF', risk: 'PERSONAL_DATA', description: "Cancel one's own pending leave request" },
  HOLIDAYS: { intent: 'HOLIDAYS', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'LOW', description: 'Company holiday calendar' },
  HR_POLICY_QUESTION: { intent: 'HR_POLICY_QUESTION', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'LOW', description: 'A question answered by HR policy documents' },

  TEAM_LEAVE_REQUESTS: { intent: 'TEAM_LEAVE_REQUESTS', zone: 'INTERNAL', target: 'TEAM', risk: 'PERSONAL_DATA', description: "Leave requests from the manager's direct reports" },
  APPROVE_LEAVE_REQUEST: { intent: 'APPROVE_LEAVE_REQUEST', zone: 'INTERNAL', target: 'TEAM', risk: 'SENSITIVE', description: 'Approve a leave request' },
  REJECT_LEAVE_REQUEST: { intent: 'REJECT_LEAVE_REQUEST', zone: 'INTERNAL', target: 'TEAM', risk: 'SENSITIVE', description: 'Reject a leave request' },
  EMPLOYEE_DIRECTORY: { intent: 'EMPLOYEE_DIRECTORY', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'PERSONAL_DATA', description: 'Search the employee directory' },
  EMPLOYEE_PROFILE: { intent: 'EMPLOYEE_PROFILE', zone: 'INTERNAL', target: 'OTHER_EMPLOYEE', risk: 'PERSONAL_DATA', description: "Another employee's profile" },
  EMPLOYEE_SALARY: { intent: 'EMPLOYEE_SALARY', zone: 'INTERNAL', target: 'OTHER_EMPLOYEE', risk: 'RESTRICTED', description: 'Salary or compensation information' },
  CANDIDATE_SEARCH: { intent: 'CANDIDATE_SEARCH', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'SENSITIVE', description: 'Search recruitment candidates' },
  CANDIDATE_DETAILS: { intent: 'CANDIDATE_DETAILS', zone: 'INTERNAL', target: 'OTHER_EMPLOYEE', risk: 'SENSITIVE', description: 'Details of a candidate or application' },
  APPLICATION_STAGE_UPDATE: { intent: 'APPLICATION_STAGE_UPDATE', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'SENSITIVE', description: 'Move an application to another stage' },
  JOB_MANAGE: { intent: 'JOB_MANAGE', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'SENSITIVE', description: 'Create, update or close a job' },
  POLICY_MANAGE: { intent: 'POLICY_MANAGE', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'SENSITIVE', description: 'Create or update an HR policy document' },
  REPORTING: { intent: 'REPORTING', zone: 'INTERNAL', target: 'ORGANISATION', risk: 'SENSITIVE', description: 'HR reports and analytics' },

  SMALL_TALK: { intent: 'SMALL_TALK', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'Greetings and pleasantries' },
  HELP: { intent: 'HELP', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'What the assistant can do' },
  OUT_OF_SCOPE: { intent: 'OUT_OF_SCOPE', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'Not an HR or recruitment topic' },
  UNKNOWN: { intent: 'UNKNOWN', zone: 'ANY', target: 'NONE', risk: 'LOW', description: 'Could not be classified' },
}

/**
 * Normalise an (untrusted) AI-proposed intent into a backend-authoritative one.
 * Any unknown intent name collapses to UNKNOWN; scope/target/risk are replaced.
 */
export function canonicaliseIntent(proposed: unknown): IntentDefinition {
  const name =
    typeof proposed === 'object' && proposed !== null
      ? (proposed as { intent?: unknown }).intent
      : proposed
  return isIntent(name) ? INTENT_DEFINITIONS[name] : INTENT_DEFINITIONS.UNKNOWN
}

/** Intents an EXTERNAL-zone caller is allowed to even attempt. */
export function isIntentAllowedInZone(intent: Intent, zone: SecurityZone): boolean {
  const def = INTENT_DEFINITIONS[intent]
  return def.zone === 'ANY' || def.zone === zone
}
