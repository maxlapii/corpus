'use client'

/**
 * People directory (CLAUDE.md §33, §35).
 *
 * Master/detail layout: the employee list on the left, and on the right either
 * the selected person (actions, then facts) or the "Add employee" form.
 *
 * GET /employees is narrowed by the API to the caller's grant — a MANAGER sees
 * only direct reports, HR sees everyone — so this page never filters for
 * security; it only shows what it was given. Compensation is RESTRICTED (§9):
 * it has its own endpoint and is fetched only when the "Salary" disclosure is
 * opened. Every `can()` check here is UX; the PolicyGateway decides (§34).
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { EmployeePicker, type PickedEmployee } from '@/components/employee-picker'
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
  formatDate,
  humanize,
} from '@/components/ui'
import { useSession } from '@/components/session'
import { api, can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Response shapes (apps/api/src/routes/employees.ts) ---------------------

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
const COMMON_CURRENCIES = ['USD', 'KHR', 'THB', 'VND', 'SGD', 'EUR', 'GBP', 'AUD', 'JPY']
const DEFAULT_STATUS = 'ACTIVE'

// --- Local helpers -----------------------------------------------------------

function fullName(e: { firstName: string; lastName: string }): string {
  return `${e.firstName} ${e.lastName}`.trim()
}

function positionLabel(p: Position): string {
  return p.level ? `${p.title} (${p.level})` : p.title
}

function toPicked(e: Employee): PickedEmployee {
  return { id: e.id, employeeNo: e.employeeNo, firstName: e.firstName, lastName: e.lastName, email: e.email }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// --- Page --------------------------------------------------------------------

interface Filters {
  query: string
  departmentId: string
  status: string
}

const DEFAULT_FILTERS: Filters = { query: '', departmentId: '', status: DEFAULT_STATUS }

type Selection = { kind: 'employee'; id: string } | { kind: 'create' } | null

export default function PeoplePage() {
  const { user } = useSession()
  const canReadAll = can(user, 'employee.read.all')
  const canReadTeam = can(user, 'employee.read.team')
  const canCreate = can(user, 'employee.create')
  const canUpdate = can(user, 'employee.update')
  const canReadCompensation = can(user, 'employee.read.compensation')

  const [queryInput, setQueryInput] = useState('')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [offset, setOffset] = useState(0)
  const [selection, setSelection] = useState<Selection>(null)
  const [panelNotice, setPanelNotice] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // Both lookups are fetched for everyone: read-only viewers need the names too.
  const departments = useApi<{ departments: Department[] }>('/departments')
  const positions = useApi<{ positions: Position[] }>('/positions')

  // Debounced search: the list refreshes 300 ms after typing stops.
  useEffect(() => {
    const term = queryInput.trim()
    if (term === filters.query) return
    const timer = setTimeout(() => {
      setFilters((f) => ({ ...f, query: term }))
      setOffset(0)
      setSelection(null)
    }, 300)
    return () => clearTimeout(timer)
  }, [queryInput, filters.query])

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

  const positionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of positions.data?.positions ?? []) map.set(p.id, positionLabel(p))
    return map
  }, [positions.data])

  const selectedId = selection?.kind === 'employee' ? selection.id : null

  // On narrow screens the detail panel sits below the list; bring it into view.
  useEffect(() => {
    if (selection && typeof window !== 'undefined' && window.innerWidth < 1200) {
      detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [selection])

  const filtersSet =
    filters.query !== '' || filters.departmentId !== '' || filters.status !== DEFAULT_STATUS

  function changeFilter(key: 'departmentId' | 'status', value: string) {
    setFilters((f) => ({ ...f, [key]: value }))
    setOffset(0)
    setSelection(null)
  }

  function clearFilters() {
    setQueryInput('')
    setFilters(DEFAULT_FILTERS)
    setOffset(0)
    setSelection(null)
  }

  function select(next: Selection) {
    setPanelNotice(null)
    setSelection(next)
  }

  if (!canReadAll && !canReadTeam) {
    return (
      <Shell>
        <PageHeader title="People" />
        <Card>
          <Empty title="You do not have access to People" hint="Ask an HR administrator." />
        </Card>
      </Shell>
    )
  }

  const page = list.data

  return (
    <Shell>
      <PageHeader
        title="People"
        description={
          canReadAll
            ? 'Everyone in the company, with their department, position and manager.'
            : 'The people who report to you.'
        }
        actions={
          canCreate ? (
            <button type="button" className="primary" onClick={() => select({ kind: 'create' })}>
              Add employee
            </button>
          ) : undefined
        }
      />

      <div className="split">
        <Card title="Directory">
          <div className="toolbar" role="search">
            <label htmlFor="people-search" className="visually-hidden">
              Search by name, e-mail or employee number
            </label>
            <input
              id="people-search"
              type="search"
              placeholder="Search by name, e-mail or employee number"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              maxLength={100}
            />
            <label htmlFor="people-department" className="visually-hidden">
              Department
            </label>
            <select
              id="people-department"
              value={filters.departmentId}
              onChange={(e) => changeFilter('departmentId', e.target.value)}
            >
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
            <select
              id="people-status"
              value={filters.status}
              onChange={(e) => changeFilter('status', e.target.value)}
            >
              <option value="">All statuses</option>
              {EMPLOYEE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
            {filtersSet ? (
              <button type="button" onClick={clearFilters}>
                Clear
              </button>
            ) : null}
          </div>

          {list.loading ? (
            <Loading rows={6} label="Loading employees" />
          ) : list.error ? (
            <ErrorState error={list.error} />
          ) : !page || page.items.length === 0 ? (
            <Empty
              title="No one matches"
              hint={
                filtersSet
                  ? 'Try a different search, or clear the filters to include everyone.'
                  : 'Employees appear here once they are added.'
              }
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Department</th>
                      <th scope="col">Position</th>
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
                          className="selectable"
                          aria-selected={selected}
                          onClick={() => select({ kind: 'employee', id: employee.id })}
                        >
                          <td>
                            <button
                              type="button"
                              className="link"
                              onClick={(e) => {
                                e.stopPropagation()
                                select({ kind: 'employee', id: employee.id })
                              }}
                            >
                              {fullName(employee)}
                            </button>
                            <div className="small-text muted">{employee.employeeNo}</div>
                          </td>
                          <td>
                            {employee.departmentId
                              ? departmentNames.get(employee.departmentId) ?? '—'
                              : '—'}
                          </td>
                          <td>
                            {employee.positionId ? positionNames.get(employee.positionId) ?? '—' : '—'}
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
              <Pager
                page={page}
                onChange={(next) => {
                  setOffset(next)
                  setSelection(null)
                }}
              />
            </>
          )}
        </Card>

        <div ref={detailRef}>
          {selection?.kind === 'create' && canCreate ? (
            <CreateEmployeeForm
              departments={departments.data?.departments ?? []}
              positions={positions.data?.positions ?? []}
              onCancel={() => select(null)}
              onCreated={(employee) => {
                setSelection({ kind: 'employee', id: employee.id })
                setPanelNotice(`Added ${fullName(employee)}.`)
                list.reload()
              }}
            />
          ) : selection?.kind === 'employee' ? (
            <EmployeeDetail
              key={selection.id}
              id={selection.id}
              departments={departments.data?.departments ?? []}
              positions={positions.data?.positions ?? []}
              departmentNames={departmentNames}
              positionNames={positionNames}
              canUpdate={canUpdate}
              canReadCompensation={canReadCompensation}
              notice={panelNotice}
              onNotice={setPanelNotice}
              onClose={() => select(null)}
              onChanged={() => list.reload()}
            />
          ) : (
            <Card>
              <Empty
                title="Select someone"
                hint={
                  canCreate
                    ? 'Choose a person from the list to see their details, or add a new employee.'
                    : 'Choose a person from the list to see their details.'
                }
              />
            </Card>
          )}
        </div>
      </div>
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
  const [manager, setManager] = useState<PickedEmployee | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const set = (key: keyof CreateForm) => (event: { target: { value: string } }) => {
    const value = event.target.value
    setForm((f) => ({ ...f, [key]: value }))
  }

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
      if (manager) body.managerId = manager.id

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
        <button type="button" className="small" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      }
    >
      <form onSubmit={submit}>
        <fieldset disabled={submitting}>
          <div className="form-row">
            <Field id="create-firstName" label="First name">
              <input
                id="create-firstName"
                value={form.firstName}
                onChange={set('firstName')}
                required
                maxLength={80}
                autoComplete="off"
              />
            </Field>
            <Field id="create-lastName" label="Last name">
              <input
                id="create-lastName"
                value={form.lastName}
                onChange={set('lastName')}
                required
                maxLength={80}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="form-row">
            <Field id="create-email" label="Work e-mail">
              <input
                id="create-email"
                type="email"
                value={form.email}
                onChange={set('email')}
                required
                maxLength={254}
                autoComplete="off"
              />
            </Field>
            <Field id="create-employeeNo" label="Employee no.">
              <input
                id="create-employeeNo"
                value={form.employeeNo}
                onChange={set('employeeNo')}
                required
                maxLength={40}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="form-row">
            <Field id="create-departmentId" label="Department">
              <select id="create-departmentId" value={form.departmentId} onChange={set('departmentId')}>
                <option value="">— None —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="create-positionId" label="Position">
              <select id="create-positionId" value={form.positionId} onChange={set('positionId')}>
                <option value="">— None —</option>
                {positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {positionLabel(p)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field id="create-hireDate" label="Hire date">
              <input
                id="create-hireDate"
                type="date"
                value={form.hireDate}
                onChange={set('hireDate')}
                required
              />
            </Field>
            <Field id="create-employmentType" label="Employment type">
              <select id="create-employmentType" value={form.employmentType} onChange={set('employmentType')}>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <details className="more">
            <summary>More options</summary>
            <Field id="create-phone" label="Phone">
              <input
                id="create-phone"
                type="tel"
                value={form.phone}
                onChange={set('phone')}
                maxLength={40}
                autoComplete="off"
              />
            </Field>
            <Field id="create-manager" label="Manager">
              <EmployeePicker id="create-manager" value={manager} onChange={setManager} disabled={submitting} />
            </Field>
          </details>

          <SubmitError error={error} />
          <div className="form-actions">
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add employee'}
            </button>
            <button type="button" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </Card>
  )
}

// --- Detail ------------------------------------------------------------------

type DetailMode = 'view' | 'edit' | 'status'

function EmployeeDetail({
  id,
  departments,
  positions,
  departmentNames,
  positionNames,
  canUpdate,
  canReadCompensation,
  notice,
  onNotice,
  onClose,
  onChanged,
}: {
  id: string
  departments: Department[]
  positions: Position[]
  departmentNames: Map<string, string>
  positionNames: Map<string, string>
  canUpdate: boolean
  canReadCompensation: boolean
  notice: string | null
  onNotice(message: string | null): void
  onClose(): void
  onChanged(): void
}) {
  const detail = useApi<{ employee: Employee }>(`/employees/${encodeURIComponent(id)}`)
  const employee = detail.data?.employee ?? null
  const [mode, setMode] = useState<DetailMode>('view')

  // The manager's name comes from their own record. A missing or refused
  // lookup shows "—" — the API decides who may be seen.
  const managerPath = employee?.managerId ? `/employees/${encodeURIComponent(employee.managerId)}` : null
  const manager = useApi<{ employee: Employee }>(managerPath)
  const managerRecord = manager.data?.employee ?? null
  const managerName = managerRecord ? fullName(managerRecord) : manager.loading ? 'Loading…' : '—'

  function switchMode(next: DetailMode) {
    onNotice(null)
    setMode((current) => (current === next ? 'view' : next))
  }

  function saved(message: string) {
    onNotice(message)
    setMode('view')
    detail.reload()
    onChanged()
  }

  return (
    <Card>
      <div className="card-header">
        <h2>
          {employee ? fullName(employee) : 'Employee'}{' '}
          {employee ? <Badge value={employee.status} /> : null}
        </h2>
        <button type="button" className="small" onClick={onClose}>
          Close
        </button>
      </div>

      {detail.loading ? (
        <Loading rows={5} label="Loading employee" />
      ) : detail.error ? (
        <ErrorState error={detail.error} />
      ) : !employee ? (
        <Empty title="Employee not found" hint="They may have been removed, or the list is out of date." />
      ) : (
        <>
          {notice ? <Notice tone="ok">{notice}</Notice> : null}

          {canUpdate ? (
            <div className="actions">
              <button
                type="button"
                className="small"
                aria-pressed={mode === 'edit'}
                onClick={() => switchMode('edit')}
              >
                Edit details
              </button>
              <button
                type="button"
                className="small"
                aria-pressed={mode === 'status'}
                onClick={() => switchMode('status')}
              >
                Change status
              </button>
            </div>
          ) : null}

          {mode === 'edit' && canUpdate ? (
            <EditDetailsForm
              key={`${employee.updatedAt}-${managerRecord?.id ?? ''}`}
              employee={employee}
              currentManager={managerRecord ? toPicked(managerRecord) : null}
              departments={departments}
              positions={positions}
              onCancel={() => setMode('view')}
              onSaved={(updated) => saved(`Saved changes for ${fullName(updated)}.`)}
            />
          ) : null}

          {mode === 'status' && canUpdate ? (
            <ChangeStatusForm
              key={employee.updatedAt}
              employee={employee}
              onCancel={() => setMode('view')}
              onSaved={(updated) => saved(`${fullName(updated)} is now ${humanize(updated.status).toLowerCase()}.`)}
            />
          ) : null}

          {canReadCompensation ? (
            <SalarySection employeeId={employee.id} onOpen={() => onNotice(null)} />
          ) : null}

          <Facts
            items={[
              { label: 'Employee no.', value: employee.employeeNo },
              { label: 'E-mail', value: <a href={`mailto:${employee.email}`}>{employee.email}</a> },
              { label: 'Phone', value: employee.phone },
              {
                label: 'Department',
                value: employee.departmentId ? departmentNames.get(employee.departmentId) ?? '—' : '—',
              },
              {
                label: 'Position',
                value: employee.positionId ? positionNames.get(employee.positionId) ?? '—' : '—',
              },
              { label: 'Manager', value: employee.managerId ? managerName : '—' },
              { label: 'Employment type', value: humanize(employee.employmentType) },
              { label: 'Hire date', value: formatDate(employee.hireDate) },
            ]}
          />
        </>
      )}
    </Card>
  )
}

// --- Edit details ------------------------------------------------------------

interface EditForm {
  firstName: string
  lastName: string
  phone: string
  departmentId: string
  positionId: string
  employmentType: string
}

/**
 * Only changed values are sent. The API treats an empty value as "not
 * provided", so a department, position or manager cannot be cleared here —
 * only replaced.
 */
