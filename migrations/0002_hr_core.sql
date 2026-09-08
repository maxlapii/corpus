-- CORPUS 0002 — departments, positions, employees, compensation, leave.

PRAGMA foreign_keys = ON;

CREATE TABLE departments (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES departments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_departments_tenant_code ON departments (tenant_id, code);

CREATE TABLE positions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  title      TEXT NOT NULL,
  level      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_positions_tenant_code ON positions (tenant_id, code);

CREATE TABLE employees (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_no     TEXT NOT NULL,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  department_id   TEXT REFERENCES departments(id) ON DELETE SET NULL,
  position_id     TEXT REFERENCES positions(id) ON DELETE SET NULL,
  manager_id      TEXT REFERENCES employees(id) ON DELETE SET NULL,
  hire_date       TEXT NOT NULL,
  employment_type TEXT NOT NULL
                    CHECK (employment_type IN ('FULL_TIME','PART_TIME','CONTRACT','INTERN','TEMPORARY')),
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','ON_LEAVE','SUSPENDED','TERMINATED')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_employees_tenant_no ON employees (tenant_id, employee_no);
CREATE UNIQUE INDEX idx_employees_tenant_email ON employees (tenant_id, email);
CREATE INDEX idx_employees_manager ON employees (tenant_id, manager_id);
CREATE INDEX idx_employees_department ON employees (tenant_id, department_id);
CREATE INDEX idx_employees_status ON employees (tenant_id, status);

-- users.employee_id is declared in 0001 without a constraint because employees
-- did not exist yet; enforce the link now via an index and application checks.
CREATE INDEX idx_users_employee_link ON users (employee_id);

-- Explicit manager relation table, so dotted-line / matrix reporting can be
-- added without changing the employees row (CLAUDE.md §20).
CREATE TABLE employee_managers (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'PRIMARY' CHECK (relation IN ('PRIMARY','SECONDARY')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (employee_id, manager_id, relation)
);

CREATE INDEX idx_employee_managers_manager ON employee_managers (tenant_id, manager_id);

-- RESTRICTED. Deliberately a separate table: no employee query can join it in
-- by accident, and access requires employee.read.compensation.
CREATE TABLE employee_compensation (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  base_salary    REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  classification TEXT NOT NULL DEFAULT 'RESTRICTED' CHECK (classification = 'RESTRICTED'),
  created_at     TEXT NOT NULL,
  created_by     TEXT
);

CREATE INDEX idx_compensation_employee ON employee_compensation (tenant_id, employee_id, effective_from);

-- --- Leave -----------------------------------------------------------------

CREATE TABLE leave_types (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                     TEXT NOT NULL,
  name                     TEXT NOT NULL,
  paid                     INTEGER NOT NULL DEFAULT 1 CHECK (paid IN (0,1)),
  requires_approval        INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0,1)),
  max_consecutive_days     INTEGER,
  counts_working_days_only INTEGER NOT NULL DEFAULT 1 CHECK (counts_working_days_only IN (0,1)),
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_leave_types_tenant_code ON leave_types (tenant_id, code);

CREATE TABLE leave_balances (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id     TEXT NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year              INTEGER NOT NULL,
  entitled_days     REAL NOT NULL DEFAULT 0,
  used_days         REAL NOT NULL DEFAULT 0,
  pending_days      REAL NOT NULL DEFAULT 0,
  carried_over_days REAL NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  CHECK (used_days >= 0 AND pending_days >= 0)
);

CREATE UNIQUE INDEX idx_leave_balances_unique
  ON leave_balances (tenant_id, employee_id, leave_type_id, year);

CREATE TABLE leave_requests (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  -- Always computed server-side from the calendar and holidays.
  working_days  REAL NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  submitted_at  TEXT NOT NULL,
  decided_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (start_date <= end_date),
  CHECK (working_days > 0)
);

CREATE INDEX idx_leave_requests_employee ON leave_requests (tenant_id, employee_id, status);
CREATE INDEX idx_leave_requests_status ON leave_requests (tenant_id, status, start_date);
CREATE INDEX idx_leave_requests_range ON leave_requests (tenant_id, employee_id, start_date, end_date);

CREATE TABLE leave_approvals (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  leave_request_id TEXT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  approver_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision         TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  comment          TEXT,
  decided_at       TEXT NOT NULL
);

CREATE INDEX idx_leave_approvals_request ON leave_approvals (tenant_id, leave_request_id);

CREATE TABLE holidays (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  name       TEXT NOT NULL,
  recurring  INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0,1)),
  region     TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_holidays_unique ON holidays (tenant_id, date, COALESCE(region, ''));
CREATE INDEX idx_holidays_date ON holidays (tenant_id, date);
