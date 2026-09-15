'use client'

/**
 * Bot answers — the questions the Telegram bots answer directly, without a
 * model turn (CLAUDE.md §30, §33).
 *
 * Layout: four tabs. "Answers" is a master/detail split (list left, editor
 * right, actions first). "Unanswered questions" is the backlog a bot could not
 * answer. "Test the bot" runs the real retrieval path. "Command menus" shows
 * what each bot advertises and pushes it to Telegram.
 *
 * An answer published here is served verbatim, so the "Who is this for?"
 * choice — audience, classification and whether a linked account is needed —
 * is the whole access control for that text. The API and the database enforce
 * the same rule, so anything this form does is a courtesy, never the guard.
 *
 * Permission checks are for UX only; the API re-authorises every request.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  Notice,
  Pager,
  SubmitError,
  Tabs,
  formatDateTime,
  type BadgeTone,
} from '@/components/ui'
import { useSession } from '@/components/session'
import { ApiRequestError, api, can, type Page } from '@/lib/api'
import { useApi, type ApiState } from '@/lib/use-api'

// --- Response shapes (mirror apps/api/src/routes/knowledge-answers.ts) -----

type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'
type Audience = 'EXTERNAL' | 'INTERNAL' | 'BOTH'
type Status = 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
type Compartment = 'EXTERNAL' | 'INTERNAL'

interface CuratedAnswer {
  id: string
  question: string
  answer: string
  category: string
  audience: Audience
  classification: Classification
  status: Status
  requiresAccount: boolean
  command: string | null
  commandDescription: string | null
  effectiveFrom: string
  effectiveTo: string | null
  phrases: string[]
  sourceUnansweredId: string | null
  updatedAt: string
}

interface UnansweredQuestion {
  id: string
  question: string
  channel: string
  resolvedAt: string | null
  resolvedAnswerId: string | null
  createdAt: string
}

interface PreviewMatch {
  answerId: string
  question: string
  answer: string
  classification: Classification
  coverage: number
  termMatches: number
  requiresAccount: boolean
  wouldServe: boolean
}

interface PreviewResponse {
  audience: Compartment
  strategy: 'fts' | 'like' | 'none'
  matches: PreviewMatch[]
}

interface BotCommand {
  command: string
  description: string
}

interface CommandMenu {
  compartment: Compartment
  builtIn: BotCommand[]
  curated: BotCommand[]
  effective: BotCommand[]
  omitted: BotCommand[]
}

interface CommandMenusResponse {
  menus: CommandMenu[]
  note: string
}

interface SyncResult {
  compartment: Compartment
  configured: boolean
  synced: boolean
  commands: BotCommand[]
  omitted: BotCommand[]
}

// --- Labels ----------------------------------------------------------------

type Tab = 'answers' | 'unanswered' | 'test' | 'commands'

const AUDIENCES: Audience[] = ['EXTERNAL', 'INTERNAL', 'BOTH']
const STATUSES: Status[] = ['DRAFT', 'ACTIVE', 'ARCHIVED']

const AUDIENCE_LABEL: Record<Audience, string> = {
  EXTERNAL: 'Recruitment bot (candidates)',
  INTERNAL: 'Employee bot (staff)',
  BOTH: 'Both bots',
}

const AUDIENCE_TONE: Record<Audience, BadgeTone> = {
  EXTERNAL: 'info',
  INTERNAL: 'muted',
  BOTH: 'warn',
}

const STATUS_LABEL: Record<Status, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Published',
  ARCHIVED: 'Archived',
}

const STATUS_TONE: Record<Status, BadgeTone> = {
  DRAFT: 'muted',
  ACTIVE: 'ok',
  ARCHIVED: 'muted',
}

const BOT_LABEL: Record<Compartment, string> = {
  EXTERNAL: 'Recruitment bot',
  INTERNAL: 'Employee bot',
}

const CHANNEL_LABEL: Record<string, string> = {
  TELEGRAM_EXTERNAL: 'Recruitment bot',
  TELEGRAM_INTERNAL: 'Employee bot',
  WEB: 'Dashboard',
  DASHBOARD: 'Dashboard',
}

/**
 * "Who is this for?" — one choice that sets audience, classification and the
 * linked-account requirement together, so the author never has to reason about
 * the rule that a candidate-reachable answer must be PUBLIC.
 */