function EditDetailsForm({
  employee,
  currentManager,
  departments,
  positions,
  onCancel,
  onSaved,
}: {
  employee: Employee
  currentManager: PickedEmployee | null
  departments: Department[]
  positions: Position[]
  onCancel(): void
  onSaved(employee: Employee): void
}) {
  const [form, setForm] = useState<EditForm>({
    firstName: employee.firstName,
    lastName: employee.lastName,
    phone: employee.phone ?? '',
    departmentId: employee.departmentId ?? '',
    positionId: employee.positionId ?? '',
    employmentType: employee.employmentType,
  })
  const [manager, setManager] = useState<PickedEmployee | null>(currentManager)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const set = (key: keyof EditForm) => (event: { target: { value: string } }) => {
    const value = event.target.value
    setForm((f) => ({ ...f, [key]: value }))
  }

  const changes = useMemo(() => {
    const body: Record<string, string> = {}
    const first = form.firstName.trim()
    const last = form.lastName.trim()
    const phone = form.phone.trim()
    if (first && first !== employee.firstName) body.firstName = first
    if (last && last !== employee.lastName) body.lastName = last
    if (phone && phone !== (employee.phone ?? '')) body.phone = phone
    if (form.departmentId && form.departmentId !== (employee.departmentId ?? '')) {
      body.departmentId = form.departmentId
    }
    if (form.positionId && form.positionId !== (employee.positionId ?? '')) {
      body.positionId = form.positionId
    }
    if (form.employmentType !== employee.employmentType) body.employmentType = form.employmentType
    if (manager && manager.id !== (employee.managerId ?? '')) body.managerId = manager.id
    return body
  }, [form, manager, employee])

  const dirty = Object.keys(changes).length > 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!dirty) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await api<{ employee: Employee }>(`/employees/${encodeURIComponent(employee.id)}`, {
        method: 'PUT',
        body: changes,
      })
      onSaved(result.employee)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="card flat">
      <fieldset disabled={submitting}>
        <legend>Edit details</legend>
        <div className="form-row">
          <Field id="edit-firstName" label="First name">
            <input
              id="edit-firstName"
              value={form.firstName}
              onChange={set('firstName')}
              required
              maxLength={80}
              autoComplete="off"
            />
          </Field>
          <Field id="edit-lastName" label="Last name">
            <input
              id="edit-lastName"
              value={form.lastName}
              onChange={set('lastName')}
              required
              maxLength={80}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="form-row">
          <Field id="edit-departmentId" label="Department">
            <select id="edit-departmentId" value={form.departmentId} onChange={set('departmentId')}>
              {employee.departmentId ? null : <option value="">— None —</option>}
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="edit-positionId" label="Position">
            <select id="edit-positionId" value={form.positionId} onChange={set('positionId')}>
              {employee.positionId ? null : <option value="">— None —</option>}
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {positionLabel(p)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          id="edit-manager"
          label="Manager"
          hint={employee.managerId && !manager ? 'Pick a new manager. The current one stays until you do.' : undefined}
        >
          <EmployeePicker id="edit-manager" value={manager} onChange={setManager} disabled={submitting} />
        </Field>
        <div className="form-row">
          <Field id="edit-employmentType" label="Employment type">
            <select id="edit-employmentType" value={form.employmentType} onChange={set('employmentType')}>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="edit-phone" label="Phone">
            <input
              id="edit-phone"
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              maxLength={40}
              autoComplete="off"
            />
          </Field>
        </div>
        <SubmitError error={error} />
        <div className="form-actions">
          <button type="submit" className="primary" disabled={submitting || !dirty}>
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          {!dirty ? <span className="small-text muted">Nothing changed yet.</span> : null}
        </div>
      </fieldset>
    </form>
  )
}

