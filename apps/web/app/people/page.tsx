'use client'

/**
 * People directory (CLAUDE.md §33, §35).
 *
 * Lists employees from GET /employees. The API narrows the result to the
 * caller's grant — a MANAGER sees only direct reports, HR sees everyone — so
 * this page never filters for security, it only explains what it was given.
 *
 * Compensation is RESTRICTED (§9): it lives behind its own endpoint, is fetched
 * only on an explicit click, and is shown only when the API answers. Every
 * `can()` check here is UX; the PolicyGateway decides (§34).
 */

import { useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, ErrorState, Loading, formatDate, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import { ApiRequestError, api, can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Response shapes (mirror the API; nothing is rendered that it does not return) --

interface Employee {
  id: string
  employeeNo: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  departmentId: string | null
  positionId: string | null
  managerId: string | null
  hireDate: string
  employmentType: string
  status: string
  createdAt: string
  updatedAt: string
}

interface Department {
  id: string
  code: string
  name: string
  parentId: string | null
}

interface Position {
  id: string
  code: string
  title: string
  level: string | null
}

interface Compensation {
  baseSalary: number
  currency: string
  effectiveFrom: string
}

const PAGE_SIZE = 25
const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'] as const
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'] as const

// --- Local helpers -----------------------------------------------------------

/** Per-field messages from a VALIDATION_FAILED response; empty for anything else. */
function fieldIssues(error: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!(error instanceof ApiRequestError)) return out
  const issues = error.error.details?.issues
  if (!Array.isArray(issues)) return out
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) continue
    const { path, message } = issue as { path?: unknown; message?: unknown }
    if (typeof path === 'string' && typeof message === 'string' && !(path in out)) {
      out[path] = message
    }
  }
  return out
}

function fullName(employee: Employee): string {
  return `${employee.firstName} ${employee.lastName}`.trim()
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}

/** A failed submit: calm permission notice for 403, an error for anything else. */
function SubmitError({ error }: { error: unknown }) {
  if (!error) return null
  if (error instanceof ApiRequestError && error.isForbidden) return <ErrorState error={error} />
  const message =
    error instanceof ApiRequestError
      ? error.error.message
      : error instanceof Error
        ? error.message
        : 'Something went wrong.'
  const requestId = error instanceof ApiRequestError ? error.error.requestId : undefined
  return (
    <div className="notice error" role="alert">
      <strong>Could not save. </strong>
      {message}
      {requestId ? (
        <div className="mono" style={{ marginTop: 6, fontSize: 11 }}>
          Reference: {requestId}
        </div>
      ) : null}
    </div>
  )
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <div id={`${id}-error`} className="hint" style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="kpi-label">{label}</div>
      <div style={{ marginTop: 2 }}>{children}</div>
    </div>
  )
}

// --- Page --------------------------------------------------------------------

interface Filters {
  query: string
  departmentId: string
  status: string
}

const EMPTY_FILTERS: Filters = { query: '', departmentId: '', status: '' }

