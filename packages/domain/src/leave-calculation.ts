/**
 * Deterministic leave arithmetic (CLAUDE.md §22 and §38).
 *
 * Never trust a client- or AI-supplied day count. Everything here is pure so it
 * can be unit-tested exhaustively and reused by both the API and the bots.
 */

import {
  compareDates,
  daysBetweenInclusive,
  dayOfWeek,
  eachDate,
  rangesOverlap,
  type DateOnly,
} from '@corpus/shared'
import type { LeaveBalance, LeaveRequest, LeaveType } from './entities.js'

/** Days of week that are non-working. Default: Saturday (6) and Sunday (0). */
export interface WorkWeek {
  nonWorkingDays: readonly number[]
}

export const DEFAULT_WORK_WEEK: WorkWeek = { nonWorkingDays: [0, 6] }

export interface WorkingDaysBreakdown {
  totalDays: number
  weekendDays: number
  holidayDays: number
  workingDays: number
  /** Individual dates counted as working days, for explainability in audit. */
  countedDates: DateOnly[]
}

/**
 * Count working days in an inclusive range, excluding weekends and holidays.
 * A holiday that falls on a weekend is counted once (as a weekend day).
 */
export function calculateWorkingDays(
  startDate: DateOnly,
  endDate: DateOnly,
  holidays: readonly DateOnly[] = [],
  workWeek: WorkWeek = DEFAULT_WORK_WEEK,
  maxRangeDays = 366,
): WorkingDaysBreakdown {
  if (compareDates(startDate, endDate) > 0) {
    throw new Error('startDate must not be after endDate')
  }
  const totalDays = daysBetweenInclusive(startDate, endDate)
  if (totalDays > maxRangeDays) {
    throw new Error(`Leave range exceeds the maximum of ${maxRangeDays} days`)
  }

  const holidaySet = new Set(holidays)
  const nonWorking = new Set(workWeek.nonWorkingDays)

  let weekendDays = 0
  let holidayDays = 0
  const countedDates: DateOnly[] = []

  for (const date of eachDate(startDate, endDate, maxRangeDays)) {
    if (nonWorking.has(dayOfWeek(date))) {
      weekendDays++
      continue
    }
    if (holidaySet.has(date)) {
      holidayDays++
      continue
    }
    countedDates.push(date)
  }

  return {
    totalDays,
    weekendDays,
    holidayDays,
    workingDays: countedDates.length,
    countedDates,
  }
}

/** Days charged against the balance for a given leave type. */
export function chargeableDays(
  leaveType: Pick<LeaveType, 'countsWorkingDaysOnly'>,
  breakdown: WorkingDaysBreakdown,
): number {
  return leaveType.countsWorkingDaysOnly ? breakdown.workingDays : breakdown.totalDays
}

export function availableDays(balance: Pick<LeaveBalance, 'entitledDays' | 'usedDays' | 'pendingDays' | 'carriedOverDays'>): number {
  return (
    balance.entitledDays + balance.carriedOverDays - balance.usedDays - balance.pendingDays
  )
}

export type LeaveValidationCode =
  | 'INVALID_RANGE'
  | 'RANGE_TOO_LONG'
  | 'NO_WORKING_DAYS'
  | 'EXCEEDS_CONSECUTIVE_LIMIT'
  | 'INSUFFICIENT_BALANCE'
  | 'OVERLAPPING_REQUEST'
  | 'EMPLOYEE_NOT_ELIGIBLE'
  | 'LEAVE_TYPE_INACTIVE'
  | 'BEFORE_HIRE_DATE'
  | 'TOO_FAR_IN_PAST'

export interface LeaveValidationIssue {
  code: LeaveValidationCode
  message: string
}

export interface LeaveValidationInput {
  startDate: DateOnly
  endDate: DateOnly
  today: DateOnly
  hireDate: DateOnly
  employeeStatus: string
  leaveType: Pick<LeaveType, 'countsWorkingDaysOnly' | 'maxConsecutiveDays' | 'active' | 'name'>
  balance: Pick<LeaveBalance, 'entitledDays' | 'usedDays' | 'pendingDays' | 'carriedOverDays'> | null
  holidays: readonly DateOnly[]
  existingRequests: readonly Pick<LeaveRequest, 'id' | 'startDate' | 'endDate' | 'status'>[]
  workWeek?: WorkWeek
  /** How far into the past a request may be backdated. */
  maxBackdateDays?: number
}

