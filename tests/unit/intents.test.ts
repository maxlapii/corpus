/**
 * Intent canonicalisation (CLAUDE.md §19).
 *
 * The central guarantee: an LLM may propose an intent *name*; scope, target and
 * risk always come from the backend table.
 */

import { describe, expect, it } from 'vitest'
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
