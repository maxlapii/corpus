'use client'

/**
 * CVs — store, preview and match against a job (CLAUDE.md §21, §33, §38).
 *
 * Two things this page is careful about:
 *
 * 1. The CV text is untrusted. It is rendered inside a `<pre>` as a text node,
 *    never as markup and never as an instruction to anything.
 * 2. The match report is advisory. It shows the sentence behind every match so
 *    a person can disagree with it, and nothing here changes an application's
 *    stage — that stays a human decision on the recruitment page.
 */

import { useCallback, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, ErrorState, Loading, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import {
  API_BASE,
  ApiRequestError,
  CSRF_HEADER,
  api,
  can,
  getCsrfToken,
  type ApiError,
  type Page,
} from '@/lib/api'
import { useApi } from '@/lib/use-api'

type ExtractionStatus = 'OK' | 'EMPTY' | 'UNSUPPORTED' | 'FAILED'

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
  source: 'TELEGRAM_EXTERNAL' | 'DASHBOARD'
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

const EXTRACTION_LABEL: Record<ExtractionStatus, string> = {
  OK: 'Text read',
  EMPTY: 'No text layer',
  UNSUPPORTED: 'Format not readable',
  FAILED: 'Could not be read',
}

const cvTextStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 420,
  overflowY: 'auto',
  background: 'var(--surface-alt)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '12px 14px',
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
}

const evidenceStyle: CSSProperties = {
  borderLeft: '3px solid var(--border)',
  paddingLeft: 10,
  margin: '6px 0 0',
  fontSize: 13,
  color: 'var(--muted)',
}

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** Multipart upload: the shared api() helper only speaks JSON. */
async function uploadCv(candidateId: string, file: File): Promise<{ document: CvListItem }> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('candidateId', candidateId)

  const headers: Record<string, string> = {}
  const token = getCsrfToken()
  if (token) headers[CSRF_HEADER] = token

  const response = await fetch(`${API_BASE}/cvs`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: form,
  })
  const text = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const error = (payload.error as ApiError | undefined) ?? {
      code: 'UNKNOWN',
      message: 'The upload failed.',
    }
    throw new ApiRequestError(response.status, error)
  }
  return payload as unknown as { document: CvListItem }
}

export default function CvsPage() {
  const { user } = useSession()
  const mayRead = can(user, 'candidate.document.read')
  const mayManage = can(user, 'candidate.document.manage')

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [jobId, setJobId] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)

  const listPath = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    })
    if (search.trim()) params.set('q', search.trim())
    return `/cvs?${params.toString()}`
  }, [search, page])

  const cvs = useApi<Page<CvListItem>>(mayRead ? listPath : null)
  const detail = useApi<CvDetail>(mayRead && selectedId ? `/cvs/${selectedId}` : null)
  const jobs = useApi<Page<JobListItem>>(mayRead ? '/jobs?limit=100&offset=0' : null)
  const match = useApi<MatchResponse>(
    mayRead && selectedId && jobId ? `/cvs/${selectedId}/match/${jobId}` : null,
  )

  const reload = useCallback(() => {
    cvs.reload()
    detail.reload()
  }, [cvs, detail])

  if (!mayRead) {
    return (
      <Shell>
        <PageHeader title="CVs" description="Candidate CVs and job matching." />
        <Card>
          <Empty
            title="You do not have access to candidate CVs"
            hint="This area needs the candidate.document.read permission. Ask an HR administrator."
          />
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <PageHeader
        title="CVs"
        description="CVs candidates sent through the recruitment bot, or that HR uploaded here."
      />

      {notice ? (
        <div className="notice ok" role="status" style={{ marginBottom: 14 }}>
          {notice}
        </div>
      ) : null}
      {actionError ? (
        actionError instanceof ApiRequestError && actionError.isForbidden ? (
          <ErrorState error={actionError} />
        ) : (
          <div className="notice error" role="alert" style={{ marginBottom: 14 }}>
            {messageOf(actionError)}
          </div>
        )
      ) : null}

      <Card title="Received CVs">
        <form
          className="toolbar"
          aria-label="Search CVs"
          onSubmit={(e) => {
            e.preventDefault()
            setPage(0)
            cvs.reload()
          }}
        >
          <label htmlFor="cv-search" className="visually-hidden">
            Search
          </label>
          <input
            id="cv-search"
            value={search}
            placeholder="Candidate name, e-mail or filename"
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>

        {cvs.loading ? (
          <Loading rows={4} label="Loading CVs" />
        ) : cvs.error ? (
          <ErrorState error={cvs.error} />
        ) : !cvs.data || cvs.data.items.length === 0 ? (
          <Empty
            title="No CVs yet"
            hint="A candidate can send one to the recruitment bot after applying, or you can upload one below."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>File</th>
                    <th>Size</th>
                    <th>Text</th>
                    <th>Source</th>
                    <th>Received</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cvs.data.items.map((cv) => (
                    <tr key={cv.id}>
                      <td>
                        <div>{cv.candidateName}</div>
                        <div className="hint">{cv.candidateEmail}</div>
                      </td>
                      <td>{cv.filename}</td>
                      <td>{formatBytes(cv.byteSize)}</td>
                      <td>
                        <Badge value={EXTRACTION_LABEL[cv.extractionStatus]} />
                        {cv.injectionFlagged ? <Badge value="FLAGGED" /> : null}
                      </td>
                      <td>
                        <Badge value={cv.source === 'TELEGRAM_EXTERNAL' ? 'BOT' : 'UPLOAD'} />
                      </td>
                      <td>{formatDateTime(cv.uploadedAt)}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(cv.id)
                            setNotice(null)
                            setActionError(null)
                          }}
                        >
                          Open
                        </button>
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
                {cvs.data.total} CV(s) — page {page + 1}
              </span>
              <button
                type="button"
                disabled={(page + 1) * PAGE_SIZE >= cvs.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </Card>

      {mayManage ? (
        <UploadCard
          onUploaded={(name) => {
            setNotice(`Uploaded ${name}.`)
            setActionError(null)
            reload()
          }}
          onError={setActionError}
        />
      ) : null}

      {selectedId ? (
        <>
          <PreviewCard
            state={detail}
            mayManage={mayManage}
            onChanged={(message) => {
              setNotice(message)
              setActionError(null)
              reload()
            }}
            onError={setActionError}
            onDeleted={() => {
              setSelectedId(null)
              setJobId('')
              setNotice('CV deleted.')
              reload()
            }}
          />

          <Card title="Match against a job">
            <p className="hint" style={{ marginTop: 0 }}>
              A keyword match over the CV text — advisory only, and it changes nothing about the
              application.
            </p>
            <div className="field">
              <label htmlFor="cv-job">Job</label>
              <select id="cv-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">Choose a job…</option>
                {(jobs.data?.items ?? []).map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.jobCode} — {job.title}
                  </option>
                ))}
              </select>
            </div>

            {!jobId ? null : match.loading ? (
              <Loading rows={3} label="Matching" />
            ) : match.error ? (
              <ErrorState error={match.error} />
            ) : match.data ? (
              <MatchReport data={match.data} />
            ) : null}
          </Card>
        </>
      ) : null}
    </Shell>
  )
}