type Reach = 'CANDIDATES' | 'EVERYONE' | 'ALL_STAFF' | 'LINKED' | 'HR' | 'HR_ADMIN'

interface ReachOption {
  key: Reach
  label: string
  audience: Audience
  classification: Classification
  requiresAccount: boolean
}

const REACH_OPTIONS: ReachOption[] = [
  {
    key: 'CANDIDATES',
    label: 'Candidates and the public',
    audience: 'EXTERNAL',
    classification: 'PUBLIC',
    requiresAccount: false,
  },
  {
    key: 'EVERYONE',
    label: 'Everyone — candidates and staff',
    audience: 'BOTH',
    classification: 'PUBLIC',
    requiresAccount: false,
  },
  {
    key: 'ALL_STAFF',
    label: 'All staff, even before they link Telegram',
    audience: 'INTERNAL',
    classification: 'PUBLIC',
    requiresAccount: false,
  },
  {
    key: 'LINKED',
    label: 'Linked employees',
    audience: 'INTERNAL',
    classification: 'INTERNAL',
    requiresAccount: true,
  },
  {
    key: 'HR',
    label: 'HR only',
    audience: 'INTERNAL',
    classification: 'CONFIDENTIAL',
    requiresAccount: true,
  },
  {
    key: 'HR_ADMIN',
    label: 'HR administrators only',
    audience: 'INTERNAL',
    classification: 'RESTRICTED',
    requiresAccount: true,
  },
]

function reachOption(key: Reach): ReachOption {
  return REACH_OPTIONS.find((option) => option.key === key) ?? REACH_OPTIONS[3]!
}

/** The closest "Who is this for?" choice for a stored answer. */
function reachOf(
  answer: Pick<CuratedAnswer, 'audience' | 'classification' | 'requiresAccount'>,
): Reach {
  const exact = REACH_OPTIONS.find(
    (option) =>
      option.audience === answer.audience &&
      option.classification === answer.classification &&
      option.requiresAccount === answer.requiresAccount,
  )
  if (exact) return exact.key
  if (answer.audience === 'EXTERNAL') return 'CANDIDATES'
  if (answer.audience === 'BOTH') return 'EVERYONE'
  if (answer.classification === 'RESTRICTED') return 'HR_ADMIN'
  if (answer.classification === 'CONFIDENTIAL') return 'HR'
  if (answer.classification === 'PUBLIC' && !answer.requiresAccount) return 'ALL_STAFF'
  return 'LINKED'
}

const FIELD_LABEL: Record<string, string> = {
  question: 'Question',
  answer: 'Answer',
  audience: 'Who is this for?',
  classification: 'Who is this for?',
  requiresAccount: 'Who is this for?',
  phrases: 'Other ways people ask this',
  category: 'Category',
  command: 'Telegram command',
  commandDescription: 'Menu description',
  effectiveFrom: 'Effective from',
  effectiveTo: 'Effective to',
}

interface FieldIssue {
  field: string
  message: string
}

/** Per-field validation issues, when the API supplied them. */
function issuesOf(error: unknown): FieldIssue[] {
  if (!(error instanceof ApiRequestError)) return []
  const issues = error.error.details?.issues
  if (!Array.isArray(issues)) return []
  return issues.filter(
    (issue): issue is FieldIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as FieldIssue).field === 'string' &&
      typeof (issue as FieldIssue).message === 'string',
  )
}

const PAGE_SIZE = 20
const MAX_PHRASES = 20

/** Trails the input by `delay` so the list is not refetched on every keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function phraseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

// --- Editor state ----------------------------------------------------------

interface Draft {
  /** Null for a new answer. */
  id: string | null
  /** The stored status of an existing answer; null for a new one. */
  status: Status | null
  question: string
  answer: string
  reach: Reach
  /** One phrasing per line — the plainest editor for a short list. */
  phrases: string
  category: string
  command: string
  commandDescription: string
  effectiveFrom: string
  effectiveTo: string
  sourceUnansweredId: string | null
}

function blankDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: null,
    status: null,
    question: '',
    answer: '',
    reach: 'LINKED',
    phrases: '',
    category: 'GENERAL',
    command: '',
    commandDescription: '',
    effectiveFrom: '',
    effectiveTo: '',
    sourceUnansweredId: null,
    ...overrides,
  }
}

function draftOf(answer: CuratedAnswer): Draft {
  return {
    id: answer.id,
    status: answer.status,
    question: answer.question,
    answer: answer.answer,
    reach: reachOf(answer),
    phrases: answer.phrases.join('\n'),
    category: answer.category,
    command: answer.command ?? '',
    commandDescription: answer.commandDescription ?? '',
    effectiveFrom: answer.effectiveFrom,
    effectiveTo: answer.effectiveTo ?? '',
    sourceUnansweredId: answer.sourceUnansweredId,
  }
}

interface Editor {
  draft: Draft
  /** Serialised draft as opened, to detect unsaved changes. */
  baseline: string
  /** Outcome of the last save, shown inside the panel until the next edit. */
  notice: string | null
}

function openEditor(draft: Draft, notice: string | null = null): Editor {
  return { draft, baseline: JSON.stringify(draft), notice }
}

// --- Page -----------------------------------------------------------------

export default function BotAnswersPage() {
  const { user } = useSession()
  const mayManage = can(user, 'faq.manage')

  const [tab, setTab] = useState<Tab>('answers')

  // Answers list
  const [searchInput, setSearchInput] = useState('')
  const search = useDebounced(searchInput.trim())
  const [audienceFilter, setAudienceFilter] = useState<Audience | ''>('')
  const [statusFilter, setStatusFilter] = useState<Status | ''>('')
  const [offset, setOffset] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Backlog
  const [backlogOffset, setBacklogOffset] = useState(0)

  const listPath = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (audienceFilter) params.set('audience', audienceFilter)
    if (statusFilter) params.set('status', statusFilter)
    if (search) params.set('q', search)
    return `/knowledge/answers?${params.toString()}`
  }, [audienceFilter, statusFilter, search, offset])

  const answers = useApi<Page<CuratedAnswer>>(mayManage ? listPath : null)
  const backlog = useApi<Page<UnansweredQuestion>>(
    mayManage
      ? `/knowledge/answers/unanswered?resolved=false&limit=${PAGE_SIZE}&offset=${backlogOffset}`
      : null,
  )

  const selectedId = editor?.draft.id ?? null
  const openedKey = editor?.baseline ?? null

  // On a narrow screen the editor sits below the list; bring it into view when
  // a draft is opened (the baseline only changes then, not on each keystroke).
  useEffect(() => {
    if (openedKey === null) return
    if (typeof window !== 'undefined' && window.innerWidth < 1200) {
      panelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [openedKey])

  const dirty = editor !== null && JSON.stringify(editor.draft) !== editor.baseline

  /** Replace the editor, asking first if the current one has unsaved changes. */
  function replaceEditor(draft: Draft | null): boolean {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return false
    setEditor(draft ? openEditor(draft) : null)
    return true
  }

  function resetForFilter() {
    setOffset(0)
    if (editor && !dirty) setEditor(null)
  }

  function clearFilters() {
    setSearchInput('')
    setAudienceFilter('')
    setStatusFilter('')
    resetForFilter()
  }

  function startAnswerFor(question: string, source: UnansweredQuestion | null, bot: Compartment) {
    const opened = replaceEditor(
      blankDraft({
        question: question.slice(0, 300),
        reach: bot === 'EXTERNAL' ? 'CANDIDATES' : 'LINKED',
        sourceUnansweredId: source?.id ?? null,
      }),
    )
    if (opened) setTab('answers')
  }

  if (!mayManage) {
    return (
      <Shell>
        <PageHeader title="Bot answers" />
        <Card>
          <Empty title="You do not have access to bot answers" hint="Ask an HR administrator." />
        </Card>
      </Shell>
    )
  }

  const filtered = Boolean(searchInput || audienceFilter || statusFilter)
  const page = answers.data

  return (
    <Shell>
      <PageHeader
        title="Bot answers"
        description="Questions the Telegram bots answer directly, without a model."
        actions={
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (replaceEditor(blankDraft())) setTab('answers')
            }}
          >
            New answer
          </button>
        }
      />

      <Tabs<Tab>
        label="Bot answers"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'answers', label: 'Answers' },
          { key: 'unanswered', label: 'Unanswered questions', count: backlog.data?.total },
          { key: 'test', label: 'Test the bot' },
          { key: 'commands', label: 'Command menus' },
        ]}
      />

      {tab === 'answers' ? (
        <div className="split">
          <Card title="Answers">
            <div className="toolbar" role="search">
              <label htmlFor="filter-q" className="visually-hidden">
                Search
              </label>
              <input
                id="filter-q"
                type="search"
                placeholder="Search questions and answers"
                value={searchInput}
                maxLength={200}
                onChange={(e) => {
                  setSearchInput(e.target.value)
                  resetForFilter()
                }}
              />
              <label htmlFor="filter-audience" className="visually-hidden">
                For
              </label>
              <select
                id="filter-audience"
                value={audienceFilter}
                onChange={(e) => {
                  setAudienceFilter(e.target.value as Audience | '')
                  resetForFilter()
                }}
              >
                <option value="">Any bot</option>
                {AUDIENCES.map((a) => (
                  <option key={a} value={a}>
                    {AUDIENCE_LABEL[a]}
                  </option>
                ))}
              </select>
              <label htmlFor="filter-status" className="visually-hidden">
                Status
              </label>
              <select
                id="filter-status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as Status | '')
                  resetForFilter()
                }}
              >
                <option value="">All statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              {filtered ? (
                <button type="button" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
            </div>

            {answers.loading ? (
              <Loading rows={5} label="Loading answers" />
            ) : answers.error ? (
              <ErrorState error={answers.error} />
            ) : !page || page.items.length === 0 ? (
              <Empty
                title="No answers to show"
                hint={
                  filtered
                    ? 'Try clearing the filters.'
                    : 'Add an answer, or start from a question in the Unanswered questions tab.'
                }
              />
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Question</th>
                        <th scope="col">For</th>
                        <th scope="col">Status</th>
                        <th scope="col">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((answer) => {
                        const selected = answer.id === selectedId
                        const open = () => {
                          if (selected) return
                          replaceEditor(draftOf(answer))
                        }
                        return (
                          <tr
                            key={answer.id}
                            className="selectable"
                            aria-selected={selected}
                            onClick={open}
                          >
                            <td>
                              <button
                                type="button"
                                className="link"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  open()
                                }}
                              >
                                {answer.question}
                              </button>
                            </td>
                            <td>
                              <Badge
                                value={AUDIENCE_LABEL[answer.audience]}
                                tone={AUDIENCE_TONE[answer.audience]}
                              />
                            </td>
                            <td>
                              <Badge
                                value={STATUS_LABEL[answer.status]}
                                tone={STATUS_TONE[answer.status]}
                              />
                            </td>
                            <td>{formatDateTime(answer.updatedAt)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager page={page} onChange={setOffset} />
              </>
            )}
          </Card>

          <div ref={panelRef}>
            {editor ? (
              <AnswerPanel
                key={editor.draft.id ?? 'new'}
                editor={editor}
                onChange={(draft) => setEditor({ draft, baseline: editor.baseline, notice: null })}
                onSaved={(saved, notice) => {
                  setEditor(openEditor(draftOf(saved), notice))
                  answers.reload()
                  backlog.reload()
                }}
                onArchived={() => {
                  setEditor(null)
                  answers.reload()
                }}
                onCancel={() => replaceEditor(null)}
              />
            ) : (
              <Card title="Answer">
                <Empty
                  title="Select an answer"
                  hint="Choose an answer from the list to edit it, or add a new one."
                />
              </Card>
            )}
          </div>
        </div>
      ) : null}

      {tab === 'unanswered' ? (
        <UnansweredCard
          backlog={backlog}
          onPage={setBacklogOffset}
          onAnswer={(item) =>
            startAnswerFor(
              item.question,
              item,
              item.channel === 'TELEGRAM_EXTERNAL' ? 'EXTERNAL' : 'INTERNAL',
            )
          }
        />
      ) : null}

      {tab === 'test' ? (
        <TestBotCard onWriteAnswer={(question, bot) => startAnswerFor(question, null, bot)} />
      ) : null}

      {tab === 'commands' ? <CommandMenus /> : null}
    </Shell>
  )
}

