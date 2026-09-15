'use client'

/**
 * CVs — preview, filter and match against a job (CLAUDE.md §21, §33, §38).
 *
 * A reading surface, not an intake one: CVs arrive on the Telegram bots, so
 * there is no upload here. That keeps one ingestion path with one set of
 * checks, and makes the provenance on every row meaningful.
 *
 * Layout: a master/detail split — the filtered list on the left, the selected
 * CV's preview on the right with its actions first, then the file text, then
 * the job match. Every action reports success or failure inside the preview.
 *
 * Two things this page is careful about:
 *
 * 1. The CV text is untrusted. It is rendered inside a `<pre>` as a text node,
 *    never as markup and never as an instruction to anything.
 * 2. The match report is advisory. It shows the sentence behind every match so
 *    a person can disagree with it, and nothing here changes an application's
 *    stage — that stays a human decision on the recruitment page.
 *
 * Permission checks here only decide which controls are rendered; the API
 * re-authorises every request through the PolicyGateway.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
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
  formatDateTime,
} from '@/components/ui'
import { useSession } from '@/components/session'
import { API_BASE, api, can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

type ExtractionStatus = 'OK' | 'EMPTY' | 'UNSUPPORTED' | 'FAILED'
type CvSource = 'TELEGRAM_EXTERNAL' | 'TELEGRAM_INTERNAL' | 'DASHBOARD'

interface CvFacets {
  total: number
  bySource: Record<string, number>
  byExtraction: Record<string, number>
  flagged: number
}

interface CvListItem {
  id: string
  candidateId: string
  candidateName: string
  candidateEmail: string
  kind: string
  filename: string
  contentType: string
  byteSize: number
  extractionStatus: ExtractionStatus
  injectionFlagged: boolean
  source: CvSource
  uploadedAt: string
}

interface CvDetail {
  document: CvListItem & { extractedText: string | null; extractionWarnings: string[] }
  candidate: { id: string; name: string; email: string; phone: string | null } | null
}

interface RequirementMatch {
  requirementId: string
  requirementType: string
  description: string
  mandatory: boolean
  matched: boolean
  matchedTerms: string[]
  missingTerms: string[]
  evidence: string[]
}

interface MatchResponse {
  job: { id: string; jobCode: string; title: string; experienceMin: number | null }
  report: {
    requirements: RequirementMatch[]
    facts: {
      yearsOfExperience: number | null
      emails: string[]
      phones: string[]
      links: string[]
      education: string[]
    }
    score: {
      mandatoryMet: number
      mandatoryTotal: number
      optionalMet: number
      optionalTotal: number
      percent: number
    }
    meetsExperienceMinimum: boolean | null
    caveats: string[]
  }
  advisory: string
}

interface JobListItem {
  id: string
  jobCode: string
  title: string
  status: string
}

const PAGE_SIZE = 20
/** How much of a long CV shows before "Show full text". */
const PREVIEW_CHARS = 1500
/** With "Needs attention" on, this many most-recent CVs are checked. */
const ATTENTION_SCAN = 100

function sourceLabel(source: CvSource): string {
  switch (source) {
    case 'TELEGRAM_EXTERNAL':
      return 'Sent by candidate'
    case 'TELEGRAM_INTERNAL':
      return 'Forwarded by staff'
    default:
      return 'Uploaded'
  }
}

function sourceTone(source: CvSource): 'info' | 'muted' {
  return source === 'TELEGRAM_EXTERNAL' ? 'info' : 'muted'
}

function hasText(cv: Pick<CvListItem, 'extractionStatus'>): boolean {
  return cv.extractionStatus === 'OK'
}

function needsAttention(cv: Pick<CvListItem, 'extractionStatus' | 'injectionFlagged'>): boolean {
  return cv.injectionFlagged || !hasText(cv)
}

function TextBadge({ cv }: { cv: Pick<CvListItem, 'extractionStatus' | 'injectionFlagged'> }) {
  if (cv.injectionFlagged) return <Badge value="Flagged" tone="danger" />
  if (hasText(cv)) return <Badge value="Ready" tone="ok" />
  return <Badge value="Needs text" tone="warn" />
}

