/**
 * CV ↔ job matching (CLAUDE.md §38).
 *
 * Deliberately deterministic: no model is involved. A job's requirements are
 * already structured, and "does this CV mention Postgres" is a string question,
 * not a judgement — so the backend answers it and the result is reproducible,
 * free, and explainable.
 *
 * Three rules shape the output:
 *
 * 1. Every match carries the CV sentence that produced it. A score with no
 *    evidence is unreviewable, and a human has to be able to disagree with it.
 * 2. Nothing here decides anything. There is no threshold that rejects a
 *    candidate; the report is advisory and the stage machine is untouched.
 * 3. Nothing infers a protected characteristic. Age, gender, nationality,
 *    marital status and health are never extracted, matched or scored, even
 *    when a CV volunteers them.
 */

import type { RequirementType } from './entities.js'

export interface MatchableRequirement {
  id: string
  requirementType: RequirementType
  description: string
  mandatory: boolean
  priority: number
}

export interface RequirementMatch {
  requirementId: string
  requirementType: RequirementType
  description: string
  mandatory: boolean
  matched: boolean
  /** Which of the requirement's significant terms were found. */
  matchedTerms: string[]
  missingTerms: string[]
  /** Sentences from the CV that produced the match, for a human to check. */
  evidence: string[]
}

export interface CvFacts {
  /** Highest "N years" figure stated anywhere in the CV, if any. */
  yearsOfExperience: number | null
  emails: string[]
  phones: string[]
  links: string[]
  /** Education signals, as literal phrases found in the CV. */
  education: string[]
}

export interface CvMatchReport {
  requirements: RequirementMatch[]
  facts: CvFacts
  score: {
    mandatoryMet: number
    mandatoryTotal: number
    optionalMet: number
    optionalTotal: number
    /** 0–100, priority-weighted. Advisory only. */
    percent: number
  }
  /** Null when the job states no minimum, or the CV states no total. */
  meetsExperienceMinimum: boolean | null
  /** Reasons the report may be incomplete, shown next to the score. */
  caveats: string[]
}

/** Words too common to be evidence of anything. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'as', 'is', 'are', 'be', 'been', 'was', 'were', 'has', 'have', 'had', 'not', 'no',
  'least', 'most', 'more', 'than', 'that', 'this', 'these', 'those', 'you', 'your', 'we',
  'our', 'will', 'must', 'should', 'able', 'strong', 'good', 'excellent', 'proven',
  'experience', 'experienced', 'years', 'year', 'working', 'work', 'ability', 'knowledge',
  'skills', 'skill', 'understanding', 'familiar', 'familiarity', 'plus', 'related', 'field',
  'degree', 'or', 'preferred', 'required', 'minimum', 'production', 'using', 'used',
])

const MAX_EVIDENCE_PER_REQUIREMENT = 3
const EVIDENCE_MAX_CHARS = 240

/**
 * Terms that are worth matching on. Short tokens survive only when they look
 * like a real technology (C#, Go, R) rather than noise.
 */
export function significantTerms(description: string): string[] {
  const raw = description
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^[.]+|[.]+$/g, ''))
    .filter(Boolean)

  const out: string[] = []
  for (const token of raw) {
    if (STOP_WORDS.has(token)) continue
    if (/^\d+$/.test(token)) continue
    if (token.length < 2) continue
    if (!out.includes(token)) out.push(token)
  }
  return out
}

/** Split into sentence-ish units so evidence is quotable. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|•|•/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function containsTerm(haystackLower: string, term: string): boolean {
  // Word-boundary-ish match that still works for "c++", "node.js", "c#".
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\+/g, '\\+')
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i')
  return pattern.test(haystackLower)
}

/**
 * A requirement counts as met when a *majority* of its significant terms appear
 * in the CV — one incidental word should not satisfy "5 years of Kubernetes
 * and Terraform on AWS".
 */
function requiredHits(termCount: number): number {
  if (termCount <= 1) return 1
  if (termCount === 2) return 2
  return Math.ceil(termCount * 0.6)
}

