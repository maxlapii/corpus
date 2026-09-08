/**
 * Repository container. Constructed once per request from the DatabaseService,
 * so every service and AI tool reaches the database through the same surface.
 */

import type { DatabaseService } from '../database-service.js'
import { AuditRepository, SecurityEventRepository } from './audit.js'
import { ConversationRepository } from './conversations.js'
import {
  CompensationRepository,
  DepartmentRepository,
  EmployeeRepository,
  PositionRepository,
} from './employees.js'
import { KnowledgeRepository } from './knowledge.js'
import {
  HolidayRepository,
  LeaveBalanceRepository,
  LeaveRequestRepository,
  LeaveTypeRepository,
} from './leave.js'
import {
  ApplicationRepository,
  CandidateRepository,
  InterviewRepository,
  JobRepository,
  JobRequirementRepository,
  OfferRepository,
} from './recruitment.js'
import { TenantRepository } from './tenants.js'
import {
  SessionRepository,
  TelegramAccountRepository,
  UserRepository,
  VerificationCodeRepository,
} from './users.js'

export interface Repositories {
  tenants: TenantRepository
  users: UserRepository
  sessions: SessionRepository
  telegramAccounts: TelegramAccountRepository
  verificationCodes: VerificationCodeRepository
  employees: EmployeeRepository
  compensation: CompensationRepository
  departments: DepartmentRepository
  positions: PositionRepository
  leaveTypes: LeaveTypeRepository
  leaveBalances: LeaveBalanceRepository
  leaveRequests: LeaveRequestRepository
  holidays: HolidayRepository
  jobs: JobRepository
  jobRequirements: JobRequirementRepository
  candidates: CandidateRepository
  applications: ApplicationRepository
  interviews: InterviewRepository
  offers: OfferRepository
  knowledge: KnowledgeRepository
  audit: AuditRepository
  securityEvents: SecurityEventRepository
  conversations: ConversationRepository
}

export function createRepositories(db: DatabaseService): Repositories {
  return {
    tenants: new TenantRepository(db),
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    telegramAccounts: new TelegramAccountRepository(db),
    verificationCodes: new VerificationCodeRepository(db),
    employees: new EmployeeRepository(db),
    compensation: new CompensationRepository(db),
    departments: new DepartmentRepository(db),
    positions: new PositionRepository(db),
    leaveTypes: new LeaveTypeRepository(db),
    leaveBalances: new LeaveBalanceRepository(db),
    leaveRequests: new LeaveRequestRepository(db),
    holidays: new HolidayRepository(db),
    jobs: new JobRepository(db),
    jobRequirements: new JobRequirementRepository(db),
    candidates: new CandidateRepository(db),
    applications: new ApplicationRepository(db),
    interviews: new InterviewRepository(db),
    offers: new OfferRepository(db),
    knowledge: new KnowledgeRepository(db),
    audit: new AuditRepository(db),
    securityEvents: new SecurityEventRepository(db),
    conversations: new ConversationRepository(db),
  }
}

export * from './audit.js'
export * from './conversations.js'
export * from './employees.js'
export * from './knowledge.js'
export * from './leave.js'
export * from './mappers.js'
export * from './recruitment.js'
export * from './tenants.js'
export * from './users.js'
