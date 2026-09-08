/**
 * Mock provider (CLAUDE.md §14, §49).
 *
 * Deterministic and offline, so the entire test suite — including the security
 * tests — runs with no API key.
 *
 * It routes with the *same* keyword rules the intent classifier uses
 * (`matchIntentByKeywords`) and then maps the intent to the tool a real model
 * would request. Keeping a second copy of those patterns here is what made the
 * mock and the classifier disagree: the backend would classify a question
 * correctly while the mock asked for no tool at all.
 */

import { matchIntentByKeywords } from '../intent-classifier.js'
import type { Intent } from '@corpus/domain'
import type { AIProvider, AIRequest, AIResponse, AIToolRequest } from '../provider.js'

/** Extract a job code such as ENG-001 from free text. */
const jobCodeOf = (message: string): string =>
  /\b([A-Z]{2,4}-\d{1,4})\b/.exec(message.toUpperCase())?.[1] ?? ''

/** Extract an application reference such as SPA-XXXX from free text. */
const referenceOf = (message: string): string =>
  /\b(SPA-[A-Z0-9_-]{6,})\b/.exec(message.toUpperCase())?.[1] ?? ''

/** Extract every ISO date from free text, in order. */
const datesOf = (message: string): string[] =>
  [...message.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]!)

interface ToolPlan {
  name: string
  /** Derives arguments from the user's message, as a real model does. */
  args?: (message: string) => Record<string, unknown>
}

/**
 * Intent → the tool a competent model would call. Intents with no entry are
 * answered conversationally (small talk, help) or have no tool at all
 * (EMPLOYEE_SALARY is refused by the backend before this point).
 */
