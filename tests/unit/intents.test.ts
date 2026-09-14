/**
 * Intent canonicalisation (CLAUDE.md §19).
 *
 * The central guarantee: an LLM may propose an intent *name*; scope, target and
 * risk always come from the backend table.
 */

import { describe, expect, it } from 'vitest'
import { matchIntentByKeywords } from '@corpus/ai'
import {
  INTENTS,
  INTENT_DEFINITIONS,
  canonicaliseIntent,
  isIntentAllowedInZone,
} from '@corpus/domain'

describe('intent definitions', () => {
  it('defines every intent exactly once', () => {
    for (const intent of INTENTS) {
      expect(INTENT_DEFINITIONS[intent]?.intent).toBe(intent)
    }
    expect(Object.keys(INTENT_DEFINITIONS)).toHaveLength(INTENTS.length)
  })

  it('marks salary as RESTRICTED risk', () => {
    expect(INTENT_DEFINITIONS.EMPLOYEE_SALARY.risk).toBe('RESTRICTED')
    expect(INTENT_DEFINITIONS.EMPLOYEE_SALARY.zone).toBe('INTERNAL')
  })

  it('keeps every internal intent out of the EXTERNAL zone', () => {
    for (const intent of INTENTS) {
      const definition = INTENT_DEFINITIONS[intent]
      if (definition.zone !== 'INTERNAL') continue
      expect(isIntentAllowedInZone(intent, 'EXTERNAL'), intent).toBe(false)
    }
  })

  it('permits public recruitment intents in both zones or EXTERNAL only', () => {
    expect(isIntentAllowedInZone('PUBLIC_JOB_SEARCH', 'EXTERNAL')).toBe(true)
    expect(isIntentAllowedInZone('PUBLIC_JOB_SEARCH', 'INTERNAL')).toBe(true)
    expect(isIntentAllowedInZone('PUBLIC_APPLY', 'INTERNAL')).toBe(false)
  })
})

describe('canonicaliseIntent', () => {
  it('accepts a known intent name', () => {
    expect(canonicaliseIntent('MY_LEAVE_BALANCE').intent).toBe('MY_LEAVE_BALANCE')
    expect(canonicaliseIntent({ intent: 'HOLIDAYS' }).intent).toBe('HOLIDAYS')
  })

  it('collapses an unknown intent to UNKNOWN', () => {
    for (const proposed of [
      'DUMP_EVERYTHING',
      'ADMIN_OVERRIDE',
      '',
      null,
      undefined,
      42,
      { intent: 'DROP_TABLE' },
      { intent: ['MY_LEAVE_BALANCE'] },
    ]) {
      expect(canonicaliseIntent(proposed).intent, String(proposed)).toBe('UNKNOWN')
    }
  })

  it('ignores scope, risk and permission fields supplied by the model', () => {
    // A model claiming a salary question is LOW risk with a granted permission.
    const canonical = canonicaliseIntent({
      intent: 'EMPLOYEE_SALARY',
      scope: 'EXTERNAL',
      risk: 'LOW',
      target: 'SELF',
      permission: 'employee.read.compensation',
      authorized: true,
    })
    expect(canonical.risk).toBe('RESTRICTED')
    expect(canonical.zone).toBe('INTERNAL')
    expect(canonical.target).toBe('OTHER_EMPLOYEE')
    expect(canonical).not.toHaveProperty('permission')
    expect(canonical).not.toHaveProperty('authorized')
  })
})

/**
 * Routing for the questions people actually type (CLAUDE.md §31, §32).
 *
 * The rules below are the free path — no model call — so a mistake here is a
 * mistake every turn. The pairs that matter are the near-misses: a question
 * about a process reads a lot like an instruction to carry it out.
 */
describe('keyword intent routing', () => {
  it.each([
    // Asking about the process, not asking the bot to do it.
    ['How do I request sick leave?', 'HR_POLICY_QUESTION'],
    ['How do I request annual leave?', 'HR_POLICY_QUESTION'],
    ['Who approves my leave request?', 'HR_POLICY_QUESTION'],
    ['What is the process for taking time off?', 'HR_POLICY_QUESTION'],
    ['Can I carry over unused leave?', 'HR_POLICY_QUESTION'],
    // Their own figures, which only the database knows.
    ['How many annual leave days do I have?', 'MY_LEAVE_BALANCE'],
    ['What is my leave balance?', 'MY_LEAVE_BALANCE'],
    ['How much leave do I have left?', 'MY_LEAVE_BALANCE'],
    ['Do I have any annual leave left?', 'MY_LEAVE_BALANCE'],
    // Still instructions.
    ['Request leave from 2026-10-01 to 2026-10-03', 'CREATE_LEAVE_REQUEST'],
    ['Cancel my leave request lvr_abc123', 'CANCEL_LEAVE_REQUEST'],
    ['Approve leave request lvr_abc123', 'APPROVE_LEAVE_REQUEST'],
    ['I want to apply for ENG-001', 'PUBLIC_APPLY'],
  ])('routes %j to %s', (message, expected) => {
    expect(matchIntentByKeywords(message)).toBe(expected)
  })

  it('does not read a question about applying as an application', () => {
    // PUBLIC_APPLY would submit an application with no name and no e-mail.
    expect(matchIntentByKeywords('Can I apply for two positions?')).not.toBe('PUBLIC_APPLY')
    expect(matchIntentByKeywords('How do I apply for a job?')).not.toBe('PUBLIC_APPLY')
  })

  it('leaves a salary question classified as a salary question', () => {
    // It must reach the gateway and be denied there, not quietly rerouted.
    expect(matchIntentByKeywords("What is Sarah's salary?")).toBe('EMPLOYEE_SALARY')
    expect(matchIntentByKeywords('How much does the HR manager earn?')).toBe('EMPLOYEE_SALARY')
  })
})
