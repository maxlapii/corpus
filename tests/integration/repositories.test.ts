/**
 * Repository behaviour against a real SQLite engine: tenant isolation,
 * transactional balance movement, and the effective-date model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantScope } from '@corpus/db'
import { availableDays } from '@corpus/domain'
import { createTestDatabase, type TestDatabase } from '@corpus/db/test-support'
import { seedDatabase, type SeedResult } from '../../scripts/seed-data.js'

describe('repositories', () => {
  let database: TestDatabase
  let a: SeedResult
  let b: SeedResult

  beforeEach(async () => {
    database = await createTestDatabase()
    a = await seedDatabase(database.repos, { tenantSlug: 'tenant-a', tenantName: 'A' })
    b = await seedDatabase(database.repos, { tenantSlug: 'tenant-b', tenantName: 'B' })
  })
  afterEach(() => database.close())

  describe('tenant isolation', () => {
    it('creates genuinely separate tenants', () => {
      expect(a.tenantId).not.toBe(b.tenantId)
    })

    it("cannot read tenant B's employee through tenant A's scope", async () => {
      const scopeA = tenantScope(a.tenantId)
      const employeeB = b.employees.employee!
      expect(await database.repos.employees.findById(scopeA, employeeB.id)).toBeNull()
    })

    it('scopes employee search to one tenant', async () => {
      const resultA = await database.repos.employees.search(tenantScope(a.tenantId), {}, 100, 0)
      const resultB = await database.repos.employees.search(tenantScope(b.tenantId), {}, 100, 0)
      expect(resultA.total).toBe(7)
      expect(resultB.total).toBe(7)
      const idsA = new Set(resultA.items.map((e) => e.id))
      for (const employee of resultB.items) expect(idsA.has(employee.id)).toBe(false)
    })

    it("cannot read tenant B's job by code through tenant A", async () => {
      const jobA = await database.repos.jobs.findByIdOrCode(tenantScope(a.tenantId), 'ENG-001')
      const jobB = await database.repos.jobs.findByIdOrCode(tenantScope(b.tenantId), 'ENG-001')
      expect(jobA?.id).not.toBe(jobB?.id)
      expect(await database.repos.jobs.findById(tenantScope(a.tenantId), jobB!.id)).toBeNull()
    })

    it('rejects a tenant-mismatched row fetched by a global reference', async () => {
      const scopeB = tenantScope(b.tenantId)
      const candidate = await database.repos.candidates.findByEmail(
        scopeB,
        'jordan.applicant@example.test',
      )
      const applications = await database.repos.applications.listForCandidate(scopeB, candidate!.id)
      const reference = applications[0]!.reference

      // The reference is globally unique, so tenant A must still refuse it.
      expect(
        await database.repos.applications.findByReference(tenantScope(a.tenantId), reference),
      ).toBeNull()
      expect(await database.repos.applications.findByReference(scopeB, reference)).not.toBeNull()
    })

    it('refuses to build a scope from a blank tenant id', () => {
      for (const bad of ['', '   ', null, undefined]) {
        expect(() => tenantScope(bad as string)).toThrow()
      }
    })
  })

  describe('leave balance transactions', () => {
    it('reserves days as pending on submission, atomically', async () => {
      const scope = tenantScope(a.tenantId)
      const employee = a.employees.employee!
      const leaveTypeId = a.leaveTypeIds.ANNUAL!
      const year = new Date().getUTCFullYear()

      const before = await database.repos.leaveBalances.find(scope, employee.id, leaveTypeId, year)
      expect(before?.pendingDays).toBe(0)

      const request = await database.repos.leaveRequests.createWithReservation(scope, {
        employeeId: employee.id,
        leaveTypeId,
        startDate: `${year}-06-02`,
        endDate: `${year}-06-06`,
        workingDays: 5,
        reason: null,
        year,
        autoApprove: false,
      })

      const after = await database.repos.leaveBalances.find(scope, employee.id, leaveTypeId, year)
      expect(after?.pendingDays).toBe(5)
      expect(after?.usedDays).toBe(0)
      expect(availableDays(after!)).toBe(availableDays(before!) - 5)
      expect(request.status).toBe('PENDING')
    })

    it('moves pending days into used on approval', async () => {
      const scope = tenantScope(a.tenantId)
      const employee = a.employees.employee!
      const approver = a.employees.manager!
      const leaveTypeId = a.leaveTypeIds.ANNUAL!
      const year = new Date().getUTCFullYear()

      const request = await database.repos.leaveRequests.createWithReservation(scope, {
        employeeId: employee.id,
        leaveTypeId,
        startDate: `${year}-07-07`,
        endDate: `${year}-07-11`,
        workingDays: 5,
        reason: null,
        year,
        autoApprove: false,
      })

      await database.repos.leaveRequests.decide(scope, {
        requestId: request.id,
        employeeId: employee.id,
        leaveTypeId,
        workingDays: 5,
        year,
        decision: 'APPROVED',
        approverUserId: approver.userId!,
        comment: 'Enjoy',
      })

      const balance = await database.repos.leaveBalances.find(scope, employee.id, leaveTypeId, year)
      expect(balance?.pendingDays).toBe(0)
      expect(balance?.usedDays).toBe(5)

      const updated = await database.repos.leaveRequests.findById(scope, request.id)
      expect(updated?.status).toBe('APPROVED')
      expect(updated?.decidedAt).toBeTruthy()
    })

    it('releases the reservation on rejection without consuming days', async () => {
      const scope = tenantScope(a.tenantId)
      const employee = a.employees.employee!
      const leaveTypeId = a.leaveTypeIds.ANNUAL!
      const year = new Date().getUTCFullYear()

      const request = await database.repos.leaveRequests.createWithReservation(scope, {
        employeeId: employee.id,
        leaveTypeId,
        startDate: `${year}-08-04`,
        endDate: `${year}-08-08`,
        workingDays: 5,
        reason: null,
        year,
        autoApprove: false,
      })
      await database.repos.leaveRequests.decide(scope, {
        requestId: request.id,
        employeeId: employee.id,
        leaveTypeId,
        workingDays: 5,
        year,
        decision: 'REJECTED',
        approverUserId: a.employees.manager!.userId!,
        comment: null,
      })

      const balance = await database.repos.leaveBalances.find(scope, employee.id, leaveTypeId, year)
      expect(balance?.pendingDays).toBe(0)
      expect(balance?.usedDays).toBe(0)
    })

    it('returns days to the balance on cancellation of an approved request', async () => {
      const scope = tenantScope(a.tenantId)
      const employee = a.employees.employee!
      const leaveTypeId = a.leaveTypeIds.ANNUAL!
      const year = new Date().getUTCFullYear()

      const request = await database.repos.leaveRequests.createWithReservation(scope, {
        employeeId: employee.id,
        leaveTypeId,
        startDate: `${year}-09-01`,
        endDate: `${year}-09-03`,
        workingDays: 3,
        reason: null,
        year,
        autoApprove: false,
      })
      await database.repos.leaveRequests.decide(scope, {
        requestId: request.id,
        employeeId: employee.id,
        leaveTypeId,
        workingDays: 3,
        year,
        decision: 'APPROVED',
        approverUserId: a.employees.manager!.userId!,
        comment: null,
      })
      await database.repos.leaveRequests.cancel(scope, {
        requestId: request.id,
        employeeId: employee.id,
        leaveTypeId,
        workingDays: 3,
        year,
        previousStatus: 'APPROVED',
      })

      const balance = await database.repos.leaveBalances.find(scope, employee.id, leaveTypeId, year)
      expect(balance?.usedDays).toBe(0)
      expect(balance?.pendingDays).toBe(0)
      expect((await database.repos.leaveRequests.findById(scope, request.id))?.status).toBe('CANCELLED')
    })

    it('auto-approves a leave type that needs no approval and consumes days directly', async () => {
      const scope = tenantScope(a.tenantId)
      const employee = a.employees.employee!
      const sickId = a.leaveTypeIds.SICK!
      const year = new Date().getUTCFullYear()

      const request = await database.repos.leaveRequests.createWithReservation(scope, {
        employeeId: employee.id,
        leaveTypeId: sickId,
        startDate: `${year}-10-06`,
        endDate: `${year}-10-07`,
        workingDays: 2,
        reason: 'Flu',
        year,
        autoApprove: true,
      })
      expect(request.status).toBe('APPROVED')
      const balance = await database.repos.leaveBalances.find(scope, employee.id, sickId, year)
      expect(balance?.usedDays).toBe(2)
      expect(balance?.pendingDays).toBe(0)
    })
  })

  describe('manager relationships', () => {
    it('lists direct reports from both the column and the relation table', async () => {
      const scope = tenantScope(a.tenantId)
      const reports = await database.repos.employees.listDirectReportIds(
        scope,
        a.employees.manager!.id,
      )
      expect(reports.sort()).toEqual([a.employees.employee!.id, a.employees.employee2!.id].sort())
      expect(reports).not.toContain(a.employees.outsider!.id)
    })

    it('returns no reports for an individual contributor', async () => {
      const reports = await database.repos.employees.listDirectReportIds(
        tenantScope(a.tenantId),
        a.employees.employee!.id,
      )
      expect(reports).toEqual([])
    })
  })

  describe('employee search scoping', () => {
    it('matches nothing when the restriction set is empty', async () => {
      const result = await database.repos.employees.search(
        tenantScope(a.tenantId),
        { restrictToIds: [] },
        100,
        0,
      )
      expect(result.total).toBe(0)
      expect(result.items).toEqual([])
    })

    it('matches only the restricted ids', async () => {
      const result = await database.repos.employees.search(
        tenantScope(a.tenantId),
        { restrictToIds: [a.employees.employee!.id] },
        100,
        0,
      )
      expect(result.items.map((e) => e.id)).toEqual([a.employees.employee!.id])
    })

    it('treats LIKE wildcards in the query as literals', async () => {
      const result = await database.repos.employees.search(
        tenantScope(a.tenantId),
        { query: '%' },
        100,
        0,
      )
      expect(result.total).toBe(0)
    })
  })

  describe('application lifecycle', () => {
    it('records an event for the initial application and each transition', async () => {
      const scope = tenantScope(a.tenantId)
      const candidate = await database.repos.candidates.findByEmail(
        scope,
        'jordan.applicant@example.test',
      )
      const applications = await database.repos.applications.listForCandidate(scope, candidate!.id)
      const application = applications[0]!

      let events = await database.repos.applications.listEvents(scope, application.id)
      expect(events).toHaveLength(1)
      expect(events[0]?.toStage).toBe('APPLIED')

      await database.repos.applications.transition(scope, {
        applicationId: application.id,
        fromStage: 'APPLIED',
        toStage: 'SCREENING',
        note: 'CV looks good',
        actorUserId: a.employees.hr!.userId,
        closeApplication: false,
      })

      events = await database.repos.applications.listEvents(scope, application.id)
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ fromStage: 'APPLIED', toStage: 'SCREENING' })
      expect((await database.repos.applications.findById(scope, application.id))?.stage).toBe('SCREENING')
    })

    it('closes an application on a terminal transition', async () => {
      const scope = tenantScope(a.tenantId)
      const candidate = await database.repos.candidates.findByEmail(scope, 'chen.hopeful@example.test')
      const application = (await database.repos.applications.listForCandidate(scope, candidate!.id))[0]!

      await database.repos.applications.transition(scope, {
        applicationId: application.id,
        fromStage: 'APPLIED',
        toStage: 'REJECTED',
        note: null,
        actorUserId: null,
        closeApplication: true,
      })
      const updated = await database.repos.applications.findById(scope, application.id)
      expect(updated?.status).toBe('CLOSED')
    })

    it('will not apply a transition whose from-stage no longer matches', async () => {
      const scope = tenantScope(a.tenantId)
      const candidate = await database.repos.candidates.findByEmail(scope, 'priya.seeker@example.test')
      const application = (await database.repos.applications.listForCandidate(scope, candidate!.id))[0]!

      // Stale write: the guard in the UPDATE means nothing changes.
      await database.repos.applications.transition(scope, {
        applicationId: application.id,
        fromStage: 'FINAL',
        toStage: 'OFFER',
        note: null,
        actorUserId: null,
        closeApplication: false,
      })
      expect((await database.repos.applications.findById(scope, application.id))?.stage).toBe('APPLIED')
    })

    it('issues unguessable, unique application references', async () => {
      const scope = tenantScope(a.tenantId)
      const references = new Set<string>()
      for (const key of ['jordan.applicant@example.test', 'priya.seeker@example.test', 'chen.hopeful@example.test']) {
        const candidate = await database.repos.candidates.findByEmail(scope, key)
        for (const application of await database.repos.applications.listForCandidate(scope, candidate!.id)) {
          expect(application.reference).toMatch(/^SPA-[A-Z0-9_-]{10,}$/)
          references.add(application.reference)
        }
      }
      expect(references.size).toBe(3)
    })
  })

  describe('audit trail', () => {
    it('redacts sensitive metadata before storing it', async () => {
      await database.repos.audit.record({
        tenantId: a.tenantId,
        channel: 'WEB',
        resource: 'employee',
        action: 'read',
        decision: 'ALLOW',
        metadata: { password: 'hunter2', code: '123456', note: 'fine' },
      })
      const { items } = await database.repos.audit.list(tenantScope(a.tenantId), {
        limit: 1,
        offset: 0,
      })
      const metadata = items[0]?.metadata as Record<string, unknown>
      expect(metadata.password).toBe('[redacted]')
      expect(metadata.code).toBe('[redacted]')
      expect(metadata.note).toBe('fine')
    })

    it('scopes audit listing to the tenant', async () => {
      await database.repos.audit.record({
        tenantId: b.tenantId,
        channel: 'WEB',
        resource: 'job',
        action: 'read',
        decision: 'ALLOW',
      })
      const listA = await database.repos.audit.list(tenantScope(a.tenantId), { limit: 50, offset: 0 })
      expect(listA.items.every((i) => i.tenantId === a.tenantId)).toBe(true)
    })
  })
})
