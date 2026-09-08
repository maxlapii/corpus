/** Leave status machine (CLAUDE.md §22). */

import { compareDates, type DateOnly } from '@corpus/shared'
import type { LeaveStatus } from './entities.js'

const ALLOWED: Record<LeaveStatus, LeaveStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['CANCELLED'],
  REJECTED: [],
  CANCELLED: [],
}

export function canTransitionLeave(
  from: LeaveStatus,
  to: LeaveStatus,
): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: `The request is already ${from}.` }
  if (!ALLOWED[from].includes(to)) {
    return { ok: false, reason: `A ${from} leave request cannot become ${to}.` }
  }
  return { ok: true }
}

export function isOpenLeaveStatus(status: LeaveStatus): boolean {
  return status === 'PENDING' || status === 'APPROVED'
}

export interface CancellableCheck {
  ok: boolean
  reason?: string
}

/**
 * Whether a leave request may still be cancelled, and the days credited back.
 *
 * A PENDING request has only *reserved* days, so releasing them is always safe.
 * An APPROVED request has consumed them, so it may only be cancelled before the
 * leave starts — otherwise cancelling would refund days the employee has
 * already taken, letting the same entitlement be spent twice.
 */
export function canCancelLeave(
  request: { status: LeaveStatus; startDate: DateOnly },
  today: DateOnly,
): CancellableCheck {
  if (!isOpenLeaveStatus(request.status)) {
    return { ok: false, reason: `A ${request.status.toLowerCase()} leave request cannot be cancelled.` }
  }
  if (request.status === 'APPROVED' && compareDates(today, request.startDate) >= 0) {
    return {
      ok: false,
      reason:
        'Approved leave cannot be cancelled once it has started. Please contact HR to adjust it.',
    }
  }
  return { ok: true }
}
