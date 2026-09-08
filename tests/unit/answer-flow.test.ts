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
  isAnswerAudience,
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
