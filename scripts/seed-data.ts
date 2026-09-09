/**
 * Development seed data (CLAUDE.md §50).
 *
 * ALL OF THIS IS FICTIONAL TEST DATA. Names, e-mails and figures are invented;
 * every account is marked as development data and every e-mail uses the
 * reserved `corpus.test` domain so it cannot reach a real inbox.
 *
 * Shared by `scripts/seed.ts` and the integration/e2e tests, so the tests
 * exercise the same fixtures an operator sees locally.
 */

import { hashPassword } from '@corpus/auth'
import { tenantScope, type Repositories } from '@corpus/db'
import type { Role } from '@corpus/domain'

export const SEED_MARKER = 'DEVELOPMENT SEED DATA — NOT REAL PEOPLE'

export interface SeedOptions {
  tenantSlug?: string
  tenantName?: string
  password?: string
  /** Reference date used for hire dates, balances and leave requests. */
  today?: string
}

export interface SeededEmployee {
  id: string
  employeeNo: string
  email: string
  userId: string | null
  roles: Role[]
}

export interface SeedResult {
  tenantId: string
  password: string
  employees: Record<string, SeededEmployee>
  leaveTypeIds: Record<string, string>
  jobIds: Record<string, string>
  documentIds: Record<string, string>
  answerIds: Record<string, string>
}

const DEPARTMENTS = [
  { code: 'HR', name: 'Human Resources' },
  { code: 'ENG', name: 'Engineering' },
  { code: 'FIN', name: 'Finance' },
  { code: 'SLS', name: 'Sales' },
  { code: 'OPS', name: 'Operations' },
]

const POSITIONS = [
  { code: 'HRBP', title: 'HR Business Partner', level: 'M2' },
  { code: 'HRD', title: 'HR Director', level: 'M4' },
  { code: 'SWE', title: 'Software Engineer', level: 'P3' },
  { code: 'SWE-SR', title: 'Senior Software Engineer', level: 'P4' },
  { code: 'EM', title: 'Engineering Manager', level: 'M3' },
  { code: 'ACC', title: 'Accountant', level: 'P2' },
  { code: 'AE', title: 'Account Executive', level: 'P3' },
  { code: 'PLAT', title: 'Platform Administrator', level: 'P4' },
]

const LEAVE_TYPES = [
  { code: 'ANNUAL', name: 'Annual Leave', paid: true, requiresApproval: true, maxConsecutiveDays: 20, entitled: 18 },
  { code: 'SICK', name: 'Sick Leave', paid: true, requiresApproval: false, maxConsecutiveDays: 10, entitled: 10 },
  { code: 'UNPAID', name: 'Unpaid Leave', paid: false, requiresApproval: true, maxConsecutiveDays: 30, entitled: 30 },
  { code: 'PARENTAL', name: 'Parental Leave', paid: true, requiresApproval: true, maxConsecutiveDays: 90, entitled: 90 },
]

/**
 * Local part of every seeded address, so one mailbox owner can reach all seven
 * accounts. The surname keeps them distinct: `lapii.director@corpus.test`.
 */
const SEED_EMAIL_PREFIX = 'lapii'

/** Fictional staff. `manager` refers to another entry's key. */
const PEOPLE = [
  { key: 'admin', employeeNo: 'E0001', firstName: 'Alex', lastName: 'Admin', department: 'OPS', position: 'PLAT', roles: ['SYSTEM_ADMIN'] as Role[], manager: null },
  { key: 'hrAdmin', employeeNo: 'E0002', firstName: 'Hana', lastName: 'Director', department: 'HR', position: 'HRD', roles: ['HR_ADMIN'] as Role[], manager: null },
  { key: 'hr', employeeNo: 'E0003', firstName: 'Rita', lastName: 'Partner', department: 'HR', position: 'HRBP', roles: ['HR'] as Role[], manager: 'hrAdmin' },
  { key: 'manager', employeeNo: 'E0004', firstName: 'Marco', lastName: 'Lead', department: 'ENG', position: 'EM', roles: ['MANAGER'] as Role[], manager: 'hrAdmin' },
  { key: 'employee', employeeNo: 'E0005', firstName: 'Elena', lastName: 'Dev', department: 'ENG', position: 'SWE', roles: ['EMPLOYEE'] as Role[], manager: 'manager' },
  { key: 'employee2', employeeNo: 'E0006', firstName: 'Sam', lastName: 'Coder', department: 'ENG', position: 'SWE-SR', roles: ['EMPLOYEE'] as Role[], manager: 'manager' },
  // Deliberately reports to someone else, to test manager scoping.
  { key: 'outsider', employeeNo: 'E0007', firstName: 'Nadia', lastName: 'Sales', department: 'SLS', position: 'AE', roles: ['EMPLOYEE'] as Role[], manager: 'hrAdmin' },
]

