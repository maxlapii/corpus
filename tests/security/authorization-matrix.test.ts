/**
 * Authorisation matrix (CLAUDE.md §27, §43).
 *
 * Walks every role against every sensitive endpoint over real HTTP, so a route
 * that forgets its PolicyGateway call fails here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness, seedEmail, type AuthedClient, type Harness } from '../helpers/harness.js'

type RoleKey = 'employee' | 'manager' | 'hr' | 'hrAdmin' | 'admin'

interface Case {
  label: string
  /** Called with a client and the harness, returns the HTTP status. */
  call: (client: AuthedClient, h: Harness) => Promise<number>
  /** Roles that must be ALLOWED (2xx). Everyone else must be denied. */
  allowed: RoleKey[]
}

const ALL_ROLES: RoleKey[] = ['employee', 'manager', 'hr', 'hrAdmin', 'admin']

const CASES: Case[] = [
  {
    label: 'read own profile',
    call: async (c) => (await c.get('/employees/me')).status,
    allowed: ALL_ROLES,
  },
  {
    label: 'read own leave balance',
    call: async (c) => (await c.get('/leave/balance/me')).status,
    allowed: ALL_ROLES,
  },
  {
    label: 'search the employee directory',
    call: async (c) => (await c.get('/employees')).status,
    allowed: ['manager', 'hr', 'hrAdmin', 'admin'],
  },
  {
    label: "read another employee's record",
    call: async (c, h) => (await c.get(`/employees/${h.seed.employees.outsider!.id}`)).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: "read another employee's compensation",
    call: async (c, h) =>
      (await c.get(`/employees/${h.seed.employees.employee!.id}/compensation`)).status,
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'create an employee',
    call: async (c) =>
      (
        await c.post('/employees', {
          employeeNo: `T${Math.floor(Math.random() * 1e6)}`,
          firstName: 'Test',
          lastName: 'Person',
          email: `t${Math.floor(Math.random() * 1e9)}@corpus.test`,
          hireDate: '2025-01-06',
          employmentType: 'FULL_TIME',
        })
      ).status,
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'list organisation-wide leave requests',
    call: async (c) => (await c.get('/leave/requests?view=all')).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'list team leave requests',
    call: async (c) => (await c.get('/leave/requests?view=team')).status,
    allowed: ['manager', 'hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'create a job',
    call: async (c) =>
      (
        await c.post('/jobs', {
          jobCode: `T-${Math.floor(Math.random() * 1e6)}`,
          title: 'Test Role',
          employmentType: 'FULL_TIME',
          description: 'A sufficiently long description for validation.',
        })
      ).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'delete (archive) a job',
    call: async (c, h) => (await c.del(`/jobs/${h.seed.jobIds.draft!}`)).status,
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'search candidates',
    call: async (c) => (await c.get('/candidates')).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'list applications',
    call: async (c) => (await c.get('/applications')).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'create an offer (RESTRICTED)',
    call: async (c, h) => {
      const applications = await h.database.repos.applications.search(
        { tenantId: h.seed.tenantId },
        {},
        1,
        0,
      )
      const application = applications.items[0]!
      // Put the application in an offer-eligible state, so this case tests the
      // authorisation decision rather than the recruitment state machine.
      await h.database.db.run(
        "UPDATE applications SET stage = 'FINAL', status = 'OPEN' WHERE id = ?",
        [application.id],
      )
      return (
        await c.post(`/applications/${application.id}/offers`, {
          baseSalary: 4000,
          currency: 'USD',
          startDate: '2025-09-01',
        })
      ).status
    },
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'list knowledge documents',
    call: async (c) => (await c.get('/policies')).status,
    allowed: ALL_ROLES,
  },
  {
    label: 'read a CONFIDENTIAL document',
    call: async (c, h) => (await c.get(`/policies/${h.seed.documentIds.grievance!}`)).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'read a RESTRICTED document',
    call: async (c, h) => (await c.get(`/policies/${h.seed.documentIds.salaryBands!}`)).status,
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'create a knowledge document',
    call: async (c) =>
      (
        await c.post('/policies', {
          name: `Doc ${Math.random()}`,
          category: 'POLICY',
          classification: 'INTERNAL',
        })
      ).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'create a RESTRICTED knowledge document',
    call: async (c) =>
      (
        await c.post('/policies', {
          name: `Restricted ${Math.random()}`,
          category: 'COMPENSATION',
          classification: 'RESTRICTED',
        })
      ).status,
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'read reports',
    call: async (c) => (await c.get('/reports/summary')).status,
    allowed: ['manager', 'hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'read the audit trail',
    call: async (c) => (await c.get('/audit')).status,
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'read security events',
    call: async (c) => (await c.get('/security/events')).status,
    allowed: ['hrAdmin', 'admin'],
  },
  {
    label: 'manage holidays',
    call: async (c) =>
      (
        await c.post('/holidays', {
          date: `2031-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
          name: 'Test Holiday',
        })
      ).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
  {
    label: 'set a leave balance',
    call: async (c, h) =>
      (
        await c.put('/leave/balance', {
          employeeId: h.seed.employees.employee!.id,
          leaveTypeId: h.seed.leaveTypeIds.ANNUAL!,
          year: 2031,
          entitledDays: 20,
        })
      ).status,
    allowed: ['hr', 'hrAdmin', 'admin'],
  },
]

describe('authorisation matrix', () => {
  let h: Harness
  const clients: Partial<Record<RoleKey, AuthedClient>> = {}

  beforeAll(async () => {
    h = await createHarness({ withKnowledge: true })
    for (const role of ALL_ROLES) {
      clients[role] = await h.login(seedEmail(h.seed, role))
    }
  })
  afterAll(() => h.close())

  for (const testCase of CASES) {
    for (const role of ALL_ROLES) {
      const shouldAllow = testCase.allowed.includes(role)
      it(`${role} ${shouldAllow ? 'CAN' : 'CANNOT'} ${testCase.label}`, async () => {
        const status = await testCase.call(clients[role]!, h)
        if (shouldAllow) {
          expect(status, `expected ${role} to be allowed, got ${status}`).toBeLessThan(400)
        } else {
          // 403 for a policy denial, 404 where the resource is hidden entirely.
          expect([403, 404], `expected ${role} to be denied, got ${status}`).toContain(status)
        }
      })
    }
  }

  it('records a DENY audit row for every refusal', async () => {
    const admin = clients.hrAdmin!
    const audit = await admin.get('/audit?decision=DENY&limit=200')
    expect(audit.status).toBe(200)
    expect(audit.body.total).toBeGreaterThan(10)
    for (const row of audit.body.items) {
      expect(row.decision).toBe('DENY')
      expect(row.reasonCode).toBeTruthy()
      expect(row.resource).toBeTruthy()
      expect(row.action).toBeTruthy()
    }
  })

  it('never leaks SQL, stack traces or internal detail in a denial', async () => {
    const employee = clients.employee!
    for (const path of [
      `/employees/${h.seed.employees.outsider!.id}/compensation`,
      `/policies/${h.seed.documentIds.salaryBands!}`,
      '/audit',
      '/security/events',
    ]) {
      const response = await employee.get(path)
      const serialised = JSON.stringify(response.body)
      expect(serialised).not.toMatch(/SELECT|FROM |WHERE |sqlite|at Object\.|node_modules/i)
      expect(serialised).not.toContain('tenant_id')
    }
  })
})
