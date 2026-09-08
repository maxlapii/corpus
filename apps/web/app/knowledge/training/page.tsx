'use client'

/**
 * Bot training — curated question/answer pairs for the external and internal
 * Telegram bots (CLAUDE.md §30, §33).
 *
 * An answer published here is served verbatim, with no model turn, so the
 * audience and classification chosen on this form are the whole access control
 * for that text. The form therefore refuses an EXTERNAL audience above PUBLIC
 * before submitting — the same rule the API and the database both enforce, so
 * this check is a courtesy, never the guard.
 *
 * Permission checks are for UX only; the API re-authorises every request.
 */

import { useCallback, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, ErrorState, Loading, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import { ApiRequestError, api, can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'
type Audience = 'EXTERNAL' | 'INTERNAL' | 'BOTH'
type Status = 'DRAFT' | 'ACTIVE' | 'ARCHIVED'

interface CuratedAnswer {
  id: string
  question: string
  answer: string
  category: string
  audience: Audience
  classification: Classification
  status: Status
  requiresAccount: boolean
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
  audience: 'EXTERNAL' | 'INTERNAL'
  strategy: 'fts' | 'like' | 'none'
  matches: PreviewMatch[]
}

const AUDIENCES: Audience[] = ['EXTERNAL', 'INTERNAL', 'BOTH']
const CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']
const STATUSES: Status[] = ['DRAFT', 'ACTIVE', 'ARCHIVED']
const PAGE_SIZE = 20
const MAX_PHRASES = 20

const AUDIENCE_HINT: Record<Audience, string> = {
  EXTERNAL: 'Public recruitment bot only. Anyone can read it, so it must be PUBLIC.',
  INTERNAL: 'Verified employees only, filtered further by classification.',
  BOTH: 'Served by both bots. Must be PUBLIC, because candidates can reach it.',
}

const emptyDraft = (): DraftState => ({
  id: null,
  question: '',
  answer: '',
  category: 'GENERAL',
  audience: 'INTERNAL',
  classification: 'INTERNAL',
  status: 'DRAFT',
  requiresAccount: true,
  phrases: '',
  effectiveFrom: '',
  effectiveTo: '',
  sourceUnansweredId: null,
})

interface DraftState {
  id: string | null
  question: string
  answer: string
  category: string
  audience: Audience
  classification: Classification
  status: Status
  requiresAccount: boolean
  /** One phrasing per line — the plainest editor for a short list. */
  phrases: string
  effectiveFrom: string
  effectiveTo: string
  sourceUnansweredId: string | null
}

const cellStyle: CSSProperties = { verticalAlign: 'top' }

const matchStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--surface-alt)',
  padding: '10px 12px',
  marginBottom: 8,
}

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function reachesExternal(audience: Audience): boolean {
  return audience === 'EXTERNAL' || audience === 'BOTH'
}

function phraseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export default function TrainingPage() {
  const { user } = useSession()
  const mayManage = can(user, 'faq.manage')

  const [audienceFilter, setAudienceFilter] = useState<Audience | ''>('')
  const [statusFilter, setStatusFilter] = useState<Status | ''>('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const listPath = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    })
    if (audienceFilter) params.set('audience', audienceFilter)
    if (statusFilter) params.set('status', statusFilter)
    if (search.trim()) params.set('q', search.trim())
    return `/knowledge/answers?${params.toString()}`
  }, [audienceFilter, statusFilter, search, page])

  const answers = useApi<Page<CuratedAnswer>>(mayManage ? listPath : null)
  const backlog = useApi<Page<UnansweredQuestion>>(
    mayManage ? `/knowledge/answers/unanswered?resolved=false&limit=10&offset=0` : null,
  )

  const [draft, setDraft] = useState<DraftState>(emptyDraft)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Set when the last save produced something the bots will not serve yet. */
  const [unpublished, setUnpublished] = useState<CuratedAnswer | null>(null)

  const reloadAll = useCallback(() => {
    answers.reload()
    backlog.reload()
  }, [answers, backlog])

  const startNew = useCallback(() => {
    setDraft(emptyDraft())
    setSubmitError(null)
    setNotice(null)
  }, [])

  const editAnswer = useCallback((answer: CuratedAnswer) => {
    setDraft({
      id: answer.id,
      question: answer.question,
      answer: answer.answer,
      category: answer.category,
      audience: answer.audience,
      classification: answer.classification,
      status: answer.status,
      requiresAccount: answer.requiresAccount,
      phrases: answer.phrases.join('\n'),
      effectiveFrom: answer.effectiveFrom,
      effectiveTo: answer.effectiveTo ?? '',
      sourceUnansweredId: answer.sourceUnansweredId,
    })
    setSubmitError(null)
    setNotice(null)
  }, [])

  const trainFromBacklog = useCallback((question: UnansweredQuestion) => {
    setDraft({
      ...emptyDraft(),
      question: question.question.slice(0, 300),
      // A question that reached the external bot must be answerable publicly.
      audience: question.channel === 'TELEGRAM_EXTERNAL' ? 'EXTERNAL' : 'INTERNAL',
      classification: question.channel === 'TELEGRAM_EXTERNAL' ? 'PUBLIC' : 'INTERNAL',
      requiresAccount: question.channel !== 'TELEGRAM_EXTERNAL',
      sourceUnansweredId: question.id,
    })
    setSubmitError(null)
    setNotice(null)
  }, [])

  const classificationConflict =
    (reachesExternal(draft.audience) && draft.classification !== 'PUBLIC') ||
    (!draft.requiresAccount && draft.classification !== 'PUBLIC')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (classificationConflict) return
    setSubmitting(true)
    setSubmitError(null)
    setNotice(null)
    setUnpublished(null)

    const body: Record<string, unknown> = {
      question: draft.question.trim(),
      answer: draft.answer.trim(),
      category: draft.category.trim() || 'GENERAL',
      audience: draft.audience,
      classification: draft.classification,
      status: draft.status,
      requiresAccount: draft.requiresAccount,
      phrases: phraseLines(draft.phrases).slice(0, MAX_PHRASES),
    }
    if (draft.effectiveFrom) body.effectiveFrom = draft.effectiveFrom
    if (draft.effectiveTo) body.effectiveTo = draft.effectiveTo
    if (!draft.id && draft.sourceUnansweredId) body.sourceUnansweredId = draft.sourceUnansweredId

    try {
      const saved = await api<{ answer: CuratedAnswer }>(
        draft.id ? `/knowledge/answers/${draft.id}` : '/knowledge/answers',
        { method: draft.id ? 'PUT' : 'POST', body },
      )

      // Closing the backlog item is a second call: the answer must exist before
      // anything can point at it.
      if (!draft.id && draft.sourceUnansweredId) {
        await api(`/knowledge/answers/unanswered/${draft.sourceUnansweredId}/resolve`, {
          method: 'POST',
          body: { answerId: saved.answer.id },
        })
      }

      const live = saved.answer.status === 'ACTIVE'
      setNotice(
        live
          ? `Saved and live. The ${saved.answer.audience.toLowerCase()} bot will answer with this now.`
          : `Saved as ${saved.answer.status}. The bots will NOT answer with it until it is published.`,
      )
      setUnpublished(live ? null : saved.answer)
      setDraft(emptyDraft())
      reloadAll()
    } catch (e) {
      setSubmitError(e)
    } finally {
      setSubmitting(false)
    }
  }

  async function changeStatus(answer: CuratedAnswer, status: Status) {
    setSubmitError(null)
    setNotice(null)
    try {
      await api(`/knowledge/answers/${answer.id}/status`, { method: 'POST', body: { status } })
      setNotice(
        status === 'ACTIVE'
          ? `"${answer.question}" is live. The bots will answer with it now.`
          : `"${answer.question}" is now ${status}.`,
      )
      setUnpublished(null)
      reloadAll()
    } catch (e) {
      setSubmitError(e)
    }
  }

  if (!mayManage) {
    return (
      <Shell>
        <PageHeader
          title="Bot training"
          description="Curated answers for the recruitment and employee Telegram bots."
        />
        <Card>
          <Empty
            title="You do not have access to bot training"
            hint="This area needs the faq.manage permission. Ask an HR administrator."
          />
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <PageHeader
        title="Bot training"
        description="Question and answer pairs the Telegram bots serve verbatim, with no model involved."
        actions={
          <button type="button" className="primary" onClick={startNew}>
            New answer
          </button>
        }
      />

      {notice ? (
        <div
          className={unpublished ? 'notice warn' : 'notice ok'}
          role="status"
          style={{ marginBottom: 14 }}
        >
          {notice}
          {unpublished ? (
            <>
              {' '}
              <button
                type="button"
                className="primary"
                style={{ marginLeft: 8 }}
                onClick={() => changeStatus(unpublished, 'ACTIVE')}
              >
                Publish it now
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {submitError ? (
        submitError instanceof ApiRequestError && submitError.isForbidden ? (
          <ErrorState error={submitError} />
        ) : (
          <div className="notice error" role="alert" style={{ marginBottom: 14 }}>
            {messageOf(submitError)}
          </div>
        )
      ) : null}

      <div className="grid two" style={{ marginBottom: 14 }}>
        <AnswerForm
          draft={draft}
          setDraft={setDraft}
          submitting={submitting}
          conflict={classificationConflict}
          onSubmit={submit}
        />
        <PreviewPanel />
      </div>

      <Card title="Training backlog">
        <p className="hint" style={{ marginTop: 0 }}>
          Questions a bot could not answer from approved material.
        </p>
        {backlog.loading ? (
          <Loading rows={3} label="Loading unanswered questions" />
        ) : backlog.error ? (
          <ErrorState error={backlog.error} />
        ) : !backlog.data || backlog.data.items.length === 0 ? (
          <Empty
            title="Nothing unanswered"
            hint="When a bot cannot answer from approved material, the question is recorded here."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Channel</th>
                  <th>Asked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backlog.data.items.map((item) => (
                  <tr key={item.id}>
                    <td style={cellStyle}>{item.question}</td>
                    <td style={cellStyle}>
                      <Badge value={item.channel} />
                    </td>
                    <td style={cellStyle}>{formatDateTime(item.createdAt)}</td>
                    <td style={cellStyle}>
                      <button type="button" onClick={() => trainFromBacklog(item)}>
                        Answer this
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Curated answers">
        <form
          className="toolbar"
          aria-label="Filter answers"
          onSubmit={(e) => {
            e.preventDefault()
            setPage(0)
            answers.reload()
          }}
        >
          <label htmlFor="filter-audience" className="visually-hidden">
            Audience
          </label>
          <select
            id="filter-audience"
            value={audienceFilter}
            onChange={(e) => {
              setAudienceFilter(e.target.value as Audience | '')
              setPage(0)
            }}
          >
            <option value="">All audiences</option>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {a}
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
              setPage(0)
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <label htmlFor="filter-q" className="visually-hidden">
            Search
          </label>
          <input
            id="filter-q"
            value={search}
            placeholder="Search questions and answers"
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Apply</button>
        </form>

        {answers.loading ? (
          <Loading rows={4} label="Loading answers" />
        ) : answers.error ? (
          <ErrorState error={answers.error} />
        ) : !answers.data || answers.data.items.length === 0 ? (
          <Empty
            title="No curated answers yet"
            hint="Add one above, or pick a question from the training backlog."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Audience</th>
                    <th>Classification</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Phrasings</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {answers.data.items.map((answer) => (
                    <tr key={answer.id}>
                      <td style={cellStyle}>{answer.question}</td>
                      <td style={cellStyle}>
                        <Badge value={answer.audience} />
                      </td>
                      <td style={cellStyle}>
                        <Badge value={answer.classification} />
                      </td>
                      <td style={cellStyle}>
                        <Badge value={answer.requiresAccount ? 'REQUIRED' : 'NOT NEEDED'} />
                      </td>
                      <td style={cellStyle}>
                        <Badge value={answer.status} />
                      </td>
                      <td style={cellStyle}>{answer.phrases.length}</td>
                      <td style={cellStyle}>{formatDateTime(answer.updatedAt)}</td>
                      <td style={cellStyle}>
                        <div className="toolbar" style={{ marginBottom: 0 }}>
                          <button type="button" onClick={() => editAnswer(answer)}>
                            Edit
                          </button>
                          {answer.status === 'DRAFT' ? (
                            <button type="button" onClick={() => changeStatus(answer, 'ACTIVE')}>
                              Publish
                            </button>
                          ) : null}
                          {answer.status !== 'ARCHIVED' ? (
                            <button type="button" onClick={() => changeStatus(answer, 'ARCHIVED')}>
                              Archive
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="hint">
                {answers.data.total} answer(s) — page {page + 1}
              </span>
              <button
                type="button"
                disabled={(page + 1) * PAGE_SIZE >= answers.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </Card>
    </Shell>
  )
}

function AnswerForm({
  draft,
  setDraft,
  submitting,
  conflict,
  onSubmit,
}: {
  draft: DraftState
  setDraft: (next: DraftState) => void
  submitting: boolean
  conflict: boolean
  onSubmit(event: FormEvent): void
}) {
  const phrases = phraseLines(draft.phrases)

  return (
    <Card title={draft.id ? 'Edit answer' : 'New answer'}>
      <form onSubmit={onSubmit} aria-label="Curated answer">
        <div className="field">
          <label htmlFor="answer-question">Question</label>
          <input
            id="answer-question"
            value={draft.question}
            maxLength={300}
            required
            onChange={(e) => setDraft({ ...draft, question: e.target.value })}
          />
          <div className="hint">The canonical wording. Alternatives go in the phrasings box.</div>
        </div>

        <div className="field">
          <label htmlFor="answer-body">Answer</label>
          <textarea
            id="answer-body"
            value={draft.answer}
            rows={5}
            maxLength={4000}
            required
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
          />
          <div className="hint">
            Served word for word. The bot will not rephrase it or add to it.
          </div>
        </div>

        <div className="field">
          <label htmlFor="answer-phrases">Training phrasings ({phrases.length}/{MAX_PHRASES})</label>
          <textarea
            id="answer-phrases"
            value={draft.phrases}
            rows={4}
            placeholder={'how do I apply\nwhere do I send my CV'}
            onChange={(e) => setDraft({ ...draft, phrases: e.target.value })}
          />
          <div className="hint">
            One per line. A way of asking that is not listed is a way the bot will not recognise.
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="answer-audience">Audience</label>
            <select
              id="answer-audience"
              value={draft.audience}
              onChange={(e) => {
                const audience = e.target.value as Audience
                setDraft({
                  ...draft,
                  audience,
                  // Steer to the only legal choice rather than letting the save fail.
                  classification: reachesExternal(audience) ? 'PUBLIC' : draft.classification,
                })
              }}
            >
              {AUDIENCES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <div className="hint">{AUDIENCE_HINT[draft.audience]}</div>
          </div>

          <div className="field">
            <label htmlFor="answer-classification">Classification</label>
            <select
              id="answer-classification"
              value={draft.classification}
              disabled={reachesExternal(draft.audience)}
              onChange={(e) =>
                setDraft({ ...draft, classification: e.target.value as Classification })
              }
            >
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {conflict ? (
              <div className="notice error" style={{ marginTop: 8, fontSize: 13 }}>
                Only a PUBLIC answer can reach the external bot, or someone without a verified
                account.
              </div>
            ) : null}
          </div>
        </div>

        {draft.audience === 'INTERNAL' ? (
          <div className="field">
            <label htmlFor="answer-account">
              <input
                id="answer-account"
                type="checkbox"
                checked={!draft.requiresAccount}
                disabled={draft.classification !== 'PUBLIC'}
                onChange={(e) => setDraft({ ...draft, requiresAccount: !e.target.checked })}
                style={{ marginRight: 8 }}
              />
              Answer this without a verified account
            </label>
            <div className="hint">
              {draft.classification === 'PUBLIC'
                ? 'General staff information — someone messaging the internal bot gets this before linking their account. Leave off for anything personal or credential-bearing.'
                : 'Only a PUBLIC answer can be given without an account. Reclassify to PUBLIC to enable this.'}
            </div>
          </div>
        ) : null}

        <div className="form-row">
          <div className="field">
            <label htmlFor="answer-category">Category</label>
            <input
              id="answer-category"
              value={draft.category}
              maxLength={60}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="answer-status">Status</label>
            <select
              id="answer-status"
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as Status })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="hint">Only ACTIVE answers are served. Archiving cannot be undone.</div>
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="answer-from">Effective from</label>
            <input
              id="answer-from"
              type="date"
              value={draft.effectiveFrom}
              onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })}
            />
            <div className="hint">Defaults to today.</div>
          </div>
          <div className="field">
            <label htmlFor="answer-to">Effective to</label>
            <input
              id="answer-to"
              type="date"
              value={draft.effectiveTo}
              onChange={(e) => setDraft({ ...draft, effectiveTo: e.target.value })}
            />
            <div className="hint">Leave blank for no end date.</div>
          </div>
        </div>

        {draft.sourceUnansweredId ? (
          <div className="notice info" style={{ marginBottom: 12, fontSize: 13 }}>
            Saving will also close the backlog question this was started from.
          </div>
        ) : null}

        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button type="submit" className="primary" disabled={submitting || conflict}>
            {submitting
              ? 'Saving…'
              : draft.status === 'ACTIVE'
                ? draft.id
                  ? 'Save and keep live'
                  : 'Create and publish'
                : draft.id
                  ? `Save as ${draft.status.toLowerCase()}`
                  : 'Save as draft'}
          </button>
          {draft.status !== 'ACTIVE' ? (
            <span className="hint">
              A {draft.status.toLowerCase()} answer is not served by either bot. Set the status to
              ACTIVE to make it live.
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  )
}

/** Dry run against the real retrieval path, so authors can check precision. */
function PreviewPanel() {
  const [question, setQuestion] = useState('')
  const [audience, setAudience] = useState<'EXTERNAL' | 'INTERNAL'>('EXTERNAL')
  const [result, setResult] = useState<PreviewResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [running, setRunning] = useState(false)

  async function run(event: FormEvent) {
    event.preventDefault()
    setRunning(true)
    setError(null)
    try {
      setResult(
        await api<PreviewResponse>('/knowledge/answers/preview', {
          method: 'POST',
          body: { question: question.trim(), audience },
        }),
      )
    } catch (e) {
      setError(e)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card title="Test a bot">
      <p className="hint" style={{ marginTop: 0 }}>
        What would the bot reply right now?
      </p>
      <form onSubmit={run} aria-label="Preview a bot answer">
        <div className="field">
          <label htmlFor="preview-audience">Bot</label>
          <select
            id="preview-audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value as 'EXTERNAL' | 'INTERNAL')}
          >
            <option value="EXTERNAL">External (candidates)</option>
            <option value="INTERNAL">Internal (employees)</option>
          </select>
          <div className="hint">
            The external preview is capped at PUBLIC, so it shows what a candidate sees.
          </div>
        </div>
        <div className="field">
          <label htmlFor="preview-question">Question</label>
          <input
            id="preview-question"
            value={question}
            required
            minLength={3}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button type="submit" disabled={running || question.trim().length < 3}>
            {running ? 'Testing…' : 'Test'}
          </button>
        </div>
      </form>

      {error ? <ErrorState error={error} /> : null}

      {result ? (
        result.matches.length === 0 ? (
          <div className="notice info" style={{ marginTop: 12, fontSize: 13 }}>
            No curated answer matches. The bot would fall back to policy search, or say it does not
            know and record the question in the backlog.
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            {result.matches.map((match) => (
              <div key={match.answerId} style={matchStyle}>
                <div className="toolbar" style={{ marginBottom: 6 }}>
                  <Badge value={match.wouldServe ? 'WOULD SERVE' : 'BELOW THRESHOLD'} />
                  <Badge value={match.classification} />
                  {match.requiresAccount ? <Badge value="ACCOUNT REQUIRED" /> : null}
                  <span className="hint">
                    {Math.round(match.coverage * 100)}% of your words matched
                  </span>
                </div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{match.question}</div>
                <div>{match.answer}</div>
              </div>
            ))}
          </div>
        )
      ) : null}
    </Card>
  )
}
