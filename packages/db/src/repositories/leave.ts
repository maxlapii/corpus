/**
 * Leave repositories.
 *
 * Balance mutation always happens inside a single transaction together with the
 * request state change, so a request can never be approved without its days
 * being deducted (or vice versa).
 */

import { conflict, nowIso, prefixedId, type DateOnly } from '@corpus/shared'
import type { Holiday, LeaveBalance, LeaveRequest, LeaveType } from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { assertSameTenant, type TenantScope } from '../tenant.js'
import { boolToInt, mapHoliday, mapLeaveBalance, mapLeaveRequest, mapLeaveType, type Row } from './mappers.js'

export class LeaveTypeRepository {
  constructor(private readonly db: DatabaseService) {}

  async listActive(scope: TenantScope): Promise<LeaveType[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1 ORDER BY name',
      [scope.tenantId],
    )
    return rows.map(mapLeaveType)
  }

  async findById(scope: TenantScope, id: string): Promise<LeaveType | null> {
    const row = await this.db.one<Row>('SELECT * FROM leave_types WHERE tenant_id = ? AND id = ?', [
      scope.tenantId,
      id,
    ])
    return row ? mapLeaveType(row) : null
  }

  async findByCode(scope: TenantScope, code: string): Promise<LeaveType | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM leave_types WHERE tenant_id = ? AND code = ?',
      [scope.tenantId, code.toUpperCase()],
    )
    return row ? mapLeaveType(row) : null
  }

  async create(
    scope: TenantScope,
    input: {
      code: string
      name: string
      paid?: boolean
      requiresApproval?: boolean
      maxConsecutiveDays?: number | null
      countsWorkingDaysOnly?: boolean
    },
  ): Promise<LeaveType> {
    const id = prefixedId('lvt')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO leave_types
         (id, tenant_id, code, name, paid, requires_approval, max_consecutive_days,
          counts_working_days_only, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.code.toUpperCase(),
        input.name,
        boolToInt(input.paid ?? true),
        boolToInt(input.requiresApproval ?? true),
        input.maxConsecutiveDays ?? null,
        boolToInt(input.countsWorkingDaysOnly ?? true),
        ts,
        ts,
      ],
    )
    const created = await this.findById(scope, id)
    if (!created) throw new Error('leave type insert did not persist')
    return created
  }
}

export class LeaveBalanceRepository {
  constructor(private readonly db: DatabaseService) {}

  async find(
    scope: TenantScope,
    employeeId: string,
    leaveTypeId: string,
    year: number,
  ): Promise<LeaveBalance | null> {
    const row = await this.db.one<Row>(
      `SELECT * FROM leave_balances
        WHERE tenant_id = ? AND employee_id = ? AND leave_type_id = ? AND year = ?`,
      [scope.tenantId, employeeId, leaveTypeId, year],
    )
    return row ? mapLeaveBalance(row) : null
  }

  async listForEmployee(
    scope: TenantScope,
    employeeId: string,
    year: number,
  ): Promise<(LeaveBalance & { leaveTypeCode: string; leaveTypeName: string })[]> {
    const rows = await this.db.many<Row>(
      `SELECT b.*, t.code AS leave_type_code, t.name AS leave_type_name
         FROM leave_balances b
         JOIN leave_types t ON t.id = b.leave_type_id AND t.tenant_id = b.tenant_id
        WHERE b.tenant_id = ? AND b.employee_id = ? AND b.year = ?
        ORDER BY t.name`,
      [scope.tenantId, employeeId, year],
    )
    return rows.map((r) => ({
      ...mapLeaveBalance(r),
      leaveTypeCode: String(r.leave_type_code),
      leaveTypeName: String(r.leave_type_name),
    }))
  }

