/**
 * Leave arithmetic (CLAUDE.md §22, §38). These are the calculations the AI is
 * explicitly forbidden from performing, so they are tested exhaustively.
 */

import { describe, expect, it } from 'vitest'
import {
  availableDays,
  calculateWorkingDays,
  chargeableDays,
  validateLeaveRequest,
  type LeaveValidationInput,
} from '@corpus/domain'

describe('calculateWorkingDays', () => {
  it('counts a single weekday as one working day', () => {
    // 2025-06-02 is a Monday.
    const result = calculateWorkingDays('2025-06-02', '2025-06-02')
    expect(result).toMatchObject({ totalDays: 1, weekendDays: 0, holidayDays: 0, workingDays: 1 })
  })

  it('excludes the weekend from a full week', () => {
    // Monday 2 June to Sunday 8 June 2025.
    const result = calculateWorkingDays('2025-06-02', '2025-06-08')
    expect(result.totalDays).toBe(7)
    expect(result.weekendDays).toBe(2)
    expect(result.workingDays).toBe(5)
  })

  it('excludes holidays that fall on weekdays', () => {
    const result = calculateWorkingDays('2025-06-02', '2025-06-06', ['2025-06-04'])
    expect(result.holidayDays).toBe(1)
    expect(result.workingDays).toBe(4)
    expect(result.countedDates).not.toContain('2025-06-04')
  })

  it('counts a holiday falling on a weekend only once, as a weekend day', () => {
    // 2025-06-07 is a Saturday.
    const result = calculateWorkingDays('2025-06-02', '2025-06-08', ['2025-06-07'])
    expect(result.weekendDays).toBe(2)
    expect(result.holidayDays).toBe(0)
    expect(result.workingDays).toBe(5)
  })

  it('returns zero working days for a weekend-only range', () => {
    const result = calculateWorkingDays('2025-06-07', '2025-06-08')
    expect(result.workingDays).toBe(0)
  })

  it('handles a range spanning a month and a year boundary', () => {
    const december = calculateWorkingDays('2025-12-29', '2026-01-02')
    expect(december.totalDays).toBe(5)
    expect(december.workingDays).toBe(5) // Mon–Fri

    const leap = calculateWorkingDays('2024-02-28', '2024-03-01')
    expect(leap.totalDays).toBe(3) // 28, 29 (leap day), 1
  })

  it('respects a custom work week', () => {
    // Friday/Saturday weekend.
    const result = calculateWorkingDays('2025-06-02', '2025-06-08', [], { nonWorkingDays: [5, 6] })
    expect(result.weekendDays).toBe(2)
    expect(result.workingDays).toBe(5)
    expect(result.countedDates).toContain('2025-06-08') // Sunday is a work day here
  })

  it('rejects an inverted range', () => {
    expect(() => calculateWorkingDays('2025-06-10', '2025-06-01')).toThrow(
      /startDate must not be after endDate/,
    )
  })

  it('rejects a range beyond the maximum span', () => {
    expect(() => calculateWorkingDays('2024-01-01', '2025-12-31')).toThrow(/exceeds the maximum/)
  })
})

describe('chargeableDays', () => {
  const breakdown = calculateWorkingDays('2025-06-02', '2025-06-08')

  it('charges working days when the type counts working days only', () => {
    expect(chargeableDays({ countsWorkingDaysOnly: true }, breakdown)).toBe(5)
  })

  it('charges calendar days otherwise', () => {
    expect(chargeableDays({ countsWorkingDaysOnly: false }, breakdown)).toBe(7)
  })
})

describe('availableDays', () => {
  it('subtracts used and pending from entitlement plus carry-over', () => {
    expect(
      availableDays({ entitledDays: 18, carriedOverDays: 2, usedDays: 5, pendingDays: 3 }),
    ).toBe(12)
  })
})

function input(overrides: Partial<LeaveValidationInput> = {}): LeaveValidationInput {
  return {
    startDate: '2025-06-02',
    endDate: '2025-06-06',
    today: '2025-05-20',
    hireDate: '2023-01-01',
    employeeStatus: 'ACTIVE',
    leaveType: {
      countsWorkingDaysOnly: true,
      maxConsecutiveDays: 20,
      active: true,
      name: 'Annual Leave',
    },
    balance: { entitledDays: 18, carriedOverDays: 2, usedDays: 0, pendingDays: 0 },
    holidays: [],
    existingRequests: [],
    ...overrides,
  }
}