const JOBS = [
  {
    key: 'eng001',
    jobCode: 'ENG-001',
    title: 'Senior Backend Engineer',
    department: 'ENG',
    location: 'Phnom Penh',
    employmentType: 'FULL_TIME' as const,
    description:
      'We are looking for a senior backend engineer to build and operate our platform APIs. ' +
      'You will design services, own reliability, and mentor other engineers.',
    salaryMin: 3500,
    salaryMax: 5000,
    currency: 'USD',
    remoteAllowed: true,
    experienceMin: 5,
    status: 'PUBLISHED' as const,
    salaryPublic: true,
    requirements: [
      { requirementType: 'EXPERIENCE' as const, description: 'At least 5 years building production backend services', mandatory: true, priority: 10 },
      { requirementType: 'SKILL' as const, description: 'TypeScript or Go, and relational database design', mandatory: true, priority: 20 },
      { requirementType: 'SKILL' as const, description: 'Experience with serverless or edge platforms', mandatory: false, priority: 30 },
      { requirementType: 'LANGUAGE' as const, description: 'Professional English', mandatory: true, priority: 40 },
    ],
  },
  {
    key: 'hr001',
    jobCode: 'HR-001',
    title: 'HR Operations Specialist',
    department: 'HR',
    location: 'Phnom Penh',
    employmentType: 'FULL_TIME' as const,
    description:
      'Support the HR team with onboarding, records administration and leave management.',
    salaryMin: 1200,
    salaryMax: 1800,
    currency: 'USD',
    remoteAllowed: false,
    experienceMin: 2,
    status: 'PUBLISHED' as const,
    // Salary range withheld from public listings for this role.
    salaryPublic: false,
    requirements: [
      { requirementType: 'EXPERIENCE' as const, description: 'Two years in an HR administration role', mandatory: true, priority: 10 },
      { requirementType: 'EDUCATION' as const, description: 'Degree in Human Resources or a related field', mandatory: false, priority: 20 },
    ],
  },
  {
    key: 'draft',
    jobCode: 'FIN-001',
    title: 'Financial Analyst',
    department: 'FIN',
    location: 'Phnom Penh',
    employmentType: 'FULL_TIME' as const,
    description: 'Draft posting, not yet approved for publication.',
    salaryMin: 2000,
    salaryMax: 2800,
    currency: 'USD',
    remoteAllowed: false,
    experienceMin: 3,
    // Stays DRAFT so tests can assert it is invisible externally.
    status: 'DRAFT' as const,
    salaryPublic: false,
    requirements: [],
  },
]

const CANDIDATES = [
  { name: 'Jordan Applicant', email: 'jordan.applicant@example.test', phone: '+855100000001', source: 'WEB', jobKey: 'eng001' },
  { name: 'Priya Seeker', email: 'priya.seeker@example.test', phone: '+855100000002', source: 'TELEGRAM', jobKey: 'eng001' },
  { name: 'Chen Hopeful', email: 'chen.hopeful@example.test', phone: null, source: 'REFERRAL', jobKey: 'hr001' },
]