function UploadCard({
  onUploaded,
  onError,
}: {
  onUploaded(filename: string): void
  onError(error: unknown): void
}) {
  const [candidateId, setCandidateId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!file || !candidateId.trim()) return
    setBusy(true)
    try {
      const result = await uploadCv(candidateId.trim(), file)
      onUploaded(result.document.filename)
      setFile(null)
      setCandidateId('')
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Upload a CV">
      <form onSubmit={submit} aria-label="Upload a CV">
        <div className="form-row">
          <div className="field">
            <label htmlFor="cv-candidate">Candidate id</label>
            <input
              id="cv-candidate"
              value={candidateId}
              placeholder="cnd_…"
              onChange={(e) => setCandidateId(e.target.value)}
            />
            <div className="hint">From the candidate record on the Recruitment page.</div>
          </div>
          <div className="field">
            <label htmlFor="cv-file">File</label>
            <input
              id="cv-file"
              type="file"
              accept=".pdf,.docx,.txt,.md"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div className="hint">PDF, DOCX, TXT or Markdown, up to 5 MB.</div>
          </div>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button type="submit" className="primary" disabled={busy || !file || !candidateId.trim()}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </Card>
  )
}

function PreviewCard({
  state,
  mayManage,
  onChanged,
  onError,
  onDeleted,
}: {
  state: ReturnType<typeof useApi<CvDetail>>
  mayManage: boolean
  onChanged(message: string): void
  onError(error: unknown): void
  onDeleted(): void
}) {
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)

  if (state.loading) {
    return (
      <Card title="CV">
        <Loading rows={4} label="Loading CV" />
      </Card>
    )
  }
  if (state.error) {
    return (
      <Card title="CV">
        <ErrorState error={state.error} />
      </Card>
    )
  }
  if (!state.data) return null

  const { document, candidate } = state.data
  const needsText = document.extractionStatus !== 'OK' || !document.extractedText

  async function savePastedText() {
    setBusy(true)
    try {
      await api(`/cvs/${document.id}/text`, { method: 'PUT', body: { text: pasted } })
      setPasted('')
      onChanged('CV text saved.')
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api(`/cvs/${document.id}`, { method: 'DELETE' })
      onDeleted()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={document.filename}>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <Badge value={EXTRACTION_LABEL[document.extractionStatus]} />
        <Badge value={document.source === 'TELEGRAM_EXTERNAL' ? 'FROM BOT' : 'UPLOADED'} />
        <span className="hint">
          {candidate ? `${candidate.name} · ${candidate.email} · ` : ''}
          {formatBytes(document.byteSize)} · {formatDateTime(document.uploadedAt)}
        </span>
        <a
          href={`${API_BASE}/cvs/${document.id}/download`}
          rel="noreferrer"
          className="hint"
          style={{ marginLeft: 'auto' }}
        >
          Download original
        </a>
        {mayManage ? (
          <button type="button" disabled={busy} onClick={remove}>
            Delete
          </button>
        ) : null}
      </div>

      {document.injectionFlagged ? (
        <div className="notice warn" style={{ fontSize: 13 }}>
          This CV contains instruction-like text. It is stored and shown as plain data and is never
          given to the assistant as an instruction — but read it with that in mind.
        </div>
      ) : null}

      {document.extractionWarnings.length > 0 ? (
        <div className="notice info" style={{ fontSize: 13 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {document.extractionWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {document.extractedText ? (
        <pre style={cvTextStyle}>{document.extractedText}</pre>
      ) : (
        <Empty
          title="No text could be read from this file"
          hint="Download the original to read it. A scanned PDF has no text layer to extract."
        />
      )}

      {needsText && mayManage ? (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="cv-paste">Paste the text by hand</label>
          <textarea
            id="cv-paste"
            rows={5}
            value={pasted}
            placeholder="Paste the CV text here so it can be matched against a job."
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <button type="button" disabled={busy || pasted.trim().length < 20} onClick={savePastedText}>
              Save text
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}

function MatchReport({ data }: { data: MatchResponse }) {
  const { report } = data
  const mandatoryGap = report.score.mandatoryTotal - report.score.mandatoryMet

  return (
    <div style={{ marginTop: 12 }}>
      <div className="notice info" style={{ fontSize: 13 }}>
        {data.advisory}
      </div>

      <div className="toolbar">
        <Badge value={`${report.score.percent}% of weighted requirements`} />
        <Badge
          value={`Must-have ${report.score.mandatoryMet}/${report.score.mandatoryTotal}`}
        />
        <Badge value={`Nice-to-have ${report.score.optionalMet}/${report.score.optionalTotal}`} />
        {report.facts.yearsOfExperience !== null ? (
          <Badge value={`${report.facts.yearsOfExperience} years stated`} />
        ) : null}
        {report.meetsExperienceMinimum === false ? <Badge value="Below stated minimum" /> : null}
      </div>

      {report.caveats.length > 0 ? (
        <div className="notice warn" style={{ fontSize: 13 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {report.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {mandatoryGap > 0 ? (
        <p className="hint">
          {mandatoryGap} must-have requirement(s) were not found in the CV text. That is a prompt to
          read it, not a verdict — wording varies, and the matcher only sees words.
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Type</th>
              <th>Need</th>
              <th>Found</th>
              <th>Evidence from the CV</th>
            </tr>
          </thead>
          <tbody>
            {report.requirements.map((requirement) => (
              <tr key={requirement.requirementId}>
                <td>{requirement.description}</td>
                <td>
                  <Badge value={requirement.requirementType} />
                </td>
                <td>
                  <Badge value={requirement.mandatory ? 'MUST' : 'NICE'} />
                </td>
                <td>
                  <Badge value={requirement.matched ? 'YES' : 'NO'} />
                </td>
                <td>
                  {requirement.evidence.length > 0 ? (
                    requirement.evidence.map((line, i) => (
                      <p key={i} style={evidenceStyle}>
                        {line}
                      </p>
                    ))
                  ) : (
                    <span className="hint">
                      {requirement.missingTerms.length > 0
                        ? `Not found: ${requirement.missingTerms.join(', ')}`
                        : '—'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card title="Details read from the CV">
        <p className="hint" style={{ marginTop: 0 }}>
          Extracted literally from the text. Nothing is inferred about the person.
        </p>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px' }}>
          <dt className="hint">Years stated</dt>
          <dd style={{ margin: 0 }}>{report.facts.yearsOfExperience ?? '—'}</dd>
          <dt className="hint">E-mail</dt>
          <dd style={{ margin: 0 }}>{report.facts.emails.join(', ') || '—'}</dd>
          <dt className="hint">Phone</dt>
          <dd style={{ margin: 0 }}>{report.facts.phones.join(', ') || '—'}</dd>
          <dt className="hint">Links</dt>
          <dd style={{ margin: 0 }}>{report.facts.links.join(', ') || '—'}</dd>
          <dt className="hint">Education signals</dt>
          <dd style={{ margin: 0 }}>{report.facts.education.join(', ') || '—'}</dd>
        </dl>
      </Card>
    </div>
  )
}
