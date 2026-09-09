/**
 * Curated-answer domain rules. The one that matters is the audience/
 * classification invariant: it is the only thing standing between an authored
 * answer and an anonymous candidate, so it is asserted from every angle.
 */

import { describe, expect, it } from 'vitest'
import {
  ANSWER_AUDIENCES,
  MAX_TRAINING_PHRASES,
  audienceReachesExternalZone,
  buildAnswerSearchText,
  canTransitionAnswer,
  RESERVED_BOT_COMMANDS,
  commandReachesCompartment,
  isAdvertisableCommand,
  isAnswerAudience,
  normaliseCommand,
  resolveRequiresAccount,
  validateAnswerDraft,
  type AnswerAudience,
  type Classification,
} from '@corpus/domain'

const base = {
  question: 'How do I apply?',
  answer: 'Tell me the job code and your name.',
  audience: 'INTERNAL' as AnswerAudience,
  classification: 'INTERNAL' as Classification,
  effectiveFrom: '2026-01-01',
}

const codesOf = (issues: { code: string }[]) => issues.map((i) => i.code)

describe('curated answer validation', () => {
  it('accepts a well-formed internal answer', () => {
    expect(validateAnswerDraft(base)).toEqual([])
  })

  it.each(['EXTERNAL', 'BOTH'] as const)(
    'refuses a %s answer that is not PUBLIC',
    (audience) => {
      for (const classification of ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const) {
        const issues = validateAnswerDraft({ ...base, audience, classification })
        expect(codesOf(issues), `${audience}/${classification}`).toContain(
          'EXTERNAL_MUST_BE_PUBLIC',
        )
      }
    },
  )

  it.each(['EXTERNAL', 'BOTH'] as const)('accepts a PUBLIC %s answer', (audience) => {
    expect(validateAnswerDraft({ ...base, audience, classification: 'PUBLIC' })).toEqual([])
  })

  it('lets an INTERNAL answer carry any classification', () => {
    for (const classification of ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const) {
      expect(validateAnswerDraft({ ...base, classification })).toEqual([])
    }
  })

  it('agrees with audienceReachesExternalZone for every audience', () => {
    for (const audience of ANSWER_AUDIENCES) {
      const issues = validateAnswerDraft({ ...base, audience, classification: 'RESTRICTED' })
      expect(codesOf(issues).includes('EXTERNAL_MUST_BE_PUBLIC')).toBe(
        audienceReachesExternalZone(audience),
      )
    }
  })

  it('rejects an empty or oversized question and answer', () => {
    expect(codesOf(validateAnswerDraft({ ...base, question: 'a' }))).toContain('TOO_SHORT')
    expect(codesOf(validateAnswerDraft({ ...base, answer: '' }))).toContain('TOO_SHORT')
    expect(codesOf(validateAnswerDraft({ ...base, question: 'q'.repeat(301) }))).toContain('TOO_LONG')
    expect(codesOf(validateAnswerDraft({ ...base, answer: 'a'.repeat(4001) }))).toContain('TOO_LONG')
  })

  it('caps the training phrase list', () => {
    const phrases = Array.from({ length: MAX_TRAINING_PHRASES + 1 }, (_, i) => `phrasing ${i}`)
    expect(codesOf(validateAnswerDraft({ ...base, phrases }))).toContain('TOO_MANY')
  })

  it('rejects a phrase that is too short to retrieve on', () => {
    expect(codesOf(validateAnswerDraft({ ...base, phrases: ['ok'] }))).toContain('INVALID')
  })

  it('rejects malformed and inverted effective dates', () => {
    expect(codesOf(validateAnswerDraft({ ...base, effectiveFrom: '01-01-2026' }))).toContain('INVALID')
    expect(
      codesOf(validateAnswerDraft({ ...base, effectiveFrom: '2026-06-01', effectiveTo: '2026-01-01' })),
    ).toContain('BEFORE_START')
  })
})

describe('the verified-account gate', () => {
  it('defaults an internal answer to requiring an account', () => {
    expect(resolveRequiresAccount('INTERNAL', undefined)).toBe(true)
  })

  it('never gates an external-audience answer, which has no account to check', () => {
    for (const audience of ['EXTERNAL', 'BOTH'] as const) {
      for (const requested of [true, false, undefined]) {
        expect(resolveRequiresAccount(audience, requested), `${audience}/${requested}`).toBe(false)
      }
    }
  })

  it('lets an internal answer drop the requirement only when PUBLIC', () => {
    const ungated = { ...base, requiresAccount: false }
    expect(validateAnswerDraft({ ...ungated, classification: 'PUBLIC' })).toEqual([])
    for (const classification of ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const) {
      expect(codesOf(validateAnswerDraft({ ...ungated, classification }))).toContain(
        'UNGATED_MUST_BE_PUBLIC',
      )
    }
  })

  it('does not complain about a gated answer at any classification', () => {
    for (const classification of ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const) {
      expect(validateAnswerDraft({ ...base, requiresAccount: true, classification })).toEqual([])
    }
  })
})

