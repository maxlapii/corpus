/**
 * Intent classification (CLAUDE.md §19). Keyword rules first (free), then one
 * short LLM call if inconclusive (§37).
 *
 * The model may propose an intent *name* and nothing else — scope, target and
 * risk are always re-read from INTENT_DEFINITIONS, so an LLM claiming
 * `"risk":"LOW"` for a salary question changes nothing.
 */

import type { Logger } from '@corpus/shared'
import {
  canonicaliseIntent,
  INTENT_DEFINITIONS,
  INTENTS,
  isIntentAllowedInZone,
  type Intent,
  type IntentDefinition,
  type SecurityZone,
} from '@corpus/domain'
import type { AIProvider } from './provider.js'
import { intentClassifierPrompt } from './prompts.js'

export interface ClassifiedIntent {
  definition: IntentDefinition
  confidence: number
  source: 'rules' | 'llm' | 'fallback'
}

interface KeywordRule {
  intent: Intent
  pattern: RegExp
}

/** Ordered: specific phrasings beat general ones. */
const RULES: KeywordRule[] = [
  { intent: 'EMPLOYEE_SALARY', pattern: /\b(salary|salaries|compensation|payslip|pay\s*slip|how\s+much\s+(do|does|is)\s+.{0,20}(earn|paid|make)|wage)\b/i },
  { intent: 'MY_LEAVE_BALANCE', pattern: /\b(my|remaining|left|available)\b.{0,20}\b(leave|annual|vacation|holiday)\b.{0,15}\b(balance|days|entitlement)?|\bhow\s+many\s+.{0,15}(leave|vacation)\s+days\b/i },
  { intent: 'CREATE_LEAVE_REQUEST', pattern: /\b(request|book|apply\s+for|submit|take)\b.{0,20}\bleave\b|\bi'?d?\s+like\s+to\s+take\b.{0,20}\b(off|leave)\b/i },
  { intent: 'CANCEL_LEAVE_REQUEST', pattern: /\bcancel\b.{0,20}\b(leave|request|time\s*off)\b/i },
  { intent: 'MY_LEAVE_REQUESTS', pattern: /\bmy\b.{0,15}\bleave\s+requests?\b|\bpending\s+leave\b/i },
  { intent: 'MY_LEAVE_HISTORY', pattern: /\bleave\s+(history|taken|record)\b/i },
  { intent: 'TEAM_LEAVE_REQUESTS', pattern: /\b(team|reports?|staff)\b.{0,20}\bleave\b|\bapprovals?\s+(pending|waiting)\b/i },
  { intent: 'APPROVE_LEAVE_REQUEST', pattern: /\bapprove\b.{0,20}\b(leave|request)\b/i },
  { intent: 'REJECT_LEAVE_REQUEST', pattern: /\b(reject|decline|deny)\b.{0,20}\b(leave|request)\b/i },
  { intent: 'HOLIDAYS', pattern: /\b(public\s+)?holidays?\b|\bbank\s+holiday\b/i },
  { intent: 'MY_PROFILE', pattern: /\bmy\s+(profile|details|record|department|position|manager|job\s+title)\b/i },
  { intent: 'EMPLOYEE_DIRECTORY', pattern: /\b(employee\s+directory|list\s+(all\s+)?employees|search\s+employees|who\s+works\s+in)\b/i },
  { intent: 'EMPLOYEE_PROFILE', pattern: /\b(profile|details|contact)\s+(for|of)\s+(employee|emp)\b/i },
  { intent: 'PUBLIC_APPLICATION_STATUS', pattern: /\b(status|progress|update)\b.{0,25}\bapplication\b|\bapplication\s+(status|reference)\b/i },
  { intent: 'PUBLIC_APPLY', pattern: /\b(apply|application)\b.{0,20}\b(for|to)\b.{0,25}\b(job|role|position|vacancy)\b|\bi\s+want\s+to\s+apply\b/i },
  { intent: 'PUBLIC_JOB_REQUIREMENTS', pattern: /\b(requirements?|qualifications?|experience\s+needed|skills?\s+(needed|required))\b/i },
  { intent: 'PUBLIC_HIRING_PROCESS', pattern: /\b(hiring|recruitment|interview)\s+process\b|\bwhat\s+happens\s+after\s+i\s+apply\b/i },
  { intent: 'PUBLIC_JOB_SEARCH', pattern: /\b(jobs?|vacanc(y|ies)|openings?|positions?|roles?)\b.{0,25}\b(available|open|hiring|list|any)\b|\bare\s+you\s+hiring\b|\bwhat\s+(jobs?|roles?)\b/i },
  { intent: 'PUBLIC_JOB_DETAILS', pattern: /\b(tell\s+me\s+about|details?\s+(of|for|about))\b.{0,25}\b(job|role|position)\b/i },
  { intent: 'CANDIDATE_SEARCH', pattern: /\b(candidates?|applicants?)\b.{0,20}\b(for|list|search|show)\b/i },
  { intent: 'APPLICATION_STAGE_UPDATE', pattern: /\b(move|advance|progress|shortlist|reject)\b.{0,25}\b(application|candidate)\b/i },
  { intent: 'JOB_MANAGE', pattern: /\b(create|post|publish|close|open)\b.{0,15}\b(job|vacancy|position)\b/i },
  { intent: 'REPORTING', pattern: /\b(report|headcount|analytics|statistics|how\s+many\s+employees)\b/i },
  {
    intent: 'HR_POLICY_QUESTION',
    // `\w*` so "remotely" and "entitlement" match.
    pattern:
      /\b(polic\w*|handbook|procedure\w*|guideline\w*|entitle\w*|matern\w*|patern\w*|parental|probation\w*|notice\s+period|overtime|expens\w*|reimburse\w*|dress\s+code|working\s+hours|work\s+from\s+home|remote\w*|relocat\w*|sick\s+pay|benefit\w*|allowance\w*|grievance\w*|discipl\w*|resign\w*|termination|onboard\w*|training|confidential\w*|conduct)\b/i,
  },
  { intent: 'HELP', pattern: /\b(what\s+can\s+you\s+do|help|how\s+do\s+i\s+use)\b/i },
  { intent: 'SMALL_TALK', pattern: /^\s*(hi|hello|hey|thanks?|thank\s+you|good\s+(morning|afternoon|evening)|bye)\b/i },
]

export interface IntentClassifierDeps {
  provider: AIProvider
  logger: Logger
  rulesOnly?: boolean
}

/** Exposed so MockAIProvider routes identically instead of keeping its own copy. */
export function matchIntentByKeywords(message: string): Intent | null {
  const trimmed = message.trim()
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return rule.intent
  }
  return null
}

