import { scanForInjection, type InjectionCategory } from './prompt-injection.js'

/**
 * AI response filter (CLAUDE.md §54) — the LAST line of defence, not the first.
 * The real protection is that unauthorised data never enters the prompt (§24).
 * This only catches model mistakes: an echoed prompt, an invented figure.
 */

export type FilterFinding =
  | 'SYSTEM_PROMPT_LEAK'
  | 'UNGROUNDED_CURRENCY'
  | 'BULK_PII'
  | 'SQL_ECHO'
  | 'UNTRUSTED_MARKUP'
  | 'INJECTED_INSTRUCTION'

export interface FilterOptions {
  /** Currency amounts absent from this list are treated as invented. */
  groundedNumbers?: readonly (string | number)[]
  allowMonetaryValues?: boolean
  externalZone?: boolean
  /** Drop instruction-like lines echoed from a document; reflecting them back
   *  is a social-engineering vector even though the model ignored them. */
  stripInjectedInstructions?: boolean
}

export interface FilterResult {
  text: string
  findings: FilterFinding[]
  modified: boolean
}

// Untrusted delimiters are handled below, as UNTRUSTED_MARKUP not a prompt leak.
const SYSTEM_PROMPT_MARKERS = [
  /you\s+are\s+CORPUS[^.]*\./i,
  /\bsystem\s+prompt\s*[::]/i,
  /\bAVAILABLE\s+TOOLS\s*[::]/i,
  /\bAUTHORISED\s+CONTEXT\s*[::]/i,
  /\bTOOL\s+RESULTS\s*[::]/i,
]

const SQL_ECHO = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]{0,60}\b(FROM|SET|WHERE|VALUES)\b/i

/** Currency-looking amounts: $12,345 / USD 12345 / 12,345.00 USD. */
const CURRENCY =
  /(?:(?:[$£€¥]|\b(?:USD|EUR|GBP|KHR|SGD|MYR|THB|VND|JPY|AUD|CAD)\b)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]{3,}(?:\.\d+)?\s?(?:USD|EUR|GBP|KHR|SGD|MYR|THB|VND|JPY|AUD|CAD)\b)/gi

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g

const REDACTION = '[redacted]'

/** A line flagged with any of these is an instruction, not content — drop it. */
const INSTRUCTION_CATEGORIES: readonly InjectionCategory[] = [
  'INSTRUCTION_OVERRIDE',
  'SECURITY_DISABLE',
  'ROLE_CLAIM',
  'AUTHORITY_CLAIM',
  'DIRECT_DATA_ACCESS',
  'SYSTEM_PROMPT_PROBE',
]

export function filterAiResponse(input: string, options: FilterOptions = {}): FilterResult {
  const findings: FilterFinding[] = []
  let text = input

  if (options.stripInjectedInstructions !== false) {
    const lines = text.split('\n')
    const kept = lines.filter((line) => {
      if (line.trim().length === 0) return true
      const scan = scanForInjection(line)
      return !scan.categories.some((category) => INSTRUCTION_CATEGORIES.includes(category))
    })
    if (kept.length !== lines.length) {
      findings.push('INJECTED_INSTRUCTION')
      text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    }
  }

  for (const marker of SYSTEM_PROMPT_MARKERS) {
    if (marker.test(text)) {
      findings.push('SYSTEM_PROMPT_LEAK')
      text = text.replace(marker, REDACTION)
    }
  }
  if (/<\/?untrusted/i.test(text)) {
    findings.push('UNTRUSTED_MARKUP')
    text = text.replace(/<\/?untrusted[^>]*>/gi, '')
  }

  // The model has no database access, so echoed SQL is noise or a reflected attack.
  if (SQL_ECHO.test(text)) {
    findings.push('SQL_ECHO')
    text = text.replace(SQL_ECHO, REDACTION)
  }

  const grounded = new Set(
    (options.groundedNumbers ?? []).map((n) => String(n).replace(/[^\d.]/g, '')),
  )
  text = text.replace(CURRENCY, (match) => {
    if (options.allowMonetaryValues === false) {
      findings.push('UNGROUNDED_CURRENCY')
      return REDACTION
    }
    const digits = match.replace(/[^\d.]/g, '')
    if (grounded.size > 0 && grounded.has(digits)) return match
    if (grounded.size === 0 && options.allowMonetaryValues) return match
    findings.push('UNGROUNDED_CURRENCY')
    return REDACTION
  })

  const emails = text.match(EMAIL) ?? []
  const threshold = options.externalZone ? 2 : 4
  if (emails.length >= threshold) {
    findings.push('BULK_PII')
    text = text.replace(EMAIL, REDACTION)
  }

  const unique = [...new Set(findings)]
  return { text: text.trim(), findings: unique, modified: text.trim() !== input.trim() }
}

/** Standard refusal when the knowledge base cannot answer (§30). */
export const INSUFFICIENT_KNOWLEDGE_REPLY =
  "I don't have enough verified information to answer that accurately. Please contact HR."
