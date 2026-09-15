'use client'

/**
 * Recruitment — jobs, applications and candidates (CLAUDE.md §21, §33, §35).
 *
 * Three tabs, each a master/detail split: a filtered list on the left and the
 * selected record on the right, with the record's actions first, then its
 * facts, then its history. Data comes from useApi(); every region has loading,
 * error and empty states.
 *
 * Permission checks in this file only decide which controls are rendered. The
 * API re-authorises every request through the PolicyGateway, and a 403 is shown
 * as the server's own message — the client never assumes an action succeeded.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Facts,
  Field,
  Loading,
  Notice,
  Pager,
  SubmitError,
  Tabs,
  formatDate,
  formatDateTime,
  humanize,
} from '@/components/ui'
import { EmployeePicker, type PickedEmployee } from '@/components/employee-picker'
import { useSession } from '@/components/session'
import { api, can, type CurrentUser, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

const PAGE_SIZE = 25

// --- Types: mirrors of what the API actually returns ------------------------

const JOB_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] as const
type JobStatus = (typeof JOB_STATUSES)[number]

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] as const
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

const REQUIREMENT_TYPES = ['SKILL', 'EDUCATION', 'EXPERIENCE', 'CERTIFICATION', 'LANGUAGE', 'OTHER'] as const
type RequirementType = (typeof REQUIREMENT_TYPES)[number]

type Stage =
  | 'APPLIED'
  | 'SCREENING'
  | 'SHORTLISTED'
  | 'INTERVIEW'
  | 'TECHNICAL'
  | 'FINAL'
  | 'OFFER'
  | 'HIRED'
  | 'REJECTED'
  | 'WITHDRAWN'

const IN_PROGRESS_STAGES: Stage[] = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'TECHNICAL', 'FINAL', 'OFFER']
const FINISHED_STAGES: Stage[] = ['HIRED', 'REJECTED', 'WITHDRAWN']

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
  salaryPublic: boolean
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
  applicationId: string
  baseSalary: number
  currency: string
  startDate: string
  status: string
  expiresAt: string | null
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

function isTerminal(stage: Stage): boolean {
  return FINISHED_STAGES.includes(stage)
}

// --- Local helpers ------------------------------------------------------------

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

function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'TELEGRAM_EXTERNAL':
      return 'Sent by candidate'
    case 'TELEGRAM_INTERNAL':
      return 'Forwarded by staff'
    default:
      return 'Uploaded'
  }
}

function formatSalary(job: Pick<Job, 'salaryMin' | 'salaryMax' | 'currency'>): string {
  if (job.salaryMin === null && job.salaryMax === null) return 'Not set'
  const min = job.salaryMin === null ? '?' : job.salaryMin.toLocaleString()
  const max = job.salaryMax === null ? '?' : job.salaryMax.toLocaleString()
  return `${min} – ${max}${job.currency ? ` ${job.currency}` : ''}`
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

/** On narrow screens the detail panel sits below the list; bring it into view when a row is chosen. */
function useScrollToDetail(ref: RefObject<HTMLElement>, key: string | null) {
  useEffect(() => {
    if (!key) return
    if (typeof window !== 'undefined' && window.innerWidth < 1200) {
      ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [ref, key])
}

/** Heading for a block inside a detail panel; h3 has no margin of its own in globals.css. */
function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 style={{ margin: '14px 0 8px' }}>{children}</h3>
}

// --- Page ------------------------------------------------------------------------

type Tab = 'jobs' | 'applications' | 'candidates'

/** Cross-tab navigation target, set when another tab hands off to Applications. */
interface ApplicationFocus {
  jobId?: string
  jobTitle?: string
  applicationId?: string
}

export default function RecruitmentPage() {
  const { user } = useSession()
  const [tab, setTab] = useState<Tab>('jobs')
  const [focus, setFocus] = useState<ApplicationFocus | null>(null)

  const canSeeApplications = can(user, 'application.read')
  const canSeeCandidates = can(user, 'candidate.read')

  if (!can(user, 'job.read.internal')) {
    return (
      <Shell>
        <PageHeader title="Recruitment" />
        <Card>
          <Empty title="You do not have access to recruitment" hint="Ask an HR administrator." />
        </Card>
      </Shell>
    )
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'jobs', label: 'Jobs' },
    ...(canSeeApplications ? [{ key: 'applications' as Tab, label: 'Applications' }] : []),
    ...(canSeeCandidates ? [{ key: 'candidates' as Tab, label: 'Candidates' }] : []),
  ]

  function openApplications(next: ApplicationFocus) {
    setFocus(next)
    setTab('applications')
  }

  return (
    <Shell>
      <PageHeader title="Recruitment" description="Jobs, applications and candidates." />

      <Tabs
        tabs={tabs}
        value={tab}
        label="Recruitment sections"
        onChange={(next) => {
          setFocus(null)
          setTab(next)
        }}
      />

      {tab === 'jobs' ? (
        <JobsTab user={user} onViewApplications={(jobId, jobTitle) => openApplications({ jobId, jobTitle })} />
      ) : null}
      {tab === 'applications' && canSeeApplications ? <ApplicationsTab user={user} focus={focus} /> : null}
      {tab === 'candidates' && canSeeCandidates ? (
        <CandidatesTab user={user} onOpenApplication={(applicationId) => openApplications({ applicationId })} />
      ) : null}
    </Shell>
  )
}