export class IntentClassifier {
  constructor(private readonly deps: IntentClassifierDeps) {}

  allowedIntents(zone: SecurityZone): Intent[] {
    return INTENTS.filter((i) => isIntentAllowedInZone(i, zone))
  }

  async classify(message: string, zone: SecurityZone): Promise<ClassifiedIntent> {
    const trimmed = message.trim()

    const matched = matchIntentByKeywords(trimmed)
    if (matched) {
      // An out-of-zone match is reported as-is, so the gateway denies it
      // explicitly and the attempt appears in the audit trail.
      return { definition: INTENT_DEFINITIONS[matched], confidence: 0.85, source: 'rules' }
    }

    if (this.deps.rulesOnly) {
      return { definition: this.fallbackFor(zone), confidence: 0.2, source: 'fallback' }
    }

    try {
      const allowed = this.allowedIntents(zone)
      const response = await this.deps.provider.generateResponse({
        system: intentClassifierPrompt(allowed),
        messages: [{ role: 'user', content: trimmed.slice(0, 1000) }],
        maxOutputTokens: 60,
        temperature: 0,
        responseFormat: 'json',
        timeoutMs: 8000,
      })
      const parsed = parseJsonObject(response.text)
      const definition = canonicaliseIntent(parsed?.intent)
      const confidence = clampConfidence(parsed?.confidence)
      // An unclassified internal question is most likely a policy question, and
      // retrieval is permission-filtered, so guessing costs one bounded search.
      if (definition.intent === 'UNKNOWN') {
        return { definition: this.fallbackFor(zone), confidence: 0.2, source: 'llm' }
      }
      return { definition, confidence, source: 'llm' }
    } catch (e) {
      this.deps.logger.warn('intent classification failed; falling back to UNKNOWN', {
        action: 'ai.classify',
        result: 'error',
        error: e instanceof Error ? e.message : String(e),
      })
      return { definition: this.fallbackFor(zone), confidence: 0, source: 'fallback' }
    }
  }

  /** Externally there is nothing safe to guess, so it stays UNKNOWN. */
  private fallbackFor(zone: SecurityZone): IntentDefinition {
    return zone === 'INTERNAL'
      ? INTENT_DEFINITIONS.HR_POLICY_QUESTION
      : INTENT_DEFINITIONS.UNKNOWN
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function clampConfidence(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}