// --- Change status -----------------------------------------------------------

function ChangeStatusForm({
  employee,
  onCancel,
  onSaved,
}: {
  employee: Employee
  onCancel(): void
  onSaved(employee: Employee): void
}) {
  const [status, setStatus] = useState(employee.status)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const dirty = status !== employee.status

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!dirty) return
    if (status === 'TERMINATED' || status === 'SUSPENDED') {
      const question =
        status === 'TERMINATED'
          ? `Terminate ${fullName(employee)}? This marks them as no longer employed.`
          : `Suspend ${fullName(employee)}? They stay suspended until you change the status again.`
      if (!window.confirm(question)) return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await api<{ employee: Employee }>(`/employees/${encodeURIComponent(employee.id)}`, {
        method: 'PUT',
        body: { status },
      })
      onSaved(result.employee)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="card flat">
      <fieldset disabled={submitting}>
        <legend>Change status</legend>
        <Field id="status-select" label="New status">
          <select id="status-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
                {s === employee.status ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <SubmitError error={error} />
        <div className="form-actions">
          <button
            type="submit"
            className={status === 'TERMINATED' || status === 'SUSPENDED' ? 'danger' : 'primary'}
            disabled={submitting || !dirty}
          >
            {submitting ? 'Saving…' : 'Save status'}
          </button>
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  )
}