export function matchRequirement(
  requirement: MatchableRequirement,
  cvText: string,
  sentences: string[],
): RequirementMatch {
  const terms = significantTerms(requirement.description)
  const haystack = cvText.toLowerCase()

  const matchedTerms: string[] = []
  const missingTerms: string[] = []
  for (const term of terms) {
    if (containsTerm(haystack, term)) matchedTerms.push(term)
    else missingTerms.push(term)
  }

  const matched = terms.length > 0 && matchedTerms.length >= requiredHits(terms.length)

  const evidence: string[] = []
  if (matched) {
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()
      if (matchedTerms.some((term) => containsTerm(lower, term))) {
        evidence.push(sentence.slice(0, EVIDENCE_MAX_CHARS))
        if (evidence.length >= MAX_EVIDENCE_PER_REQUIREMENT) break
      }
    }
  }

  return {
    requirementId: requirement.id,
    requirementType: requirement.requirementType,
    description: requirement.description,
    mandatory: requirement.mandatory,
    matched,
    matchedTerms,
    missingTerms,
    evidence,
  }
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d[\d\s-]{6,14}\d/g
const LINK = /\bhttps?:\/\/[^\s<>"')]+/gi
const YEARS = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi

const EDUCATION_SIGNALS = [
  "bachelor", "master", "phd", "doctorate", "mba", "bsc", "msc", "b.sc", "m.sc",
  "b.eng", "m.eng", "beng", "meng", "diploma", "associate degree", "university",
  "college",
]

/** Distinct, capped, order-preserving. */
function uniqueCapped(values: Iterable<string>, cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

export function extractCvFacts(cvText: string): CvFacts {
  const lower = cvText.toLowerCase()

  const years = [...cvText.matchAll(YEARS)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 60)

  // Phone matching is loose enough to catch dates and IDs, so anything that
  // looks like a bare year range is dropped rather than shown as a number.
  const phones = [...cvText.matchAll(PHONE)]
    .map((m) => m[0].trim())
    .filter((p) => p.replace(/\D/g, '').length >= 8)

  return {
    yearsOfExperience: years.length > 0 ? Math.max(...years) : null,
    emails: uniqueCapped([...cvText.matchAll(EMAIL)].map((m) => m[0]), 5),
    phones: uniqueCapped(phones, 5),
    links: uniqueCapped([...cvText.matchAll(LINK)].map((m) => m[0]), 8),
    education: EDUCATION_SIGNALS.filter((signal) => lower.includes(signal)),
  }
}

export interface AnalyseCvInput {
  cvText: string
  requirements: readonly MatchableRequirement[]
  /** From the job posting, when it states one. */
  experienceMin?: number | null
}

export function analyseCv(input: AnalyseCvInput): CvMatchReport {
  const cvText = input.cvText ?? ''
  const sentences = sentencesOf(cvText)
  const facts = extractCvFacts(cvText)

  const requirements = [...input.requirements]
    .sort((a, b) => a.priority - b.priority)
    .map((requirement) => matchRequirement(requirement, cvText, sentences))

  const mandatory = requirements.filter((r) => r.mandatory)
  const optional = requirements.filter((r) => !r.mandatory)

  // Mandatory requirements carry three times the weight of a nice-to-have, so
  // a CV cannot score well by collecting only the optional ones.
  const weightOf = (r: RequirementMatch) => (r.mandatory ? 3 : 1)
  const totalWeight = requirements.reduce((sum, r) => sum + weightOf(r), 0)
  const metWeight = requirements
    .filter((r) => r.matched)
    .reduce((sum, r) => sum + weightOf(r), 0)

  const caveats: string[] = []
  if (cvText.trim().length === 0) {
    caveats.push('No text could be read from this CV, so nothing was matched.')
  } else if (cvText.trim().length < 200) {
    caveats.push('Very little text was read from this CV; the match may be incomplete.')
  }
  if (requirements.length === 0) {
    caveats.push('This job lists no requirements, so there was nothing to match against.')
  }

  const meetsExperienceMinimum =
    input.experienceMin == null || facts.yearsOfExperience == null
      ? null
      : facts.yearsOfExperience >= input.experienceMin

  return {
    requirements,
    facts,
    score: {
      mandatoryMet: mandatory.filter((r) => r.matched).length,
      mandatoryTotal: mandatory.length,
      optionalMet: optional.filter((r) => r.matched).length,
      optionalTotal: optional.length,
      percent: totalWeight === 0 ? 0 : Math.round((metWeight / totalWeight) * 100),
    },
    meetsExperienceMinimum,
    caveats,
  }
}
