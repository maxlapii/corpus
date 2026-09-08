/** Jobs, requirements, candidates, applications, interviews and offers. */

import { escapeLike, nowIso, prefixedId, randomToken, type DateOnly } from '@corpus/shared'
import type {
  Application,
  ApplicationEvent,
  ApplicationStage,
  Candidate,
  Interview,
  Job,
  JobRequirement,
  Offer,
} from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { assertSameTenant, type TenantScope } from '../tenant.js'
import {
  boolToInt,
  mapApplication,
  mapApplicationEvent,
  mapCandidate,
  mapInterview,
  mapJob,
  mapJobRequirement,
  mapOffer,
  type Row,
} from './mappers.js'

export interface JobSearchFilters {
  query?: string
  departmentId?: string
  location?: string
  employmentType?: Job['employmentType']
  remoteOnly?: boolean
  /** When set, only these statuses are returned. Callers in the EXTERNAL zone
   *  must pass `['PUBLISHED']`; the repository never widens it. */
  statuses: readonly Job['status'][]
}

/** Public projection of a job: no internal salary range unless flagged public. */
export interface PublicJob {
  id: string
  jobCode: string
  title: string
  location: string | null
  employmentType: Job['employmentType']
  description: string
  remoteAllowed: boolean
  experienceMin: number | null
  closingDate: DateOnly | null
  publishedAt: string | null
  salaryRange: { min: number | null; max: number | null; currency: string | null } | null
}

export class JobRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(scope: TenantScope, id: string): Promise<Job | null> {
    const row = await this.db.one<Row>('SELECT * FROM jobs WHERE tenant_id = ? AND id = ?', [
      scope.tenantId,
      id,
    ])
    assertSameTenant(scope, row as { tenant_id?: string } | null)
    return row ? mapJob(row) : null
  }

  /** Look up by id or human job code — both are safe to expose publicly. */
  async findByIdOrCode(scope: TenantScope, idOrCode: string): Promise<Job | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM jobs WHERE tenant_id = ? AND (id = ? OR job_code = ?)',
      [scope.tenantId, idOrCode, idOrCode.toUpperCase()],
    )
    return row ? mapJob(row) : null
  }

  async isSalaryPublic(scope: TenantScope, jobId: string): Promise<boolean> {
    const row = await this.db.one<{ salary_public: number }>(
      'SELECT salary_public FROM jobs WHERE tenant_id = ? AND id = ?',
      [scope.tenantId, jobId],
    )
    return Number(row?.salary_public ?? 0) === 1
  }

  async search(
    scope: TenantScope,
    filters: JobSearchFilters,
    limit: number,
    offset: number,
  ): Promise<{ items: Job[]; total: number }> {
    if (filters.statuses.length === 0) return { items: [], total: 0 }

    const where = ['tenant_id = ?', `status IN (${filters.statuses.map(() => '?').join(', ')})`]
    const params: (string | number)[] = [scope.tenantId, ...filters.statuses]

    if (filters.query) {
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR job_code LIKE ? ESCAPE '\\')")
      const like = `%${escapeLike(filters.query)}%`
      params.push(like, like, like)
    }
    if (filters.departmentId) {
      where.push('department_id = ?')
      params.push(filters.departmentId)
    }
    if (filters.location) {
      where.push("location LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(filters.location)}%`)
    }
    if (filters.employmentType) {
      where.push('employment_type = ?')
      params.push(filters.employmentType)
    }
    if (filters.remoteOnly) where.push('remote_allowed = 1')

    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `SELECT * FROM jobs WHERE ${clause}
        ORDER BY COALESCE(published_at, created_at) DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM jobs WHERE ${clause}`, params)
    return { items: rows.map(mapJob), total }
  }

  async create(
    scope: TenantScope,
    input: {
      jobCode: string
      title: string
      departmentId?: string | null
      location?: string | null
      employmentType: Job['employmentType']
      description: string
      salaryMin?: number | null
      salaryMax?: number | null
      currency?: string | null
      remoteAllowed?: boolean
      experienceMin?: number | null
      status?: Job['status']
      salaryPublic?: boolean
      closingDate?: DateOnly | null
    },
  ): Promise<Job> {
    const id = prefixedId('job')
    const ts = nowIso()
    const status = input.status ?? 'DRAFT'
    await this.db.run(
      `INSERT INTO jobs
         (id, tenant_id, job_code, title, department_id, location, employment_type, description,
          salary_min, salary_max, currency, remote_allowed, experience_min, status,
          salary_public, published_at, closing_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.jobCode.toUpperCase(),
        input.title,
        input.departmentId ?? null,
        input.location ?? null,
        input.employmentType,
        input.description,
        input.salaryMin ?? null,
        input.salaryMax ?? null,
        input.currency ?? null,
        boolToInt(input.remoteAllowed ?? false),
        input.experienceMin ?? null,
        status,
        boolToInt(input.salaryPublic ?? false),
        status === 'PUBLISHED' ? ts : null,
        input.closingDate ?? null,
        ts,
        ts,
      ],
    )
    const created = await this.findById(scope, id)
    if (!created) throw new Error('job insert did not persist')
    return created
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: Partial<{
      title: string
      departmentId: string | null
      location: string | null
      employmentType: Job['employmentType']
      description: string
      salaryMin: number | null
      salaryMax: number | null
      currency: string | null
      remoteAllowed: boolean
      experienceMin: number | null
      status: Job['status']
      salaryPublic: boolean
      closingDate: DateOnly | null
    }>,
  ): Promise<Job | null> {
    const columns: Record<string, string> = {
      title: 'title',
      departmentId: 'department_id',
      location: 'location',
      employmentType: 'employment_type',
      description: 'description',
      salaryMin: 'salary_min',
      salaryMax: 'salary_max',
      currency: 'currency',
      remoteAllowed: 'remote_allowed',
      experienceMin: 'experience_min',
      status: 'status',
      salaryPublic: 'salary_public',
      closingDate: 'closing_date',
    }
    const sets: string[] = []
    const params: (string | number | null)[] = []
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue
      const value = (patch as Record<string, unknown>)[key]
      sets.push(`${column} = ?`)
      params.push(typeof value === 'boolean' ? boolToInt(value) : ((value as string | number | null) ?? null))
    }
    if (sets.length === 0) return this.findById(scope, id)
    // Stamp published_at the first time a job becomes PUBLISHED.
    if (patch.status === 'PUBLISHED') sets.push('published_at = COALESCE(published_at, ?)')
    if (patch.status === 'PUBLISHED') params.push(nowIso())
    sets.push('updated_at = ?')
    params.push(nowIso(), scope.tenantId, id)
    await this.db.run(`UPDATE jobs SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, params)
    return this.findById(scope, id)
  }

  async countByStatus(scope: TenantScope): Promise<Record<string, number>> {
    const rows = await this.db.many<{ status: string; c: number }>(
      'SELECT status, COUNT(*) AS c FROM jobs WHERE tenant_id = ? GROUP BY status',
      [scope.tenantId],
    )
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]))
  }
}

