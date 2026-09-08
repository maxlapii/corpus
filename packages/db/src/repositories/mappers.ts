/** Row → entity mapping. SQLite has no boolean or date types, so normalise here. */

import type {
  Application,
  ApplicationEvent,
  Candidate,
  Department,
  DocumentChunk,
  DocumentVersion,
  Employee,
  Holiday,
  Interview,
  Job,
  JobRequirement,
  KnowledgeDocument,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  Offer,
  Position,
  Tenant,
  TelegramAccount,
  User,
} from '@corpus/domain'

export type Row = Record<string, unknown>

export const asString = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
export const asStringOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v)
export const asNumber = (v: unknown): number => Number(v ?? 0)
export const asNumberOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)
export const asBool = (v: unknown): boolean => v === 1 || v === true || v === '1'
export const boolToInt = (v: boolean): number => (v ? 1 : 0)

export const mapTenant = (r: Row): Tenant => ({
  id: asString(r.id),
  slug: asString(r.slug),
  name: asString(r.name),
  status: asString(r.status) as Tenant['status'],
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapUser = (r: Row): User => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  email: asString(r.email),
  displayName: asString(r.display_name),
  status: asString(r.status) as User['status'],
  employeeId: asStringOrNull(r.employee_id),
  lastLoginAt: asStringOrNull(r.last_login_at),
  failedLoginCount: asNumber(r.failed_login_count),
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapTelegramAccount = (r: Row): TelegramAccount => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  telegramUserId: asString(r.telegram_user_id),
  employeeId: asStringOrNull(r.employee_id),
  userId: asStringOrNull(r.user_id),
  scope: asString(r.scope) as TelegramAccount['scope'],
  verifiedAt: asStringOrNull(r.verified_at),
  revokedAt: asStringOrNull(r.revoked_at),
  createdAt: asString(r.created_at),
})

export const mapDepartment = (r: Row): Department => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  code: asString(r.code),
  name: asString(r.name),
  parentId: asStringOrNull(r.parent_id),
})

export const mapPosition = (r: Row): Position => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  code: asString(r.code),
  title: asString(r.title),
  level: asStringOrNull(r.level),
})

export const mapEmployee = (r: Row): Employee => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  employeeNo: asString(r.employee_no),
  firstName: asString(r.first_name),
  lastName: asString(r.last_name),
  email: asString(r.email),
  phone: asStringOrNull(r.phone),
  departmentId: asStringOrNull(r.department_id),
  positionId: asStringOrNull(r.position_id),
  managerId: asStringOrNull(r.manager_id),
  hireDate: asString(r.hire_date),
  employmentType: asString(r.employment_type) as Employee['employmentType'],
  status: asString(r.status) as Employee['status'],
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapJob = (r: Row): Job => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  jobCode: asString(r.job_code),
  title: asString(r.title),
  departmentId: asStringOrNull(r.department_id),
  location: asStringOrNull(r.location),
  employmentType: asString(r.employment_type) as Job['employmentType'],
  description: asString(r.description),
  salaryMin: asNumberOrNull(r.salary_min),
  salaryMax: asNumberOrNull(r.salary_max),
  currency: asStringOrNull(r.currency),
  remoteAllowed: asBool(r.remote_allowed),
  experienceMin: asNumberOrNull(r.experience_min),
  status: asString(r.status) as Job['status'],
  publishedAt: asStringOrNull(r.published_at),
  closingDate: asStringOrNull(r.closing_date),
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapJobRequirement = (r: Row): JobRequirement => ({
  id: asString(r.id),
  jobId: asString(r.job_id),
  requirementType: asString(r.requirement_type) as JobRequirement['requirementType'],
  description: asString(r.description),
  mandatory: asBool(r.mandatory),
  priority: asNumber(r.priority),
})

export const mapCandidate = (r: Row): Candidate => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  name: asString(r.name),
  email: asString(r.email),
  phone: asStringOrNull(r.phone),
  telegramUserId: asStringOrNull(r.telegram_user_id),
  cvFileId: asStringOrNull(r.cv_file_id),
  source: asString(r.source),
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapApplication = (r: Row): Application => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  candidateId: asString(r.candidate_id),
  jobId: asString(r.job_id),
  stage: asString(r.stage) as Application['stage'],
  status: asString(r.status) as Application['status'],
  reference: asString(r.reference),
  appliedAt: asString(r.applied_at),
  updatedAt: asString(r.updated_at),
})

