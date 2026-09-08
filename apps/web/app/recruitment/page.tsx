'use client'

/**
 * Recruitment — jobs, applications and candidates (CLAUDE.md §21, §33, §35).
 *
 * Follows the dashboard pattern: Shell + PageHeader, data via useApi(), and
 * explicit loading / error / empty states for every region.
 *
 * Permission checks in this file only decide which controls are rendered. The
 * API re-authorises every request through the PolicyGateway, and a 403 is shown
 * as the server's own message — the client never assumes an action succeeded.
 */

import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, ErrorState, Loading, formatDate, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import { ApiRequestError, api, can, type CurrentUser, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

const PAGE_SIZE = 25

// --- Types: mirrors of what the API actually returns ------------------------

const JOB_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] as const
type JobStatus = (typeof JOB_STATUSES)[number]

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] as const
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

const REQUIREMENT_TYPES = ['SKILL', 'EDUCATION', 'EXPERIENCE', 'CERTIFICATION', 'LANGUAGE', 'OTHER'] as const
type RequirementType = (typeof REQUIREMENT_TYPES)[number]

const STAGES = [
  'APPLIED',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'TECHNICAL',
  'FINAL',
  'OFFER',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
] as const
type Stage = (typeof STAGES)[number]

const INTERVIEW_MODES = ['ONSITE', 'REMOTE', 'PHONE'] as const
type InterviewMode = (typeof INTERVIEW_MODES)[number]

interface Job {
  id: string
  tenantId: string
  jobCode: string
  title: string
  departmentId: string | null
  location: string | null
  employmentType: EmploymentType
  description: string
  salaryMin: number | null
  salaryMax: number | null
  currency: string | null
  remoteAllowed: boolean
  experienceMin: number | null
  status: JobStatus
  publishedAt: string | null
  closingDate: string | null
  createdAt: string
  updatedAt: string
}

interface JobRequirement {
  id: string
  jobId: string
  requirementType: RequirementType
  description: string
  mandatory: boolean
  priority: number
}

interface JobDetailResponse {
  job: Job
  requirements: JobRequirement[]
}

interface Department {
  id: string
  code: string
  name: string
}

interface Candidate {
  id: string
  tenantId: string
  name: string
  email: string
  phone: string | null
  telegramUserId: string | null
  cvFileId: string | null
  source: string
  createdAt: string
  updatedAt: string
}

/** `ApplicationDetail` from the repository: the application joined to job and candidate. */
interface ApplicationRow {
  id: string
  tenantId: string
  candidateId: string
  jobId: string
  stage: Stage
  status: 'OPEN' | 'CLOSED'
  reference: string
  appliedAt: string
  updatedAt: string
  jobTitle: string
  jobCode: string
  candidateName: string
  candidateEmail: string
}

interface ApplicationEvent {
  id: string
  applicationId: string
  tenantId: string
  fromStage: Stage | null
  toStage: Stage
  note: string | null
  actorUserId: string | null
  createdAt: string
}

interface Interview {
  id: string
  tenantId: string
  applicationId: string
  scheduledAt: string
  durationMinutes: number
  mode: InterviewMode
  interviewerEmployeeId: string | null
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'
  evaluation: string | null
  score: number | null
  createdAt: string
}

interface Offer {
  id: string
  tenantId: string
  applicationId: string
  baseSalary: number
  currency: string
  startDate: string
  status: string
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

interface ApplicationDetailResponse {
  application: ApplicationRow
  events: ApplicationEvent[]
  interviews: Interview[]
}

interface CandidateDetailResponse {
  candidate: Candidate
  applications: ApplicationRow[]
}

/**
 * Legal stage transitions. This mirrors ALLOWED in
 * packages/domain/src/application-flow.ts so the select only offers moves the
 * backend will accept — the backend still validates every transition itself.
 */
const ALLOWED: Record<Stage, Stage[]> = {
  APPLIED: ['SCREENING', 'REJECTED', 'WITHDRAWN'],
  SCREENING: ['SHORTLISTED', 'REJECTED', 'WITHDRAWN'],
  SHORTLISTED: ['INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['TECHNICAL', 'FINAL', 'REJECTED', 'WITHDRAWN'],
  TECHNICAL: ['FINAL', 'REJECTED', 'WITHDRAWN'],
  FINAL: ['OFFER', 'REJECTED', 'WITHDRAWN'],
  OFFER: ['HIRED', 'REJECTED', 'WITHDRAWN'],
  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
}

// --- Local helpers ------------------------------------------------------------

interface Failure {
  message: string
  /** Validation issues grouped by field path, when the API supplied them. */
  issues: Record<string, string[]>
}

function describeFailure(e: unknown): Failure {
  if (e instanceof ApiRequestError) {
    const issues: Record<string, string[]> = {}
    const raw = e.error.details?.issues
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === 'object' && 'path' in item && 'message' in item) {
          const path = String((item as { path: unknown }).path) || '$'
          const message = String((item as { message: unknown }).message)
          issues[path] = [...(issues[path] ?? []), message]
        }
      }
    }
    return { message: e.error.message, issues }
  }
  return { message: e instanceof Error ? e.message : 'Something went wrong.', issues: {} }
}