export class JobRequirementRepository {
  constructor(private readonly db: DatabaseService) {}

  async listForJob(scope: TenantScope, jobId: string): Promise<JobRequirement[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM job_requirements WHERE tenant_id = ? AND job_id = ? ORDER BY priority, id',
      [scope.tenantId, jobId],
    )
    return rows.map(mapJobRequirement)
  }

  async create(
    scope: TenantScope,
    input: {
      jobId: string
      requirementType: JobRequirement['requirementType']
      description: string
      mandatory?: boolean
      priority?: number
    },
  ): Promise<JobRequirement> {
    const id = prefixedId('jrq')
    await this.db.run(
      `INSERT INTO job_requirements
         (id, tenant_id, job_id, requirement_type, description, mandatory, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.jobId,
        input.requirementType,
        input.description,
        boolToInt(input.mandatory ?? true),
        input.priority ?? 100,
        nowIso(),
      ],
    )
    return {
      id,
      jobId: input.jobId,
      requirementType: input.requirementType,
      description: input.description,
      mandatory: input.mandatory ?? true,
      priority: input.priority ?? 100,
    }
  }

  async deleteForJob(scope: TenantScope, jobId: string): Promise<void> {
    await this.db.run('DELETE FROM job_requirements WHERE tenant_id = ? AND job_id = ?', [
      scope.tenantId,
      jobId,
    ])
  }
}

export class CandidateRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(scope: TenantScope, id: string): Promise<Candidate | null> {
    const row = await this.db.one<Row>('SELECT * FROM candidates WHERE tenant_id = ? AND id = ?', [
      scope.tenantId,
      id,
    ])
    return row ? mapCandidate(row) : null
  }

  async findByEmail(scope: TenantScope, email: string): Promise<Candidate | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM candidates WHERE tenant_id = ? AND email = ?',
      [scope.tenantId, email.toLowerCase()],
    )
    return row ? mapCandidate(row) : null
  }

  async findByTelegramUserId(scope: TenantScope, telegramUserId: string): Promise<Candidate | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM candidates WHERE tenant_id = ? AND telegram_user_id = ? LIMIT 1',
      [scope.tenantId, telegramUserId],
    )
    return row ? mapCandidate(row) : null
  }

  async search(
    scope: TenantScope,
    filters: { query?: string },
    limit: number,
    offset: number,
  ): Promise<{ items: Candidate[]; total: number }> {
    const where = ['tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]
    if (filters.query) {
      where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')")
      const like = `%${escapeLike(filters.query)}%`
      params.push(like, like)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `SELECT * FROM candidates WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM candidates WHERE ${clause}`, params)
    return { items: rows.map(mapCandidate), total }
  }

  /** Create, or return the existing candidate with the same e-mail. */
  async createOrGet(
    scope: TenantScope,
    input: {
      name: string
      email: string
      phone?: string | null
      telegramUserId?: string | null
      source?: string
    },
  ): Promise<Candidate> {
    const existing = await this.findByEmail(scope, input.email)
    if (existing) {
      // Deliberately NOT attaching input.telegramUserId to an existing record.
      // The caller has only asserted an e-mail address, which is not proof of
      // ownership; binding a Telegram account here would let anyone who knows a
      // candidate's address take over that candidate's identity on the bot.
      // Linking an existing candidate requires `linkTelegramAccount`, which the
      // caller may only reach after presenting the application reference.
      return existing
    }
    const id = prefixedId('can')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO candidates
         (id, tenant_id, name, email, phone, telegram_user_id, cv_file_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.name,
        input.email.toLowerCase(),
        input.phone ?? null,
        input.telegramUserId ?? null,
        input.source ?? 'DIRECT',
        ts,
        ts,
      ],
    )
    const created = await this.findById(scope, id)
    if (!created) throw new Error('candidate insert did not persist')
    return created
  }

  /**
   * Bind a Telegram account to an existing candidate. Only call this once the
   * caller has proven ownership (currently: possession of the unguessable
   * application reference). Never binds over an existing, different link.
   */
  async linkTelegramAccount(
    scope: TenantScope,
    candidateId: string,
    telegramUserId: string,
  ): Promise<void> {
    await this.db.run(
      `UPDATE candidates SET telegram_user_id = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND telegram_user_id IS NULL`,
      [telegramUserId, nowIso(), scope.tenantId, candidateId],
    )
  }

  async setCvFileId(scope: TenantScope, id: string, fileId: string): Promise<void> {
    await this.db.run(
      'UPDATE candidates SET cv_file_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
      [fileId, nowIso(), scope.tenantId, id],
    )
  }

  async countAll(scope: TenantScope): Promise<number> {
    return this.db.count('SELECT COUNT(*) AS c FROM candidates WHERE tenant_id = ?', [
      scope.tenantId,
    ])
  }
}

export interface ApplicationDetail extends Application {
  jobTitle: string
  jobCode: string
  candidateName: string
  candidateEmail: string
}

export class ApplicationRepository {
  constructor(private readonly db: DatabaseService) {}

  private static readonly SELECT_DETAIL = `
    SELECT a.*, j.title AS job_title, j.job_code AS job_code,
           c.name AS candidate_name, c.email AS candidate_email
      FROM applications a
      JOIN jobs       j ON j.id = a.job_id       AND j.tenant_id = a.tenant_id
      JOIN candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id`

  private static hydrate(r: Row): ApplicationDetail {
    return {
      ...mapApplication(r),
      jobTitle: String(r.job_title),
      jobCode: String(r.job_code),
      candidateName: String(r.candidate_name),
      candidateEmail: String(r.candidate_email),
    }
  }

  async findById(scope: TenantScope, id: string): Promise<Application | null> {
    const row = await this.db.one<Row>('SELECT * FROM applications WHERE tenant_id = ? AND id = ?', [
      scope.tenantId,
      id,
    ])
    assertSameTenant(scope, row as { tenant_id?: string } | null)
    return row ? mapApplication(row) : null
  }

  async findDetailById(scope: TenantScope, id: string): Promise<ApplicationDetail | null> {
    const row = await this.db.one<Row>(
      `${ApplicationRepository.SELECT_DETAIL} WHERE a.tenant_id = ? AND a.id = ?`,
      [scope.tenantId, id],
    )
    return row ? ApplicationRepository.hydrate(row) : null
  }

  /**
   * Look up by the opaque candidate-facing reference. Tenant is re-checked
   * because the reference is globally unique, not tenant-prefixed.
   */
  async findByReference(scope: TenantScope, reference: string): Promise<ApplicationDetail | null> {
    const row = await this.db.one<Row>(
      `${ApplicationRepository.SELECT_DETAIL} WHERE a.reference = ? AND a.tenant_id = ?`,
      [reference, scope.tenantId],
    )
    if (!row) return null
    assertSameTenant(scope, row as { tenant_id?: string })
    return ApplicationRepository.hydrate(row)
  }

  async listForCandidate(scope: TenantScope, candidateId: string): Promise<ApplicationDetail[]> {
    const rows = await this.db.many<Row>(
      `${ApplicationRepository.SELECT_DETAIL}
        WHERE a.tenant_id = ? AND a.candidate_id = ? ORDER BY a.applied_at DESC LIMIT 50`,
      [scope.tenantId, candidateId],
    )
    return rows.map(ApplicationRepository.hydrate)
  }

  async search(
    scope: TenantScope,
    filters: { jobId?: string; stage?: ApplicationStage; status?: Application['status'] },
    limit: number,
    offset: number,
  ): Promise<{ items: ApplicationDetail[]; total: number }> {
    const where = ['a.tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]
    if (filters.jobId) {
      where.push('a.job_id = ?')
      params.push(filters.jobId)
    }
    if (filters.stage) {
      where.push('a.stage = ?')
      params.push(filters.stage)
    }
    if (filters.status) {
      where.push('a.status = ?')
      params.push(filters.status)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `${ApplicationRepository.SELECT_DETAIL} WHERE ${clause}
        ORDER BY a.applied_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM applications a WHERE ${clause}`,
      params,
    )
    return { items: rows.map(ApplicationRepository.hydrate), total }
  }

  async create(
    scope: TenantScope,
    input: { candidateId: string; jobId: string; coverNote?: string | null },
  ): Promise<Application> {
    const id = prefixedId('app')
    const ts = nowIso()
    // Unguessable, human-quotable reference. 20 base64url chars ≈ 120 bits.
    const reference = `SPA-${randomToken(15).slice(0, 20).toUpperCase()}`
    await this.db.transaction((uow) => {
      uow.add(
        `INSERT INTO applications
           (id, tenant_id, candidate_id, job_id, stage, status, reference, cover_note, applied_at, updated_at)
         VALUES (?, ?, ?, ?, 'APPLIED', 'OPEN', ?, ?, ?, ?)`,
        [id, scope.tenantId, input.candidateId, input.jobId, reference, input.coverNote ?? null, ts, ts],
      )
      uow.add(
        `INSERT INTO application_events
           (id, tenant_id, application_id, from_stage, to_stage, note, actor_user_id, created_at)
         VALUES (?, ?, ?, NULL, 'APPLIED', 'Application received', NULL, ?)`,
        [prefixedId('ape'), scope.tenantId, id, ts],
      )
    })
    const created = await this.findById(scope, id)
    if (!created) throw new Error('application insert did not persist')
    return created
  }

  /**
   * Move an application to a new stage and record the event atomically.
   * Transition legality is checked by the caller against the domain machine.
   */
  async transition(
    scope: TenantScope,
    input: {
      applicationId: string
      fromStage: ApplicationStage
      toStage: ApplicationStage
      note: string | null
      actorUserId: string | null
      closeApplication: boolean
    },
  ): Promise<void> {
    const ts = nowIso()
    await this.db.transaction((uow) => {
      uow.add(
        `UPDATE applications SET stage = ?, status = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND stage = ?`,
        [
          input.toStage,
          input.closeApplication ? 'CLOSED' : 'OPEN',
          ts,
          scope.tenantId,
          input.applicationId,
          input.fromStage,
        ],
      )
      uow.add(
        `INSERT INTO application_events
           (id, tenant_id, application_id, from_stage, to_stage, note, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          prefixedId('ape'),
          scope.tenantId,
          input.applicationId,
          input.fromStage,
          input.toStage,
          input.note,
          input.actorUserId,
          ts,
        ],
      )
    })
  }

  async listEvents(scope: TenantScope, applicationId: string): Promise<ApplicationEvent[]> {
    const rows = await this.db.many<Row>(
      `SELECT * FROM application_events
        WHERE tenant_id = ? AND application_id = ? ORDER BY created_at ASC LIMIT 100`,
      [scope.tenantId, applicationId],
    )
    return rows.map(mapApplicationEvent)
  }

  async funnel(scope: TenantScope): Promise<{ stage: string; count: number }[]> {
    const rows = await this.db.many<{ stage: string; c: number }>(
      'SELECT stage, COUNT(*) AS c FROM applications WHERE tenant_id = ? GROUP BY stage',
      [scope.tenantId],
    )
    return rows.map((r) => ({ stage: r.stage, count: Number(r.c) }))
  }

  async countAll(scope: TenantScope): Promise<number> {
    return this.db.count('SELECT COUNT(*) AS c FROM applications WHERE tenant_id = ?', [
      scope.tenantId,
    ])
  }

  async overTime(scope: TenantScope, sinceIso: string): Promise<{ day: string; count: number }[]> {
    const rows = await this.db.many<{ day: string; c: number }>(
      `SELECT substr(applied_at, 1, 10) AS day, COUNT(*) AS c
         FROM applications WHERE tenant_id = ? AND applied_at >= ?
        GROUP BY day ORDER BY day`,
      [scope.tenantId, sinceIso],
    )
    return rows.map((r) => ({ day: r.day, count: Number(r.c) }))
  }

  async bySource(scope: TenantScope): Promise<{ source: string; count: number }[]> {
    const rows = await this.db.many<{ source: string; c: number }>(
      `SELECT c.source AS source, COUNT(*) AS c
         FROM applications a JOIN candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? GROUP BY c.source ORDER BY c DESC`,
      [scope.tenantId],
    )
    return rows.map((r) => ({ source: r.source, count: Number(r.c) }))
  }
}