/** Policy documents, with a deliberate spread of classifications (§9). */
const DOCUMENTS = [
  {
    key: 'handbook',
    name: 'Employee Handbook',
    category: 'HANDBOOK',
    classification: 'INTERNAL' as const,
    owner: 'People Team',
    text: `EMPLOYEE HANDBOOK

WORKING HOURS
Standard working hours are 08:30 to 17:30, Monday to Friday, with one hour for lunch.
Flexible start times between 08:00 and 09:30 are available with your manager's agreement.

ANNUAL LEAVE
Full-time employees accrue 18 days of paid annual leave per calendar year.
Leave accrues monthly and is available from the first full month of employment.
Up to 5 unused days may be carried into the following year and must be used by 31 March.
Annual leave must be requested through the HR system and approved by your manager.

SICK LEAVE
Employees are entitled to 10 days of paid sick leave per calendar year.
Absences of three consecutive days or more require a medical certificate.
Sick leave does not require prior approval but must be reported on the first day of absence.

PROBATION PERIOD
New employees serve a probation period of three months.
During probation either party may terminate with seven days' written notice.

NOTICE PERIOD
After probation, the notice period is 30 days for individual contributors and
60 days for managers.

OVERTIME
Overtime must be approved in advance by your manager. Approved overtime on a
working day is paid at 150 percent of the normal hourly rate, and on a public
holiday at 200 percent.

PUBLIC HOLIDAYS
The company observes the public holidays published each year by HR. Where a
public holiday falls on a weekend, no substitute day is granted.

EXPENSES
Business expenses must be submitted within 30 days with a valid receipt.
Expenses over 200 USD require prior written approval.

DRESS CODE
Business casual is expected in the office. Client-facing meetings require
business attire.`,
  },
  {
    key: 'parental',
    name: 'Parental Leave Policy',
    category: 'POLICY',
    classification: 'INTERNAL' as const,
    owner: 'People Team',
    text: `PARENTAL LEAVE POLICY

ELIGIBILITY
Employees with at least 12 months of continuous service are eligible for paid
parental leave.

ENTITLEMENT
Primary carers are entitled to 90 calendar days of paid parental leave.
Secondary carers are entitled to 14 calendar days of paid parental leave.

NOTICE
Requests should be submitted at least 60 days before the intended start date,
together with supporting documentation.

RETURN TO WORK
Employees returning from parental leave may request a phased return over four
weeks, subject to manager agreement.`,
  },
  {
    key: 'grievance',
    name: 'HR Investigation Procedure',
    category: 'PROCEDURE',
    classification: 'CONFIDENTIAL' as const,
    owner: 'HR Director',
    text: `HR INVESTIGATION PROCEDURE

SCOPE
This procedure governs how HR investigates grievances and alleged misconduct.
It is confidential and intended for HR practitioners.

INVESTIGATION STEPS
1. Acknowledge the complaint within two working days.
2. Appoint an investigating officer with no conflict of interest.
3. Gather documentary evidence before conducting interviews.
4. Interview the complainant, the respondent, and any witnesses separately.
5. Produce a written findings report with a recommendation.

CONFIDENTIALITY
Investigation materials are held by HR and are not shared with line managers
except where necessary to implement an outcome.`,
  },
  {
    key: 'salaryBands',
    name: 'Salary Band Framework',
    category: 'COMPENSATION',
    classification: 'RESTRICTED' as const,
    owner: 'HR Director',
    text: `SALARY BAND FRAMEWORK

PURPOSE
This document defines the salary bands used for offers and annual review.
It is RESTRICTED and available only to HR administration.

BANDS
P2 Associate: 1200 to 1800 USD per month.
P3 Professional: 1800 to 2800 USD per month.
P4 Senior: 2800 to 4200 USD per month.
M3 Manager: 3200 to 4800 USD per month.
M4 Director: 4800 to 7000 USD per month.

REVIEW
Bands are reviewed annually against market data by the HR Director and Finance.`,
  },
]

const HOLIDAYS = [
  { month: 1, day: 1, name: 'International New Year' },
  { month: 4, day: 14, name: 'Khmer New Year' },
  { month: 5, day: 1, name: 'Labour Day' },
  { month: 9, day: 24, name: 'Constitution Day' },
  { month: 11, day: 9, name: 'Independence Day' },
  { month: 12, day: 25, name: 'Company Winter Holiday' },
]


/**
 * Curated bot answers, so both bots have something trained out of the box.
 * EXTERNAL/BOTH entries are PUBLIC by construction — the same rule the schema
 * and `validateAnswerDraft` enforce.
 */