describe('validateLeaveRequest', () => {
  it('accepts a valid request and reports the balance impact', () => {
    const result = validateLeaveRequest(input())
    expect(result.valid).toBe(true)
    expect(result.chargeableDays).toBe(5)
    expect(result.availableBefore).toBe(20)
    expect(result.availableAfter).toBe(15)
  })

  it('rejects an inverted date range without evaluating anything else', () => {
    const result = validateLeaveRequest(input({ startDate: '2025-06-10', endDate: '2025-06-01' }))
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toEqual(['INVALID_RANGE'])
  })

  it('rejects a request that exceeds the available balance', () => {
    const result = validateLeaveRequest(
      input({ balance: { entitledDays: 3, carriedOverDays: 0, usedDays: 0, pendingDays: 0 } }),
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('INSUFFICIENT_BALANCE')
    expect(result.issues.find((i) => i.code === 'INSUFFICIENT_BALANCE')?.message).toContain('3 day(s)')
  })

  it('counts pending days against the balance', () => {
    const result = validateLeaveRequest(
      input({ balance: { entitledDays: 6, carriedOverDays: 0, usedDays: 0, pendingDays: 4 } }),
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('INSUFFICIENT_BALANCE')
  })

  it('rejects a request with no balance record at all', () => {
    const result = validateLeaveRequest(input({ balance: null }))
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('INSUFFICIENT_BALANCE')
  })

  it('rejects an overlapping pending request', () => {
    const result = validateLeaveRequest(
      input({
        existingRequests: [
          { id: 'lvr_1', startDate: '2025-06-05', endDate: '2025-06-09', status: 'PENDING' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('OVERLAPPING_REQUEST')
  })

  it('ignores overlaps with rejected or cancelled requests', () => {
    const result = validateLeaveRequest(
      input({
        existingRequests: [
          { id: 'a', startDate: '2025-06-05', endDate: '2025-06-09', status: 'REJECTED' },
          { id: 'b', startDate: '2025-06-03', endDate: '2025-06-04', status: 'CANCELLED' },
        ],
      }),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a range with no working days', () => {
    const result = validateLeaveRequest(input({ startDate: '2025-06-07', endDate: '2025-06-08' }))
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('NO_WORKING_DAYS')
  })

  it('enforces the consecutive-day limit for the leave type', () => {
    const result = validateLeaveRequest(
      input({
        startDate: '2025-06-02',
        endDate: '2025-06-13',
        leaveType: { countsWorkingDaysOnly: true, maxConsecutiveDays: 5, active: true, name: 'Sick Leave' },
        balance: { entitledDays: 40, carriedOverDays: 0, usedDays: 0, pendingDays: 0 },
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('EXCEEDS_CONSECUTIVE_LIMIT')
  })

  it('rejects leave before the hire date', () => {
    const result = validateLeaveRequest(input({ hireDate: '2025-07-01' }))
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('BEFORE_HIRE_DATE')
  })

  it('rejects leave for a terminated employee', () => {
    const result = validateLeaveRequest(input({ employeeStatus: 'TERMINATED' }))
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('EMPLOYEE_NOT_ELIGIBLE')
  })

  it('rejects an inactive leave type', () => {
    const result = validateLeaveRequest(
      input({
        leaveType: { countsWorkingDaysOnly: true, maxConsecutiveDays: null, active: false, name: 'Study Leave' },
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('LEAVE_TYPE_INACTIVE')
  })

  it('rejects excessive backdating but allows recent backdating', () => {
    const tooOld = validateLeaveRequest(
      input({ startDate: '2025-01-06', endDate: '2025-01-10', today: '2025-05-20' }),
    )
    expect(tooOld.issues.map((i) => i.code)).toContain('TOO_FAR_IN_PAST')

    const recent = validateLeaveRequest(
      input({ startDate: '2025-05-12', endDate: '2025-05-16', today: '2025-05-20' }),
    )
    expect(recent.valid).toBe(true)
  })

  it('deducts holidays from the chargeable total', () => {
    const result = validateLeaveRequest(input({ holidays: ['2025-06-04'] }))
    expect(result.valid).toBe(true)
    expect(result.chargeableDays).toBe(4)
  })
})