/** Builds a query string, skipping empty values so the API sees only real filters. */
function qs(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function humanise(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function formatSalary(job: Pick<Job, 'salaryMin' | 'salaryMax' | 'currency'>): string {
  if (job.salaryMin === null && job.salaryMax === null) return '—'
  const min = job.salaryMin === null ? '?' : job.salaryMin.toLocaleString()
  const max = job.salaryMax === null ? '?' : job.salaryMax.toLocaleString()
  return `${min} – ${max}${job.currency ? ` ${job.currency}` : ''}`
}

/**
 * Runs one async action at a time and exposes busy / failure / status for the
 * UI. The success text is only set from the API's own response.
 */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  async function run<T>(fn: () => Promise<T>, success: string | ((result: T) => string)): Promise<T | undefined> {
    setBusy(true)
    setFailure(null)
    setStatus(null)
    try {
      const result = await fn()
      setStatus(typeof success === 'function' ? success(result) : success)
      return result
    } catch (e) {
      setFailure(describeFailure(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  function fail(message: string) {
    setStatus(null)
    setFailure({ message, issues: {} })
  }

  return { busy, failure, status, run, fail }
}

// --- Small presentational pieces ---------------------------------------------

function LinkButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        color: 'var(--accent)',
        fontWeight: 600,
        textAlign: 'left',
      }}
    >
      {children}
    </button>
  )
}

function FailureNotice({ failure }: { failure: Failure | null }) {
  if (!failure) return null
  const paths = Object.keys(failure.issues)
  return (
    <div className="notice error" role="alert">
      <strong>{failure.message}</strong>
      {paths.length > 0 ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {paths.map((path) =>
            (failure.issues[path] ?? []).map((message, i) => (
              <li key={`${path}-${i}`}>
                <span className="mono">{path}</span> {message}
              </li>
            )),
          )}
        </ul>
      ) : null}
    </div>
  )
}

function StatusLine({ text }: { text: string | null }) {
  return (
    <p role="status" aria-live="polite" style={{ margin: text ? '10px 0 0' : 0, color: 'var(--ok)', fontSize: 13 }}>
      {text}
    </p>
  )
}

function Field({
  id,
  label,
  hint,
  issues,
  children,
}: {
  id: string
  label: string
  hint?: string
  issues?: string[]
  children: ReactNode
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
      {issues?.map((message, i) => (
        <div key={i} className="hint" style={{ color: 'var(--danger)' }} role="alert">
          {message}
        </div>
      ))}
    </div>
  )
}