/** A value that trails `value` by `delay` ms — for search boxes without an Apply button. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** On narrow screens the preview sits below the list; bring it into view when a row is chosen. */
function useScrollToDetail(ref: RefObject<HTMLElement>, key: string | null) {
  useEffect(() => {
    if (!key) return
    if (typeof window !== 'undefined' && window.innerWidth < 1200) {
      ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [ref, key])
}

export default function CvsPage() {
  const { user } = useSession()
  const mayRead = can(user, 'candidate.document.read')
  const mayManage = can(user, 'candidate.document.manage')

  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim())
  const [attention, setAttention] = useState(false)
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // A changed filter is a new list: back to the first page, nothing selected.
  useEffect(() => {
    setOffset(0)
    setSelectedId(null)
  }, [query, attention])

  // "Needs attention" means flagged OR without text. The list route filters
  // with AND and takes one extraction status at a time, so that union cannot
  // be asked for directly; instead the most recent files are fetched and
  // narrowed here, without paging.
  const params = new URLSearchParams({
    limit: String(attention ? ATTENTION_SCAN : PAGE_SIZE),
    offset: String(attention ? 0 : offset),
  })
  if (query) params.set('q', query)
  const listPath = `/cvs?${params.toString()}`

  const cvs = useApi<Page<CvListItem> & { facets: CvFacets }>(mayRead ? listPath : null)
  const jobs = useApi<Page<JobListItem>>(mayRead ? '/jobs?limit=100&offset=0' : null)

  useScrollToDetail(detailRef, selectedId)

  if (!mayRead) {
    return (
      <Shell>
        <PageHeader title="CVs" />
        <Card>
          <Empty title="You do not have access to candidate CVs" hint="Ask an HR administrator." />
        </Card>
      </Shell>
    )
  }

  const filtered = search !== '' || attention
  const items = cvs.data ? (attention ? cvs.data.items.filter(needsAttention) : cvs.data.items) : []
  const withoutText =
    (cvs.data?.facets.byExtraction.EMPTY ?? 0) +
    (cvs.data?.facets.byExtraction.UNSUPPORTED ?? 0) +
    (cvs.data?.facets.byExtraction.FAILED ?? 0)

  return (
    <Shell>
      <PageHeader
        title="CVs"
        description="CVs candidates sent to the recruitment bot, or that staff forwarded on the employee bot."
      />

      <div className="split">
        <Card title="Received CVs">
          <div className="toolbar">
            <label htmlFor="cv-search" className="visually-hidden">
              Search
            </label>
            <input
              id="cv-search"
              type="search"
              value={search}
              maxLength={120}
              placeholder="Candidate name, e-mail or file name"
              onChange={(e) => setSearch(e.target.value)}
            />
            <label className="check" htmlFor="cv-attention">
              <input
                id="cv-attention"
                type="checkbox"
                checked={attention}
                onChange={(e) => setAttention(e.target.checked)}
              />
              Needs attention
            </label>
            {filtered ? (
              <button
                type="button"
                onClick={() => {
                  setSearch('')
                  setAttention(false)
                }}
              >
                Clear
              </button>
            ) : null}
          </div>

          {withoutText > 0 ? (
            <p className="hint">
              {withoutText.toLocaleString()} need text added
            </p>
          ) : null}

          {cvs.loading ? (
            <Loading rows={4} label="Loading CVs" />
          ) : cvs.error ? (
            <ErrorState error={cvs.error} />
          ) : !cvs.data || items.length === 0 ? (
            <Empty
              title={filtered ? 'No CVs match' : 'No CVs yet'}
              hint={
                filtered
                  ? 'Try clearing the search or the filter.'
                  : 'Candidates send a CV to the recruitment bot after applying; staff forward one to the employee bot.'
              }
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Candidate</th>
                      <th scope="col">Source</th>
                      <th scope="col">Text</th>
                      <th scope="col">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((cv) => (
                      <tr
                        key={cv.id}
                        className="selectable"
                        aria-selected={cv.id === selectedId}
                        onClick={() => setSelectedId(cv.id)}
                      >
                        <td>
                          <button type="button" className="link" onClick={() => setSelectedId(cv.id)}>
                            {cv.candidateName}
                          </button>
                          <div className="small-text muted">{cv.filename}</div>
                        </td>
                        <td>
                          <Badge value={sourceLabel(cv.source)} tone={sourceTone(cv.source)} />
                        </td>
                        <td>
                          <TextBadge cv={cv} />
                        </td>
                        <td>{formatDateTime(cv.uploadedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {attention ? (
                cvs.data.total > ATTENTION_SCAN ? (
                  <p className="hint">
                    Checked the {ATTENTION_SCAN} most recent CVs. Narrow the search to check older ones.
                  </p>
                ) : null
              ) : (
                <Pager page={cvs.data} onChange={setOffset} />
              )}
            </>
          )}
        </Card>

        <div ref={detailRef}>
          {selectedId ? (
            <PreviewPanel
              key={selectedId}
              cvId={selectedId}
              mayManage={mayManage}
              jobs={jobs.data?.items ?? []}
              onChanged={() => cvs.reload()}
              onDeleted={() => {
                setSelectedId(null)
                cvs.reload()
              }}
            />
          ) : (
            <Card title="CV">
              <Empty title="Select a CV" hint="Choose one from the list to read it or match it against a job." />
            </Card>
          )}
        </div>
      </div>
    </Shell>
  )
}

function PreviewPanel({
  cvId,
  mayManage,
  jobs,
  onChanged,
  onDeleted,
}: {
  cvId: string
  mayManage: boolean
  jobs: JobListItem[]
  onChanged(): void
  onDeleted(): void
}) {
  const detail = useApi<CvDetail>(`/cvs/${encodeURIComponent(cvId)}`)
  const [jobId, setJobId] = useState('')
  const match = useApi<MatchResponse>(jobId ? `/cvs/${encodeURIComponent(cvId)}/match/${encodeURIComponent(jobId)}` : null)

  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)
  const [wide, setWide] = useState(false)

  // The text box only gets a bounded height beside the list; stacked on a
  // narrow screen it would become a scroll box inside the page's scroll.
  useEffect(() => {
    const update = () => setWide(window.innerWidth >= 1200)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  if (detail.loading) {
    return (
      <Card title="CV">
        <Loading rows={4} label="Loading CV" />
      </Card>
    )
  }
  if (detail.error) {
    return (
      <Card title="CV">
        <ErrorState error={detail.error} />
      </Card>
    )
  }
  if (!detail.data) return null

  const { document, candidate } = detail.data
  const text = document.extractedText
  const missingText = !hasText(document) || !text

  async function savePastedText() {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await api(`/cvs/${encodeURIComponent(document.id)}/text`, { method: 'PUT', body: { text: pasted } })
      setPasted('')
      setDone('Text saved. The CV can now be matched against a job.')
      detail.reload()
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${document.filename}? The file is removed for good.`)) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await api(`/cvs/${encodeURIComponent(document.id)}`, { method: 'DELETE' })
      onDeleted()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <Card title={document.filename} actions={<TextBadge cv={document} />}>
      <SubmitError error={error} />
      {done ? <Notice tone="ok">{done}</Notice> : null}

      <div className="actions">
        <a href={`${API_BASE}/cvs/${encodeURIComponent(document.id)}/download`} target="_blank" rel="noreferrer">
          Download original
        </a>
        {mayManage ? (
          <button type="button" className="danger small" disabled={busy} onClick={remove} style={{ marginLeft: 'auto' }}>
            Delete
          </button>
        ) : null}
      </div>

      <p className="small-text muted">
        {candidate ? `${candidate.name} · ${candidate.email} · ` : ''}
        {sourceLabel(document.source)} · {formatDateTime(document.uploadedAt)}
      </p>

      {document.injectionFlagged ? (
        <Notice tone="warn">
          This file contains text that looks like instructions to a system. Read it with care.
        </Notice>
      ) : null}

      {text ? (
        <CvText text={text} wide={wide} />
      ) : (
        <Empty
          title="No text could be read from this file"
          hint="Download the original to read it. A scanned PDF has no text to pick up."
        />
      )}

      {missingText && mayManage ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void savePastedText()
          }}
        >
          <Field
            id="cv-paste"
            label="This CV could not be read automatically — paste its text"
            hint="At least 20 characters. Once saved, the CV can be matched against a job."
          >
            <textarea
              id="cv-paste"
              rows={6}
              value={pasted}
              placeholder="Paste the CV text here"
              onChange={(e) => {
                setDone(null)
                setPasted(e.target.value)
              }}
            />
          </Field>
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy || pasted.trim().length < 20}>
              {busy ? 'Saving…' : 'Save text'}
            </button>
          </div>
        </form>
      ) : null}

      <details className="more" open>
        <summary>Match against a job</summary>
        <Field id="cv-job" label="Job">
          <select id="cv-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">Choose a job</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
        </Field>
        {!jobId ? null : match.loading ? (
          <Loading rows={3} label="Matching" />
        ) : match.error ? (
          <ErrorState error={match.error} />
        ) : match.data ? (
          <MatchReport data={match.data} />
        ) : null}
      </details>
    </Card>
  )
}

/** The CV text as a text node. Long text is folded behind a disclosure so the page stays scrollable on a phone. */
function CvText({ text, wide }: { text: string; wide: boolean }) {
  if (wide) {
    return (
      <pre className="plain small-text" style={{ maxHeight: 420, overflowY: 'auto' }}>
        {text}
      </pre>
    )
  }
  if (text.length <= PREVIEW_CHARS) {
    return <pre className="plain small-text">{text}</pre>
  }
  return (
    <>
      <pre className="plain small-text">{text.slice(0, PREVIEW_CHARS)}…</pre>
      <details className="more">
        <summary>Show full text</summary>
        <pre className="plain small-text">{text}</pre>
      </details>
    </>
  )
}

function MatchReport({ data }: { data: MatchResponse }) {
  const { report } = data
  const { score } = report
  const years = report.facts.yearsOfExperience

  return (
    <div>
      <p>
        <strong>
          Meets {score.mandatoryMet} of {score.mandatoryTotal} must-haves, {score.optionalMet} of{' '}
          {score.optionalTotal} nice-to-haves.
        </strong>
        {years !== null ? ` The CV states ${years} years of experience.` : ''}
        {report.meetsExperienceMinimum === false ? ' That is below the minimum the job asks for.' : ''}
      </p>
      <p className="small-text muted">
        {report.caveats[0] ??
          'This is a word match over the CV text, not a judgement of the person — read the evidence.'}
      </p>

      {report.requirements.length === 0 ? (
        <Empty title="This job has no requirements yet" hint="Add requirements to the job to match against." />
      ) : (
        <div className="rows">
          {report.requirements.map((requirement) => (
            <div className="row-card" key={requirement.requirementId}>
              <div className="row-head">
                <strong>{requirement.description}</strong>
                <span className="actions">
                  <Badge
                    value={requirement.mandatory ? 'Must have' : 'Nice to have'}
                    tone={requirement.mandatory ? 'info' : 'muted'}
                  />
                  <Badge
                    value={requirement.matched ? 'Found' : 'Not found'}
                    tone={requirement.matched ? 'ok' : 'danger'}
                  />
                </span>
              </div>
              {requirement.evidence.length > 0 ? (
                requirement.evidence.map((line, i) => (
                  <p key={i} className="small-text muted">
                    {line}
                  </p>
                ))
              ) : requirement.missingTerms.length > 0 ? (
                <p className="small-text muted">Not found: {requirement.missingTerms.join(', ')}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
