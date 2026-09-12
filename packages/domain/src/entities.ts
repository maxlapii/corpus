/** Domain entity shapes and their state machines. */

import type { Classification } from './classification.js'
import type { AnswerAudience, AnswerStatus } from './answer-flow.js'
import type { DateOnly } from '@corpus/shared'

// --- Tenancy

export interface Tenant {
  id: string
  slug: string
  name: string
  status: 'ACTIVE' | 'SUSPENDED'
  createdAt: string
  updatedAt: string
}

// --- Users

export interface User {
  id: string
  tenantId: string
  email: string
  displayName: string
  status: 'ACTIVE' | 'DISABLED' | 'LOCKED'
  employeeId: string | null
  lastLoginAt: string | null
  failedLoginCount: number
  createdAt: string
  updatedAt: string
}

export interface TelegramAccount {
  id: string
  tenantId: string
  telegramUserId: string
  employeeId: string | null
  userId: string | null
  scope: 'EXTERNAL' | 'INTERNAL'
  verifiedAt: string | null
  revokedAt: string | null
  createdAt: string
}

// --- Organisation

export interface Department {
  id: string
  tenantId: string
  code: string
  name: string
  parentId: string | null
}

export interface Position {
  id: string
  tenantId: string
  code: string
  title: string
  level: string | null
}

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] as const
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

export const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

export interface Employee {
  id: string
  tenantId: string
  employeeNo: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  departmentId: string | null
  positionId: string | null
  managerId: string | null
  hireDate: DateOnly
  employmentType: EmploymentType
  status: EmployeeStatus
  createdAt: string
  updatedAt: string
}

/**
 * Compensation lives in its own table with RESTRICTED classification so that a
 * plain employee read can never accidentally join it in.
 */
export interface EmployeeCompensation {
  employeeId: string
  tenantId: string
  baseSalary: number
  currency: string
  effectiveFrom: DateOnly
  classification: Extract<Classification, 'RESTRICTED'>
}

// --- Recruitment

export const JOB_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export interface Job {
  id: string
  tenantId: string
  jobCode: string
  title: string
  departmentId: string | null
  location: string | null
  employmentType: EmploymentType
  description: string
  salaryMin: number | null
  salaryMax: number | null
  currency: string | null
  remoteAllowed: boolean
  experienceMin: number | null
  status: JobStatus
  publishedAt: string | null
  closingDate: DateOnly | null
  createdAt: string
  updatedAt: string
}

export const REQUIREMENT_TYPES = ['SKILL', 'EDUCATION', 'EXPERIENCE', 'CERTIFICATION', 'LANGUAGE', 'OTHER'] as const
export type RequirementType = (typeof REQUIREMENT_TYPES)[number]

export interface JobRequirement {
  id: string
  jobId: string
  requirementType: RequirementType
  description: string
  mandatory: boolean
  priority: number
}

export interface Candidate {
  id: string
  tenantId: string
  name: string
  email: string
  phone: string | null
  telegramUserId: string | null
  cvFileId: string | null
  source: string
  createdAt: string
  updatedAt: string
}

export const APPLICATION_STAGES = [
  'APPLIED',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'TECHNICAL',
  'FINAL',
  'OFFER',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
] as const
export type ApplicationStage = (typeof APPLICATION_STAGES)[number]

export const APPLICATION_STATUSES = ['OPEN', 'CLOSED'] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export interface Application {
  id: string
  tenantId: string
  candidateId: string
  jobId: string
  stage: ApplicationStage
  status: ApplicationStatus
  /** Opaque reference the candidate can quote to check status. */
  reference: string
  appliedAt: string
  updatedAt: string
}

export interface ApplicationEvent {
  id: string
  applicationId: string
  tenantId: string
  fromStage: ApplicationStage | null
  toStage: ApplicationStage
  note: string | null
  actorUserId: string | null
  createdAt: string
}

export const INTERVIEW_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number]

export interface Interview {
  id: string
  tenantId: string
  applicationId: string
  scheduledAt: string
  durationMinutes: number
  mode: 'ONSITE' | 'REMOTE' | 'PHONE'
  interviewerEmployeeId: string | null
  status: InterviewStatus
  /** Evaluation notes are CONFIDENTIAL and never exposed to the EXTERNAL zone. */
  evaluation: string | null
  score: number | null
  createdAt: string
}

export const OFFER_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'] as const
export type OfferStatus = (typeof OFFER_STATUSES)[number]

export interface Offer {
  id: string
  tenantId: string
  applicationId: string
  baseSalary: number
  currency: string
  startDate: DateOnly
  status: OfferStatus
  expiresAt: DateOnly | null
  createdAt: string
  updatedAt: string
}

