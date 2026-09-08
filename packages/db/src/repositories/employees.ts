/** Employees, org structure and (separately) compensation. */

import { escapeLike, nowIso, prefixedId, type DateOnly } from '@corpus/shared'
import type { Department, Employee, Position } from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { assertSameTenant, type TenantScope } from '../tenant.js'
import { mapDepartment, mapEmployee, mapPosition, type Row } from './mappers.js'

export interface EmployeeSearchFilters {
  query?: string
  departmentId?: string
  status?: Employee['status']
  managerId?: string
  /** Team scoping. An empty array matches nothing, never everything. */
  restrictToIds?: readonly string[]
}

export class EmployeeRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(scope: TenantScope, id: string): Promise<Employee | null> {
    const row = await this.db.one<Row>('SELECT * FROM employees WHERE tenant_id = ? AND id = ?', [
      scope.tenantId,
      id,
    ])
    assertSameTenant(scope, row as { tenant_id?: string } | null)
    return row ? mapEmployee(row) : null
  }

  async findByEmail(scope: TenantScope, email: string): Promise<Employee | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM employees WHERE tenant_id = ? AND email = ?',
      [scope.tenantId, email.toLowerCase()],
    )
    return row ? mapEmployee(row) : null
  }

  async findByEmployeeNo(scope: TenantScope, employeeNo: string): Promise<Employee | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM employees WHERE tenant_id = ? AND employee_no = ?',
      [scope.tenantId, employeeNo],
    )
    return row ? mapEmployee(row) : null
  }

  /** Direct reports of an employee, from both the column and the relation table. */
  async listDirectReportIds(scope: TenantScope, managerEmployeeId: string): Promise<string[]> {
    const rows = await this.db.many<{ id: string }>(
      `SELECT id FROM employees WHERE tenant_id = ? AND manager_id = ?
       UNION
       SELECT employee_id AS id FROM employee_managers WHERE tenant_id = ? AND manager_id = ?`,
      [scope.tenantId, managerEmployeeId, scope.tenantId, managerEmployeeId],
    )
    return rows.map((r) => r.id)
  }

  async search(
    scope: TenantScope,
    filters: EmployeeSearchFilters,
    limit: number,
    offset: number,
  ): Promise<{ items: Employee[]; total: number }> {
    const where: string[] = ['tenant_id = ?']
    const params: (string | number)[] = [scope.tenantId]

    if (filters.query) {
      where.push(
        "(first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR employee_no LIKE ? ESCAPE '\\')",
      )
      const like = `%${escapeLike(filters.query)}%`
      params.push(like, like, like, like)
    }
    if (filters.departmentId) {
      where.push('department_id = ?')
      params.push(filters.departmentId)
    }
    if (filters.status) {
      where.push('status = ?')
      params.push(filters.status)
    }
    if (filters.managerId) {
      where.push('manager_id = ?')
      params.push(filters.managerId)
    }
    if (filters.restrictToIds) {
      // An empty restriction set must match nothing, never everything.
      if (filters.restrictToIds.length === 0) return { items: [], total: 0 }
      where.push(`id IN (${filters.restrictToIds.map(() => '?').join(', ')})`)
      params.push(...filters.restrictToIds)
    }

    const clause = where.join(' AND ')
    const rows = await this.db.many<Row>(
      `SELECT * FROM employees WHERE ${clause} ORDER BY last_name, first_name LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM employees WHERE ${clause}`,
      params,
    )
    return { items: rows.map(mapEmployee), total }
  }

  async create(
    scope: TenantScope,
    input: {
      employeeNo: string
      firstName: string
      lastName: string
      email: string
      phone?: string | null
      departmentId?: string | null
      positionId?: string | null
      managerId?: string | null
      hireDate: DateOnly
      employmentType: Employee['employmentType']
      status?: Employee['status']
    },
  ): Promise<Employee> {
    const id = prefixedId('emp')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO employees
         (id, tenant_id, employee_no, first_name, last_name, email, phone,
          department_id, position_id, manager_id, hire_date, employment_type,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.employeeNo,
        input.firstName,
        input.lastName,
        input.email.toLowerCase(),
        input.phone ?? null,
        input.departmentId ?? null,
        input.positionId ?? null,
        input.managerId ?? null,
        input.hireDate,
        input.employmentType,
        input.status ?? 'ACTIVE',
        ts,
        ts,
      ],
    )
    if (input.managerId) {
      await this.db.run(
        `INSERT OR IGNORE INTO employee_managers (tenant_id, employee_id, manager_id, relation, created_at)
         VALUES (?, ?, ?, 'PRIMARY', ?)`,
        [scope.tenantId, id, input.managerId, ts],
      )
    }
    const created = await this.findById(scope, id)
    if (!created) throw new Error('employee insert did not persist')
    return created
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: Partial<{
      firstName: string
      lastName: string
      phone: string | null
      departmentId: string | null
      positionId: string | null
      managerId: string | null
      employmentType: Employee['employmentType']
      status: Employee['status']
    }>,
  ): Promise<Employee | null> {
    const columns: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      phone: 'phone',
      departmentId: 'department_id',
      positionId: 'position_id',
      managerId: 'manager_id',
      employmentType: 'employment_type',
      status: 'status',
    }
    const sets: string[] = []
    const params: (string | number | null)[] = []
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        sets.push(`${column} = ?`)
        params.push((patch as Record<string, string | null>)[key] ?? null)
      }
    }
    if (sets.length === 0) return this.findById(scope, id)
    sets.push('updated_at = ?')
    params.push(nowIso(), scope.tenantId, id)
    await this.db.run(
      `UPDATE employees SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params,
    )
    return this.findById(scope, id)
  }

  async countByStatus(scope: TenantScope): Promise<Record<string, number>> {
    const rows = await this.db.many<{ status: string; c: number }>(
      'SELECT status, COUNT(*) AS c FROM employees WHERE tenant_id = ? GROUP BY status',
      [scope.tenantId],
    )
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]))
  }

  async headcountByDepartment(
    scope: TenantScope,
  ): Promise<{ departmentId: string | null; departmentName: string; count: number }[]> {
    const rows = await this.db.many<{ department_id: string | null; name: string | null; c: number }>(
      `SELECT e.department_id, d.name, COUNT(*) AS c
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id AND d.tenant_id = e.tenant_id
        WHERE e.tenant_id = ? AND e.status = 'ACTIVE'
        GROUP BY e.department_id, d.name
        ORDER BY c DESC`,
      [scope.tenantId],
    )
    return rows.map((r) => ({
      departmentId: r.department_id ?? null,
      departmentName: r.name ?? 'Unassigned',
      count: Number(r.c),
    }))
  }
}

/**
 * Compensation. RESTRICTED throughout: the only read path requires
 * `employee.read.compensation` at the PolicyGateway.
 */
export class CompensationRepository {
  constructor(private readonly db: DatabaseService) {}

  async currentForEmployee(
    scope: TenantScope,
    employeeId: string,
    onDate: DateOnly,
  ): Promise<{ baseSalary: number; currency: string; effectiveFrom: DateOnly } | null> {
    const row = await this.db.one<Row>(
      `SELECT base_salary, currency, effective_from
         FROM employee_compensation
        WHERE tenant_id = ? AND employee_id = ? AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from DESC LIMIT 1`,
      [scope.tenantId, employeeId, onDate, onDate],
    )
    if (!row) return null
    return {
      baseSalary: Number(row.base_salary),
      currency: String(row.currency),
      effectiveFrom: String(row.effective_from),
    }
  }

  async upsert(
    scope: TenantScope,
    input: {
      employeeId: string
      baseSalary: number
      currency: string
      effectiveFrom: DateOnly
      createdBy: string | null
    },
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO employee_compensation
         (id, tenant_id, employee_id, base_salary, currency, effective_from, classification, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'RESTRICTED', ?, ?)`,
      [
        prefixedId('cmp'),
        scope.tenantId,
        input.employeeId,
        input.baseSalary,
        input.currency,
        input.effectiveFrom,
        nowIso(),
        input.createdBy,
      ],
    )
  }
}

