/**
 * ToolRegistry invariants (CLAUDE.md §15, §16, §17, §53).
 *
 * These tests assert the *structural* guarantees: a dangerous tool cannot be
 * registered, an out-of-zone tool cannot be executed, and no handler runs
 * before the PolicyGateway has allowed it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nullLogger, object, str } from '@corpus/shared'
import {
  ALL_TOOLS,
  EXTERNAL_TOOLS,
  INTERNAL_MANAGEMENT_TOOLS,
  INTERNAL_SELF_TOOLS,
  ToolRegistry,
  assertToolIsSafe,
  type ToolContext,
  type ToolDefinition,
} from '@corpus/ai'
import { createGatewayHarness, type GatewayHarness } from '../helpers/gateway.js'
import { EMPLOYEE, HR_ADMIN, MANAGER, makeAnonymous } from '../helpers/identities.js'

function contextFor(identity: ReturnType<typeof EMPLOYEE>, harness: GatewayHarness): ToolContext {
  return {
    identity,
    repos: {} as never,
    gateway: harness.gateway,
    knowledgeSearch: { search: async () => ({ passages: [], empty: true, strategy: 'none' }) } as never,
    logger: nullLogger,
    today: '2025-06-02',
    requestId: 'req_test',
    conversationId: null,
    allowedClassifications: [],
    limits: { maxContextChunks: 5, maxPageSize: 25 },
  }
}

describe('tool catalogue', () => {
  it('registers every declared tool without tripping a safety check', () => {
    const harness = createGatewayHarness()
    const registry = new ToolRegistry(harness.gateway, nullLogger)
    expect(() => registry.registerAll(ALL_TOOLS)).not.toThrow()
    expect(ALL_TOOLS.length).toBe(
      EXTERNAL_TOOLS.length + INTERNAL_SELF_TOOLS.length + INTERNAL_MANAGEMENT_TOOLS.length,
    )
  })

  it('has no duplicate tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('never exposes a generic SQL or database tool', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).not.toMatch(/sql|execute|query_database|raw|eval/i)
      const serialised = JSON.stringify(tool.parameters).toLowerCase()
      expect(serialised).not.toContain('"sql"')
      expect(serialised).not.toContain('table')
    }
  })

  it('gives every tool a permission, zone, risk and resource', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.permission, tool.name).toBeTruthy()
      expect(['EXTERNAL', 'INTERNAL']).toContain(tool.scope)
      expect(['LOW', 'PERSONAL_DATA', 'SENSITIVE', 'RESTRICTED']).toContain(tool.risk)
      expect(tool.resource, tool.name).toBeTruthy()
      expect(typeof tool.resolveResource, tool.name).toBe('function')
      expect(typeof tool.handler, tool.name).toBe('function')
    }
  })

  it('keeps self-service tools free of any subject identifier', () => {
    for (const tool of INTERNAL_SELF_TOOLS) {
      const properties = Object.keys(
        (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      )
      for (const property of properties) {
        expect(property, `${tool.name}.${property}`).not.toMatch(
          /employee|user_?id|tenant|role|permission/i,
        )
      }
    }
  })

  it('exposes no compensation tool in any zone', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.resource).not.toBe('employee.compensation')
      expect(tool.permission).not.toBe('employee.read.compensation')
    }
  })
})

describe('assertToolIsSafe', () => {
  const base: Omit<ToolDefinition<any>, 'name' | 'parameters' | 'validator'> = {
    description: 'x',
    scope: 'INTERNAL',
    permission: 'leave.read.self',
    risk: 'LOW',
    resource: 'leave.balance',
    action: 'read',
    auditRequired: false,
    resolveResource: async () => ({ type: 'leave.balance' }),
    handler: async () => ({ ok: true, result: { summary: 'x' } }),
  }

  it('rejects a tool named like an execution primitive', () => {
    for (const name of ['execute_sql', 'query_database', 'run_raw_query', 'eval_expression']) {
      expect(() =>
        assertToolIsSafe({
          ...base,
          name,
          parameters: { type: 'object', properties: {} },
          validator: object({}) as never,
        }),
      ).toThrow(/execution primitive|forbids/i)
    }
  })

  it('rejects a self-service tool that accepts an employee id', () => {
    expect(() =>
      assertToolIsSafe({
        ...base,
        name: 'get_leave_balance',
        parameters: { type: 'object', properties: { employee_id: { type: 'string' } } },
        validator: object({ employee_id: str() }) as never,
      }),
    ).toThrow(/derive the subject from the authenticated identity/)
  })

  it('rejects any tool that accepts a tenant, role or permission', () => {
    for (const property of ['tenant_id', 'role', 'permissions']) {
      expect(() =>
        assertToolIsSafe({
          ...base,
          // Even an allowlisted manager tool may not take these.
          name: 'search_employees',
          parameters: { type: 'object', properties: { [property]: { type: 'string' } } },
          validator: object({ [property]: str() }) as never,
        }),
      ).toThrow(/never inputs to a tool/)
    }
  })

  it('permits a manager tool to target another subject by business identifier', () => {
    expect(() =>
      assertToolIsSafe({
        ...base,
        name: 'get_employee_profile',
        permission: 'employee.read.team',
        resource: 'employee',
        parameters: { type: 'object', properties: { employeeNo: { type: 'string' } } },
        validator: object({ employeeNo: str() }) as never,
      }),
    ).not.toThrow()
  })
})

describe('tool visibility by identity', () => {
  let harness: GatewayHarness
  let registry: ToolRegistry

  beforeEach(() => {
    harness = createGatewayHarness()
    registry = new ToolRegistry(harness.gateway, nullLogger)
    registry.registerAll(ALL_TOOLS)
  })

  it('offers an external caller only the recruitment tools', () => {
    const names = registry.availableNames(makeAnonymous()).sort()
    expect(names).toEqual(
      [
        'get_application_status',
        'get_hiring_process',
        'get_job_details',
        'get_job_requirements',
        'search_jobs',
        'submit_application',
      ].sort(),
    )
  })

  it('never describes an internal tool to an external caller', () => {
    const described = JSON.stringify(registry.describeFor(makeAnonymous()))
    for (const forbidden of [
      'leave',
      'employee',
      'policy',
      'salary',
      'candidate',
      'approve',
      'holiday',
    ]) {
      expect(described.toLowerCase(), `external tool list mentions "${forbidden}"`).not.toContain(
        forbidden,
      )
    }
  })

  it('offers an employee only self-service tools', () => {
    const names = registry.availableNames(EMPLOYEE()).sort()
    expect(names).toEqual(
      [
        'cancel_leave_request',
        'create_leave_request',
        'get_holidays',
        'get_my_leave_balance',
        'get_my_leave_history',
        'get_my_leave_requests',
        'get_my_profile',
        'raise_hr_ticket',
        'search_hr_policy',
      ].sort(),
    )
    expect(names).not.toContain('approve_leave_request')
    expect(names).not.toContain('search_employees')
  })

  it('adds team tools for a manager', () => {
    const names = registry.availableNames(MANAGER())
    expect(names).toContain('get_team_leave_requests')
    expect(names).toContain('approve_leave_request')
    expect(names).toContain('search_employees')
    expect(names).not.toContain('update_application_stage')
  })

  it('adds recruitment management for HR_ADMIN', () => {
    const names = registry.availableNames(HR_ADMIN())
    expect(names).toContain('update_application_stage')
    expect(names).toContain('create_job')
    expect(names).toContain('search_candidates')
  })
})

describe('tool execution', () => {
  let harness: GatewayHarness
  let registry: ToolRegistry

  beforeEach(() => {
    harness = createGatewayHarness()
    registry = new ToolRegistry(harness.gateway, nullLogger)
    registry.registerAll(ALL_TOOLS)
  })

  it('denies an unknown tool without revealing the catalogue', async () => {
    const execution = await registry.execute('dump_all_salaries', {}, contextFor(EMPLOYEE(), harness))
    expect(execution.decision).toBe('DENY')
    expect(execution.reasonCode).toBe('TOOL_NOT_FOUND')
    expect(execution.outcome.ok).toBe(false)
    if (!execution.outcome.ok) {
      expect(execution.outcome.message).not.toMatch(/get_my_leave_balance|search_jobs/)
    }
  })

  it('denies an internal tool requested from the EXTERNAL zone', async () => {
    const execution = await registry.execute(
      'get_my_leave_balance',
      {},
      contextFor(makeAnonymous() as never, harness),
    )
    expect(execution.decision).toBe('DENY')
    expect(execution.reasonCode).toBe('TOOL_NOT_AVAILABLE_IN_ZONE')
  })

  it('denies an external tool requested from the INTERNAL zone', async () => {
    const execution = await registry.execute('search_jobs', {}, contextFor(EMPLOYEE(), harness))
    expect(execution.decision).toBe('DENY')
    expect(execution.reasonCode).toBe('TOOL_NOT_AVAILABLE_IN_ZONE')
  })

  it('rejects invalid arguments before the handler runs', async () => {
    const spy = vi.spyOn(
      ALL_TOOLS.find((t) => t.name === 'create_leave_request')!,
      'handler',
    )
    const execution = await registry.execute(
      'create_leave_request',
      { leaveTypeCode: 'ANNUAL', startDate: 'not-a-date', endDate: '2025-06-06' },
      contextFor(EMPLOYEE(), harness),
    )
    expect(execution.decision).toBe('DENY')
    expect(execution.reasonCode).toBe('INVALID_ARGUMENTS')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('never calls a handler when the gateway denies the request', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'approve_leave_request')!
    const spy = vi.spyOn(tool, 'handler')
    // An EMPLOYEE lacks leave.approve.team.
    const execution = await registry.execute(
      'approve_leave_request',
      { requestId: 'lvr_1' },
      {
        ...contextFor(EMPLOYEE(), harness),
        repos: {
          leaveRequests: { findById: async () => ({ employeeId: 'emp_other' }) },
        } as never,
      },
    )
    expect(execution.decision).toBe('DENY')
    expect(spy).not.toHaveBeenCalled()
    expect(harness.auditEntries.at(-1)).toMatchObject({ decision: 'DENY' })
    spy.mockRestore()
  })

  it('records an audit entry for every tool authorisation decision', async () => {
    await registry.execute('get_holidays', {}, {
      ...contextFor(EMPLOYEE(), harness),
      repos: { holidays: { listUpcoming: async () => [] } } as never,
    })
    expect(harness.auditEntries.at(-1)).toMatchObject({
      resource: 'holiday',
      action: 'list',
      decision: 'ALLOW',
    })
  })
})