// --- Leave

export interface LeaveType {
  id: string
  tenantId: string
  code: string
  name: string
  paid: boolean
  requiresApproval: boolean
  maxConsecutiveDays: number | null
  /** Whether weekends/holidays inside the range are deducted. */
  countsWorkingDaysOnly: boolean
  active: boolean
}

export interface LeaveBalance {
  id: string
  tenantId: string
  employeeId: string
  leaveTypeId: string
  year: number
  entitledDays: number
  usedDays: number
  pendingDays: number
  carriedOverDays: number
}

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const
export type LeaveStatus = (typeof LEAVE_STATUSES)[number]

export interface LeaveRequest {
  id: string
  tenantId: string
  employeeId: string
  leaveTypeId: string
  startDate: DateOnly
  endDate: DateOnly
  /** Working days, always computed by the backend. */
  workingDays: number
  reason: string | null
  status: LeaveStatus
  submittedAt: string
  decidedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LeaveApproval {
  id: string
  tenantId: string
  leaveRequestId: string
  approverUserId: string
  decision: 'APPROVED' | 'REJECTED'
  comment: string | null
  decidedAt: string
}

export interface Holiday {
  id: string
  tenantId: string
  date: DateOnly
  name: string
  recurring: boolean
  region: string | null
}

// --- Knowledge

export const DOCUMENT_STATUSES = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export interface KnowledgeDocument {
  id: string
  tenantId: string
  name: string
  category: string
  classification: Classification
  owner: string | null
  status: DocumentStatus
  createdAt: string
  updatedAt: string
}

export interface DocumentVersion {
  id: string
  documentId: string
  tenantId: string
  version: number
  effectiveFrom: DateOnly
  effectiveTo: DateOnly | null
  filePath: string | null
  contentType: string | null
  byteSize: number | null
  createdAt: string
  createdBy: string | null
}

export interface DocumentChunk {
  id: string
  documentId: string
  documentVersionId: string
  tenantId: string
  version: number
  classification: Classification
  effectiveFrom: DateOnly
  effectiveTo: DateOnly | null
  section: string | null
  page: number | null
  ordinal: number
  content: string
}

export interface KnowledgeAnswer {
  id: string
  tenantId: string
  question: string
  answer: string
  category: string
  audience: AnswerAudience
  classification: Classification
  status: AnswerStatus
  /** False lets an unverified person on the internal bot receive this. */
  requiresAccount: boolean
  /** Bound Telegram command, without the slash. */
  command: string | null
  /** Menu text for that command. World-readable. */
  commandDescription: string | null
  effectiveFrom: DateOnly
  effectiveTo: DateOnly | null
  phrases: string[]
  sourceUnansweredId: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
}

export interface CandidateDocument {
  id: string
  tenantId: string
  candidateId: string
  kind: 'CV' | 'COVER_LETTER' | 'OTHER'
  filename: string
  contentType: string
  byteSize: number
  checksum: string | null
  storageKey: string
  /** Untrusted data. Rendered as text, never interpreted (§26). */
  extractedText: string | null
  extractionStatus: 'OK' | 'EMPTY' | 'UNSUPPORTED' | 'FAILED'
  extractor: string | null
  extractionWarnings: string[]
  injectionFlagged: boolean
  source: 'TELEGRAM_EXTERNAL' | 'TELEGRAM_INTERNAL' | 'DASHBOARD'
  uploadedAt: string
  uploadedByUserId: string | null
}

// --- Conversations

export interface Conversation {
  id: string
  tenantId: string
  channel: string
  subjectKey: string
  userId: string | null
  candidateId: string | null
  startedAt: string
  lastMessageAt: string
}

export interface ConversationMessage {
  id: string
  conversationId: string
  tenantId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  intent: string | null
  createdAt: string
}

export interface ToolCallRecord {
  id: string
  conversationId: string | null
  tenantId: string
  toolName: string
  decision: 'ALLOW' | 'DENY'
  reasonCode: string | null
  latencyMs: number | null
  createdAt: string
}

export interface UnansweredQuestion {
  id: string
  tenantId: string
  conversationId: string | null
  question: string
  channel: string
  askedByUserId: string | null
  resolvedAt: string | null
  resolvedAnswerId: string | null
  resolvedByUserId: string | null
  createdAt: string
}

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export interface HrTicket {
  id: string
  tenantId: string
  subject: string
  body: string
  raisedByUserId: string | null
  status: TicketStatus
  createdAt: string
  updatedAt: string
}