const CURATED_ANSWERS = [
  {
    question: 'How do I apply for a job?',
    answer:
      'Ask me to search for openings, then tell me the job code you want. ' +
      'I will need your full name and e-mail address to submit the application.',
    category: 'RECRUITMENT',
    audience: 'EXTERNAL' as const,
    classification: 'PUBLIC' as const,
    phrases: ['how to apply', 'where do I send my CV', 'application process', 'can I apply here'],
  },
  {
    question: 'What benefits do you offer?',
    answer:
      'Full-time staff receive health cover from their first day, 18 days of paid annual leave, ' +
      'and a company pension contribution.',
    category: 'GENERAL',
    audience: 'BOTH' as const,
    classification: 'PUBLIC' as const,
    command: 'benefits',
    commandDescription: 'What we offer employees',
    phrases: ['what benefits do you have', 'company benefits', 'perks'],
  },
  {
    question: 'Do you offer remote or hybrid work?',
    answer:
      'Some roles are remote-friendly. Each job advert states whether remote work is allowed, ' +
      'so check the specific opening you are interested in.',
    category: 'RECRUITMENT',
    audience: 'EXTERNAL' as const,
    classification: 'PUBLIC' as const,
    phrases: ['is this job remote', 'work from home', 'hybrid working', 'remote policy for candidates'],
  },
  {
    question: 'How long does the hiring process take?',
    answer:
      'Most hiring decisions are made within four weeks of the closing date. ' +
      'You will hear from the recruitment team at each stage.',
    category: 'RECRUITMENT',
    audience: 'BOTH' as const,
    classification: 'PUBLIC' as const,
    phrases: ['how long until I hear back', 'hiring timeline', 'when will I get a response'],
  },
  {
    question: 'How do I reset my payroll portal password?',
    answer:
      'Use the "Forgot password" link on the payroll portal sign-in page. ' +
      'If the reset e-mail does not arrive within ten minutes, contact HR.',
    category: 'IT',
    audience: 'INTERNAL' as const,
    classification: 'INTERNAL' as const,
    // Credential-adjacent, so it stays behind a verified account.
    requiresAccount: true,
    phrases: ['payroll password reset', 'locked out of payroll', 'cannot sign in to payroll'],
  },
  {
    question: 'Who approves my leave request?',
    answer:
      'Your direct manager approves leave. If they are unavailable for more than three working days, ' +
      'HR can approve on their behalf.',
    category: 'LEAVE',
    audience: 'INTERNAL' as const,
    // General process information: PUBLIC, and answerable before someone links
    // their Telegram account. Their own balance still is not.
    classification: 'PUBLIC' as const,
    requiresAccount: false,
    phrases: ['who signs off my leave', 'leave approval chain', 'manager approve holiday'],
  },
  {
    question: 'How do I contact the HR team?',
    command: 'hr',
    commandDescription: 'How to reach the HR team',
    answer:
      'Reach the HR team through the internal helpdesk, or ask this assistant. ' +
      'The team answers within one working day.',
    category: 'GENERAL',
    audience: 'INTERNAL' as const,
    classification: 'PUBLIC' as const,
    requiresAccount: false,
    phrases: ['how do I reach HR', 'contact human resources', 'HR helpdesk'],
  },
]

/**
 * Populate a database with the development fixture set.
 * Idempotent enough to re-run on an existing database: existing rows are reused.
 */
