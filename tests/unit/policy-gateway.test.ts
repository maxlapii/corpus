import { beforeEach, describe, expect, it } from 'vitest'
import { createGatewayHarness, type GatewayHarness } from '../helpers/gateway.js'
import {
  EMPLOYEE,
  HR,
  HR_ADMIN,
  MANAGER,
  SYSTEM_ADMIN,
  TENANT_A,
  TENANT_B,
  makeAnonymous,
  makeUser,
} from '../helpers/identities.js'

describe('PolicyGateway', () => {
  let h: GatewayHarness
  beforeEach(() => {
    h = createGatewayHarness()
  })

  describe('tenant isolation', () => {
    it('denies a cross-tenant resource even for SYSTEM_ADMIN', async () => {
      const decision = await h.gateway.authorize({
        identity: SYSTEM_ADMIN(),
        action: 'read',
        resource: { type: 'employee', id: 'emp_x', tenantId: TENANT_B, ownerEmployeeId: 'emp_x' },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('TENANT_MISMATCH')
    })

    it('raises a CRITICAL security event on a cross-tenant attempt', async () => {
      await h.gateway.authorize({
        identity: HR(),
        action: 'read',
        resource: { type: 'employee', tenantId: TENANT_B, ownerEmployeeId: 'emp_x' },
      })
      expect(h.securityEvents.map((e) => e.eventType)).toContain('TENANT_ACCESS_VIOLATION')
    })

    it('allows a same-tenant resource', async () => {
      const decision = await h.gateway.authorize({
        identity: HR(),
        action: 'read',
        resource: { type: 'employee', tenantId: TENANT_A, ownerEmployeeId: 'emp_9' },
      })
      expect(decision.allowed).toBe(true)
    })
  })

  describe('security zones', () => {
    it('denies an EXTERNAL caller access to employee records', async () => {
      const decision = await h.gateway.authorize({
        identity: makeAnonymous(),
        action: 'read',
        resource: { type: 'employee', ownerEmployeeId: 'emp_1' },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('WRONG_SECURITY_ZONE')
    })

    it('denies an EXTERNAL caller access to knowledge documents', async () => {
      const decision = await h.gateway.authorize({
        identity: makeAnonymous(),
        action: 'search',
        resource: { type: 'knowledge.chunk', classification: 'INTERNAL' },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('WRONG_SECURITY_ZONE')
      expect(h.securityEvents.map((e) => e.eventType)).toContain('SCOPE_VIOLATION')
    })

    it('allows an EXTERNAL caller to read a published job', async () => {
      const decision = await h.gateway.authorize({
        identity: makeAnonymous(),
        action: 'read',
        resource: { type: 'job', id: 'job_1', classification: 'PUBLIC' },
      })
      expect(decision.allowed).toBe(true)
    })

    it('denies an EXTERNAL caller a non-public job classification', async () => {
      const decision = await h.gateway.authorize({
        identity: makeAnonymous(),
        action: 'read',
        resource: { type: 'job', id: 'job_draft', classification: 'INTERNAL' },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('CLASSIFICATION_TOO_HIGH')
    })
  })

  describe('ownership', () => {
    it('allows an employee to read their own leave balance', async () => {
      const decision = await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'read',
        resource: { type: 'leave.balance', ownerEmployeeId: 'emp_1' },
        intent: 'MY_LEAVE_BALANCE',
      })
      expect(decision.allowed).toBe(true)
      if (decision.allowed) expect(decision.viaPermission).toBe('leave.read.self')
    })

    it("denies an employee another employee's leave balance", async () => {
      const decision = await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'read',
        resource: { type: 'leave.balance', ownerEmployeeId: 'emp_other' },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('NOT_OWNER')
      expect(h.securityEvents.map((e) => e.eventType)).toContain('CROSS_USER_ACCESS')
    })

    it('allows a manager to read a direct report, but not a non-report', async () => {
      const report = await h.gateway.authorize({
        identity: MANAGER(),
        action: 'read',
        resource: { type: 'leave.request', ownerEmployeeId: 'emp_2' },
      })
      expect(report.allowed).toBe(true)

      const stranger = await h.gateway.authorize({
        identity: MANAGER(),
        action: 'read',
        resource: { type: 'leave.request', ownerEmployeeId: 'emp_999' },
      })
      expect(stranger.allowed).toBe(false)
      if (!stranger.allowed) expect(stranger.reason).toBe('NOT_MANAGER_OF_TARGET')
    })

    it('denies a SELF grant when the resource carries no owner', async () => {
      // A missing owner must never be read as an implicit match.
      const decision = await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'create',
        resource: { type: 'leave.request' },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('NOT_OWNER')
    })

    it('lets HR read any employee via the .all grant', async () => {
      const decision = await h.gateway.authorize({
        identity: HR(),
        action: 'read',
        resource: { type: 'employee', ownerEmployeeId: 'emp_anyone' },
      })
      expect(decision.allowed).toBe(true)
      if (decision.allowed) expect(decision.viaPermission).toBe('employee.read.all')
    })
  })

  describe('compensation and restricted data', () => {
    it('denies compensation to EMPLOYEE, MANAGER and HR', async () => {
      for (const identity of [EMPLOYEE(), MANAGER(), HR()]) {
        const decision = await h.gateway.authorize({
          identity,
          action: 'read',
          resource: { type: 'employee.compensation', ownerEmployeeId: 'emp_1', classification: 'RESTRICTED' },
          intent: 'EMPLOYEE_SALARY',
        })
        expect(decision.allowed, `${identity.roles.join()} must not read compensation`).toBe(false)
      }
    })

    it('allows compensation for HR_ADMIN on the web channel', async () => {
      const decision = await h.gateway.authorize({
        identity: HR_ADMIN(),
        action: 'read',
        resource: { type: 'employee.compensation', ownerEmployeeId: 'emp_1', classification: 'RESTRICTED' },
      })
      expect(decision.allowed).toBe(true)
    })

    it('refuses compensation over Telegram even for HR_ADMIN', async () => {
      const decision = await h.gateway.authorize({
        identity: makeUser({
          roles: ['HR_ADMIN'],
          employeeId: 'emp_hra',
          channel: 'TELEGRAM_INTERNAL',
        }),
        action: 'read',
        resource: { type: 'employee.compensation', ownerEmployeeId: 'emp_1', classification: 'RESTRICTED' },
        intent: 'EMPLOYEE_SALARY',
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('RISK_TOO_HIGH')
    })
  })

  describe('knowledge classification ceilings', () => {
    it('caps an EMPLOYEE at INTERNAL', async () => {
      const allowed = await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'search',
        resource: { type: 'knowledge.chunk', classification: 'INTERNAL' },
        intent: 'HR_POLICY_QUESTION',
      })
      expect(allowed.allowed).toBe(true)
      if (allowed.allowed) {
        expect(allowed.maxClassification).toBe('INTERNAL')
        expect(allowed.allowedClassifications).toEqual(['PUBLIC', 'INTERNAL'])
      }

      const denied = await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'search',
        resource: { type: 'knowledge.chunk', classification: 'CONFIDENTIAL' },
      })
      expect(denied.allowed).toBe(false)
      if (!denied.allowed) expect(denied.reason).toBe('CLASSIFICATION_TOO_HIGH')
    })

    it('lets HR reach CONFIDENTIAL but not RESTRICTED', async () => {
      const confidential = await h.gateway.authorize({
        identity: HR(),
        action: 'search',
        resource: { type: 'knowledge.chunk', classification: 'CONFIDENTIAL' },
      })
      expect(confidential.allowed).toBe(true)
      if (confidential.allowed) expect(confidential.maxClassification).toBe('CONFIDENTIAL')

      const restricted = await h.gateway.authorize({
        identity: HR(),
        action: 'search',
        resource: { type: 'knowledge.chunk', classification: 'RESTRICTED' },
      })
      expect(restricted.allowed).toBe(false)
    })

    it('lets HR_ADMIN reach RESTRICTED', async () => {
      const decision = await h.gateway.authorize({
        identity: HR_ADMIN(),
        action: 'search',
        resource: { type: 'knowledge.chunk', classification: 'RESTRICTED' },
      })
      expect(decision.allowed).toBe(true)
      if (decision.allowed) {
        expect(decision.allowedClassifications).toEqual([
          'PUBLIC',
          'INTERNAL',
          'CONFIDENTIAL',
          'RESTRICTED',
        ])
      }
    })
  })

  describe('undefined operations', () => {
    it('denies an operation with no policy rule rather than defaulting open', async () => {
      const decision = await h.gateway.authorize({
        identity: SYSTEM_ADMIN(),
        // `system:delete` is deliberately not in the rule table.
        action: 'delete',
        resource: { type: 'system' },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('MISSING_PERMISSION')
    })
  })

  describe('business rules', () => {
    it('denies when a business rule fails, after permissions pass', async () => {
      const decision = await h.gateway.authorize({
        identity: MANAGER(),
        action: 'approve',
        resource: { type: 'leave.request', id: 'lvr_1', ownerEmployeeId: 'emp_1' },
        businessRules: [
          { code: 'ALREADY_DECIDED', message: 'That request has already been decided.', satisfied: false },
        ],
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.reason).toBe('BUSINESS_RULE')
        expect(decision.message).toBe('That request has already been decided.')
      }
    })

    it('allows when all business rules are satisfied', async () => {
      const decision = await h.gateway.authorize({
        identity: MANAGER(),
        action: 'approve',
        resource: { type: 'leave.request', id: 'lvr_1', ownerEmployeeId: 'emp_1' },
        businessRules: [{ code: 'PENDING', message: 'x', satisfied: true }],
      })
      expect(decision.allowed).toBe(true)
    })
  })

  describe('auditing', () => {
    it('records every decision with resource, action and outcome', async () => {
      await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'read',
        resource: { type: 'leave.balance', ownerEmployeeId: 'emp_1' },
        intent: 'MY_LEAVE_BALANCE',
        requestId: 'req_1',
      })
      await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'read',
        resource: { type: 'employee.compensation', ownerEmployeeId: 'emp_2' },
      })

      expect(h.auditEntries).toHaveLength(2)
      expect(h.auditEntries[0]).toMatchObject({
        decision: 'ALLOW',
        resource: 'leave.balance',
        action: 'read',
        intent: 'MY_LEAVE_BALANCE',
        requestId: 'req_1',
      })
      expect(h.auditEntries[1]).toMatchObject({ decision: 'DENY', resource: 'employee.compensation' })
    })

    it('honours skipAudit for UI pre-checks', async () => {
      await h.gateway.authorize({
        identity: EMPLOYEE(),
        action: 'read',
        resource: { type: 'leave.balance', ownerEmployeeId: 'emp_1' },
        skipAudit: true,
      })
      expect(h.auditEntries).toHaveLength(0)
    })
  })

  describe('require()', () => {
    it('throws a FORBIDDEN AppError that carries no internal detail', async () => {
      await expect(
        h.gateway.require({
          identity: EMPLOYEE(),
          action: 'read',
          resource: { type: 'employee.compensation', ownerEmployeeId: 'emp_2', classification: 'RESTRICTED' },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    })
  })

  describe('permissions cannot be self-asserted', () => {
    it('ignores roles the identity claims but whose permissions it lacks', async () => {
      // An identity fabricated with the HR_ADMIN role label but no permissions
      // must still be denied — permissions, not labels, are what count.
      const spoofed = makeUser({ roles: ['HR_ADMIN'], employeeId: 'emp_1', permissions: [] })
      const decision = await h.gateway.authorize({
        identity: spoofed,
        action: 'read',
        resource: { type: 'employee.compensation', ownerEmployeeId: 'emp_2', classification: 'RESTRICTED' },
      })
      expect(decision.allowed).toBe(false)
    })
  })
})