function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, max-content) 1fr',
        gap: '6px 14px',
        margin: 0,
        fontSize: 13,
      }}
    >
      {items.map(([term, value]) => (
        <Fragment key={term}>
          <dt style={{ color: 'var(--text-muted)' }}>{term}</dt>
          <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function Pager({ page, onOffset }: { page: Page<unknown>; onOffset(offset: number): void }) {
  const from = page.total === 0 ? 0 : page.offset + 1
  const to = Math.min(page.offset + page.items.length, page.total)
  const showNav = page.hasMore || page.offset > 0
  return (
    <div className="toolbar" style={{ marginTop: 12, marginBottom: 0, justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }} aria-live="polite">
        Showing {from}–{to} of {page.total.toLocaleString()}
      </span>
      {showNav ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={page.offset === 0}
            onClick={() => onOffset(Math.max(0, page.offset - page.limit))}
          >
            Previous
          </button>
          <button type="button" disabled={!page.hasMore} onClick={() => onOffset(page.offset + page.limit)}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  )
}

const selectedRowStyle = { background: 'var(--accent-soft)' }

// --- Page ------------------------------------------------------------------------

type Tab = 'jobs' | 'applications' | 'candidates'

const TABS: { id: Tab; label: string }[] = [
  { id: 'jobs', label: 'Jobs' },
  { id: 'applications', label: 'Applications' },
  { id: 'candidates', label: 'Candidates' },
]

/** Cross-tab navigation target, set when another tab hands off to Applications. */
interface ApplicationFocus {
  jobId?: string
  applicationId?: string
}

export default function RecruitmentPage() {
  const { user } = useSession()
  const [tab, setTab] = useState<Tab>('jobs')
  const [focus, setFocus] = useState<ApplicationFocus | null>(null)

  function openApplications(next: ApplicationFocus) {
    setFocus(next)
    setTab('applications')
  }

  return (
    <Shell>
      <PageHeader
        title="Recruitment"
        description="Jobs, applications and candidates. Controls reflect your role; every action is re-authorised by the server."
      />

      <div role="tablist" aria-label="Recruitment sections" className="toolbar">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={tab === item.id ? `panel-${item.id}` : undefined}
            className={tab === item.id ? 'primary' : undefined}
            onClick={() => {
              setFocus(null)
              setTab(item.id)
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'jobs' ? (
          <JobsTab user={user} onViewApplications={(jobId) => openApplications({ jobId })} />
        ) : null}
        {tab === 'applications' ? <ApplicationsTab user={user} focus={focus} /> : null}
        {tab === 'candidates' ? (
          <CandidatesTab user={user} onOpenApplication={(applicationId) => openApplications({ applicationId })} />
        ) : null}
      </div>
    </Shell>
  )
}

// --- Jobs ------------------------------------------------------------------------

function JobsTab({
  user,
  onViewApplications,
}: {
  user: CurrentUser | null
  onViewApplications(jobId: string): void
}) {
  const [status, setStatus] = useState<'' | JobStatus>('')
  const [pendingQuery, setPendingQuery] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)

  const canCreate = can(user, 'job.create')

  const list = useApi<Page<Job>>(`/jobs${qs({ limit: PAGE_SIZE, offset, status, query })}`)
  const detail = useApi<JobDetailResponse>(selectedId ? `/jobs/${encodeURIComponent(selectedId)}` : null)
  // Department names for display and for the New job form. Optional: on
  // failure the raw id is shown and the form falls back to a text input.
  const departments = useApi<{ departments: Department[] }>('/departments')
  const departmentName = (id: string | null): string => {
    if (!id) return '—'
    return departments.data?.departments.find((d) => d.id === id)?.name ?? id
  }

  function refresh() {
    list.reload()
    detail.reload()
  }

  return (
    <>
      <Card
        title="Jobs"
        actions={
          canCreate ? (
            <button
              type="button"
              className={showNew ? undefined : 'primary'}
              aria-expanded={showNew}
              aria-controls="new-job-form"
              onClick={() => setShowNew((v) => !v)}
            >
              {showNew ? 'Cancel' : 'New job'}
            </button>
          ) : undefined
        }
      >
        {showNew && canCreate ? (
          <NewJobForm
            departments={departments.error ? null : departments.data?.departments ?? []}
            onCreated={(job) => {
              setShowNew(false)
              setSelectedId(job.id)
              list.reload()
            }}
          />
        ) : null}

        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault()
            setQuery(pendingQuery.trim())
            setOffset(0)
          }}
        >
          <label htmlFor="jobs-query" className="visually-hidden">
            Search jobs
          </label>
          <input
            id="jobs-query"
            type="search"
            placeholder="Search title, code or description"
            maxLength={100}
            value={pendingQuery}
            onChange={(e) => setPendingQuery(e.target.value)}
          />
          <label htmlFor="jobs-status" className="visually-hidden">
            Status
          </label>
          <select
            id="jobs-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | JobStatus)
              setOffset(0)
            }}
          >
            <option value="">All statuses</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanise(s)}
              </option>
            ))}
          </select>
          <button type="submit">Search</button>
        </form>

        {list.loading ? (
          <Loading rows={5} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !list.data || list.data.items.length === 0 ? (
          <Empty
            title="No jobs found"
            hint={query || status ? 'Try clearing the search or status filter.' : 'Jobs you create will appear here.'}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Title</th>
                    <th scope="col">Location</th>
                    <th scope="col">Type</th>
                    <th scope="col">Status</th>
                    <th scope="col">Published</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((job) => (
                    <tr key={job.id} style={job.id === selectedId ? selectedRowStyle : undefined}>
                      <td className="mono">{job.jobCode}</td>
                      <td>
                        <LinkButton onClick={() => setSelectedId(job.id)}>{job.title}</LinkButton>
                      </td>
                      <td>{job.location ?? '—'}</td>
                      <td>{humanise(job.employmentType)}</td>
                      <td>
                        <Badge value={job.status} />
                      </td>
                      <td>{formatDate(job.publishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={list.data} onOffset={setOffset} />
          </>
        )}
      </Card>

      {selectedId ? (
        <div style={{ marginTop: 14 }}>
          {detail.loading ? (
            <Card title="Job details">
              <Loading rows={6} />
            </Card>
          ) : detail.error ? (
            <Card title="Job details" actions={<button type="button" onClick={() => setSelectedId(null)}>Close</button>}>
              <ErrorState error={detail.error} />
            </Card>
          ) : detail.data ? (
            <JobDetail
              data={detail.data}
              user={user}
              departmentName={departmentName}
              onChanged={refresh}
              onViewApplications={onViewApplications}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function JobDetail({
  data,
  user,
  departmentName,
  onChanged,
  onViewApplications,
  onClose,
}: {
  data: JobDetailResponse
  user: CurrentUser | null
  departmentName(id: string | null): string
  onChanged(): void
  onViewApplications(jobId: string): void
  onClose(): void
}) {
  const { job, requirements } = data
  const canUpdate = can(user, 'job.update')
  const canDelete = can(user, 'job.delete')
  const canSeeApplications = can(user, 'application.read')
  const action = useAction()
  const jobPath = `/jobs/${encodeURIComponent(job.id)}`

  async function changeStatus(next: JobStatus, prompt: string) {
    if (!window.confirm(prompt)) return
    const result = await action.run(
      () => api<{ job: Job }>(jobPath, { method: 'PUT', body: { status: next } }),
      (r) => `Job ${r.job.jobCode} is now ${humanise(r.job.status)}.`,
    )
    if (result) onChanged()
  }

  async function archive() {
    if (
      !window.confirm(
        `Archive ${job.jobCode}? It is removed from every listing but kept for the audit trail. This cannot be undone here.`,
      )
    )
      return
    const result = await action.run(
      () => api<{ job: Job }>(jobPath, { method: 'DELETE' }),
      (r) => `Job ${r.job.jobCode} archived.`,
    )
    if (result) onChanged()
  }

  async function setSalaryPublic(value: boolean) {
    const prompt = value
      ? `Show the salary range for ${job.jobCode} on the public job listing?`
      : `Hide the salary range for ${job.jobCode} from the public job listing?`
    if (!window.confirm(prompt)) return
    const result = await action.run(
      () => api<{ job: Job }>(jobPath, { method: 'PUT', body: { salaryPublic: value } }),
      value ? 'Salary range is now shown on the public listing.' : 'Salary range is now internal only.',
    )
    if (result) onChanged()
  }

  const hasSalary = job.salaryMin !== null || job.salaryMax !== null

  return (
    <div className="grid two">
      <Card
        title={job.title}
        actions={
          <button type="button" onClick={onClose}>
            Close details
          </button>
        }
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <Badge value={job.status} />
          <span className="mono">{job.jobCode}</span>
        </div>
        <DefinitionList
          items={[
            ['Employment type', humanise(job.employmentType)],
            ['Department', departmentName(job.departmentId)],
            ['Location', job.location ?? '—'],
            ['Remote', job.remoteAllowed ? 'Allowed' : 'Not allowed'],
            ['Minimum experience', job.experienceMin === null ? '—' : `${job.experienceMin} years`],
            [
              'Salary range',
              <>
                {formatSalary(job)} <Badge value="INTERNAL" />
              </>,
            ],
            ['Closing date', formatDate(job.closingDate)],
            ['Published', formatDateTime(job.publishedAt)],
            ['Created', formatDateTime(job.createdAt)],
            ['Updated', formatDateTime(job.updatedAt)],
          ]}
        />
        <h3 style={{ marginTop: 14 }}>Description</h3>
        <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', overflowWrap: 'anywhere' }}>{job.description}</p>
        {canSeeApplications ? (
          <button type="button" style={{ marginTop: 14 }} onClick={() => onViewApplications(job.id)}>
            View applications for this job
          </button>
        ) : null}
      </Card>

      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        <Card title="Requirements">
          {requirements.length === 0 ? (
            <Empty title="No requirements yet" hint={canUpdate ? 'Add the first requirement below.' : undefined} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">Description</th>
                    <th scope="col">Mandatory</th>
                    <th scope="col">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {requirements.map((r) => (
                    <tr key={r.id}>
                      <td>{humanise(r.requirementType)}</td>
                      <td>{r.description}</td>
                      <td>{r.mandatory ? 'Yes' : 'No'}</td>
                      <td className="num">{r.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canUpdate ? <AddRequirementForm jobId={job.id} onAdded={onChanged} /> : null}
        </Card>

        <Card title="Actions">
          {!canUpdate && !canDelete ? (
            <Empty title="No actions available to your role" />
          ) : (
            <>
              <FailureNotice failure={action.failure} />
              <div className="toolbar" style={{ marginBottom: 0 }}>
                {canUpdate && (job.status === 'DRAFT' || job.status === 'CLOSED') ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={action.busy}
                    onClick={() =>
                      void changeStatus(
                        'PUBLISHED',
                        `Publish ${job.jobCode}? It becomes visible to the public and opens for applications.`,
                      )
                    }
                  >
                    Publish
                  </button>
                ) : null}
                {canUpdate && job.status === 'PUBLISHED' ? (
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() =>
                      void changeStatus('CLOSED', `Close ${job.jobCode}? It will stop accepting applications.`)
                    }
                  >
                    Close job
                  </button>
                ) : null}
                {canDelete && job.status !== 'ARCHIVED' ? (
                  <button type="button" disabled={action.busy} onClick={() => void archive()}>
                    Archive
                  </button>
                ) : null}
                {job.status === 'ARCHIVED' ? (
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>This job is archived.</span>
                ) : null}
              </div>

              {canUpdate ? (
                <div style={{ marginTop: 14 }}>
                  <h3>Salary range visibility</h3>
                  <p className="hint" style={{ color: 'var(--text-faint)', fontSize: 12, margin: '4px 0 8px' }}>
                    Controls whether the public listing shows the salary range. The current setting is not
                    reported by the API, so choose the visibility to apply.
                  </p>
                  <div className="toolbar" style={{ marginBottom: 0 }}>
                    <button
                      type="button"
                      disabled={action.busy || !hasSalary}
                      title={hasSalary ? undefined : 'No salary range is set on this job.'}
                      onClick={() => void setSalaryPublic(true)}
                    >
                      Show publicly
                    </button>
                    <button type="button" disabled={action.busy} onClick={() => void setSalaryPublic(false)}>
                      Internal only
                    </button>
                  </div>
                </div>
              ) : null}
              <StatusLine text={action.status} />
            </>
          )}
        </Card>
      </div>
    </div>
  )
}

const EMPTY_REQUIREMENT = {
  requirementType: 'SKILL' as RequirementType,
  description: '',
  mandatory: true,
  priority: '100',
}

function AddRequirementForm({ jobId, onAdded }: { jobId: string; onAdded(): void }) {
  const [form, setForm] = useState(EMPTY_REQUIREMENT)
  const action = useAction()

  async function submit(event: FormEvent) {
    event.preventDefault()
    const body: Record<string, unknown> = {
      requirementType: form.requirementType,
      description: form.description.trim(),
      mandatory: form.mandatory,
    }
    if (form.priority.trim() !== '') body.priority = Number(form.priority)

    const result = await action.run(
      () =>
        api<{ requirement: JobRequirement }>(`/jobs/${encodeURIComponent(jobId)}/requirements`, {
          method: 'POST',
          body,
        }),
      (r) => `Requirement "${r.requirement.description}" added.`,
    )
    if (result) {
      setForm(EMPTY_REQUIREMENT)
      onAdded()
    }
  }

  const issues = action.failure?.issues ?? {}

  return (
    <form onSubmit={submit} aria-labelledby="add-requirement-title" style={{ marginTop: 14 }}>
      <h3 id="add-requirement-title" style={{ marginBottom: 8 }}>
        Add requirement
      </h3>
      <FailureNotice failure={action.failure} />
      <div className="form-row">
        <Field id="req-type" label="Type" issues={issues.requirementType}>
          <select
            id="req-type"
            value={form.requirementType}
            onChange={(e) => setForm({ ...form, requirementType: e.target.value as RequirementType })}
          >
            {REQUIREMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanise(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="req-priority" label="Priority" hint="1 is highest; default 100." issues={issues.priority}>
          <input
            id="req-priority"
            type="number"
            min={1}
            max={999}
            step={1}
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value })}
          />
        </Field>
      </div>
      <Field id="req-description" label="Description" issues={issues.description}>
        <input
          id="req-description"
          type="text"
          required
          minLength={2}
          maxLength={500}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={form.mandatory}
            onChange={(e) => setForm({ ...form, mandatory: e.target.checked })}
          />
          Mandatory requirement
        </label>
      </div>
      <button type="submit" className="primary" disabled={action.busy}>
        {action.busy ? 'Adding…' : 'Add requirement'}
      </button>
      <StatusLine text={action.status} />
    </form>
  )
}

interface NewJobFormState {
  jobCode: string
  title: string
  departmentId: string
  location: string
  employmentType: EmploymentType
  description: string
  salaryMin: string
  salaryMax: string
  currency: string
  remoteAllowed: boolean
  experienceMin: string
  salaryPublic: boolean
  closingDate: string
  status: 'DRAFT' | 'PUBLISHED'
}

const EMPTY_JOB: NewJobFormState = {
  jobCode: '',
  title: '',
  departmentId: '',
  location: '',
  employmentType: 'FULL_TIME',
  description: '',
  salaryMin: '',
  salaryMax: '',
  currency: '',
  remoteAllowed: false,
  experienceMin: '',
  salaryPublic: false,
  closingDate: '',
  status: 'DRAFT',
}

function NewJobForm({
  departments,
  onCreated,
}: {
  /** null when the department list could not be loaded — a text input is shown instead. */
  departments: Department[] | null
  onCreated(job: Job): void
}) {
  const [form, setForm] = useState<NewJobFormState>(EMPTY_JOB)
  const action = useAction()

  function set<K extends keyof NewJobFormState>(key: K, value: NewJobFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (form.status === 'PUBLISHED' && !window.confirm('Create this job as PUBLISHED? It becomes publicly visible immediately.')) {
      return
    }

    const body: Record<string, unknown> = {
      jobCode: form.jobCode.trim().toUpperCase(),
      title: form.title.trim(),
      employmentType: form.employmentType,
      description: form.description.trim(),
      remoteAllowed: form.remoteAllowed,
      salaryPublic: form.salaryPublic,
      status: form.status,
    }
    if (form.departmentId.trim()) body.departmentId = form.departmentId.trim()
    if (form.location.trim()) body.location = form.location.trim()
    if (form.salaryMin.trim()) body.salaryMin = Number(form.salaryMin)
    if (form.salaryMax.trim()) body.salaryMax = Number(form.salaryMax)
    if (form.currency.trim()) body.currency = form.currency.trim().toUpperCase()
    if (form.experienceMin.trim()) body.experienceMin = Number(form.experienceMin)
    if (form.closingDate) body.closingDate = form.closingDate

    const result = await action.run(
      () => api<{ job: Job }>('/jobs', { method: 'POST', body }),
      (r) => `Job ${r.job.jobCode} created as ${humanise(r.job.status)}.`,
    )
    if (result) {
      setForm(EMPTY_JOB)
      onCreated(result.job)
    }
  }

  const issues = action.failure?.issues ?? {}

  return (
    <form
      id="new-job-form"
      onSubmit={submit}
      aria-labelledby="new-job-title"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 14,
        marginBottom: 16,
        background: 'var(--surface-alt)',
      }}
    >
      <h3 id="new-job-title" style={{ marginBottom: 10 }}>
        New job
      </h3>
      <FailureNotice failure={action.failure} />
      <div className="form-row">
        <Field id="job-code" label="Job code" hint="2–40 characters; stored upper-case." issues={issues.jobCode}>
          <input
            id="job-code"
            type="text"
            required
            minLength={2}
            maxLength={40}
            value={form.jobCode}
            onChange={(e) => set('jobCode', e.target.value)}
          />
        </Field>
        <Field id="job-title" label="Title" issues={issues.title}>
          <input
            id="job-title"
            type="text"
            required
            minLength={3}
            maxLength={150}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
        <Field id="job-employment-type" label="Employment type" issues={issues.employmentType}>
          <select
            id="job-employment-type"
            value={form.employmentType}
            onChange={(e) => set('employmentType', e.target.value as EmploymentType)}
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanise(t)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field
          id="job-department"
          label="Department"
          hint={departments === null ? 'Department list unavailable; enter a department id or leave blank.' : undefined}
          issues={issues.departmentId}
        >
          {departments === null ? (
            <input
              id="job-department"
              type="text"
              maxLength={40}
              value={form.departmentId}
              onChange={(e) => set('departmentId', e.target.value)}
            />
          ) : (
            <select id="job-department" value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
              <option value="">— None —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="job-location" label="Location" issues={issues.location}>
          <input
            id="job-location"
            type="text"
            maxLength={120}
            value={form.location}
            onChange={(e) => set('location', e.target.value)}
          />
        </Field>
        <Field id="job-closing" label="Closing date" issues={issues.closingDate}>
          <input
            id="job-closing"
            type="date"
            value={form.closingDate}
            onChange={(e) => set('closingDate', e.target.value)}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field id="job-salary-min" label="Salary minimum" issues={issues.salaryMin}>
          <input
            id="job-salary-min"
            type="number"
            min={0}
            step="any"
            value={form.salaryMin}
            onChange={(e) => set('salaryMin', e.target.value)}
          />
        </Field>
        <Field id="job-salary-max" label="Salary maximum" issues={issues.salaryMax}>
          <input
            id="job-salary-max"
            type="number"
            min={0}
            step="any"
            value={form.salaryMax}
            onChange={(e) => set('salaryMax', e.target.value)}
          />
        </Field>
        <Field id="job-currency" label="Currency" hint="3-letter code, e.g. USD." issues={issues.currency}>
          <input
            id="job-currency"
            type="text"
            minLength={3}
            maxLength={3}
            autoCapitalize="characters"
            value={form.currency}
            onChange={(e) => set('currency', e.target.value)}
          />
        </Field>
        <Field id="job-experience" label="Minimum experience (years)" issues={issues.experienceMin}>
          <input
            id="job-experience"
            type="number"
            min={0}
            max={60}
            step={1}
            value={form.experienceMin}
            onChange={(e) => set('experienceMin', e.target.value)}
          />
        </Field>
      </div>
      <Field id="job-description" label="Description" hint="At least 10 characters." issues={issues.description}>
        <textarea
          id="job-description"
          required
          minLength={10}
          maxLength={20_000}
          rows={6}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>
      <div className="form-row" style={{ alignItems: 'end' }}>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.remoteAllowed}
              onChange={(e) => set('remoteAllowed', e.target.checked)}
            />
            Remote work allowed
          </label>
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.salaryPublic}
              onChange={(e) => set('salaryPublic', e.target.checked)}
            />
            Show salary range publicly
          </label>
        </div>
        <Field id="job-status" label="Initial status" issues={issues.status}>
          <select
            id="job-status"
            value={form.status}
            onChange={(e) => set('status', e.target.value as 'DRAFT' | 'PUBLISHED')}
          >
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
          </select>
        </Field>
      </div>
      <button type="submit" className="primary" disabled={action.busy}>
        {action.busy ? 'Creating…' : 'Create job'}
      </button>
      <StatusLine text={action.status} />
    </form>
  )
}

// --- Applications ------------------------------------------------------------------

function ApplicationsTab({ user, focus }: { user: CurrentUser | null; focus: ApplicationFocus | null }) {
  const [jobId, setJobId] = useState(focus?.jobId ?? '')
  const [stage, setStage] = useState<'' | Stage>('')
  const [status, setStatus] = useState<'' | 'OPEN' | 'CLOSED'>('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(focus?.applicationId ?? null)

  // Apply a hand-off from another tab if it changes while mounted.
  useEffect(() => {
    if (!focus) return
    if (focus.jobId !== undefined) {
      setJobId(focus.jobId)
      setOffset(0)
    }
    if (focus.applicationId !== undefined) setSelectedId(focus.applicationId)
  }, [focus])

  // Jobs for the filter select. Optional: on failure a plain job id input is shown.
  const jobs = useApi<Page<Job>>(`/jobs${qs({ limit: 100 })}`)
  const list = useApi<Page<ApplicationRow>>(
    `/applications${qs({ limit: PAGE_SIZE, offset, jobId, stage, status })}`,
  )
  const detail = useApi<ApplicationDetailResponse>(
    selectedId ? `/applications/${encodeURIComponent(selectedId)}` : null,
  )

  function refresh() {
    list.reload()
    detail.reload()
  }

  return (
    <>
      <Card title="Applications">
        <div className="toolbar">
          <label htmlFor="apps-job" className="visually-hidden">
            Job
          </label>
          {jobs.error ? (
            <input
              id="apps-job"
              type="text"
              placeholder="Job id"
              maxLength={40}
              value={jobId}
              onChange={(e) => {
                setJobId(e.target.value)
                setOffset(0)
              }}
            />
          ) : (
            <select
              id="apps-job"
              value={jobId}
              onChange={(e) => {
                setJobId(e.target.value)
                setOffset(0)
              }}
            >
              <option value="">All jobs</option>
              {(jobs.data?.items ?? []).map((job) => (
                <option key={job.id} value={job.id}>
                  {job.jobCode} — {job.title}
                </option>
              ))}
              {jobId && jobs.data && !jobs.data.items.some((j) => j.id === jobId) ? (
                <option value={jobId}>Selected job ({jobId})</option>
              ) : null}
            </select>
          )}
          <label htmlFor="apps-stage" className="visually-hidden">
            Stage
          </label>
          <select
            id="apps-stage"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value as '' | Stage)
              setOffset(0)
            }}
          >
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {humanise(s)}
              </option>
            ))}
          </select>
          <label htmlFor="apps-status" className="visually-hidden">
            Status
          </label>
          <select
            id="apps-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | 'OPEN' | 'CLOSED')
              setOffset(0)
            }}
          >
            <option value="">Open and closed</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
          </select>
        </div>

        {list.loading ? (
          <Loading rows={5} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !list.data || list.data.items.length === 0 ? (
          <Empty
            title="No applications found"
            hint={jobId || stage || status ? 'Try clearing a filter.' : 'Applications submitted by candidates appear here.'}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Candidate</th>
                    <th scope="col">Job</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((row) => (
                    <tr key={row.id} style={row.id === selectedId ? selectedRowStyle : undefined}>
                      <td className="mono">
                        <LinkButton onClick={() => setSelectedId(row.id)}>{row.reference}</LinkButton>
                      </td>
                      <td>
                        {row.candidateName}
                        <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>{row.candidateEmail}</div>
                      </td>
                      <td>
                        {row.jobTitle}
                        <div className="mono" style={{ color: 'var(--text-faint)' }}>
                          {row.jobCode}
                        </div>
                      </td>
                      <td>
                        <Badge value={row.stage} />
                      </td>
                      <td>{formatDateTime(row.appliedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={list.data} onOffset={setOffset} />
          </>
        )}
      </Card>

      {selectedId ? (
        <div style={{ marginTop: 14 }}>
          {detail.loading ? (
            <Card title="Application details">
              <Loading rows={6} />
            </Card>
          ) : detail.error ? (
            <Card
              title="Application details"
              actions={<button type="button" onClick={() => setSelectedId(null)}>Close</button>}
            >
              <ErrorState error={detail.error} />
            </Card>
          ) : detail.data ? (
            <ApplicationDetail data={detail.data} user={user} onChanged={refresh} onClose={() => setSelectedId(null)} />
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function ApplicationDetail({
  data,
  user,
  onChanged,
  onClose,
}: {
  data: ApplicationDetailResponse
  user: CurrentUser | null
  onChanged(): void
  onClose(): void
}) {
  const { application, events, interviews } = data
  const canUpdate = can(user, 'application.update')
  const canInterview = can(user, 'interview.manage')
  const canOffer = can(user, 'offer.manage')

  return (
    <div className="grid two">
      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        <Card
          title={`Application ${application.reference}`}
          actions={
            <button type="button" onClick={onClose}>
              Close details
            </button>
          }
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <Badge value={application.stage} />
            <Badge value={application.status} />
            <Badge value="CONFIDENTIAL" />
          </div>
          <DefinitionList
            items={[
              ['Candidate', application.candidateName],
              ['E-mail', application.candidateEmail],
              [
                'Job',
                <>
                  {application.jobTitle} <span className="mono">{application.jobCode}</span>
                </>,
              ],
              ['Applied', formatDateTime(application.appliedAt)],
              ['Last updated', formatDateTime(application.updatedAt)],
            ]}
          />
        </Card>

        <Card title="Timeline">
          {events.length === 0 ? (
            <Empty title="No events recorded" />
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {events.map((event) => (
                <li
                  key={event.id}
                  style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: 12, fontSize: 13 }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {event.fromStage ? (
                      <>
                        <Badge value={event.fromStage} />
                        <span aria-hidden="true">→</span>
                      </>
                    ) : null}
                    <Badge value={event.toStage} />
                    <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{formatDateTime(event.createdAt)}</span>
                  </div>
                  {event.note ? <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{event.note}</div> : null}
                  <div style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 2 }}>
                    {event.actorUserId ? (
                      <>
                        By user <span className="mono">{event.actorUserId}</span>
                      </>
                    ) : (
                      'System'
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Interviews">
          {interviews.length === 0 ? (
            <Empty title="No interviews scheduled" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Scheduled</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Status</th>
                    <th scope="col">Interviewer</th>
                    <th scope="col">Score</th>
                    <th scope="col">Evaluation</th>
                  </tr>
                </thead>
                <tbody>
                  {interviews.map((interview) => (
                    <tr key={interview.id}>
                      <td>{formatDateTime(interview.scheduledAt)}</td>
                      <td>{interview.durationMinutes} min</td>
                      <td>{humanise(interview.mode)}</td>
                      <td>
                        <Badge value={interview.status} />
                      </td>
                      <td className="mono">{interview.interviewerEmployeeId ?? '—'}</td>
                      <td className="num">{interview.score ?? '—'}</td>
                      <td style={{ whiteSpace: 'pre-wrap', minWidth: 160 }}>{interview.evaluation ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        {!canUpdate && !canInterview && !canOffer ? (
          <Card title="Actions">
            <Empty title="No actions available to your role" />
          </Card>
        ) : null}
        {canUpdate ? <MoveStageForm application={application} onMoved={onChanged} /> : null}
        {canInterview ? <ScheduleInterviewForm applicationId={application.id} onScheduled={onChanged} /> : null}
        {canOffer ? <CreateOfferForm application={application} /> : null}
      </div>
    </div>
  )
}

function MoveStageForm({ application, onMoved }: { application: ApplicationRow; onMoved(): void }) {
  const options = ALLOWED[application.stage]
  const [stage, setStage] = useState<Stage | ''>(options[0] ?? '')
  const [note, setNote] = useState('')
  const action = useAction()

  // The legal targets change with the stage; keep the select in range.
  useEffect(() => {
    setStage(ALLOWED[application.stage][0] ?? '')
    setNote('')
  }, [application.id, application.stage])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!stage) return
    if (
      !window.confirm(
        `Move application ${application.reference} from ${humanise(application.stage)} to ${humanise(stage)}?`,
      )
    )
      return
    const body: Record<string, unknown> = { stage }
    if (note.trim()) body.note = note.trim()
    const result = await action.run(
      () =>
        api<{ ok: true; from: Stage; to: Stage }>(`/applications/${encodeURIComponent(application.id)}/stage`, {
          method: 'POST',
          body,
        }),
      (r) => `Moved from ${humanise(r.from)} to ${humanise(r.to)}.`,
    )
    if (result) {
      setNote('')
      onMoved()
    }
  }

  const issues = action.failure?.issues ?? {}

  return (
    <Card title="Move to stage">
      {options.length === 0 ? (
        <div className="notice info" role="status" style={{ marginBottom: 0 }}>
          This application is in the terminal stage <strong>{humanise(application.stage)}</strong> and can no longer
          be moved.
        </div>
      ) : (
        <form onSubmit={submit}>
          <FailureNotice failure={action.failure} />
          <Field
            id="stage-target"
            label={`Next stage (currently ${humanise(application.stage)})`}
            issues={issues.stage}
          >
            <select id="stage-target" value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
              {options.map((s) => (
                <option key={s} value={s}>
                  {humanise(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="stage-note" label="Note (optional)" issues={issues.note}>
            <textarea
              id="stage-note"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <button type="submit" className="primary" disabled={action.busy || !stage}>
            {action.busy ? 'Moving…' : 'Move application'}
          </button>
          <StatusLine text={action.status} />
        </form>
      )}
    </Card>
  )
}

const EMPTY_INTERVIEW = {
  scheduledAt: '',
  durationMinutes: '60',
  mode: 'REMOTE' as InterviewMode,
  interviewerEmployeeId: '',
}

function ScheduleInterviewForm({ applicationId, onScheduled }: { applicationId: string; onScheduled(): void }) {
  const [form, setForm] = useState(EMPTY_INTERVIEW)
  const action = useAction()

  async function submit(event: FormEvent) {
    event.preventDefault()
    const when = new Date(form.scheduledAt)
    if (!form.scheduledAt || Number.isNaN(when.getTime())) {
      action.fail('Enter a valid date and time for the interview.')
      return
    }
    const body: Record<string, unknown> = { scheduledAt: when.toISOString(), mode: form.mode }
    if (form.durationMinutes.trim()) body.durationMinutes = Number(form.durationMinutes)
    if (form.interviewerEmployeeId.trim()) body.interviewerEmployeeId = form.interviewerEmployeeId.trim()

    const result = await action.run(
      () =>
        api<{ interview: Interview }>(`/applications/${encodeURIComponent(applicationId)}/interviews`, {
          method: 'POST',
          body,
        }),
      (r) => `Interview scheduled for ${formatDateTime(r.interview.scheduledAt)} (${humanise(r.interview.mode)}).`,
    )
    if (result) {
      setForm(EMPTY_INTERVIEW)
      onScheduled()
    }
  }

  const issues = action.failure?.issues ?? {}

  return (
    <Card title="Schedule interview">
      <form onSubmit={submit}>
        <FailureNotice failure={action.failure} />
        <Field id="interview-when" label="Date and time" issues={issues.scheduledAt}>
          <input
            id="interview-when"
            type="datetime-local"
            required
            value={form.scheduledAt}
            onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
          />
        </Field>
        <div className="form-row">
          <Field id="interview-duration" label="Duration (minutes)" hint="15–480" issues={issues.durationMinutes}>
            <input
              id="interview-duration"
              type="number"
              min={15}
              max={480}
              step={1}
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
            />
          </Field>
          <Field id="interview-mode" label="Mode" issues={issues.mode}>
            <select
              id="interview-mode"
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value as InterviewMode })}
            >
              {INTERVIEW_MODES.map((m) => (
                <option key={m} value={m}>
                  {humanise(m)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          id="interview-interviewer"
          label="Interviewer employee id (optional)"
          issues={issues.interviewerEmployeeId}
        >
          <input
            id="interview-interviewer"
            type="text"
            maxLength={40}
            value={form.interviewerEmployeeId}
            onChange={(e) => setForm({ ...form, interviewerEmployeeId: e.target.value })}
          />
        </Field>
        <button type="submit" className="primary" disabled={action.busy}>
          {action.busy ? 'Scheduling…' : 'Schedule interview'}
        </button>
        <StatusLine text={action.status} />
      </form>
    </Card>
  )
}

const EMPTY_OFFER = { baseSalary: '', currency: '', startDate: '', expiresAt: '' }

function CreateOfferForm({ application }: { application: ApplicationRow }) {
  const [form, setForm] = useState(EMPTY_OFFER)
  const action = useAction()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (
      !window.confirm(
        `Create a draft offer for ${application.candidateName} (${application.reference})? Compensation is RESTRICTED data and this action is audited.`,
      )
    )
      return
    const body: Record<string, unknown> = {
      baseSalary: Number(form.baseSalary),
      currency: form.currency.trim().toUpperCase(),
      startDate: form.startDate,
    }
    if (form.expiresAt) body.expiresAt = form.expiresAt

    const result = await action.run(
      () =>
        api<{ offer: Offer }>(`/applications/${encodeURIComponent(application.id)}/offers`, {
          method: 'POST',
          body,
        }),
      (r) => `Offer created with status ${humanise(r.offer.status)}, start date ${formatDate(r.offer.startDate)}.`,
    )
    if (result) setForm(EMPTY_OFFER)
  }

  const issues = action.failure?.issues ?? {}

  return (
    <Card title="Create offer" actions={<Badge value="RESTRICTED" />}>
      <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 12 }}>
        Offers carry compensation and are restricted to roles with offer management rights. The offer is created as a
        draft.
      </p>
      <form onSubmit={submit}>
        <FailureNotice failure={action.failure} />
        <div className="form-row">
          <Field id="offer-salary" label="Base salary" issues={issues.baseSalary}>
            <input
              id="offer-salary"
              type="number"
              required
              min={0}
              step="any"
              value={form.baseSalary}
              onChange={(e) => setForm({ ...form, baseSalary: e.target.value })}
            />
          </Field>
          <Field id="offer-currency" label="Currency" hint="3-letter code, e.g. USD." issues={issues.currency}>
            <input
              id="offer-currency"
              type="text"
              required
              minLength={3}
              maxLength={3}
              autoCapitalize="characters"
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field id="offer-start" label="Start date" issues={issues.startDate}>
            <input
              id="offer-start"
              type="date"
              required
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </Field>
          <Field id="offer-expires" label="Expires (optional)" issues={issues.expiresAt}>
            <input
              id="offer-expires"
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </Field>
        </div>
        <button type="submit" className="primary" disabled={action.busy}>
          {action.busy ? 'Creating…' : 'Create draft offer'}
        </button>
        <StatusLine text={action.status} />
      </form>
    </Card>
  )
}

// --- Candidates ----------------------------------------------------------------------

function CandidatesTab({
  user,
  onOpenApplication,
}: {
  user: CurrentUser | null
  onOpenApplication(applicationId: string): void
}) {
  const [pendingQuery, setPendingQuery] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const canSeeApplications = can(user, 'application.read')

  const list = useApi<Page<Candidate>>(`/candidates${qs({ limit: PAGE_SIZE, offset, query })}`)
  const detail = useApi<CandidateDetailResponse>(
    selectedId ? `/candidates/${encodeURIComponent(selectedId)}` : null,
  )

  return (
    <>
      <Card title="Candidates" actions={<Badge value="CONFIDENTIAL" />}>
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault()
            setQuery(pendingQuery.trim())
            setOffset(0)
          }}
        >
          <label htmlFor="candidates-query" className="visually-hidden">
            Search candidates
          </label>
          <input
            id="candidates-query"
            type="search"
            placeholder="Search by name or e-mail"
            maxLength={100}
            value={pendingQuery}
            onChange={(e) => setPendingQuery(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>

        {list.loading ? (
          <Loading rows={5} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !list.data || list.data.items.length === 0 ? (
          <Empty
            title="No candidates found"
            hint={query ? 'Try a different name or e-mail.' : 'Candidates who apply will appear here.'}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Phone</th>
                    <th scope="col">Source</th>
                    <th scope="col">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((candidate) => (
                    <tr key={candidate.id} style={candidate.id === selectedId ? selectedRowStyle : undefined}>
                      <td>
                        <LinkButton onClick={() => setSelectedId(candidate.id)}>{candidate.name}</LinkButton>
                      </td>
                      <td>{candidate.email}</td>
                      <td>{candidate.phone ?? '—'}</td>
                      <td>
                        <Badge value={candidate.source} />
                      </td>
                      <td>{formatDate(candidate.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={list.data} onOffset={setOffset} />
          </>
        )}
      </Card>

      {selectedId ? (
        <div style={{ marginTop: 14 }}>
          {detail.loading ? (
            <Card title="Candidate details">
              <Loading rows={6} />
            </Card>
          ) : detail.error ? (
            <Card title="Candidate details" actions={<button type="button" onClick={() => setSelectedId(null)}>Close</button>}>
              <ErrorState error={detail.error} />
            </Card>
          ) : detail.data ? (
            <div className="grid two">
              <Card
                title={detail.data.candidate.name}
                actions={
                  <button type="button" onClick={() => setSelectedId(null)}>
                    Close details
                  </button>
                }
              >
                <DefinitionList
                  items={[
                    ['E-mail', detail.data.candidate.email],
                    ['Phone', detail.data.candidate.phone ?? '—'],
                    ['Source', <Badge key="source" value={detail.data.candidate.source} />],
                    ['Telegram linked', detail.data.candidate.telegramUserId ? 'Yes' : 'No'],
                    ['CV on file', detail.data.candidate.cvFileId ? 'Yes' : 'No'],
                    ['Added', formatDateTime(detail.data.candidate.createdAt)],
                    ['Updated', formatDateTime(detail.data.candidate.updatedAt)],
                  ]}
                />
              </Card>

              <Card title="Applications">
                {detail.data.applications.length === 0 ? (
                  <Empty title="No applications from this candidate" />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Reference</th>
                          <th scope="col">Job</th>
                          <th scope="col">Stage</th>
                          <th scope="col">Applied</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.applications.map((row) => (
                          <tr key={row.id}>
                            <td className="mono">
                              {canSeeApplications ? (
                                <LinkButton onClick={() => onOpenApplication(row.id)}>{row.reference}</LinkButton>
                              ) : (
                                row.reference
                              )}
                            </td>
                            <td>
                              {row.jobTitle}
                              <div className="mono" style={{ color: 'var(--text-faint)' }}>
                                {row.jobCode}
                              </div>
                            </td>
                            <td>
                              <Badge value={row.stage} />
                            </td>
                            <td>{formatDateTime(row.appliedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