export default function PeoplePage() {
  const { user } = useSession()
  const canReadAll = can(user, 'employee.read.all')
  const canReadTeam = can(user, 'employee.read.team')
  const canCreate = can(user, 'employee.create')
  const canUpdate = can(user, 'employee.update')
  const canReadCompensation = can(user, 'employee.read.compensation')

  const [queryInput, setQueryInput] = useState('')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [pageMessage, setPageMessage] = useState<string | null>(null)

  const departments = useApi<{ departments: Department[] }>('/departments')
  const positions = useApi<{ positions: Position[] }>(canCreate || canUpdate ? '/positions' : null)

  const listPath = useMemo(() => {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    if (filters.query) params.set('query', filters.query)
    if (filters.departmentId) params.set('departmentId', filters.departmentId)
    if (filters.status) params.set('status', filters.status)
    return `/employees?${params.toString()}`
  }, [filters, offset])
  const list = useApi<Page<Employee>>(listPath)

  const departmentNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of departments.data?.departments ?? []) map.set(d.id, d.name)
    return map
  }, [departments.data])

  const employeeNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of list.data?.items ?? []) map.set(e.id, fullName(e))
    return map
  }, [list.data])

  const hasFilters = filters.query !== '' || filters.departmentId !== '' || filters.status !== ''

  function applySearch(event: FormEvent) {
    event.preventDefault()
    setOffset(0)
    setFilters((f) => ({ ...f, query: queryInput.trim() }))
  }

  function updateFilter(key: 'departmentId' | 'status') {
    return (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value
      setOffset(0)
      setFilters((f) => ({ ...f, [key]: value }))
    }
  }

  function clearFilters() {
    setQueryInput('')
    setOffset(0)
    setFilters(EMPTY_FILTERS)
  }

  const page = list.data
  const from = page && page.items.length > 0 ? page.offset + 1 : 0
  const to = page ? page.offset + page.items.length : 0

  return (
    <Shell>
      <PageHeader
        title="People"
        description="Employee directory. Select a row to view a profile."
        actions={
          canCreate ? (
            <button type="button" className="primary" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? 'Close form' : 'Add employee'}
            </button>
          ) : undefined
        }
      />

      {!canReadAll && canReadTeam ? (
        <div className="notice info" role="note">
          <strong>Scoped to your team. </strong>
          This list shows only the employees who report to you. The wider directory is available to HR.
        </div>
      ) : null}

      {pageMessage ? (
        <div className="notice info" role="status" aria-live="polite">
          {pageMessage}
        </div>
      ) : null}

      {showCreate && canCreate ? (
        <div style={{ marginBottom: 16 }}>
          <CreateEmployeeForm
            departments={departments.data?.departments ?? []}
            positions={positions.data?.positions ?? []}
            onCancel={() => setShowCreate(false)}
            onCreated={(employee) => {
              setShowCreate(false)
              setPageMessage(`Created ${fullName(employee)} (${employee.employeeNo}).`)
              setSelectedId(employee.id)
              list.reload()
            }}
          />
        </div>
      ) : null}

      <Card title="Directory">
        <form className="toolbar" role="search" onSubmit={applySearch}>
          <label htmlFor="people-search" className="visually-hidden">
            Search employees
          </label>
          <input
            id="people-search"
            type="search"
            placeholder="Search name, e-mail or employee no."
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            maxLength={100}
          />
          <label htmlFor="people-department" className="visually-hidden">
            Department
          </label>
          <select id="people-department" value={filters.departmentId} onChange={updateFilter('departmentId')}>
            <option value="">All departments</option>
            {(departments.data?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <label htmlFor="people-status" className="visually-hidden">
            Status
          </label>
          <select id="people-status" value={filters.status} onChange={updateFilter('status')}>
            <option value="">All statuses</option>
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
          <button type="submit">Search</button>
          {hasFilters ? (
            <button type="button" onClick={clearFilters}>
              Clear
            </button>
          ) : null}
        </form>

        {departments.error ? <ErrorState error={departments.error} /> : null}

        {list.loading ? (
          <Loading rows={6} label="Loading employees" />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !page || page.items.length === 0 ? (
          <Empty
            title="No employees found"
            hint={hasFilters ? 'Try clearing the filters.' : 'Employees will appear here once they are added.'}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">No.</th>
                    <th scope="col">Name</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Department</th>
                    <th scope="col">Status</th>
                    <th scope="col">Hire date</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((employee) => {
                    const selected = employee.id === selectedId
                    return (
                      <tr
                        key={employee.id}
                        onClick={() => setSelectedId(employee.id)}
                        style={{
                          cursor: 'pointer',
                          background: selected ? 'var(--accent-soft)' : undefined,
                        }}
                      >
                        <td className="mono">{employee.employeeNo}</td>
                        <td>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedId(employee.id)
                            }}
                            aria-pressed={selected}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              color: 'var(--accent)',
                              fontWeight: 500,
                              textAlign: 'left',
                            }}
                          >
                            {fullName(employee)}
                          </button>
                        </td>
                        <td>{employee.email}</td>
                        <td>
                          {employee.departmentId
                            ? departmentNames.get(employee.departmentId) ?? (
                                <span className="mono">{employee.departmentId}</span>
                              )
                            : '—'}
                        </td>
                        <td>
                          <Badge value={employee.status} />
                        </td>
                        <td>{formatDate(employee.hireDate)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div
              className="toolbar"
              style={{ marginTop: 12, marginBottom: 0, justifyContent: 'space-between' }}
            >
              <span role="status" aria-live="polite" style={{ color: 'var(--text-muted)' }}>
                Showing {from}–{to} of {page.total.toLocaleString()}
              </span>
              {page.hasMore || page.offset > 0 ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    disabled={page.offset === 0}
                    onClick={() => setOffset(Math.max(0, page.offset - page.limit))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={!page.hasMore}
                    onClick={() => setOffset(page.offset + page.limit)}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </Card>

      {selectedId ? (
        <div style={{ marginTop: 16 }}>
          <EmployeeDetail
            key={selectedId}
            id={selectedId}
            departments={departments.data?.departments ?? []}
            positions={positions.data?.positions ?? []}
            departmentNames={departmentNames}
            employeeNames={employeeNames}
            canUpdate={canUpdate}
            canReadCompensation={canReadCompensation}
            onClose={() => setSelectedId(null)}
            onChanged={() => list.reload()}
          />
        </div>
      ) : null}
    </Shell>
  )
}

// --- Create ------------------------------------------------------------------

interface CreateForm {
  employeeNo: string
  firstName: string
  lastName: string
  email: string
  phone: string
  departmentId: string
  positionId: string
  managerId: string
  hireDate: string
  employmentType: string
}

const EMPTY_CREATE: CreateForm = {
  employeeNo: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  departmentId: '',
  positionId: '',
  managerId: '',
  hireDate: '',
  employmentType: 'FULL_TIME',
}

function CreateEmployeeForm({
  departments,
  positions,
  onCreated,
  onCancel,
}: {
  departments: Department[]
  positions: Position[]
  onCreated(employee: Employee): void
  onCancel(): void
}) {
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const issues = fieldIssues(error)

  const set =
    (key: keyof CreateForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.target.value
      setForm((f) => ({ ...f, [key]: value }))
    }

  const invalid = (key: keyof CreateForm) => (issues[key] ? true : undefined)
  const describedBy = (key: keyof CreateForm) => (issues[key] ? `create-${key}-error` : undefined)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        employeeNo: form.employeeNo.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        hireDate: form.hireDate,
        employmentType: form.employmentType,
      }
      if (form.phone.trim()) body.phone = form.phone.trim()
      if (form.departmentId) body.departmentId = form.departmentId
      if (form.positionId) body.positionId = form.positionId
      if (form.managerId.trim()) body.managerId = form.managerId.trim()

      const result = await api<{ employee: Employee }>('/employees', { method: 'POST', body })
      onCreated(result.employee)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card
      title="Add employee"
      actions={
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      }
    >
      <form onSubmit={submit} noValidate>
        <SubmitError error={error} />
        <div className="form-row">
          <Field id="create-employeeNo" label="Employee no." error={issues.employeeNo}>
            <input
              id="create-employeeNo"
              value={form.employeeNo}
              onChange={set('employeeNo')}
              required
              maxLength={40}
              aria-invalid={invalid('employeeNo')}
              aria-describedby={describedBy('employeeNo')}
            />
          </Field>
          <Field id="create-firstName" label="First name" error={issues.firstName}>
            <input
              id="create-firstName"
              value={form.firstName}
              onChange={set('firstName')}
              required
              maxLength={80}
              autoComplete="off"
              aria-invalid={invalid('firstName')}
              aria-describedby={describedBy('firstName')}
            />
          </Field>
          <Field id="create-lastName" label="Last name" error={issues.lastName}>
            <input
              id="create-lastName"
              value={form.lastName}
              onChange={set('lastName')}
              required
              maxLength={80}
              autoComplete="off"
              aria-invalid={invalid('lastName')}
              aria-describedby={describedBy('lastName')}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field id="create-email" label="E-mail" error={issues.email}>
            <input
              id="create-email"
              type="email"
              value={form.email}
              onChange={set('email')}
              required
              maxLength={254}
              autoComplete="off"
              aria-invalid={invalid('email')}
              aria-describedby={describedBy('email')}
            />
          </Field>
          <Field id="create-phone" label="Phone" error={issues.phone} hint="Optional">
            <input
              id="create-phone"
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              maxLength={40}
              autoComplete="off"
              aria-invalid={invalid('phone')}
              aria-describedby={describedBy('phone')}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field id="create-departmentId" label="Department" error={issues.departmentId}>
            <select
              id="create-departmentId"
              value={form.departmentId}
              onChange={set('departmentId')}
              aria-invalid={invalid('departmentId')}
              aria-describedby={describedBy('departmentId')}
            >
              <option value="">— None —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="create-positionId" label="Position" error={issues.positionId}>
            <select
              id="create-positionId"
              value={form.positionId}
              onChange={set('positionId')}
              aria-invalid={invalid('positionId')}
              aria-describedby={describedBy('positionId')}
            >
              <option value="">— None —</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                  {p.level ? ` (${p.level})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id="create-managerId"
            label="Manager id"
            error={issues.managerId}
            hint="Optional. The employee id of the line manager."
          >
            <input
              id="create-managerId"
              className="mono"
              value={form.managerId}
              onChange={set('managerId')}
              maxLength={40}
              autoComplete="off"
              aria-invalid={invalid('managerId')}
              aria-describedby={describedBy('managerId')}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field id="create-hireDate" label="Hire date" error={issues.hireDate}>
            <input
              id="create-hireDate"
              type="date"
              value={form.hireDate}
              onChange={set('hireDate')}
              required
              aria-invalid={invalid('hireDate')}
              aria-describedby={describedBy('hireDate')}
            />
          </Field>
          <Field id="create-employmentType" label="Employment type" error={issues.employmentType}>
            <select
              id="create-employmentType"
              value={form.employmentType}
              onChange={set('employmentType')}
              aria-invalid={invalid('employmentType')}
              aria-describedby={describedBy('employmentType')}
            >
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create employee'}
          </button>
        </div>
      </form>
    </Card>
  )
}

// --- Detail ------------------------------------------------------------------

function EmployeeDetail({
  id,
  departments,
  positions,
  departmentNames,
  employeeNames,
  canUpdate,
  canReadCompensation,
  onClose,
  onChanged,
}: {
  id: string
  departments: Department[]
  positions: Position[]
  departmentNames: Map<string, string>
  employeeNames: Map<string, string>
  canUpdate: boolean
  canReadCompensation: boolean
  onClose(): void
  onChanged(): void
}) {
  const detail = useApi<{ employee: Employee }>(`/employees/${encodeURIComponent(id)}`)
  const [message, setMessage] = useState<string | null>(null)
  const employee = detail.data?.employee ?? null

  const positionTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of positions) map.set(p.id, p.level ? `${p.title} (${p.level})` : p.title)
    return map
  }, [positions])

  return (
    <Card
      title={employee ? fullName(employee) : 'Employee'}
      actions={
        <button type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      {detail.loading ? (
        <Loading rows={4} label="Loading employee" />
      ) : detail.error ? (
        <ErrorState error={detail.error} />
      ) : !employee ? (
        <Empty title="Employee not found" />
      ) : (
        <>
          {message ? (
            <div className="notice info" role="status" aria-live="polite">
              {message}
            </div>
          ) : null}

          <div className="grid kpi" style={{ marginBottom: 16 }}>
            <Detail label="Employee no.">
              <span className="mono">{employee.employeeNo}</span>
            </Detail>
            <Detail label="Status">
              <Badge value={employee.status} />
            </Detail>
            <Detail label="E-mail">
              <a href={`mailto:${employee.email}`}>{employee.email}</a>
            </Detail>
            <Detail label="Phone">{employee.phone ?? '—'}</Detail>
            <Detail label="Department">
              {employee.departmentId ? (
                departmentNames.get(employee.departmentId) ?? (
                  <span className="mono">{employee.departmentId}</span>
                )
              ) : (
                '—'
              )}
            </Detail>
            <Detail label="Position">
              {employee.positionId ? (
                positionTitles.get(employee.positionId) ?? (
                  <span className="mono">{employee.positionId}</span>
                )
              ) : (
                '—'
              )}
            </Detail>
            <Detail label="Manager">
              {employee.managerId ? (
                <>
                  {employeeNames.get(employee.managerId) ? (
                    <div>{employeeNames.get(employee.managerId)}</div>
                  ) : null}
                  <span className="mono">{employee.managerId}</span>
                </>
              ) : (
                '—'
              )}
            </Detail>
            <Detail label="Employment type">
              <Badge value={employee.employmentType} />
            </Detail>
            <Detail label="Hire date">{formatDate(employee.hireDate)}</Detail>
            <Detail label="Last updated">{formatDateTime(employee.updatedAt)}</Detail>
          </div>

          {canUpdate ? (
            <section style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 4 }}>
              <h3 style={{ marginBottom: 10 }}>Edit basics</h3>
              <EditBasicsForm
                key={employee.updatedAt}
                employee={employee}
                departments={departments}
                positions={positions}
                onSaved={(updated) => {
                  setMessage(`Saved changes for ${fullName(updated)}.`)
                  detail.reload()
                  onChanged()
                }}
              />
            </section>
          ) : null}

          {canReadCompensation ? (
            <section style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 16 }}>
              <CompensationSection employeeId={employee.id} employeeName={fullName(employee)} />
            </section>
          ) : null}
        </>
      )}
    </Card>
  )
}

// --- Edit basics -------------------------------------------------------------

interface EditForm {
  status: string
  departmentId: string
  positionId: string
  managerId: string
}

function EditBasicsForm({
  employee,
  departments,
  positions,
  onSaved,
}: {
  employee: Employee
  departments: Department[]
  positions: Position[]
  onSaved(employee: Employee): void
}) {
  const [form, setForm] = useState<EditForm>({
    status: employee.status,
    departmentId: employee.departmentId ?? '',
    positionId: employee.positionId ?? '',
    managerId: employee.managerId ?? '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [note, setNote] = useState<string | null>(null)
  const issues = fieldIssues(error)

  const set =
    (key: keyof EditForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.target.value
      setNote(null)
      setForm((f) => ({ ...f, [key]: value }))
    }

  // Only changed, non-empty values are sent. The API treats an empty value as
  // "not provided", so clearing a field is not offered here.
  const changes = useMemo(() => {
    const body: Record<string, string> = {}
    if (form.status !== employee.status) body.status = form.status
    if (form.departmentId && form.departmentId !== (employee.departmentId ?? '')) {
      body.departmentId = form.departmentId
    }
    if (form.positionId && form.positionId !== (employee.positionId ?? '')) {
      body.positionId = form.positionId
    }
    const manager = form.managerId.trim()
    if (manager && manager !== (employee.managerId ?? '')) body.managerId = manager
    return body
  }, [form, employee])

  const dirty = Object.keys(changes).length > 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!dirty) {
      setNote('No changes to save.')
      return
    }
    if (changes.status !== undefined) {
      const ok = window.confirm(
        `Change the status of ${fullName(employee)} from ${humanize(employee.status)} to ${humanize(changes.status)}? This change is audited.`,
      )
      if (!ok) return
    }
    setSubmitting(true)
    setError(null)
    setNote(null)
    try {
      const result = await api<{ employee: Employee }>(
        `/employees/${encodeURIComponent(employee.id)}`,
        { method: 'PUT', body: changes },
      )
      onSaved(result.employee)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <SubmitError error={error} />
      <div className="form-row">
        <Field id="edit-status" label="Status" error={issues.status}>
          <select
            id="edit-status"
            value={form.status}
            onChange={set('status')}
            aria-invalid={issues.status ? true : undefined}
            aria-describedby={issues.status ? 'edit-status-error' : undefined}
          >
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="edit-departmentId" label="Department" error={issues.departmentId}>
          <select
            id="edit-departmentId"
            value={form.departmentId}
            onChange={set('departmentId')}
            aria-invalid={issues.departmentId ? true : undefined}
            aria-describedby={issues.departmentId ? 'edit-departmentId-error' : undefined}
          >
            {employee.departmentId ? null : <option value="">— None —</option>}
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="edit-positionId" label="Position" error={issues.positionId}>
          <select
            id="edit-positionId"
            value={form.positionId}
            onChange={set('positionId')}
            aria-invalid={issues.positionId ? true : undefined}
            aria-describedby={issues.positionId ? 'edit-positionId-error' : undefined}
          >
            {employee.positionId ? null : <option value="">— None —</option>}
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
                {p.level ? ` (${p.level})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="edit-managerId"
          label="Manager id"
          error={issues.managerId}
          hint="The employee id of the line manager."
        >
          <input
            id="edit-managerId"
            className="mono"
            value={form.managerId}
            onChange={set('managerId')}
            maxLength={40}
            autoComplete="off"
            aria-invalid={issues.managerId ? true : undefined}
            aria-describedby={issues.managerId ? 'edit-managerId-error' : undefined}
          />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'flex-end' }}>
        <span role="status" aria-live="polite" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {note}
        </span>
        <button type="submit" className="primary" disabled={submitting || !dirty}>
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

// --- Compensation (RESTRICTED) ------------------------------------------------

type CompensationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; data: Compensation | null }
  | { status: 'error'; error: unknown }

function CompensationSection({
  employeeId,
  employeeName,
}: {
  employeeId: string
  employeeName: string
}) {
  const [state, setState] = useState<CompensationState>({ status: 'idle' })
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ baseSalary: '', currency: '', effectiveFrom: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const issues = fieldIssues(error)

  const path = `/employees/${encodeURIComponent(employeeId)}/compensation`

  async function load() {
    setState({ status: 'loading' })
    try {
      const result = await api<{ compensation: Compensation | null }>(path)
      setState({ status: 'loaded', data: result.compensation })
    } catch (e) {
      setState({ status: 'error', error: e })
    }
  }

  const set =
    (key: 'baseSalary' | 'currency' | 'effectiveFrom') => (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value
      setForm((f) => ({ ...f, [key]: value }))
    }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const baseSalary = Number(form.baseSalary)
    const currency = form.currency.trim().toUpperCase()
    const ok = window.confirm(
      `Set compensation for ${employeeName} to ${form.baseSalary || '—'} ${currency || '—'} effective ${form.effectiveFrom || '—'}? This is RESTRICTED data and the change is audited.`,
    )
    if (!ok) return
    setSubmitting(true)
    setError(null)
    setSaved(null)
    try {
      await api<{ ok: true }>(path, {
        method: 'PUT',
        body: {
          baseSalary: form.baseSalary.trim() === '' ? undefined : baseSalary,
          currency,
          effectiveFrom: form.effectiveFrom,
        },
      })
      setSaved(`Compensation saved for ${employeeName}.`)
      setShowForm(false)
      setForm({ baseSalary: '', currency: '', effectiveFrom: '' })
      await load()
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <div className="card-header" style={{ marginBottom: 10 }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Compensation <Badge value="RESTRICTED" />
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {state.status === 'idle' || state.status === 'error' ? (
            <button type="button" onClick={() => void load()}>
              Load compensation
            </button>
          ) : state.status === 'loaded' ? (
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
          ) : null}
          <button type="button" onClick={() => setShowForm((v) => !v)} disabled={submitting}>
            {showForm ? 'Cancel' : 'Set compensation'}
          </button>
        </div>
      </div>

      <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 12 }}>
        Salary data is restricted and every read is audited. It is loaded only when you ask for it.
      </p>

      {saved ? (
        <div className="notice info" role="status" aria-live="polite">
          {saved}
        </div>
      ) : null}

      {state.status === 'idle' ? (
        <Empty title="Not loaded" hint="Use “Load compensation” to view the current record." />
      ) : state.status === 'loading' ? (
        <Loading rows={2} label="Loading compensation" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} />
      ) : state.data === null ? (
        <Empty title="No compensation on record" hint="No record is effective today." />
      ) : (
        <div className="grid kpi">
          <Detail label="Base salary">
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
              {state.data.baseSalary.toLocaleString()}
            </span>
          </Detail>
          <Detail label="Currency">
            <span className="mono">{state.data.currency}</span>
          </Detail>
          <Detail label="Effective from">{formatDate(state.data.effectiveFrom)}</Detail>
        </div>
      )}

      {showForm ? (
        <form onSubmit={submit} noValidate style={{ marginTop: 14 }}>
          <SubmitError error={error} />
          <div className="form-row">
            <Field id="comp-baseSalary" label="Base salary" error={issues.baseSalary}>
              <input
                id="comp-baseSalary"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.baseSalary}
                onChange={set('baseSalary')}
                required
                aria-invalid={issues.baseSalary ? true : undefined}
                aria-describedby={issues.baseSalary ? 'comp-baseSalary-error' : undefined}
              />
            </Field>
            <Field id="comp-currency" label="Currency" error={issues.currency} hint="Three-letter code, e.g. USD">
              <input
                id="comp-currency"
                className="mono"
                value={form.currency}
                onChange={set('currency')}
                required
                minLength={3}
                maxLength={3}
                autoComplete="off"
                aria-invalid={issues.currency ? true : undefined}
                aria-describedby={issues.currency ? 'comp-currency-error' : undefined}
              />
            </Field>
            <Field id="comp-effectiveFrom" label="Effective from" error={issues.effectiveFrom}>
              <input
                id="comp-effectiveFrom"
                type="date"
                value={form.effectiveFrom}
                onChange={set('effectiveFrom')}
                required
                aria-invalid={issues.effectiveFrom ? true : undefined}
                aria-describedby={issues.effectiveFrom ? 'comp-effectiveFrom-error' : undefined}
              />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setShowForm(false)} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save compensation'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