// --- Answer panel (actions first, then the form) ---------------------------

function AnswerPanel({
  editor,
  onChange,
  onSaved,
  onArchived,
  onCancel,
}: {
  editor: Editor
  onChange(draft: Draft): void
  onSaved(answer: CuratedAnswer, notice: string): void
  onArchived(): void
  onCancel(): void
}) {
  const { draft, notice } = editor
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [localIssue, setLocalIssue] = useState<string | null>(null)

  const isNew = draft.id === null
  const reach = reachOption(draft.reach)

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    onChange({ ...draft, [key]: value })
  }

  function buildBody(status: Status | null): Record<string, unknown> {
    const body: Record<string, unknown> = {
      question: draft.question.trim(),
      answer: draft.answer.trim(),
      category: draft.category.trim() || 'GENERAL',
      audience: reach.audience,
      classification: reach.classification,
      requiresAccount: reach.requiresAccount,
      phrases: phraseLines(draft.phrases).slice(0, MAX_PHRASES),
    }
    if (status) body.status = status
    if (draft.command.trim()) {
      body.command = draft.command.trim().replace(/^\//, '')
      body.commandDescription = draft.commandDescription.trim()
    }
    if (draft.effectiveFrom) body.effectiveFrom = draft.effectiveFrom
    if (draft.effectiveTo) body.effectiveTo = draft.effectiveTo
    if (isNew && draft.sourceUnansweredId) body.sourceUnansweredId = draft.sourceUnansweredId
    return body
  }

  async function save(status: Status | null) {
    setError(null)
    setLocalIssue(null)

    if (draft.command.trim() && !draft.commandDescription.trim()) {
      setLocalIssue('A Telegram command needs a menu description.')
      return
    }

    setSubmitting(true)
    try {
      const saved = await api<{ answer: CuratedAnswer }>(
        isNew ? '/knowledge/answers' : `/knowledge/answers/${draft.id}`,
        { method: isNew ? 'POST' : 'PUT', body: buildBody(status) },
      )
      // Closing the backlog item is a second call: the answer must exist
      // before anything can point at it.
      if (isNew && draft.sourceUnansweredId) {
        await api(`/knowledge/answers/unanswered/${draft.sourceUnansweredId}/resolve`, {
          method: 'POST',
          body: { answerId: saved.answer.id },
        })
      }
      onSaved(
        saved.answer,
        saved.answer.status === 'ACTIVE'
          ? isNew
            ? 'Saved and published. The bot will use it now.'
            : 'Changes saved. The bot is using them now.'
          : isNew
            ? 'Saved as a draft. The bot will not use it until you publish it.'
            : 'Changes saved.',
      )
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  async function changeStatus(next: 'ACTIVE' | 'ARCHIVED') {
    if (!draft.id) return
    const question =
      next === 'ACTIVE'
        ? 'Publish this answer? The bot will start using it immediately.'
        : 'Archive this answer? It cannot be restored.'
    if (!window.confirm(question)) return

    setError(null)
    setSubmitting(true)
    try {
      const result = await api<{ answer: CuratedAnswer }>(`/knowledge/answers/${draft.id}/status`, {
        method: 'POST',
        body: { status: next },
      })
      if (next === 'ARCHIVED') {
        onArchived()
        return
      }
      onSaved(result.answer, 'Published. The bot will use it now.')
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    // A new answer is saved as a draft by default; the second button publishes.
    void save(isNew ? 'DRAFT' : null)
  }

  const issues = issuesOf(error)
  const commandSet = draft.command.trim().length > 0

  return (
    <Card title={isNew ? 'New answer' : 'Answer'}>
      <div className="grid">
        {!isNew && draft.status ? (
          <div className="actions">
            <Badge value={STATUS_LABEL[draft.status]} tone={STATUS_TONE[draft.status]} />
            {draft.status === 'DRAFT' ? (
              <button
                type="button"
                className="primary"
                disabled={submitting}
                onClick={() => changeStatus('ACTIVE')}
              >
                Publish
              </button>
            ) : null}
            {draft.status !== 'ARCHIVED' ? (
              <button
                type="button"
                className="danger"
                disabled={submitting}
                onClick={() => changeStatus('ARCHIVED')}
              >
                Archive
              </button>
            ) : null}
          </div>
        ) : null}

        {notice ? <Notice tone="ok">{notice}</Notice> : null}
        {localIssue ? <Notice tone="error">{localIssue}</Notice> : null}
        <SubmitError error={error} />
        {issues.length > 0 ? (
          <ul className="small-text">
            {issues.map((issue, i) => (
              <li key={`${issue.field}-${i}`}>
                <strong>{FIELD_LABEL[issue.field] ?? issue.field}:</strong> {issue.message}
              </li>
            ))}
          </ul>
        ) : null}

        <form onSubmit={onSubmit} aria-label={isNew ? 'New answer' : 'Edit answer'}>
          <Field id="answer-question" label="Question">
            <input
              id="answer-question"
              required
              minLength={3}
              maxLength={300}
              value={draft.question}
              onChange={(e) => set('question', e.target.value)}
            />
          </Field>

          <Field
            id="answer-body"
            label="Answer"
            hint="Sent word for word. The bot will not rephrase it."
          >
            <textarea
              id="answer-body"
              required
              minLength={3}
              maxLength={4000}
              rows={5}
              value={draft.answer}
              onChange={(e) => set('answer', e.target.value)}
            />
          </Field>

          <fieldset>
            <legend>Who is this for?</legend>
            {REACH_OPTIONS.map((option) => (
              <label key={option.key} className="check" htmlFor={`reach-${option.key}`}>
                <input
                  id={`reach-${option.key}`}
                  type="radio"
                  name="reach"
                  value={option.key}
                  checked={draft.reach === option.key}
                  onChange={() => set('reach', option.key)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>

          <details className="more">
            <summary>Other ways people ask this</summary>
            <Field
              id="answer-phrases"
              label={`Phrasings (${phraseLines(draft.phrases).length}/${MAX_PHRASES})`}
              hint="One per line. The bot only recognises a wording that is listed here or close to the question."
            >
              <textarea
                id="answer-phrases"
                rows={4}
                placeholder={'how do I apply\nwhere do I send my CV'}
                value={draft.phrases}
                onChange={(e) => set('phrases', e.target.value)}
              />
            </Field>
          </details>

          <details className="more">
            <summary>More options</summary>
            <Field id="answer-category" label="Category">
              <input
                id="answer-category"
                maxLength={60}
                value={draft.category}
                onChange={(e) => set('category', e.target.value)}
              />
            </Field>
            <div className="form-row">
              <Field
                id="answer-command"
                label="Telegram command"
                hint="Lower-case letters, digits and underscores. Optional."
              >
                <input
                  id="answer-command"
                  maxLength={33}
                  placeholder="benefits"
                  value={draft.command}
                  onChange={(e) => set('command', e.target.value)}
                />
              </Field>
              <Field
                id="answer-command-description"
                label="Menu description"
                hint={
                  commandSet
                    ? 'Shown in the bot menu to anyone who opens it. Required with a command.'
                    : 'Only needed with a command.'
                }
              >
                <input
                  id="answer-command-description"
                  maxLength={256}
                  required={commandSet}
                  disabled={!commandSet}
                  value={draft.commandDescription}
                  onChange={(e) => set('commandDescription', e.target.value)}
                />
              </Field>
            </div>
            <div className="form-row">
              <Field id="answer-from" label="Effective from" hint="Leave blank for today.">
                <input
                  id="answer-from"
                  type="date"
                  value={draft.effectiveFrom}
                  onChange={(e) => set('effectiveFrom', e.target.value)}
                />
              </Field>
              <Field id="answer-to" label="Effective to" hint="Leave blank for no end date.">
                <input
                  id="answer-to"
                  type="date"
                  min={draft.effectiveFrom || undefined}
                  value={draft.effectiveTo}
                  onChange={(e) => set('effectiveTo', e.target.value)}
                />
              </Field>
            </div>
          </details>

          {isNew && draft.sourceUnansweredId ? (
            <Notice tone="info">
              Saving also closes the unanswered question this started from.
            </Notice>
          ) : null}

          <div className="form-actions">
            {isNew ? (
              <>
                <button type="submit" disabled={submitting}>
                  {submitting ? 'Saving…' : 'Save as draft'}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={submitting}
                  onClick={() => void save('ACTIVE')}
                >
                  Save and publish
                </button>
              </>
            ) : (
              <button type="submit" className="primary" disabled={submitting}>
                {submitting ? 'Saving…' : 'Save changes'}
              </button>
            )}
            <button type="button" onClick={onCancel} disabled={submitting}>
              {isNew ? 'Cancel' : 'Close'}
            </button>
          </div>
        </form>
      </div>
    </Card>
  )
}

// --- Unanswered questions --------------------------------------------------

function UnansweredCard({
  backlog,
  onPage,
  onAnswer,
}: {
  backlog: ApiState<Page<UnansweredQuestion>>
  onPage(offset: number): void
  onAnswer(item: UnansweredQuestion): void
}) {
  const [error, setError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function dismiss(item: UnansweredQuestion) {
    if (!window.confirm('Dismiss this question? It leaves the list without an answer.')) return
    setError(null)
    setBusyId(item.id)
    try {
      await api(`/knowledge/answers/unanswered/${item.id}/resolve`, { method: 'POST', body: {} })
      backlog.reload()
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card title="Unanswered questions">
      <p className="hint">
        Questions a bot could not answer. Write an answer, or dismiss the ones that do not need one.
      </p>
      <SubmitError error={error} />
      {backlog.loading ? (
        <Loading rows={3} label="Loading unanswered questions" />
      ) : backlog.error ? (
        <ErrorState error={backlog.error} />
      ) : !backlog.data || backlog.data.items.length === 0 ? (
        <Empty
          title="Nothing waiting"
          hint="When a bot cannot answer a question, it appears here."
        />
      ) : (
        <>
          <div className="rows">
            {backlog.data.items.map((item) => (
              <div className="row-card" key={item.id}>
                <div className="row-head">
                  <strong>{item.question}</strong>
                </div>
                <div className="row-meta">
                  <span>{CHANNEL_LABEL[item.channel] ?? 'Bot'}</span>
                  <span>Asked {formatDateTime(item.createdAt)}</span>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="small primary"
                    disabled={busyId === item.id}
                    onClick={() => onAnswer(item)}
                  >
                    Answer this
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={busyId === item.id}
                    onClick={() => dismiss(item)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Pager page={backlog.data} onChange={onPage} />
        </>
      )}
    </Card>
  )
}

// --- Test the bot ----------------------------------------------------------

function TestBotCard({
  onWriteAnswer,
}: {
  onWriteAnswer(question: string, bot: Compartment): void
}) {
  const [question, setQuestion] = useState('')
  const [bot, setBot] = useState<Compartment>('EXTERNAL')
  const [result, setResult] = useState<PreviewResponse | null>(null)
  const [asked, setAsked] = useState<{ question: string; bot: Compartment } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [running, setRunning] = useState(false)

  async function run(event: FormEvent) {
    event.preventDefault()
    setRunning(true)
    setError(null)
    const trimmed = question.trim()
    try {
      setResult(
        await api<PreviewResponse>('/knowledge/answers/preview', {
          method: 'POST',
          body: { question: trimmed, audience: bot },
        }),
      )
      setAsked({ question: trimmed, bot })
    } catch (e) {
      setError(e)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  const served = result?.matches.find((match) => match.wouldServe) ?? null

  return (
    <Card title="Test the bot">
      <div className="grid">
        <form onSubmit={run} aria-label="Test the bot">
          <Field id="test-bot" label="Bot">
            <select
              id="test-bot"
              value={bot}
              onChange={(e) => setBot(e.target.value as Compartment)}
            >
              <option value="EXTERNAL">{BOT_LABEL.EXTERNAL}</option>
              <option value="INTERNAL">{BOT_LABEL.INTERNAL}</option>
            </select>
          </Field>
          <Field
            id="test-question"
            label="Question"
            hint="Type it the way someone would in Telegram."
          >
            <input
              id="test-question"
              required
              minLength={3}
              maxLength={500}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
          <div className="form-actions">
            <button
              type="submit"
              className="primary"
              disabled={running || question.trim().length < 3}
            >
              {running ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </form>

        {error ? <ErrorState error={error} /> : null}

        {result && asked ? (
          served ? (
            <div className="rows">
              <div className="bubble user">{asked.question}</div>
              <div className="bubble">{served.answer}</div>
              <div className="bubble-meta">
                {BOT_LABEL[asked.bot]} · from the answer “{served.question}”
              </div>
            </div>
          ) : (
            <Notice tone="info">
              <div className="grid">
                <span>
                  The bot would not answer this — it would search policies or say it does not know.
                </span>
                <div className="actions">
                  <button type="button" onClick={() => onWriteAnswer(asked.question, asked.bot)}>
                    Write an answer
                  </button>
                </div>
              </div>
            </Notice>
          )
        ) : null}
      </div>
    </Card>
  )
}

// --- Command menus ---------------------------------------------------------

/**
 * Pushing a menu changes what everyone who opens the bot can see, so it is a
 * deliberate action here rather than a side effect of saving an answer.
 */
function CommandMenus() {
  const menus = useApi<CommandMenusResponse>('/knowledge/answers/commands')
  const [syncing, setSyncing] = useState(false)
  const [results, setResults] = useState<SyncResult[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function push() {
    if (
      !window.confirm(
        'Push these menus to Telegram? Everyone who opens the bots sees the new menu.',
      )
    )
      return
    setSyncing(true)
    setResults(null)
    setError(null)
    try {
      const response = await api<{ results: SyncResult[] }>('/knowledge/answers/commands/sync', {
        method: 'POST',
        body: {},
      })
      setResults(response.results)
      menus.reload()
    } catch (e) {
      setError(e)
    } finally {
      setSyncing(false)
    }
  }

  function describe(result: SyncResult): string {
    if (!result.configured) return 'skipped — this bot is not set up yet.'
    if (!result.synced) return 'Telegram did not accept the update.'
    const n = result.commands.length
    return `${n} command${n === 1 ? '' : 's'} published.`
  }

  return (
    <div className="grid">
      {menus.loading ? (
        <Card title="Command menus">
          <Loading rows={3} label="Loading command menus" />
        </Card>
      ) : menus.error ? (
        <Card title="Command menus">
          <ErrorState error={menus.error} />
        </Card>
      ) : menus.data ? (
        <div className="grid two">
          {menus.data.menus.map((menu) => {
            const builtIn = new Set(menu.builtIn.map((entry) => entry.command))
            return (
              <Card key={menu.compartment} title={BOT_LABEL[menu.compartment]}>
                {menu.effective.length === 0 ? (
                  <Empty
                    title="No commands"
                    hint="Add a Telegram command to an answer to list it here."
                  />
                ) : (
                  <ul className="small-text">
                    {menu.effective.map((entry) => (
                      <li key={entry.command}>
                        <span className="mono">/{entry.command}</span> — {entry.description}{' '}
                        {builtIn.has(entry.command) ? (
                          <Badge value="built in" tone="muted" />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {menu.omitted.length > 0 ? (
                  <Notice tone="warn">
                    {menu.omitted.length} command{menu.omitted.length === 1 ? '' : 's'} do not fit
                    in Telegram&apos;s menu and will not be sent.
                  </Notice>
                ) : null}
              </Card>
            )
          })}
        </div>
      ) : null}

      <Card title="Telegram">
        <div className="grid">
          <p className="hint">
            Only answers anyone may read are listed in a menu, because Telegram shows it before a
            person links their account. A command on any other answer still works for the people
            allowed to use it.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={syncing || menus.loading}
              onClick={push}
            >
              {syncing ? 'Pushing…' : 'Push menus to Telegram'}
            </button>
            <span className="hint">Replaces each bot&apos;s whole menu.</span>
          </div>
          <SubmitError error={error} />
          {results ? (
            <Notice tone="ok">
              {results.map((result) => (
                <div key={result.compartment}>
                  {BOT_LABEL[result.compartment]}: {describe(result)}
                </div>
              ))}
            </Notice>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