export class InterviewRepository {
  constructor(private readonly db: DatabaseService) {}

  async listForApplication(scope: TenantScope, applicationId: string): Promise<Interview[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM interviews WHERE tenant_id = ? AND application_id = ? ORDER BY scheduled_at',
      [scope.tenantId, applicationId],
    )
    return rows.map(mapInterview)
  }

  async create(
    scope: TenantScope,
    input: {
      applicationId: string
      scheduledAt: string
      durationMinutes?: number
      mode?: Interview['mode']
      interviewerEmployeeId?: string | null
    },
  ): Promise<Interview> {
    const id = prefixedId('int')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO interviews
         (id, tenant_id, application_id, scheduled_at, duration_minutes, mode,
          interviewer_employee_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)`,
      [
        id,
        scope.tenantId,
        input.applicationId,
        input.scheduledAt,
        input.durationMinutes ?? 60,
        input.mode ?? 'REMOTE',
        input.interviewerEmployeeId ?? null,
        ts,
        ts,
      ],
    )
    const rows = await this.listForApplication(scope, input.applicationId)
    const created = rows.find((r) => r.id === id)
    if (!created) throw new Error('interview insert did not persist')
    return created
  }

  async recordEvaluation(
    scope: TenantScope,
    id: string,
    input: { evaluation: string; score: number | null; status: Interview['status'] },
  ): Promise<void> {
    await this.db.run(
      `UPDATE interviews SET evaluation = ?, score = ?, status = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [input.evaluation, input.score, input.status, nowIso(), scope.tenantId, id],
    )
  }
}