// --- Jobs ------------------------------------------------------------------------

function JobsTab({
  user,
  onViewApplications,
}: {
  user: CurrentUser | null
  onViewApplications(jobId: string, jobTitle: string): void
}) {
  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim())
  const [status, setStatus] = useState<'' | JobStatus>('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const detailRef = useRef<HTMLDivElement>(null)

  const canCreate = can(user, 'job.create')

  // A new search term is a new list: back to the first page, nothing selected.
  useEffect(() => {
    setOffset(0)
    setSelectedId(null)
  }, [query])

  const list = useApi<Page<Job>>(`/jobs${qs({ limit: PAGE_SIZE, offset, status, query })}`)
  const detail = useApi<JobDetailResponse>(
    selectedId && !creating ? `/jobs/${encodeURIComponent(selectedId)}` : null,
  )
  // Department names for display and for the New job form.
  const departments = useApi<{ departments: Department[] }>('/departments')
  const departmentName = (id: string | null): string => {
    if (!id) return '—'
    return departments.data?.departments.find((d) => d.id === id)?.name ?? '—'
  }

  useScrollToDetail(detailRef, creating ? 'new' : selectedId)

  function refresh() {
    list.reload()
    detail.reload()
  }

  const filtered = search !== '' || status !== ''

  return (
    <div className="split">
      <Card
        title="Jobs"
        actions={
          canCreate ? (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setCreating(true)
                setSelectedId(null)
              }}
            >
              New job
            </button>
          ) : undefined
        }
      >
        <div className="toolbar">
          <label htmlFor="jobs-query" className="visually-hidden">
            Search jobs
          </label>
          <input
            id="jobs-query"
            type="search"
            placeholder="Search by title or code"
            maxLength={100}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
              setSelectedId(null)
            }}
          >
            <option value="">All statuses</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setSearch('')
                setStatus('')
                setOffset(0)
                setSelectedId(null)
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        {list.loading ? (
          <Loading rows={5} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !list.data || list.data.items.length === 0 ? (
          <Empty
            title="No jobs found"
            hint={filtered ? 'Try clearing the search or status filter.' : 'Jobs you create appear here.'}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Department</th>
                    <th scope="col">Status</th>
                    <th scope="col">Closing date</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((job) => {
                    const selected = job.id === selectedId && !creating
                    const select = () => {
                      setCreating(false)
                      setSelectedId(job.id)
                    }
                    return (
                      <tr key={job.id} className="selectable" aria-selected={selected} onClick={select}>
                        <td>
                          <button type="button" className="link" onClick={select}>
                            {job.title}
                          </button>
                          <div className="small-text muted">{job.jobCode}</div>
                        </td>
                        <td>{departmentName(job.departmentId)}</td>
                        <td>
                          <Badge value={job.status} />
                        </td>
                        <td>{formatDate(job.closingDate)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={list.data} onChange={setOffset} />
          </>
        )}
      </Card>

      <div ref={detailRef}>
        {creating && canCreate ? (
          <Card title="New job">
            <NewJobForm
              departments={departments.data?.departments ?? []}
              onCancel={() => setCreating(false)}
              onCreated={(job) => {
                setCreating(false)
                setSelectedId(job.id)
                list.reload()
              }}
            />
          </Card>
        ) : !selectedId ? (
          <Card title="Job">
            <Empty title="Select a job" hint="Choose a job from the list to see its details." />
          </Card>
        ) : detail.loading ? (
          <Card title="Job">
            <Loading rows={6} />
          </Card>
        ) : detail.error ? (
          <Card title="Job">
            <ErrorState error={detail.error} />
          </Card>
        ) : detail.data ? (
          <JobDetail
            data={detail.data}
            user={user}
            departmentName={departmentName}
            onChanged={refresh}
            onViewApplications={onViewApplications}
          />
        ) : null}
      </div>
    </div>
  )
}

function JobDetail({
  data,
  user,
  departmentName,
  onChanged,
  onViewApplications,
}: {
  data: JobDetailResponse
  user: CurrentUser | null
  departmentName(id: string | null): string
  onChanged(): void
  onViewApplications(jobId: string, jobTitle: string): void
}) {
  const { job, requirements, salaryPublic } = data
  const canUpdate = can(user, 'job.update')
  const canDelete = can(user, 'job.delete')
  const canSeeApplications = can(user, 'application.read')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)
  const jobPath = `/jobs/${encodeURIComponent(job.id)}`

  async function run(request: () => Promise<unknown>, success: string) {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await request()
      setDone(success)
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  function publish() {
    if (!window.confirm(`Publish "${job.title}"? Candidates can see it and apply from now on.`)) return
    void run(() => api(jobPath, { method: 'PUT', body: { status: 'PUBLISHED' } }), 'Job published.')
  }

  function close() {
    if (!window.confirm(`Close "${job.title}"? It stops accepting applications.`)) return
    void run(() => api(jobPath, { method: 'PUT', body: { status: 'CLOSED' } }), 'Job closed.')
  }

  function archive() {
    if (!window.confirm(`Archive "${job.title}"? It disappears from every list and cannot be reopened here.`)) return
    void run(() => api(jobPath, { method: 'DELETE' }), 'Job archived.')
  }

  function toggleSalaryPublic(value: boolean) {
    void run(
      () => api(jobPath, { method: 'PUT', body: { salaryPublic: value } }),
      value ? 'The salary range now shows on the public listing.' : 'The salary range is hidden from candidates.',
    )
  }

  const hasActions = canUpdate || canDelete || canSeeApplications

  return (
    <Card title={job.title} actions={<Badge value={job.status} />}>
      {hasActions ? (
        <section className="card flat" style={{ marginBottom: 12 }}>
          <SectionTitle>Actions</SectionTitle>
          <SubmitError error={error} />
          {done ? <Notice tone="ok">{done}</Notice> : null}
          <div className="actions">
            {canUpdate && (job.status === 'DRAFT' || job.status === 'CLOSED') ? (
              <button type="button" className="primary" disabled={busy} onClick={publish}>
                Publish
              </button>
            ) : null}
            {canUpdate && job.status === 'PUBLISHED' ? (
              <button type="button" disabled={busy} onClick={close}>
                Close
              </button>
            ) : null}
            {canSeeApplications ? (
              <button type="button" onClick={() => onViewApplications(job.id, job.title)}>
                View applications
              </button>
            ) : null}
            {canDelete && job.status !== 'ARCHIVED' ? (
              <button type="button" className="danger" disabled={busy} onClick={archive}>
                Archive
              </button>
            ) : null}
          </div>
          {canUpdate ? (
            <label className="check" htmlFor="job-salary-public">
              <input
                id="job-salary-public"
                type="checkbox"
                checked={salaryPublic}
                disabled={busy}
                onChange={(e) => toggleSalaryPublic(e.target.checked)}
              />
              Show salary range on the public listing
            </label>
          ) : null}
        </section>
      ) : null}

      <SectionTitle>Details</SectionTitle>
      <Facts
        items={[
          { label: 'Department', value: departmentName(job.departmentId) },
          { label: 'Location', value: job.location },
          { label: 'Employment type', value: humanize(job.employmentType) },
          { label: 'Remote', value: job.remoteAllowed ? 'Allowed' : 'Not allowed' },
          { label: 'Salary range', value: formatSalary(job) },
          { label: 'Minimum experience', value: job.experienceMin === null ? '—' : `${job.experienceMin} years` },
          { label: 'Closing date', value: formatDate(job.closingDate) },
          { label: 'Published', value: formatDate(job.publishedAt) },
        ]}
      />

      <SectionTitle>Description</SectionTitle>
      <pre className="plain">{job.description}</pre>

      <SectionTitle>Requirements</SectionTitle>
      {requirements.length === 0 ? (
        <Empty title="No requirements yet" hint={canUpdate ? 'Add the first one below.' : undefined} />
      ) : (
        <div className="rows">
          {requirements.map((r) => (
            <div className="row-card" key={r.id}>
              <div className="row-head">
                <strong>{r.description}</strong>
                {r.mandatory ? <Badge value="Must have" tone="info" /> : null}
              </div>
              <div className="row-meta">
                <span>{humanize(r.requirementType)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {canUpdate && job.status !== 'ARCHIVED' ? (
        <details className="more">
          <summary>New requirement</summary>
          <AddRequirementForm jobId={job.id} onAdded={onChanged} />
        </details>
      ) : null}
    </Card>
  )
}

const EMPTY_REQUIREMENT = {
  requirementType: 'SKILL' as RequirementType,
  description: '',
  mandatory: true,
}

function AddRequirementForm({ jobId, onAdded }: { jobId: string; onAdded(): void }) {
  const [form, setForm] = useState(EMPTY_REQUIREMENT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await api(`/jobs/${encodeURIComponent(jobId)}/requirements`, {
        method: 'POST',
        body: {
          requirementType: form.requirementType,
          description: form.description.trim(),
          mandatory: form.mandatory,
        },
      })
      setForm(EMPTY_REQUIREMENT)
      setDone('Requirement added.')
      onAdded()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <SubmitError error={error} />
      {done ? <Notice tone="ok">{done}</Notice> : null}
      <div className="form-row">
        <Field id="req-type" label="Type">
          <select
            id="req-type"
            value={form.requirementType}
            onChange={(e) => {
              setDone(null)
              setForm({ ...form, requirementType: e.target.value as RequirementType })
            }}
          >
            {REQUIREMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="req-description" label="Description">
          <input
            id="req-description"
            type="text"
            required
            minLength={2}
            maxLength={500}
            value={form.description}
            onChange={(e) => {
              setDone(null)
              setForm({ ...form, description: e.target.value })
            }}
          />
        </Field>
      </div>
      <div className="field">
        <label className="check" htmlFor="req-mandatory">
          <input
            id="req-mandatory"
            type="checkbox"
            checked={form.mandatory}
            onChange={(e) => setForm({ ...form, mandatory: e.target.checked })}
          />
          Must have
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'New requirement'}
        </button>
      </div>
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
}

function NewJobForm({
  departments,
  onCancel,
  onCreated,
}: {
  departments: Department[]
  onCancel(): void
  onCreated(job: Job): void
}) {
  const [form, setForm] = useState<NewJobFormState>(EMPTY_JOB)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  function set<K extends keyof NewJobFormState>(key: K, value: NewJobFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const body: Record<string, unknown> = {
      jobCode: form.jobCode.trim().toUpperCase(),
      title: form.title.trim(),
      employmentType: form.employmentType,
      description: form.description.trim(),
      remoteAllowed: form.remoteAllowed,
      salaryPublic: form.salaryPublic,
      status: 'DRAFT',
    }
    if (form.departmentId) body.departmentId = form.departmentId
    if (form.location.trim()) body.location = form.location.trim()
    if (form.salaryMin.trim()) body.salaryMin = Number(form.salaryMin)
    if (form.salaryMax.trim()) body.salaryMax = Number(form.salaryMax)
    if (form.currency.trim()) body.currency = form.currency.trim().toUpperCase()
    if (form.experienceMin.trim()) body.experienceMin = Number(form.experienceMin)
    if (form.closingDate) body.closingDate = form.closingDate

    setBusy(true)
    setError(null)
    try {
      const result = await api<{ job: Job }>('/jobs', { method: 'POST', body })
      setForm(EMPTY_JOB)
      onCreated(result.job)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <SubmitError error={error} />
      <Field id="job-title" label="Title">
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
      <div className="form-row">
        <Field id="job-department" label="Department">
          <select id="job-department" value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
            <option value="">Not set</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="job-type" label="Employment type">
          <select
            id="job-type"
            value={form.employmentType}
            onChange={(e) => set('employmentType', e.target.value as EmploymentType)}
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id="job-description" label="Description" hint="What the role is and what the person will do.">
        <textarea
          id="job-description"
          required
          minLength={10}
          maxLength={20000}
          rows={6}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>
      <Field id="job-code" label="Job code" hint="Short code shown to candidates, e.g. ENG-014">
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

      <details className="more">
        <summary>More options</summary>
        <div className="form-row">
          <Field id="job-location" label="Location">
            <input
              id="job-location"
              type="text"
              maxLength={120}
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
            />
          </Field>
          <Field id="job-closing" label="Closing date">
            <input
              id="job-closing"
              type="date"
              value={form.closingDate}
              onChange={(e) => set('closingDate', e.target.value)}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field id="job-salary-min" label="Salary from">
            <input
              id="job-salary-min"
              type="number"
              min={0}
              step="any"
              value={form.salaryMin}
              onChange={(e) => set('salaryMin', e.target.value)}
            />
          </Field>
          <Field id="job-salary-max" label="Salary to">
            <input
              id="job-salary-max"
              type="number"
              min={0}
              step="any"
              value={form.salaryMax}
              onChange={(e) => set('salaryMax', e.target.value)}
            />
          </Field>
          <Field id="job-currency" label="Currency" hint="Three letters, e.g. USD">
            <input
              id="job-currency"
              type="text"
              minLength={3}
              maxLength={3}
              value={form.currency}
              onChange={(e) => set('currency', e.target.value)}
            />
          </Field>
          <Field id="job-experience" label="Minimum experience (years)">
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
        <div className="field">
          <label className="check" htmlFor="job-remote">
            <input
              id="job-remote"
              type="checkbox"
              checked={form.remoteAllowed}
              onChange={(e) => set('remoteAllowed', e.target.checked)}
            />
            Remote work allowed
          </label>
        </div>
        <div className="field">
          <label className="check" htmlFor="job-salary-public">
            <input
              id="job-salary-public"
              type="checkbox"
              checked={form.salaryPublic}
              onChange={(e) => set('salaryPublic', e.target.checked)}
            />
            Show salary range on the public listing
          </label>
        </div>
      </details>

      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create job'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <span className="hint">Created as a draft. Publish it from the job's details when it is ready.</span>
      </div>
    </form>
  )
}

// --- Applications ------------------------------------------------------------------

function ApplicationsTab({ user, focus }: { user: CurrentUser | null; focus: ApplicationFocus | null }) {
  const [jobId, setJobId] = useState(focus?.jobId ?? '')
  const [stage, setStage] = useState<'' | Stage>('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(focus?.applicationId ?? null)
  const [jobNotice, setJobNotice] = useState<string | null>(focus?.jobTitle ?? null)
  const detailRef = useRef<HTMLDivElement>(null)

  const jobs = useApi<Page<Pick<Job, 'id' | 'title' | 'jobCode' | 'status'>>>('/jobs?limit=100')
  const list = useApi<Page<ApplicationRow>>(`/applications${qs({ limit: PAGE_SIZE, offset, jobId, stage })}`)
  const detail = useApi<ApplicationDetailResponse>(
    selectedId ? `/applications/${encodeURIComponent(selectedId)}` : null,
  )

  useScrollToDetail(detailRef, selectedId)

  function refresh() {
    list.reload()
    detail.reload()
  }

  const filtered = jobId !== '' || stage !== ''

  return (
    <div className="split">
      <Card title="Applications">
        <div className="toolbar">
          <label htmlFor="applications-job" className="visually-hidden">
            Job
          </label>
          <select
            id="applications-job"
            value={jobId}
            onChange={(e) => {
              setJobId(e.target.value)
              setJobNotice(null)
              setOffset(0)
              setSelectedId(null)
            }}
          >
            <option value="">All jobs</option>
            {(jobs.data?.items ?? []).map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
          <label htmlFor="applications-stage" className="visually-hidden">
            Stage
          </label>
          <select
            id="applications-stage"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value as '' | Stage)
              setOffset(0)
              setSelectedId(null)
            }}
          >
            <option value="">All stages</option>
            <optgroup label="In progress">
              {IN_PROGRESS_STAGES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Finished">
              {FINISHED_STAGES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </optgroup>
          </select>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setJobId('')
                setStage('')
                setJobNotice(null)
                setOffset(0)
                setSelectedId(null)
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        {jobNotice ? (
          <Notice tone="info">
            <div className="actions">
              <span>Showing applications for {jobNotice}</span>
              <button type="button" className="small" onClick={() => setJobNotice(null)}>
                Dismiss
              </button>
            </div>
          </Notice>
        ) : null}

        {list.loading ? (
          <Loading rows={5} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !list.data || list.data.items.length === 0 ? (
          <Empty
            title="No applications found"
            hint={filtered ? 'Try clearing a filter.' : 'Applications from candidates appear here.'}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Candidate</th>
                    <th scope="col">Job</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((row) => (
                    <tr
                      key={row.id}
                      className="selectable"
                      aria-selected={row.id === selectedId}
                      onClick={() => setSelectedId(row.id)}
                    >
                      <td>
                        <button type="button" className="link" onClick={() => setSelectedId(row.id)}>
                          {row.candidateName}
                        </button>
                        <div className="small-text muted">{row.candidateEmail}</div>
                      </td>
                      <td>{row.jobTitle}</td>
                      <td>
                        <Badge value={row.stage} />
                      </td>
                      <td>{formatDate(row.appliedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={list.data} onChange={setOffset} />
          </>
        )}
      </Card>

      <div ref={detailRef}>
        {!selectedId ? (
          <Card title="Application">
            <Empty title="Select an application" hint="Choose one from the list to see its details." />
          </Card>
        ) : detail.loading ? (
          <Card title="Application">
            <Loading rows={6} />
          </Card>
        ) : detail.error ? (
          <Card title="Application">
            <ErrorState error={detail.error} />
          </Card>
        ) : detail.data ? (
          <ApplicationDetail data={detail.data} user={user} onChanged={refresh} />
        ) : null}
      </div>
    </div>
  )
}

function describeEvent(event: ApplicationEvent): string {
  if (event.fromStage === null) return 'Applied'
  return `Moved from ${humanize(event.fromStage)} to ${humanize(event.toStage)}`
}

function ApplicationDetail({
  data,
  user,
  onChanged,
}: {
  data: ApplicationDetailResponse
  user: CurrentUser | null
  onChanged(): void
}) {
  const { application, events, interviews } = data
  const canUpdate = can(user, 'application.update')
  const canInterview = can(user, 'interview.manage')
  const canOffer = can(user, 'offer.manage')
  const open = application.status === 'OPEN' && !isTerminal(application.stage)
  const offerStage = application.stage === 'FINAL' || application.stage === 'OFFER'

  return (
    <Card title={application.reference} actions={<Badge value={application.stage} />}>
      {open && canUpdate ? <MoveStageForm application={application} onMoved={onChanged} /> : null}
      {open && canInterview ? <ScheduleInterviewForm applicationId={application.id} onScheduled={onChanged} /> : null}
      {open && canOffer && offerStage ? <CreateOfferForm applicationId={application.id} onCreated={onChanged} /> : null}

      <SectionTitle>Details</SectionTitle>
      <Facts
        items={[
          { label: 'Candidate', value: application.candidateName },
          { label: 'E-mail', value: application.candidateEmail },
          { label: 'Job', value: application.jobTitle },
          { label: 'Applied', value: formatDateTime(application.appliedAt) },
        ]}
      />

      <SectionTitle>Timeline</SectionTitle>
      {events.length === 0 ? (
        <Empty title="Nothing recorded yet" />
      ) : (
        <div className="rows">
          {events.map((event) => (
            <div className="row-card" key={event.id}>
              <div className="row-head">
                <strong>{describeEvent(event)}</strong>
                <span className="small-text muted">{formatDateTime(event.createdAt)}</span>
              </div>
              {event.note ? <div className="small-text">{event.note}</div> : null}
            </div>
          ))}
        </div>
      )}

      <SectionTitle>Interviews</SectionTitle>
      {interviews.length === 0 ? (
        <Empty title="No interviews yet" hint={open && canInterview ? 'Schedule one above.' : undefined} />
      ) : (
        <div className="rows">
          {interviews.map((interview) => (
            <div className="row-card" key={interview.id}>
              <div className="row-head">
                <strong>{formatDateTime(interview.scheduledAt)}</strong>
                <Badge value={interview.status} />
              </div>
              <div className="row-meta">
                <span>{humanize(interview.mode)}</span>
                <span>{interview.durationMinutes} minutes</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function MoveStageForm({ application, onMoved }: { application: ApplicationRow; onMoved(): void }) {
  const options = ALLOWED[application.stage]
  const [stage, setStage] = useState<Stage | ''>(options[0] ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!stage) return
    if (stage === 'REJECTED' && !window.confirm(`Reject ${application.candidateName}'s application? This closes it.`)) {
      return
    }
    if (stage === 'HIRED' && !window.confirm(`Mark ${application.candidateName} as hired? This closes the application.`)) {
      return
    }
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const body: Record<string, unknown> = { stage }
      if (note.trim()) body.note = note.trim()
      await api(`/applications/${encodeURIComponent(application.id)}/stage`, { method: 'POST', body })
      setNote('')
      setDone(`Moved to ${humanize(stage)}.`)
      onMoved()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (options.length === 0) return null

  return (
    <section className="card flat" style={{ marginBottom: 12 }}>
      <SectionTitle>Move to stage</SectionTitle>
      <form onSubmit={submit}>
        <SubmitError error={error} />
        {done ? <Notice tone="ok">{done}</Notice> : null}
        <Field id="stage-next" label="Next stage">
          <select
            id="stage-next"
            value={stage}
            onChange={(e) => {
              setDone(null)
              setStage(e.target.value as Stage)
            }}
          >
            {options.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="stage-note" label="Note (optional)">
          <textarea
            id="stage-note"
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(e) => {
              setDone(null)
              setNote(e.target.value)
            }}
          />
        </Field>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || !stage}>
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </form>
    </section>
  )
}

const EMPTY_INTERVIEW = {
  scheduledAt: '',
  durationMinutes: '60',
  mode: 'REMOTE' as InterviewMode,
}

function ScheduleInterviewForm({ applicationId, onScheduled }: { applicationId: string; onScheduled(): void }) {
  const [form, setForm] = useState(EMPTY_INTERVIEW)
  const [interviewer, setInterviewer] = useState<PickedEmployee | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const when = new Date(form.scheduledAt)
    if (!form.scheduledAt || Number.isNaN(when.getTime())) {
      setError(new Error('Enter a valid date and time for the interview.'))
      return
    }
    const body: Record<string, unknown> = { scheduledAt: when.toISOString(), mode: form.mode }
    if (form.durationMinutes.trim()) body.durationMinutes = Number(form.durationMinutes)
    if (interviewer) body.interviewerEmployeeId = interviewer.id

    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const result = await api<{ interview: Interview }>(
        `/applications/${encodeURIComponent(applicationId)}/interviews`,
        { method: 'POST', body },
      )
      setForm(EMPTY_INTERVIEW)
      setInterviewer(null)
      setDone(`Interview scheduled for ${formatDateTime(result.interview.scheduledAt)}.`)
      onScheduled()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card flat" style={{ marginBottom: 12 }}>
      <SectionTitle>Schedule interview</SectionTitle>
      <form onSubmit={submit}>
        <SubmitError error={error} />
        {done ? <Notice tone="ok">{done}</Notice> : null}
        <div className="form-row">
          <Field id="interview-when" label="Date and time">
            <input
              id="interview-when"
              type="datetime-local"
              required
              value={form.scheduledAt}
              onChange={(e) => {
                setDone(null)
                setForm({ ...form, scheduledAt: e.target.value })
              }}
            />
          </Field>
          <Field id="interview-mode" label="Type">
            <select
              id="interview-mode"
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value as InterviewMode })}
            >
              {INTERVIEW_MODES.map((m) => (
                <option key={m} value={m}>
                  {humanize(m)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field id="interview-interviewer" label="Interviewer (optional)">
          <EmployeePicker id="interview-interviewer" value={interviewer} onChange={setInterviewer} disabled={busy} />
        </Field>
        <details className="more">
          <summary>More options</summary>
          <Field id="interview-duration" label="Duration (minutes)" hint="Between 15 and 480.">
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
        </details>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      </form>
    </section>
  )
}

const EMPTY_OFFER = { baseSalary: '', currency: '', startDate: '', expiresAt: '' }

function CreateOfferForm({ applicationId, onCreated }: { applicationId: string; onCreated(): void }) {
  const [form, setForm] = useState(EMPTY_OFFER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!window.confirm('Create this offer? It is recorded against the application.')) return
    const body: Record<string, unknown> = {
      baseSalary: Number(form.baseSalary),
      currency: form.currency.trim().toUpperCase(),
      startDate: form.startDate,
    }
    if (form.expiresAt) body.expiresAt = form.expiresAt

    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const result = await api<{ offer: Offer }>(`/applications/${encodeURIComponent(applicationId)}/offers`, {
        method: 'POST',
        body,
      })
      setForm(EMPTY_OFFER)
      setDone(`Offer created, starting ${formatDate(result.offer.startDate)}.`)
      onCreated()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card flat" style={{ marginBottom: 12 }}>
      <SectionTitle>Create offer</SectionTitle>
      <form onSubmit={submit}>
        <SubmitError error={error} />
        {done ? <Notice tone="ok">{done}</Notice> : null}
        <div className="form-row">
          <Field id="offer-salary" label="Base salary">
            <input
              id="offer-salary"
              type="number"
              required
              min={0}
              step="any"
              value={form.baseSalary}
              onChange={(e) => {
                setDone(null)
                setForm({ ...form, baseSalary: e.target.value })
              }}
            />
          </Field>
          <Field id="offer-currency" label="Currency" hint="Three letters, e.g. USD">
            <input
              id="offer-currency"
              type="text"
              required
              minLength={3}
              maxLength={3}
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
            />
          </Field>
          <Field id="offer-start" label="Start date">
            <input
              id="offer-start"
              type="date"
              required
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </Field>
        </div>
        <details className="more">
          <summary>More options</summary>
          <Field id="offer-expires" label="Offer expires">
            <input
              id="offer-expires"
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </Field>
        </details>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create offer'}
          </button>
        </div>
      </form>
    </section>
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
  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim())
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  const canSeeApplications = can(user, 'application.read')

  useEffect(() => {
    setOffset(0)
    setSelectedId(null)
  }, [query])

  const list = useApi<Page<Candidate>>(`/candidates${qs({ limit: PAGE_SIZE, offset, query })}`)
  const detail = useApi<CandidateDetailResponse>(
    selectedId ? `/candidates/${encodeURIComponent(selectedId)}` : null,
  )

  useScrollToDetail(detailRef, selectedId)

  return (
    <div className="split">
      <Card title="Candidates">
        <div className="toolbar">
          <label htmlFor="candidates-query" className="visually-hidden">
            Search candidates
          </label>
          <input
            id="candidates-query"
            type="search"
            placeholder="Search by name or e-mail"
            maxLength={100}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <button type="button" onClick={() => setSearch('')}>
              Clear
            </button>
          ) : null}
        </div>

        {list.loading ? (
          <Loading rows={5} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !list.data || list.data.items.length === 0 ? (
          <Empty
            title="No candidates found"
            hint={query ? 'Try a different name or e-mail.' : 'Candidates who apply appear here.'}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Source</th>
                    <th scope="col">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((candidate) => (
                    <tr
                      key={candidate.id}
                      className="selectable"
                      aria-selected={candidate.id === selectedId}
                      onClick={() => setSelectedId(candidate.id)}
                    >
                      <td>
                        <button type="button" className="link" onClick={() => setSelectedId(candidate.id)}>
                          {candidate.name}
                        </button>
                      </td>
                      <td>{candidate.email}</td>
                      <td>{sourceLabel(candidate.source)}</td>
                      <td>{formatDate(candidate.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={list.data} onChange={setOffset} />
          </>
        )}
      </Card>

      <div ref={detailRef}>
        {!selectedId ? (
          <Card title="Candidate">
            <Empty title="Select a candidate" hint="Choose one from the list to see their details." />
          </Card>
        ) : detail.loading ? (
          <Card title="Candidate">
            <Loading rows={5} />
          </Card>
        ) : detail.error ? (
          <Card title="Candidate">
            <ErrorState error={detail.error} />
          </Card>
        ) : detail.data ? (
          <Card title={detail.data.candidate.name}>
            <SectionTitle>Details</SectionTitle>
            <Facts
              items={[
                { label: 'E-mail', value: detail.data.candidate.email },
                { label: 'Phone', value: detail.data.candidate.phone },
                { label: 'Source', value: sourceLabel(detail.data.candidate.source) },
                { label: 'Added', value: formatDateTime(detail.data.candidate.createdAt) },
              ]}
            />

            <SectionTitle>Applications</SectionTitle>
            {detail.data.applications.length === 0 ? (
              <Empty title="No applications" hint="This candidate has not applied for a job yet." />
            ) : (
              <div className="rows">
                {detail.data.applications.map((row) => (
                  <div className="row-card" key={row.id}>
                    <div className="row-head">
                      {canSeeApplications ? (
                        <button type="button" className="link" onClick={() => onOpenApplication(row.id)}>
                          {row.reference}
                        </button>
                      ) : (
                        <strong>{row.reference}</strong>
                      )}
                      <Badge value={row.stage} />
                    </div>
                    <div className="row-meta">
                      <span>{row.jobTitle}</span>
                      <span>Applied {formatDate(row.appliedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : null}
      </div>
    </div>
  )
}
