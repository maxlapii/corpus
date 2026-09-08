/**
 * Application stage machine (CLAUDE.md §21).
 *
 * Transitions are validated in the backend; a caller (or the AI) cannot jump an
 * application straight from APPLIED to HIRED.
 */

import type { ApplicationStage } from './entities.js'

const TERMINAL: ApplicationStage[] = ['HIRED', 'REJECTED', 'WITHDRAWN']

export const PIPELINE: ApplicationStage[] = [
  'APPLIED',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'TECHNICAL',
  'FINAL',
  'OFFER',
  'HIRED',
]

const ALLOWED: Record<ApplicationStage, ApplicationStage[]> = {
  APPLIED: ['SCREENING', 'REJECTED', 'WITHDRAWN'],
  SCREENING: ['SHORTLISTED', 'REJECTED', 'WITHDRAWN'],
  SHORTLISTED: ['INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['TECHNICAL', 'FINAL', 'REJECTED', 'WITHDRAWN'],
  TECHNICAL: ['FINAL', 'REJECTED', 'WITHDRAWN'],
  FINAL: ['OFFER', 'REJECTED', 'WITHDRAWN'],
  OFFER: ['HIRED', 'REJECTED', 'WITHDRAWN'],
  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
}

export function isTerminalStage(stage: ApplicationStage): boolean {
  return TERMINAL.includes(stage)
}

export function allowedNextStages(stage: ApplicationStage): ApplicationStage[] {
  return [...(ALLOWED[stage] ?? [])]
}

export interface TransitionResult {
  ok: boolean
  reason?: string
}

export function canTransition(from: ApplicationStage, to: ApplicationStage): TransitionResult {
  if (from === to) return { ok: false, reason: 'The application is already in that stage.' }
  if (isTerminalStage(from)) {
    return { ok: false, reason: `An application in stage ${from} can no longer be moved.` }
  }
  if (!ALLOWED[from].includes(to)) {
    return {
      ok: false,
      reason: `An application cannot move from ${from} to ${to}. Allowed: ${ALLOWED[from].join(', ')}.`,
    }
  }
  return { ok: true }
}

/**
 * Stage descriptions safe to show a candidate. Internal stage names such as
 * SCREENING leak process detail, so external callers see a coarser summary.
 */
export function publicStageLabel(stage: ApplicationStage): string {
  switch (stage) {
    case 'APPLIED':
      return 'Received'
    case 'SCREENING':
    case 'SHORTLISTED':
      return 'Under review'
    case 'INTERVIEW':
    case 'TECHNICAL':
    case 'FINAL':
      return 'In interview process'
    case 'OFFER':
      return 'Offer stage'
    case 'HIRED':
      return 'Hired'
    case 'REJECTED':
      return 'Not proceeding'
    case 'WITHDRAWN':
      return 'Withdrawn'
  }
}

/**
 * Whether an application may still have interviews or offers attached.
 *
 * A terminal or CLOSED application is a finished record: writing new artefacts
 * onto it would create interviews for a rejected candidate, or a second offer
 * after one was already accepted.
 */
export function canAttachToApplication(application: {
  stage: ApplicationStage
  status: 'OPEN' | 'CLOSED'
}): TransitionResult {
  if (application.status === 'CLOSED' || isTerminalStage(application.stage)) {
    return {
      ok: false,
      reason: `This application is ${application.stage.toLowerCase()} and can no longer be changed.`,
    }
  }
  return { ok: true }
}

/** Stages at which extending an offer is meaningful. */
export function canExtendOffer(application: {
  stage: ApplicationStage
  status: 'OPEN' | 'CLOSED'
}): TransitionResult {
  const attachable = canAttachToApplication(application)
  if (!attachable.ok) return attachable
  if (application.stage !== 'FINAL' && application.stage !== 'OFFER') {
    return {
      ok: false,
      reason: `An offer can only be made at the FINAL or OFFER stage; this application is at ${application.stage}.`,
    }
  }
  return { ok: true }
}