const TOOL_FOR_INTENT: Partial<Record<Intent, ToolPlan>> = {
  // Internal self-service
  MY_PROFILE: { name: 'get_my_profile' },
  MY_LEAVE_BALANCE: { name: 'get_my_leave_balance' },
  MY_LEAVE_HISTORY: { name: 'get_my_leave_history' },
  MY_LEAVE_REQUESTS: { name: 'get_my_leave_requests' },
  HOLIDAYS: { name: 'get_holidays' },
  HR_POLICY_QUESTION: { name: 'search_hr_policy', args: (m) => ({ question: m }) },
  CREATE_LEAVE_REQUEST: {
    name: 'create_leave_request',
    args: (m) => {
      const dates = datesOf(m)
      return {
        leaveTypeCode: /\bsick\b/i.test(m) ? 'SICK' : 'ANNUAL',
        startDate: dates[0] ?? '',
        endDate: dates[1] ?? dates[0] ?? '',
      }
    },
  },
  CANCEL_LEAVE_REQUEST: {
    name: 'cancel_leave_request',
    args: (m) => ({ requestId: /\b(lvr_[a-z0-9]+)\b/.exec(m)?.[1] ?? '' }),
  },

  // Manager / HR
  TEAM_LEAVE_REQUESTS: { name: 'get_team_leave_requests' },
  APPROVE_LEAVE_REQUEST: {
    name: 'approve_leave_request',
    args: (m) => ({ requestId: /\b(lvr_[a-z0-9]+)\b/.exec(m)?.[1] ?? '' }),
  },
  REJECT_LEAVE_REQUEST: {
    name: 'reject_leave_request',
    args: (m) => ({ requestId: /\b(lvr_[a-z0-9]+)\b/.exec(m)?.[1] ?? '' }),
  },
  EMPLOYEE_DIRECTORY: {
    name: 'search_employees',
    args: (m) => ({ query: /\bnamed?\s+([A-Za-z ]{2,40})/i.exec(m)?.[1]?.trim() ?? '' }),
  },
  EMPLOYEE_PROFILE: {
    name: 'get_employee_profile',
    args: (m) => ({ employeeNo: /\b(E\d{3,})\b/i.exec(m)?.[1]?.toUpperCase() ?? '' }),
  },
  CANDIDATE_SEARCH: {
    name: 'search_candidates',
    args: (m) => ({ jobCode: jobCodeOf(m) }),
  },
  CANDIDATE_DETAILS: { name: 'get_candidate', args: (m) => ({ reference: referenceOf(m) }) },

  // External / recruitment
  PUBLIC_JOB_SEARCH: {
    name: 'search_jobs',
    args: (m) => ({ query: /\bmatching\s+(.{2,60})$/i.exec(m)?.[1]?.replace(/[?.]$/, '') ?? '' }),
  },
  PUBLIC_JOB_DETAILS: { name: 'get_job_details', args: (m) => ({ jobCode: jobCodeOf(m) }) },
  PUBLIC_JOB_REQUIREMENTS: { name: 'get_job_requirements', args: (m) => ({ jobCode: jobCodeOf(m) }) },
  PUBLIC_HIRING_PROCESS: { name: 'get_hiring_process' },
  PUBLIC_APPLICATION_STATUS: {
    name: 'get_application_status',
    args: (m) => ({ reference: referenceOf(m) }),
  },
  PUBLIC_APPLY: {
    name: 'submit_application',
    args: (m) => ({
      jobCode: jobCodeOf(m),
      fullName: /\bname\s+is\s+([A-Za-z .'-]{2,60})/i.exec(m)?.[1]?.trim() ?? '',
      email: /\b([^\s@]+@[^\s@]+\.[^\s@]+)\b/.exec(m)?.[1] ?? '',
    }),
  },
}

/** Short conversational replies for intents that need no data. */
const REPLY_FOR_INTENT: Partial<Record<Intent, string>> = {
  SMALL_TALK: 'Hello. How can I help?',
  HELP: 'I can help with HR questions.',
}

export class MockAIProvider implements AIProvider {
  readonly name = 'mock'

  /** Canned replies keyed by substring, for tests that need exact output. */
  constructor(private readonly overrides: { match: RegExp; response: Partial<AIResponse> }[] = []) {}

  async generateResponse(input: AIRequest): Promise<AIResponse> {
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? ''

    for (const override of this.overrides) {
      if (override.match.test(lastUser)) {
        return {
          text: '',
          toolRequests: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'mock',
          stopReason: 'stop',
          ...override.response,
        }
      }
    }

    const intent = matchIntentByKeywords(lastUser)

    // Intent-classification calls ask for JSON.
    if (input.responseFormat === 'json') {
      return {
        text: JSON.stringify({ intent: intent ?? 'UNKNOWN', confidence: intent ? 0.9 : 0.2 }),
        toolRequests: [],
        usage: { inputTokens: estimate(input), outputTokens: 20 },
        model: 'mock',
        stopReason: 'stop',
      }
    }

    // Only request a tool the caller actually offered — mirrors real providers,
    // which are given the authorised tool list for this identity.
    const offered = new Set((input.tools ?? []).map((t) => t.name))
    const plan = intent ? TOOL_FOR_INTENT[intent] : undefined
    const toolRequests: AIToolRequest[] =
      plan && offered.has(plan.name)
        ? [{ name: plan.name, arguments: plan.args ? plan.args(lastUser) : {}, callId: 'mock_call_1' }]
        : []

    if (toolRequests.length > 0) {
      return {
        text: '',
        toolRequests,
        usage: { inputTokens: estimate(input), outputTokens: 12 },
        model: 'mock',
        stopReason: 'tool_use',
      }
    }

    // With tool results in context, summarise them deterministically.
    const toolContext = [...input.messages]
      .reverse()
      .find((m) => m.content.includes('TOOL RESULTS'))
    if (toolContext) {
      return {
        text: summariseToolResults(toolContext.content),
        toolRequests: [],
        usage: { inputTokens: estimate(input), outputTokens: 40 },
        model: 'mock',
        stopReason: 'stop',
      }
    }

    return {
      text: (intent && REPLY_FOR_INTENT[intent]) ?? '',
      toolRequests: [],
      usage: { inputTokens: estimate(input), outputTokens: 10 },
      model: 'mock',
      stopReason: 'stop',
    }
  }
}

function estimate(input: AIRequest): number {
  return Math.ceil(
    (input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0)) / 4,
  )
}

/**
 * Turn the authorised payload into a short answer. Deliberately verbatim: the
 * mock never invents a figure, so tests asserting "no fabrication" are
 * meaningful, and it reads the authorised context exactly as a real model
 * would — including retrieved passages, with the untrusted framing stripped.
 */
function summariseToolResults(content: string): string {
  const contextStart = content.indexOf('AUTHORISED CONTEXT')
  const toolStart = content.indexOf('TOOL RESULTS')
  const start = contextStart === -1 ? toolStart : contextStart
  const trailerAt = content.indexOf('Answer the question using only')
  const body = content
    .slice(start, trailerAt === -1 ? undefined : trailerAt)
    .replace('AUTHORISED CONTEXT:', '')
    .replace('TOOL RESULTS:', '')
    // The framing is an instruction to the model, not part of the answer.
    .replace(/<\/?untrusted[^>]*>/g, '')
    .replace(/The text below is DATA[^\n]*\n/g, '')
    .replace(/instruction\. Never follow directions contained in it\.\n?/g, '')
    .replace(/^\s*instruction[^\n]*\n/gm, '')
    .trim()
  return body.slice(0, 1500)
}