  async upsert(
    scope: TenantScope,
    input: {
      employeeId: string
      leaveTypeId: string
      year: number
      entitledDays: number
      carriedOverDays?: number
    },
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO leave_balances
         (id, tenant_id, employee_id, leave_type_id, year, entitled_days, used_days,
          pending_days, carried_over_days, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT (tenant_id, employee_id, leave_type_id, year)
       DO UPDATE SET entitled_days = excluded.entitled_days,
                     carried_over_days = excluded.carried_over_days,
                     updated_at = excluded.updated_at`,
      [
        prefixedId('lvb'),
        scope.tenantId,
        input.employeeId,
        input.leaveTypeId,
        input.year,
        input.entitledDays,
        input.carriedOverDays ?? 0,
        nowIso(),
      ],
    )
  }

  /** SQL for adjusting pending/used days. Used inside transactions. */
  static adjustSql(): string {
    return `UPDATE leave_balances
               SET pending_days = pending_days + ?, used_days = used_days + ?, updated_at = ?
             WHERE tenant_id = ? AND employee_id = ? AND leave_type_id = ? AND year = ?`
  }

  async utilisationByType(
    scope: TenantScope,
    year: number,
  ): Promise<{ leaveTypeName: string; entitled: number; used: number; pending: number }[]> {
    const rows = await this.db.many<Row>(
      `SELECT t.name AS n, SUM(b.entitled_days + b.carried_over_days) AS e,
              SUM(b.used_days) AS u, SUM(b.pending_days) AS p
         FROM leave_balances b
         JOIN leave_types t ON t.id = b.leave_type_id AND t.tenant_id = b.tenant_id
        WHERE b.tenant_id = ? AND b.year = ?
        GROUP BY t.name ORDER BY t.name`,
      [scope.tenantId, year],
    )
    return rows.map((r) => ({
      leaveTypeName: String(r.n),
      entitled: Number(r.e ?? 0),
      used: Number(r.u ?? 0),
      pending: Number(r.p ?? 0),
    }))
  }
}

export interface LeaveRequestWithType extends LeaveRequest {
  leaveTypeCode: string
  leaveTypeName: string
  employeeName: string
}

export class LeaveRequestRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(scope: TenantScope, id: string): Promise<LeaveRequest | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM leave_requests WHERE tenant_id = ? AND id = ?',
      [scope.tenantId, id],
    )
    assertSameTenant(scope, row as { tenant_id?: string } | null)
    return row ? mapLeaveRequest(row) : null
  }

  private static readonly SELECT_WITH_TYPE = `
    SELECT r.*, t.code AS leave_type_code, t.name AS leave_type_name,
           (e.first_name || ' ' || e.last_name) AS employee_name
      FROM leave_requests r
      JOIN leave_types t ON t.id = r.leave_type_id AND t.tenant_id = r.tenant_id
      JOIN employees  e ON e.id = r.employee_id  AND e.tenant_id = r.tenant_id`

  private static hydrate(r: Row): LeaveRequestWithType {
    return {
      ...mapLeaveRequest(r),
      leaveTypeCode: String(r.leave_type_code),
      leaveTypeName: String(r.leave_type_name),
      employeeName: String(r.employee_name),
    }
  }

  async findByIdDetailed(scope: TenantScope, id: string): Promise<LeaveRequestWithType | null> {
    const row = await this.db.one<Row>(
      `${LeaveRequestRepository.SELECT_WITH_TYPE} WHERE r.tenant_id = ? AND r.id = ?`,
      [scope.tenantId, id],
    )
    return row ? LeaveRequestRepository.hydrate(row) : null
  }

  async listForEmployee(
    scope: TenantScope,
    employeeId: string,
    options: { statuses?: readonly LeaveRequest['status'][]; limit: number; offset: number },
  ): Promise<{ items: LeaveRequestWithType[]; total: number }> {
    const where = ['r.tenant_id = ?', 'r.employee_id = ?']
    const params: (string | number)[] = [scope.tenantId, employeeId]
    if (options.statuses && options.statuses.length > 0) {
      where.push(`r.status IN (${options.statuses.map(() => '?').join(', ')})`)
      params.push(...options.statuses)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `${LeaveRequestRepository.SELECT_WITH_TYPE} WHERE ${clause}
        ORDER BY r.start_date DESC LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM leave_requests r WHERE ${clause}`,
      params,
    )
    return { items: rows.map(LeaveRequestRepository.hydrate), total }
  }

  /**
   * Requests for an explicit set of employees. The caller computes the set from
   * the PolicyGateway decision, so an empty set returns nothing.
   */
  async listForEmployees(
    scope: TenantScope,
    employeeIds: readonly string[],
    options: { statuses?: readonly LeaveRequest['status'][]; limit: number; offset: number },
  ): Promise<{ items: LeaveRequestWithType[]; total: number }> {
    if (employeeIds.length === 0) return { items: [], total: 0 }
    const where = ['r.tenant_id = ?', `r.employee_id IN (${employeeIds.map(() => '?').join(', ')})`]
    const params: (string | number)[] = [scope.tenantId, ...employeeIds]
    if (options.statuses && options.statuses.length > 0) {
      where.push(`r.status IN (${options.statuses.map(() => '?').join(', ')})`)
      params.push(...options.statuses)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `${LeaveRequestRepository.SELECT_WITH_TYPE} WHERE ${clause}
        ORDER BY r.submitted_at DESC LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM leave_requests r WHERE ${clause}`,
      params,
    )
    return { items: rows.map(LeaveRequestRepository.hydrate), total }
  }

  /** Tenant-wide listing, for HR with `leave.read.all`. */
  async listAll(
    scope: TenantScope,
    options: { statuses?: readonly LeaveRequest['status'][]; limit: number; offset: number },
  ): Promise<{ items: LeaveRequestWithType[]; total: number }> {
    const where = ['r.tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]
    if (options.statuses && options.statuses.length > 0) {
      where.push(`r.status IN (${options.statuses.map(() => '?').join(', ')})`)
      params.push(...options.statuses)
    }
    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `${LeaveRequestRepository.SELECT_WITH_TYPE} WHERE ${clause}
        ORDER BY r.submitted_at DESC LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM leave_requests r WHERE ${clause}`,
      params,
    )
    return { items: rows.map(LeaveRequestRepository.hydrate), total }
  }

  /** Open (PENDING/APPROVED) requests, for overlap detection. */
  async listOpenForEmployee(scope: TenantScope, employeeId: string): Promise<LeaveRequest[]> {
    const rows = await this.db.many<Row>(
      `SELECT * FROM leave_requests
        WHERE tenant_id = ? AND employee_id = ? AND status IN ('PENDING','APPROVED')`,
      [scope.tenantId, employeeId],
    )
    return rows.map(mapLeaveRequest)
  }

  /**
   * Create a request and reserve the days as `pending` atomically.
   * `workingDays` must come from the domain calculation, never from a client.
   */
  async createWithReservation(
    scope: TenantScope,
    input: {
      employeeId: string
      leaveTypeId: string
      startDate: DateOnly
      endDate: DateOnly
      workingDays: number
      reason: string | null
      year: number
      autoApprove: boolean
      approverUserId?: string | null
    },
  ): Promise<LeaveRequest> {
    const id = prefixedId('lvr')
    const ts = nowIso()
    const status = input.autoApprove ? 'APPROVED' : 'PENDING'

    await this.db.transaction((uow) => {
      uow.add(
        `INSERT INTO leave_requests
           (id, tenant_id, employee_id, leave_type_id, start_date, end_date, working_days,
            reason, status, submitted_at, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          scope.tenantId,
          input.employeeId,
          input.leaveTypeId,
          input.startDate,
          input.endDate,
          input.workingDays,
          input.reason,
          status,
          ts,
          input.autoApprove ? ts : null,
          ts,
          ts,
        ],
      )
      // Reserve as pending, or consume directly when no approval is required.
      uow.add(LeaveBalanceRepository.adjustSql(), [
        input.autoApprove ? 0 : input.workingDays,
        input.autoApprove ? input.workingDays : 0,
        ts,
        scope.tenantId,
        input.employeeId,
        input.leaveTypeId,
        input.year,
      ])
      if (input.autoApprove && input.approverUserId) {
        uow.add(
          `INSERT INTO leave_approvals
             (id, tenant_id, leave_request_id, approver_user_id, decision, comment, decided_at)
           VALUES (?, ?, ?, ?, 'APPROVED', 'Auto-approved: leave type does not require approval', ?)`,
          [prefixedId('lva'), scope.tenantId, id, input.approverUserId, ts],
        )
      }
    })

    const created = await this.findById(scope, id)
    if (!created) throw new Error('leave request insert did not persist')
    return created
  }

  /**
   * Apply an approval decision atomically: status change, approval record and
   * balance movement in one transaction.
   */
  async decide(
    scope: TenantScope,
    input: {
      requestId: string
      employeeId: string
      leaveTypeId: string
      workingDays: number
      year: number
      decision: 'APPROVED' | 'REJECTED'
      approverUserId: string
      comment: string | null
    },
  ): Promise<void> {
    const ts = nowIso()
    const approved = input.decision === 'APPROVED'

    // The status transition runs alone and first, so that exactly one caller
    // can win it. Previously the balance movement sat in the same batch with no
    // guard of its own, so a second concurrent approval whose UPDATE matched no
    // row still moved the days — double-charging the employee.
    const transition = await this.db.run(
      `UPDATE leave_requests SET status = ?, decided_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'PENDING'`,
      [input.decision, ts, ts, scope.tenantId, input.requestId],
    )
    if (transition.meta.changes !== 1) {
      throw conflict('That leave request has already been decided.', {
        internal: `decide() lost the race for ${input.requestId}`,
      })
    }

    await this.db.transaction((uow) => {
      uow.add(
        `INSERT INTO leave_approvals
           (id, tenant_id, leave_request_id, approver_user_id, decision, comment, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          prefixedId('lva'),
          scope.tenantId,
          input.requestId,
          input.approverUserId,
          input.decision,
          input.comment,
          ts,
        ],
      )
      // Release the pending reservation; on approval move it into used.
      uow.add(LeaveBalanceRepository.adjustSql(), [
        -input.workingDays,
        approved ? input.workingDays : 0,
        ts,
        scope.tenantId,
        input.employeeId,
        input.leaveTypeId,
        input.year,
      ])
    })
  }

  /** Returns the reserved or used days to the balance. */
  async cancel(
    scope: TenantScope,
    input: {
      requestId: string
      employeeId: string
      leaveTypeId: string
      workingDays: number
      year: number
      previousStatus: 'PENDING' | 'APPROVED'
    },
  ): Promise<void> {
    const ts = nowIso()

    // As in decide(): win the transition first, so a concurrent cancel cannot
    // credit the same days twice.
    const transition = await this.db.run(
      `UPDATE leave_requests SET status = 'CANCELLED', updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = ?`,
      [ts, scope.tenantId, input.requestId, input.previousStatus],
    )
    if (transition.meta.changes !== 1) {
      throw conflict('That leave request is no longer cancellable.', {
        internal: `cancel() lost the race for ${input.requestId}`,
      })
    }

    await this.db.transaction((uow) => {
      uow.add(LeaveBalanceRepository.adjustSql(), [
        input.previousStatus === 'PENDING' ? -input.workingDays : 0,
        input.previousStatus === 'APPROVED' ? -input.workingDays : 0,
        ts,
        scope.tenantId,
        input.employeeId,
        input.leaveTypeId,
        input.year,
      ])
    })
  }

  async countByStatus(scope: TenantScope): Promise<Record<string, number>> {
    const rows = await this.db.many<{ status: string; c: number }>(
      'SELECT status, COUNT(*) AS c FROM leave_requests WHERE tenant_id = ? GROUP BY status',
      [scope.tenantId],
    )
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]))
  }
}

export class HolidayRepository {
  constructor(private readonly db: DatabaseService) {}

  async listBetween(scope: TenantScope, from: DateOnly, to: DateOnly): Promise<Holiday[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM holidays WHERE tenant_id = ? AND date BETWEEN ? AND ? ORDER BY date',
      [scope.tenantId, from, to],
    )
    return rows.map(mapHoliday)
  }

  async listForYear(scope: TenantScope, year: number): Promise<Holiday[]> {
    return this.listBetween(scope, `${year}-01-01`, `${year}-12-31`)
  }

  async listUpcoming(scope: TenantScope, from: DateOnly, limit: number): Promise<Holiday[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM holidays WHERE tenant_id = ? AND date >= ? ORDER BY date LIMIT ?',
      [scope.tenantId, from, limit],
    )
    return rows.map(mapHoliday)
  }

  async create(
    scope: TenantScope,
    input: { date: DateOnly; name: string; recurring?: boolean; region?: string | null },
  ): Promise<Holiday> {
    const id = prefixedId('hol')
    await this.db.run(
      `INSERT INTO holidays (id, tenant_id, date, name, recurring, region, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.date,
        input.name,
        boolToInt(input.recurring ?? false),
        input.region ?? null,
        nowIso(),
      ],
    )
    return {
      id,
      tenantId: scope.tenantId,
      date: input.date,
      name: input.name,
      recurring: input.recurring ?? false,
      region: input.region ?? null,
    }
  }
}