export const mapApplicationEvent = (r: Row): ApplicationEvent => ({
  id: asString(r.id),
  applicationId: asString(r.application_id),
  tenantId: asString(r.tenant_id),
  fromStage: asStringOrNull(r.from_stage) as ApplicationEvent['fromStage'],
  toStage: asString(r.to_stage) as ApplicationEvent['toStage'],
  note: asStringOrNull(r.note),
  actorUserId: asStringOrNull(r.actor_user_id),
  createdAt: asString(r.created_at),
})

export const mapInterview = (r: Row): Interview => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  applicationId: asString(r.application_id),
  scheduledAt: asString(r.scheduled_at),
  durationMinutes: asNumber(r.duration_minutes),
  mode: asString(r.mode) as Interview['mode'],
  interviewerEmployeeId: asStringOrNull(r.interviewer_employee_id),
  status: asString(r.status) as Interview['status'],
  evaluation: asStringOrNull(r.evaluation),
  score: asNumberOrNull(r.score),
  createdAt: asString(r.created_at),
})

export const mapOffer = (r: Row): Offer => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  applicationId: asString(r.application_id),
  baseSalary: asNumber(r.base_salary),
  currency: asString(r.currency),
  startDate: asString(r.start_date),
  status: asString(r.status) as Offer['status'],
  expiresAt: asStringOrNull(r.expires_at),
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapLeaveType = (r: Row): LeaveType => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  code: asString(r.code),
  name: asString(r.name),
  paid: asBool(r.paid),
  requiresApproval: asBool(r.requires_approval),
  maxConsecutiveDays: asNumberOrNull(r.max_consecutive_days),
  countsWorkingDaysOnly: asBool(r.counts_working_days_only),
  active: asBool(r.active),
})

export const mapLeaveBalance = (r: Row): LeaveBalance => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  employeeId: asString(r.employee_id),
  leaveTypeId: asString(r.leave_type_id),
  year: asNumber(r.year),
  entitledDays: asNumber(r.entitled_days),
  usedDays: asNumber(r.used_days),
  pendingDays: asNumber(r.pending_days),
  carriedOverDays: asNumber(r.carried_over_days),
})

export const mapLeaveRequest = (r: Row): LeaveRequest => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  employeeId: asString(r.employee_id),
  leaveTypeId: asString(r.leave_type_id),
  startDate: asString(r.start_date),
  endDate: asString(r.end_date),
  workingDays: asNumber(r.working_days),
  reason: asStringOrNull(r.reason),
  status: asString(r.status) as LeaveRequest['status'],
  submittedAt: asString(r.submitted_at),
  decidedAt: asStringOrNull(r.decided_at),
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapHoliday = (r: Row): Holiday => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  date: asString(r.date),
  name: asString(r.name),
  recurring: asBool(r.recurring),
  region: asStringOrNull(r.region),
})

export const mapDocument = (r: Row): KnowledgeDocument => ({
  id: asString(r.id),
  tenantId: asString(r.tenant_id),
  name: asString(r.name),
  category: asString(r.category),
  classification: asString(r.classification) as KnowledgeDocument['classification'],
  owner: asStringOrNull(r.owner),
  status: asString(r.status) as KnowledgeDocument['status'],
  createdAt: asString(r.created_at),
  updatedAt: asString(r.updated_at),
})

export const mapDocumentVersion = (r: Row): DocumentVersion => ({
  id: asString(r.id),
  documentId: asString(r.document_id),
  tenantId: asString(r.tenant_id),
  version: asNumber(r.version),
  effectiveFrom: asString(r.effective_from),
  effectiveTo: asStringOrNull(r.effective_to),
  filePath: asStringOrNull(r.file_path),
  contentType: asStringOrNull(r.content_type),
  byteSize: asNumberOrNull(r.byte_size),
  createdAt: asString(r.created_at),
  createdBy: asStringOrNull(r.created_by),
})

export const mapDocumentChunk = (r: Row): DocumentChunk => ({
  id: asString(r.id),
  documentId: asString(r.document_id),
  documentVersionId: asString(r.document_version_id),
  tenantId: asString(r.tenant_id),
  version: asNumber(r.version),
  classification: asString(r.classification) as DocumentChunk['classification'],
  effectiveFrom: asString(r.effective_from),
  effectiveTo: asStringOrNull(r.effective_to),
  section: asStringOrNull(r.section),
  page: asNumberOrNull(r.page),
  ordinal: asNumber(r.ordinal),
  content: asString(r.content),
})