// --- Salary (RESTRICTED; loaded only when the disclosure opens) ---------------

function SalarySection({ employeeId, onOpen }: { employeeId: string; onOpen(): void }) {
  const [open, setOpen] = useState(false)
  const path = `/employees/${encodeURIComponent(employeeId)}/compensation`
  const current = useApi<{ compensation: Compensation | null }>(open ? path : null)

  const [form, setForm] = useState({ baseSalary: '', currency: 'USD', effectiveFrom: today() })
  const [seeded, setSeeded] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const record = current.data?.compensation ?? null

  // Pre-fill the form once from the current record so a small change is a small edit.
  useEffect(() => {
    if (seeded || !current.data) return
    setSeeded(true)
    if (record) {
      setForm({ baseSalary: String(record.baseSalary), currency: record.currency, effectiveFrom: today() })
    }
  }, [current.data, record, seeded])

  const currencies = useMemo(() => {
    const list = [...COMMON_CURRENCIES]
    for (const code of [record?.currency, form.currency]) {
      if (code && !list.includes(code)) list.push(code)
    }
    return list
  }, [record, form.currency])

  const set = (key: 'baseSalary' | 'currency' | 'effectiveFrom') => (event: { target: { value: string } }) => {
    const value = event.target.value
    setSaved(null)
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setSaved(null)
    try {
      await api<{ ok: true }>(path, {
        method: 'PUT',
        body: {
          baseSalary: Number(form.baseSalary),
          currency: form.currency,
          effectiveFrom: form.effectiveFrom,
        },
      })
      setSaved('Salary saved.')
      current.reload()
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <details
      className="more"
      onToggle={(e) => {
        const isOpen = (e.target as HTMLDetailsElement).open
        setOpen(isOpen)
        if (isOpen) onOpen()
      }}
    >
      <summary>Salary</summary>
      <div className="card flat">
        <p className="small-text muted">Only HR administrators can see this.</p>
        {current.loading ? (
          <Loading rows={2} label="Loading salary" />
        ) : current.error ? (
          <ErrorState error={current.error} />
        ) : current.data ? (
          <>
            {record ? (
              <Facts
                items={[
                  {
                    label: 'Current salary',
                    value: `${record.baseSalary.toLocaleString()} ${record.currency}`,
                  },
                  { label: 'Since', value: formatDate(record.effectiveFrom) },
                ]}
              />
            ) : (
              <Empty title="No salary on record" hint="Enter one below to start a record." />
            )}
            <form onSubmit={submit}>
              <fieldset disabled={submitting}>
                <legend>{record ? 'Update salary' : 'Set salary'}</legend>
                <div className="form-row">
                  <Field id="salary-amount" label="Base salary">
                    <input
                      id="salary-amount"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={form.baseSalary}
                      onChange={set('baseSalary')}
                      required
                    />
                  </Field>
                  <Field id="salary-currency" label="Currency">
                    <select id="salary-currency" value={form.currency} onChange={set('currency')}>
                      {currencies.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="salary-from" label="Effective from">
                    <input
                      id="salary-from"
                      type="date"
                      value={form.effectiveFrom}
                      onChange={set('effectiveFrom')}
                      required
                    />
                  </Field>
                </div>
                {saved ? <Notice tone="ok">{saved}</Notice> : null}
                <SubmitError error={error} />
                <div className="form-actions">
                  <button type="submit" className="primary" disabled={submitting}>
                    {submitting ? 'Saving…' : 'Save salary'}
                  </button>
                </div>
              </fieldset>
            </form>
          </>
        ) : null}
      </div>
    </details>
  )
}