export class OfferRepository {
  constructor(private readonly db: DatabaseService) {}

  async listForApplication(scope: TenantScope, applicationId: string): Promise<Offer[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM offers WHERE tenant_id = ? AND application_id = ? ORDER BY created_at DESC',
      [scope.tenantId, applicationId],
    )
    return rows.map(mapOffer)
  }

  async create(
    scope: TenantScope,
    input: {
      applicationId: string
      baseSalary: number
      currency: string
      startDate: DateOnly
      expiresAt?: DateOnly | null
    },
  ): Promise<Offer> {
    const id = prefixedId('off')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO offers
         (id, tenant_id, application_id, base_salary, currency, start_date, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.applicationId,
        input.baseSalary,
        input.currency,
        input.startDate,
        input.expiresAt ?? null,
        ts,
        ts,
      ],
    )
    const created = (await this.listForApplication(scope, input.applicationId)).find((o) => o.id === id)
    if (!created) throw new Error('offer insert did not persist')
    return created
  }

  async setStatus(scope: TenantScope, id: string, status: Offer['status']): Promise<void> {
    await this.db.run('UPDATE offers SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', [
      status,
      nowIso(),
      scope.tenantId,
      id,
    ])
  }

  async countHiredSince(scope: TenantScope, sinceIso: string): Promise<number> {
    return this.db.count(
      `SELECT COUNT(*) AS c FROM applications
        WHERE tenant_id = ? AND stage = 'HIRED' AND updated_at >= ?`,
      [scope.tenantId, sinceIso],
    )
  }
}