describe('bot commands on an answer', () => {
  const withCommand = (command: string, description = 'A short menu line') => ({
    ...base,
    command,
    commandDescription: description,
  })

  it('accepts a well-formed command with a description', () => {
    expect(validateAnswerDraft(withCommand('benefits'))).toEqual([])
    expect(validateAnswerDraft(withCommand('/benefits'))).toEqual([])
    expect(validateAnswerDraft(withCommand('parental_leave_2026'))).toEqual([])
  })

  it('rejects a command Telegram would not accept', () => {
    for (const bad of ['My Command', 'benefits!', 'café', 'a'.repeat(33), '-x']) {
      expect(codesOf(validateAnswerDraft(withCommand(bad))), bad).toContain('INVALID')
    }
  })

  it('refuses to shadow a built-in command', () => {
    for (const reserved of RESERVED_BOT_COMMANDS) {
      expect(codesOf(validateAnswerDraft(withCommand(reserved))), reserved).toContain('RESERVED')
    }
  })

  it('requires a menu description, because the menu is world-readable', () => {
    expect(codesOf(validateAnswerDraft({ ...base, command: 'benefits' }))).toContain('REQUIRED')
    expect(codesOf(validateAnswerDraft(withCommand('benefits', 'x')))).toContain('REQUIRED')
    expect(codesOf(validateAnswerDraft(withCommand('benefits', 'y'.repeat(257))))).toContain('TOO_LONG')
  })

  it('leaves an answer without a command alone', () => {
    expect(validateAnswerDraft({ ...base, command: null })).toEqual([])
    expect(validateAnswerDraft({ ...base, command: '' })).toEqual([])
  })

  it('normalises the leading slash and casing', () => {
    expect(normaliseCommand('/Benefits')).toBe('benefits')
    expect(normaliseCommand('  BENEFITS  ')).toBe('benefits')
  })
})

describe('what may be advertised in a bot menu', () => {
  const advertisable = {
    command: 'benefits',
    commandDescription: 'What we offer',
    audience: 'BOTH' as AnswerAudience,
    classification: 'PUBLIC' as Classification,
    status: 'ACTIVE' as const,
  }

  it('advertises an ACTIVE PUBLIC command', () => {
    expect(isAdvertisableCommand(advertisable)).toBe(true)
  })

  it.each(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const)(
    'never advertises a %s answer, even though its command still works',
    (classification) => {
      // The menu is visible before anyone verifies, so listing a sensitive
      // command would leak that it exists.
      expect(isAdvertisableCommand({ ...advertisable, classification })).toBe(false)
    },
  )

  it.each(['DRAFT', 'ARCHIVED'] as const)('never advertises a %s answer', (status) => {
    expect(isAdvertisableCommand({ ...advertisable, status })).toBe(false)
  })

  it('needs both a command and a description', () => {
    expect(isAdvertisableCommand({ ...advertisable, command: null })).toBe(false)
    expect(isAdvertisableCommand({ ...advertisable, commandDescription: null })).toBe(false)
  })

  it('routes each audience to the right bot menu', () => {
    expect(commandReachesCompartment('EXTERNAL', 'EXTERNAL')).toBe(true)
    expect(commandReachesCompartment('EXTERNAL', 'INTERNAL')).toBe(false)
    expect(commandReachesCompartment('INTERNAL', 'INTERNAL')).toBe(true)
    expect(commandReachesCompartment('INTERNAL', 'EXTERNAL')).toBe(false)
    expect(commandReachesCompartment('BOTH', 'EXTERNAL')).toBe(true)
    expect(commandReachesCompartment('BOTH', 'INTERNAL')).toBe(true)
  })
})

describe('curated answer status flow', () => {
  it('allows publishing and archiving', () => {
    expect(canTransitionAnswer('DRAFT', 'ACTIVE')).toBe(true)
    expect(canTransitionAnswer('ACTIVE', 'ARCHIVED')).toBe(true)
    expect(canTransitionAnswer('DRAFT', 'ARCHIVED')).toBe(true)
  })

  it('treats ARCHIVED as terminal, so retired text cannot silently return', () => {
    expect(canTransitionAnswer('ARCHIVED', 'ACTIVE')).toBe(false)
    expect(canTransitionAnswer('ARCHIVED', 'DRAFT')).toBe(false)
  })

  it('rejects a no-op transition', () => {
    expect(canTransitionAnswer('ACTIVE', 'ACTIVE')).toBe(false)
  })
})

describe('search text', () => {
  it('indexes the question together with every phrasing', () => {
    expect(buildAnswerSearchText('How do I apply?', ['where do I send my CV', 'apply here'])).toBe(
      'How do I apply?\nwhere do I send my CV\napply here',
    )
  })

  it('drops blank phrasings rather than indexing empty lines', () => {
    expect(buildAnswerSearchText('Question', ['  ', 'real phrasing'])).toBe('Question\nreal phrasing')
  })
})

describe('audience type guard', () => {
  it('accepts only the three declared audiences', () => {
    for (const audience of ANSWER_AUDIENCES) expect(isAnswerAudience(audience)).toBe(true)
    for (const other of ['PUBLIC', 'ANY', '', 'internal', null, 7]) {
      expect(isAnswerAudience(other)).toBe(false)
    }
  })
})