export class DepartmentRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(scope: TenantScope): Promise<Department[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM departments WHERE tenant_id = ? ORDER BY name',
      [scope.tenantId],
    )
    return rows.map(mapDepartment)
  }

  async findByCode(scope: TenantScope, code: string): Promise<Department | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM departments WHERE tenant_id = ? AND code = ?',
      [scope.tenantId, code],
    )
    return row ? mapDepartment(row) : null
  }

  async create(
    scope: TenantScope,
    input: { code: string; name: string; parentId?: string | null },
  ): Promise<Department> {
    const id = prefixedId('dep')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO departments (id, tenant_id, code, name, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, scope.tenantId, input.code, input.name, input.parentId ?? null, ts, ts],
    )
    return { id, tenantId: scope.tenantId, code: input.code, name: input.name, parentId: input.parentId ?? null }
  }
}

export class PositionRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(scope: TenantScope): Promise<Position[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM positions WHERE tenant_id = ? ORDER BY title',
      [scope.tenantId],
    )
    return rows.map(mapPosition)
  }

  async create(
    scope: TenantScope,
    input: { code: string; title: string; level?: string | null },
  ): Promise<Position> {
    const id = prefixedId('pos')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO positions (id, tenant_id, code, title, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, scope.tenantId, input.code, input.title, input.level ?? null, ts, ts],
    )
    return { id, tenantId: scope.tenantId, code: input.code, title: input.title, level: input.level ?? null }
  }
}