export interface LeaveValidationResult {
  valid: boolean
  issues: LeaveValidationIssue[]
  breakdown: WorkingDaysBreakdown | null
  chargeableDays: number
  availableBefore: number
  availableAfter: number
}

/**
 * Full backend validation of a leave request (CLAUDE.md §22).
 * Pure: callers supply the loaded rows, so this is trivially testable.
 */
export function validateLeaveRequest(input: LeaveValidationInput): LeaveValidationResult {
  const issues: LeaveValidationIssue[] = []
  const maxBackdateDays = input.maxBackdateDays ?? 30

  const fail = (code: LeaveValidationCode, message: string) => issues.push({ code, message })

  if (compareDates(input.startDate, input.endDate) > 0) {
    fail('INVALID_RANGE', 'The start date must be on or before the end date.')
    return {
      valid: false,
      issues,
      breakdown: null,
      chargeableDays: 0,
      availableBefore: input.balance ? availableDays(input.balance) : 0,
      availableAfter: input.balance ? availableDays(input.balance) : 0,
    }
  }

  if (!input.leaveType.active) {
    fail('LEAVE_TYPE_INACTIVE', `${input.leaveType.name} is not currently available.`)
  }

  if (input.employeeStatus !== 'ACTIVE' && input.employeeStatus !== 'ON_LEAVE') {
    fail('EMPLOYEE_NOT_ELIGIBLE', 'Your employment status does not allow new leave requests.')
  }

  if (compareDates(input.startDate, input.hireDate) < 0) {
    fail('BEFORE_HIRE_DATE', 'Leave cannot start before your hire date.')
  }

  if (daysBetweenInclusive(input.startDate, input.today) - 1 > maxBackdateDays) {
    fail('TOO_FAR_IN_PAST', `Leave cannot be backdated by more than ${maxBackdateDays} days.`)
  }

  let breakdown: WorkingDaysBreakdown | null = null
  try {
    breakdown = calculateWorkingDays(
      input.startDate,
      input.endDate,
      input.holidays,
      input.workWeek ?? DEFAULT_WORK_WEEK,
    )
  } catch {
    fail('RANGE_TOO_LONG', 'The requested leave range is too long.')
  }

  let charged = 0
  if (breakdown) {
    charged = chargeableDays(input.leaveType, breakdown)
    if (charged <= 0) {
      fail('NO_WORKING_DAYS', 'The selected dates contain no working days.')
    }
    const limit = input.leaveType.maxConsecutiveDays
    if (limit !== null && limit !== undefined && charged > limit) {
      fail(
        'EXCEEDS_CONSECUTIVE_LIMIT',
        `${input.leaveType.name} allows at most ${limit} consecutive days.`,
      )
    }
  }

  const overlapping = input.existingRequests.filter(
    (r) =>
      (r.status === 'PENDING' || r.status === 'APPROVED') &&
      rangesOverlap(input.startDate, input.endDate, r.startDate, r.endDate),
  )
  if (overlapping.length > 0) {
    fail('OVERLAPPING_REQUEST', 'You already have a leave request covering some of those dates.')
  }

  const availableBefore = input.balance ? availableDays(input.balance) : 0
  if (!input.balance) {
    fail('INSUFFICIENT_BALANCE', `You have no ${input.leaveType.name} balance for this period.`)
  } else if (charged > availableBefore) {
    fail(
      'INSUFFICIENT_BALANCE',
      `You have ${availableBefore} day(s) of ${input.leaveType.name} available but requested ${charged}.`,
    )
  }

  return {
    valid: issues.length === 0,
    issues,
    breakdown,
    chargeableDays: charged,
    availableBefore,
    availableAfter: availableBefore - charged,
  }
}
