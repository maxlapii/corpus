/**
 * Job status machine (CLAUDE.md §21).
 *
 * ARCHIVED is terminal: an archived posting must not be silently republished,
 * because applications and audit rows still reference it and candidates would
 * see a role the business considers closed.
 */

import type { JobStatus } from './entities.js'

const ALLOWED: Record<JobStatus, JobStatus[]> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['CLOSED', 'ARCHIVED'],
  CLOSED: ['PUBLISHED', 'ARCHIVED'],
  ARCHIVED: [],
}

export function allowedNextJobStatuses(status: JobStatus): JobStatus[] {
  return [...(ALLOWED[status] ?? [])]
}

export function canTransitionJob(
  from: JobStatus,
  to: JobStatus,
): { ok: boolean; reason?: string } {
  if (from === to) return { ok: true }
  if (!ALLOWED[from].includes(to)) {
    return {
      ok: false,
      reason:
        ALLOWED[from].length === 0
          ? `An ${from.toLowerCase()} job cannot be changed.`
          : `A job cannot move from ${from} to ${to}. Allowed: ${ALLOWED[from].join(', ')}.`,
    }
  }
  return { ok: true }
}