export async function seedDatabase(
  repos: Repositories,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const slug = options.tenantSlug ?? process.env.DEFAULT_TENANT_SLUG ?? 'default'
  const name = options.tenantName ?? 'CORPUS Demo Company'
  const password = options.password ?? process.env.SEED_PASSWORD ?? '@@1234$$qwer'
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const year = Number(today.slice(0, 4))

  const tenant =
    (await repos.tenants.findBySlug(slug)) ?? (await repos.tenants.create({ slug, name }))
  const scope = tenantScope(tenant.id)

  // --- Organisation
  const departments = new Map<string, string>()
  for (const department of DEPARTMENTS) {
    const existing = await repos.departments.findByCode(scope, department.code)
    departments.set(
      department.code,
      existing?.id ?? (await repos.departments.create(scope, department)).id,
    )
  }

  const positions = new Map<string, string>()
  const existingPositions = await repos.positions.list(scope)
  for (const position of POSITIONS) {
    const existing = existingPositions.find((p) => p.code === position.code)
    positions.set(position.code, existing?.id ?? (await repos.positions.create(scope, position)).id)
  }

  // --- People
  const passwordHash = await hashPassword(password)
  const employees: Record<string, SeededEmployee> = {}

  // Two passes so manager references resolve.
  for (const person of PEOPLE) {
    const email = `${SEED_EMAIL_PREFIX}.${person.lastName}`.toLowerCase() + '@corpus.test'
    const existing = await repos.employees.findByEmployeeNo(scope, person.employeeNo)
    const employee =
      existing ??
      (await repos.employees.create(scope, {
        employeeNo: person.employeeNo,
        firstName: person.firstName,
        lastName: person.lastName,
        email,
        phone: null,
        departmentId: departments.get(person.department) ?? null,
        positionId: positions.get(person.position) ?? null,
        managerId: null,
        hireDate: `${year - 2}-03-01`,
        employmentType: 'FULL_TIME',
      }))

    const existingUser = await repos.users.findByEmployeeId(scope, employee.id)
    const user =
      existingUser ??
      (await repos.users.create(scope, {
        email,
        displayName: `${person.firstName} ${person.lastName}`,
        passwordHash,
        employeeId: employee.id,
      }))
    for (const role of person.roles) {
      await repos.users.grantRole(scope, user.id, role, null)
    }

    employees[person.key] = {
      id: employee.id,
      employeeNo: employee.employeeNo,
      email,
      userId: user.id,
      roles: person.roles,
    }
  }

  for (const person of PEOPLE) {
    if (!person.manager) continue
    const self = employees[person.key]
    const manager = employees[person.manager]
    if (self && manager) {
      await repos.employees.update(scope, self.id, { managerId: manager.id })
    }
  }

  // --- Leave
  const leaveTypeIds: Record<string, string> = {}
  for (const type of LEAVE_TYPES) {
    const existing = await repos.leaveTypes.findByCode(scope, type.code)
    const created =
      existing ??
      (await repos.leaveTypes.create(scope, {
        code: type.code,
        name: type.name,
        paid: type.paid,
        requiresApproval: type.requiresApproval,
        maxConsecutiveDays: type.maxConsecutiveDays,
      }))
    leaveTypeIds[type.code] = created.id

    for (const employee of Object.values(employees)) {
      await repos.leaveBalances.upsert(scope, {
        employeeId: employee.id,
        leaveTypeId: created.id,
        year,
        entitledDays: type.entitled,
        carriedOverDays: type.code === 'ANNUAL' ? 2 : 0,
      })
    }
  }

  for (const holiday of HOLIDAYS) {
    const date = `${year}-${String(holiday.month).padStart(2, '0')}-${String(holiday.day).padStart(2, '0')}`
    const existing = await repos.holidays.listBetween(scope, date, date)
    if (existing.length === 0) {
      await repos.holidays.create(scope, { date, name: holiday.name, recurring: true })
    }
  }

  // --- Recruitment
  const jobIds: Record<string, string> = {}
  for (const job of JOBS) {
    const existing = await repos.jobs.findByIdOrCode(scope, job.jobCode)
    const created =
      existing ??
      (await repos.jobs.create(scope, {
        jobCode: job.jobCode,
        title: job.title,
        departmentId: departments.get(job.department) ?? null,
        location: job.location,
        employmentType: job.employmentType,
        description: job.description,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        currency: job.currency,
        remoteAllowed: job.remoteAllowed,
        experienceMin: job.experienceMin,
        status: job.status,
        salaryPublic: job.salaryPublic,
        closingDate: null,
      }))
    jobIds[job.key] = created.id

    const existingRequirements = await repos.jobRequirements.listForJob(scope, created.id)
    if (existingRequirements.length === 0) {
      for (const requirement of job.requirements) {
        await repos.jobRequirements.create(scope, { jobId: created.id, ...requirement })
      }
    }
  }

  for (const candidate of CANDIDATES) {
    const created = await repos.candidates.createOrGet(scope, {
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      source: candidate.source,
    })
    const jobId = jobIds[candidate.jobKey]
    if (!jobId) continue
    const existing = (await repos.applications.listForCandidate(scope, created.id)).find(
      (a) => a.jobId === jobId,
    )
    if (!existing) {
      await repos.applications.create(scope, { candidateId: created.id, jobId })
    }
  }

  // --- Knowledge
  const documentIds: Record<string, string> = {}
  for (const document of DOCUMENTS) {
    const existing = await repos.knowledge.findDocumentByName(scope, document.name)
    const created =
      existing ??
      (await repos.knowledge.createDocument(scope, {
        name: document.name,
        category: document.category,
        classification: document.classification,
        owner: document.owner,
        status: 'DRAFT',
      }))
    documentIds[document.key] = created.id
  }

  // --- Curated bot answers
  const answerIds: Record<string, string> = {}
  for (const curated of CURATED_ANSWERS) {
    const existing = await repos.knowledgeAnswers.findByQuestion(scope, curated.question)
    const created =
      existing ??
      (await repos.knowledgeAnswers.create(scope, {
        question: curated.question,
        answer: curated.answer,
        category: curated.category,
        audience: curated.audience,
        classification: curated.classification,
        status: 'ACTIVE',
        ...(curated.requiresAccount === undefined ? {} : { requiresAccount: curated.requiresAccount }),
        ...('command' in curated && curated.command
          ? { command: curated.command, commandDescription: curated.commandDescription }
          : {}),
        effectiveFrom: `${year - 1}-01-01`,
        effectiveTo: null,
        phrases: curated.phrases,
        actorUserId: null,
      }))
    answerIds[curated.question] = created.id
  }

  return { tenantId: tenant.id, password, employees, leaveTypeIds, jobIds, documentIds, answerIds }
}

/** Document texts, exposed so the ingestion pipeline can index them. */
export const SEED_DOCUMENT_TEXTS: Record<string, { name: string; text: string }> =
  Object.fromEntries(DOCUMENTS.map((d) => [d.key, { name: d.name, text: d.text }]))
