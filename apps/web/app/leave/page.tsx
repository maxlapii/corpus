'use client'

/**
 * Leave (CLAUDE.md §22, §33, §35).
 *
 * Sections, top to bottom: Approvals (only for people who can decide), then
 * "My balance" beside "Request leave", "My requests", "Holidays", and for
 * leave.manage the "Leave entitlements" admin.
 *
 * Permission checks in this file only decide what to draw; the API
 * re-authorises every call through the PolicyGateway. Every day count shown
 * here — working days, available days — was computed by the backend and is
 * displayed as received. The browser never calculates leave (§22, §38).
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
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
import { api, can, type CurrentUser, type Page } from '@/lib/api'
import { useApi, type ApiState } from '@/lib/use-api'

// --- Response shapes (apps/api/src/routes/leave.ts) --------------------------

interface LeaveType {
  id: string
  code: string
  name: string
  paid: boolean
  requiresApproval: boolean
  maxConsecutiveDays: number | null
  countsWorkingDaysOnly: boolean
  active: boolean
}

interface LeaveTypesResponse {
  leaveTypes: LeaveType[]
}

interface BalanceRow {
  id: string
  leaveTypeId: string
  year: number
  entitledDays: number
  usedDays: number
  pendingDays: number
  carriedOverDays: number
  /** Computed by the backend; shown as received. */
  availableDays: number
  leaveTypeCode: string
  leaveTypeName: string
}

interface BalanceResponse {
  /** null when the signed-in account has no employee record. */
  year: number | null
  balances: BalanceRow[]
}

type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
const LEAVE_STATUSES: LeaveStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']

interface LeaveRequestRow {
  id: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  workingDays: number
  reason: string | null
  status: LeaveStatus
  submittedAt: string
  decidedAt: string | null
  leaveTypeCode: string
  leaveTypeName: string
  employeeName: string
}

interface CreateLeaveResponse {
  request: {
    id: string
    status: LeaveStatus
    startDate: string
    endDate: string
    workingDays: number
  }
  breakdown: {
    totalDays: number
    weekendDays: number
    holidayDays: number
    chargeableDays: number
    remainingAfter: number
  }
}

interface Holiday {
  id: string
  date: string
  name: string
  region: string | null
}

interface HolidaysResponse {
  year: number
  holidays: Holiday[]
}

const PAGE_SIZE = 10

// --- Local helpers -----------------------------------------------------------

function fmtDays(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'day' : 'days'}`
}

function dateRange(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`
}

function withQuery(base: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `${base}?${encoded}` : base
}

/** A compact select for a card header; the label is for screen readers. */
function HeaderSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string
  label: string
  value: string
  onChange(value: string): void
  children: React.ReactNode
}) {
  return (
    <span>
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>
        {children}
      </select>
    </span>
  )
}

function StatusSelect({ id, value, onChange }: { id: string; value: string; onChange(value: string): void }) {
  return (
    <HeaderSelect id={id} label="Status" value={value} onChange={onChange}>
      <option value="">All statuses</option>
      {LEAVE_STATUSES.map((status) => (
        <option key={status} value={status}>
          {humanize(status)}
        </option>
      ))}
    </HeaderSelect>
  )
}

// --- Approvals ---------------------------------------------------------------

function ApprovalsCard({
  state,
  pendingCount,
  status,
  onStatus,
  onOffset,
  user,
  onDecided,
}: {
  state: ApiState<Page<LeaveRequestRow>>
  pendingCount: number | null
  status: string
  onStatus(status: string): void
  onOffset(offset: number): void
  user: CurrentUser | null
  onDecided(): void
}) {
  const [comments, setComments] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cardError, setCardError] = useState<{ id: string; error: unknown } | null>(null)
  const [missingComment, setMissingComment] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function setComment(id: string, value: string) {
    setNotice(null)
    if (missingComment === id && value.trim()) setMissingComment(null)
    setComments((current) => ({ ...current, [id]: value }))
  }

  async function decide(row: LeaveRequestRow, action: 'approve' | 'reject') {
    const comment = (comments[row.id] ?? '').trim()
    setNotice(null)
    setCardError(null)
    if (action === 'reject') {
      if (!comment) {
        setMissingComment(row.id)
        return
      }
      const ok = window.confirm(
        `Reject ${row.employeeName}'s ${row.leaveTypeName.toLowerCase()} for ${dateRange(row.startDate, row.endDate)}?`,
      )
      if (!ok) return
    }
    setBusyId(row.id)
    try {
      await api<{ ok: boolean; decision: string }>(
        `/leave/requests/${encodeURIComponent(row.id)}/${action}`,
        { method: 'POST', body: comment ? { comment } : {} },
      )
      setNotice(
        `${action === 'approve' ? 'Approved' : 'Rejected'} ${row.employeeName}'s ${row.leaveTypeName.toLowerCase()} for ${dateRange(row.startDate, row.endDate)}.`,
      )
      setComments((current) => {
        const next = { ...current }
        delete next[row.id]
        return next
      })
      onDecided()
    } catch (e) {
      setCardError({ id: row.id, error: e })
    } finally {
      setBusyId(null)
    }
  }

  const title = pendingCount !== null ? `Approvals (${pendingCount.toLocaleString()} pending)` : 'Approvals'

  return (
    <Card title={title} actions={<StatusSelect id="approval-status" value={status} onChange={onStatus} />}>
      {notice ? <Notice tone="ok">{notice}</Notice> : null}

      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !state.data || state.data.items.length === 0 ? (
        <Empty
          title={status === 'PENDING' ? 'Nothing waiting' : 'No requests to show'}
          hint={
            status === 'PENDING'
              ? 'New requests from your team appear here as soon as they are submitted.'
              : 'Change the status filter to see other requests.'
          }
        />
      ) : (
        <>
          <div className="rows">
            {state.data.items.map((row) => {
              const pending = row.status === 'PENDING'
              const isSelf = user?.employeeId !== null && user?.employeeId === row.employeeId
              const busy = busyId === row.id
              const commentId = `comment-${row.id}`
              const needsComment = missingComment === row.id
              return (
                <div className="row-card" key={row.id}>
                  <div className="row-head">
                    <strong>{row.employeeName}</strong>
                    <Badge value={row.status} />
                  </div>
                  <div className="row-meta">
                    <span>{row.leaveTypeName}</span>
                    <span>{dateRange(row.startDate, row.endDate)}</span>
                    <span>{fmtDays(row.workingDays)}</span>
                    <span>Submitted {formatDate(row.submittedAt)}</span>
                  </div>
                  {row.reason ? <p className="small-text">{row.reason}</p> : null}

                  {pending ? (
                    isSelf ? (
                      <p className="small-text muted">Your own request — someone else decides it.</p>
                    ) : (
                      <fieldset disabled={busy}>
                        <Field
                          id={commentId}
                          label="Comment"
                          hint={needsComment ? undefined : 'Optional when approving, required when rejecting.'}
                        >
                          <input
                            id={commentId}
                            type="text"
                            maxLength={500}
                            value={comments[row.id] ?? ''}
                            aria-invalid={needsComment || undefined}
                            onChange={(e) => setComment(row.id, e.target.value)}
                          />
                          {needsComment ? (
                            <div className="hint" role="alert">
                              Add a comment so the employee knows why the request was rejected.
                            </div>
                          ) : null}
                        </Field>
                        {cardError?.id === row.id ? <SubmitError error={cardError.error} /> : null}
                        <div className="actions">
                          <button
                            type="button"
                            className="primary small"
                            onClick={() => void decide(row, 'approve')}
                          >
                            {busy ? 'Working…' : 'Approve'}
                          </button>
                          <button type="button" className="danger small" onClick={() => void decide(row, 'reject')}>
                            Reject
                          </button>
                        </div>
                      </fieldset>
                    )
                  ) : row.decidedAt ? (
                    <p className="small-text muted">Decided {formatDate(row.decidedAt)}</p>
                  ) : null}
                </div>
              )
            })}
          </div>
          <Pager page={state.data} onChange={onOffset} />
        </>
      )}
    </Card>
  )
}

// --- My balance --------------------------------------------------------------

function BalanceCard({ state, hasEmployee }: { state: ApiState<BalanceResponse>; hasEmployee: boolean }) {
  const year = state.data?.year ?? null
  return (
    <Card title="My balance" actions={year !== null ? <span className="small-text muted">{year}</span> : undefined}>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !hasEmployee ? (
        <Empty
          title="No employee record yet"
          hint="Your account is not linked to an employee record, so there is no balance to show. Ask HR to link it."
        />
      ) : !state.data || state.data.balances.length === 0 ? (
        <Empty
          title={`No leave balances for ${year ?? 'this year'}`}
          hint="HR has not allocated leave to you yet. Ask HR if you expected a balance here."
        />
      ) : (
        <div className="rows">
          {state.data.balances.map((row) => (
            <div className="row-card" key={row.id}>
              <div className="row-head">
                <strong>{row.leaveTypeName}</strong>
                <span>
                  <span className="kpi-value">{row.availableDays.toLocaleString()}</span>{' '}
                  <span className="small-text muted">available</span>
                </span>
              </div>
              <div className="row-meta">
                <span>of {row.entitledDays.toLocaleString()} entitled</span>
                {row.carriedOverDays > 0 ? <span>+ {row.carriedOverDays.toLocaleString()} carried over</span> : null}
                <span>used {row.usedDays.toLocaleString()}</span>
                <span>pending {row.pendingDays.toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// --- Request leave -----------------------------------------------------------

const EMPTY_REQUEST = { leaveTypeId: '', startDate: '', endDate: '', reason: '' }

function RequestLeaveCard({
  types,
  user,
  onCreated,
}: {
  types: ApiState<LeaveTypesResponse>
  user: CurrentUser | null
  onCreated(): void
}) {
  const hasEmployee = Boolean(user?.employeeId)
  const allowed = can(user, 'leave.create.self')
  const [form, setForm] = useState(EMPTY_REQUEST)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<CreateLeaveResponse | null>(null)

  const leaveTypes = types.data?.leaveTypes ?? []
  const selected = leaveTypes.find((type) => type.id === form.leaveTypeId)

  const set = (key: keyof typeof EMPTY_REQUEST) => (event: { target: { value: string } }) => {
    const value = event.target.value
    setResult(null)
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const reason = form.reason.trim()
      const created = await api<CreateLeaveResponse>('/leave/requests', {
        method: 'POST',
        body: {
          leaveTypeId: form.leaveTypeId,
          startDate: form.startDate,
          endDate: form.endDate,
          ...(reason ? { reason } : {}),
        },
      })
      setResult(created)
      setForm(EMPTY_REQUEST)
      onCreated()
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card title="Request leave">
      {!hasEmployee ? (
        <Empty
          title="No employee record yet"
          hint="Leave can only be requested from an account linked to an employee record. Ask HR to link it."
        />
      ) : !allowed ? (
        <Empty title="Not available to your role" hint="Your role does not include requesting leave." />
      ) : types.loading ? (
        <Loading rows={2} />
      ) : types.error ? (
        <ErrorState error={types.error} />
      ) : leaveTypes.length === 0 ? (
        <Empty title="No leave types yet" hint="HR has not set up any leave types." />
      ) : (
        <form onSubmit={onSubmit}>
          <fieldset disabled={submitting}>
            <Field id="req-type" label="Leave type">
              <select id="req-type" required value={form.leaveTypeId} onChange={set('leaveTypeId')}>
                <option value="">Choose a leave type…</option>
                {leaveTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
              {selected ? (
                <div className="actions hint">
                  {selected.requiresApproval ? <Badge value="Needs approval" tone="info" /> : null}
                  <Badge value={selected.paid ? 'Paid' : 'Unpaid'} tone={selected.paid ? 'ok' : 'warn'} />
                  {selected.maxConsecutiveDays !== null ? (
                    <Badge value={`Max ${selected.maxConsecutiveDays} days`} tone="muted" />
                  ) : null}
                </div>
              ) : null}
            </Field>
            <div className="form-row">
              <Field id="req-start" label="First day">
                <input id="req-start" type="date" required value={form.startDate} onChange={set('startDate')} />
              </Field>
              <Field id="req-end" label="Last day">
                <input
                  id="req-end"
                  type="date"
                  required
                  min={form.startDate || undefined}
                  value={form.endDate}
                  onChange={set('endDate')}
                />
              </Field>
            </div>
            <Field id="req-reason" label="Reason (optional)">
              <textarea id="req-reason" rows={2} maxLength={500} value={form.reason} onChange={set('reason')} />
            </Field>

            <SubmitError error={error} />
            {result ? (
              <Notice tone="ok">
                <strong>
                  {fmtDays(result.breakdown.chargeableDays)} requested — {fmtDays(result.breakdown.remainingAfter)}{' '}
                  remaining
                </strong>
                <div className="small-text">
                  {dateRange(result.request.startDate, result.request.endDate)} ·{' '}
                  {result.request.status === 'APPROVED' ? 'approved' : 'waiting for approval'}
                </div>
                <details className="more">
                  <summary>How was this counted?</summary>
                  <Facts
                    items={[
                      { label: 'Calendar days', value: result.breakdown.totalDays.toLocaleString() },
                      { label: 'Weekend days', value: result.breakdown.weekendDays.toLocaleString() },
                      { label: 'Public holidays', value: result.breakdown.holidayDays.toLocaleString() },
                      { label: 'Working days charged', value: result.breakdown.chargeableDays.toLocaleString() },
                    ]}
                  />
                </details>
              </Notice>
            ) : null}

            <div className="form-actions">
              <button className="primary" type="submit" disabled={submitting}>
                {submitting ? 'Sending…' : 'Request leave'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </Card>
  )
}

// --- My requests -------------------------------------------------------------

function MyRequestsCard({
  state,
  status,
  onStatus,
  onOffset,
  canCancel,
  onChanged,
}: {
  state: ApiState<Page<LeaveRequestRow>>
  status: string
  onStatus(status: string): void
  onOffset(offset: number): void
  canCancel: boolean
  onChanged(): void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function cancel(row: LeaveRequestRow) {
    setNotice(null)
    setError(null)
    const ok = window.confirm(
      `Cancel your ${row.leaveTypeName.toLowerCase()} request for ${dateRange(row.startDate, row.endDate)}?`,
    )
    if (!ok) return
    setBusyId(row.id)
    try {
      const response = await api<{ ok: boolean; daysReturned: number }>(
        `/leave/requests/${encodeURIComponent(row.id)}/cancel`,
        { method: 'POST' },
      )
      setNotice(`Request cancelled. ${fmtDays(response.daysReturned)} returned to your balance.`)
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card title="My requests" actions={<StatusSelect id="my-status" value={status} onChange={onStatus} />}>
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      <SubmitError error={error} />

      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !state.data || state.data.items.length === 0 ? (
        <Empty
          title={status ? `No ${humanize(status).toLowerCase()} requests` : 'No leave requests yet'}
          hint="Requests you make appear here with their status."
        />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Dates</th>
                  <th scope="col">Days</th>
                  <th scope="col">Status</th>
                  {canCancel ? (
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.leaveTypeName}</td>
                    <td>{dateRange(row.startDate, row.endDate)}</td>
                    <td className="num">{row.workingDays.toLocaleString()}</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    {canCancel ? (
                      <td>
                        {row.status === 'PENDING' ? (
                          <button
                            type="button"
                            className="small"
                            disabled={busyId !== null}
                            onClick={() => void cancel(row)}
                          >
                            {busyId === row.id ? 'Cancelling…' : 'Cancel'}
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={state.data} onChange={onOffset} />
        </>
      )}
    </Card>
  )
}

// --- Holidays ----------------------------------------------------------------

function HolidaysCard({
  state,
  year,
  years,
  onYear,
  canManage,
  onAdded,
}: {
  state: ApiState<HolidaysResponse>
  year: number
  years: number[]
  onYear(year: number): void
  canManage: boolean
  onAdded(year: number): void
}) {
  const [form, setForm] = useState({ date: '', name: '', region: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const set = (key: 'date' | 'name' | 'region') => (event: { target: { value: string } }) => {
    const value = event.target.value
    setNotice(null)
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      const region = form.region.trim()
      const response = await api<{ holiday: Holiday }>('/holidays', {
        method: 'POST',
        body: { date: form.date, name: form.name.trim(), ...(region ? { region } : {}) },
      })
      setNotice(`Added ${response.holiday.name} on ${formatDate(response.holiday.date)}.`)
      setForm({ date: '', name: '', region: '' })
      onAdded(Number(response.holiday.date.slice(0, 4)))
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card
      title="Holidays"
      actions={
        <HeaderSelect id="holiday-year" label="Year" value={String(year)} onChange={(v) => onYear(Number(v))}>
          {years.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </HeaderSelect>
      }
    >
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !state.data || state.data.holidays.length === 0 ? (
        <Empty
          title={`No holidays for ${year}`}
          hint={canManage ? 'Add the public holidays below so they are not counted as leave.' : 'HR has not added holidays for this year yet.'}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Name</th>
                <th scope="col">Region</th>
              </tr>
            </thead>
            <tbody>
              {state.data.holidays.map((holiday) => (
                <tr key={holiday.id}>
                  <td>{formatDate(holiday.date)}</td>
                  <td>{holiday.name}</td>
                  <td>{holiday.region ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage ? (
        <details className="more">
          <summary>New holiday</summary>
          <form onSubmit={onSubmit}>
            <fieldset disabled={submitting}>
              <div className="form-row">
                <Field id="holiday-date" label="Date">
                  <input id="holiday-date" type="date" required value={form.date} onChange={set('date')} />
                </Field>
                <Field id="holiday-name" label="Name">
                  <input id="holiday-name" type="text" required maxLength={120} value={form.name} onChange={set('name')} />
                </Field>
                <Field id="holiday-region" label="Region (optional)">
                  <input id="holiday-region" type="text" maxLength={40} value={form.region} onChange={set('region')} />
                </Field>
              </div>
              {notice ? <Notice tone="ok">{notice}</Notice> : null}
              <SubmitError error={error} />
              <div className="form-actions">
                <button className="primary" type="submit" disabled={submitting}>
                  {submitting ? 'Saving…' : 'New holiday'}
                </button>
              </div>
            </fieldset>
          </form>
        </details>
      ) : null}
    </Card>
  )
}

// --- Leave entitlements (leave.manage) ----------------------------------------

function EntitlementsCard({
  types,
  defaultYear,
  years,
  onSaved,
}: {
  types: ApiState<LeaveTypesResponse>
  defaultYear: number
  years: number[]
  onSaved(employeeId: string): void
}) {
  const [employee, setEmployee] = useState<PickedEmployee | null>(null)
  const [year, setYear] = useState(String(defaultYear))
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [entitledDays, setEntitledDays] = useState('')
  const [carriedOverDays, setCarriedOverDays] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const leaveTypes = types.data?.leaveTypes ?? []
  const selectedType = leaveTypes.find((type) => type.id === leaveTypeId)

  const balances = useApi<BalanceResponse>(
    employee ? withQuery(`/leave/balance/${encodeURIComponent(employee.id)}`, { year }) : null,
  )
  const existing = useMemo(
    () => balances.data?.balances.find((row) => row.leaveTypeId === leaveTypeId) ?? null,
    [balances.data, leaveTypeId],
  )

  // Pre-fill from the current entitlement so a correction is a small edit.
  useEffect(() => {
    if (!leaveTypeId || !balances.data) return
    setEntitledDays(existing ? String(existing.entitledDays) : '')
    setCarriedOverDays(existing && existing.carriedOverDays > 0 ? String(existing.carriedOverDays) : '')
  }, [leaveTypeId, balances.data, existing])

  function choose(next: PickedEmployee | null) {
    setNotice(null)
    setError(null)
    setEmployee(next)
    setLeaveTypeId('')
    setEntitledDays('')
    setCarriedOverDays('')
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!employee || !selectedType) return
    const name = `${employee.firstName} ${employee.lastName}`
    const before = existing
      ? `${fmtDays(existing.entitledDays)}${existing.carriedOverDays > 0 ? ` + ${fmtDays(existing.carriedOverDays)} carried over` : ''}`
      : 'nothing'
    const after = `${fmtDays(Number(entitledDays || 0))}${carriedOverDays ? ` + ${fmtDays(Number(carriedOverDays))} carried over` : ''}`
    const ok = window.confirm(
      `Set ${name}'s ${year} ${selectedType.name.toLowerCase()} entitlement from ${before} to ${after}? Used and pending days are kept.`,
    )
    if (!ok) return
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      await api<{ ok: boolean }>('/leave/balance', {
        method: 'PUT',
        body: {
          employeeId: employee.id,
          leaveTypeId,
          year: Number(year),
          entitledDays: Number(entitledDays),
          ...(carriedOverDays !== '' ? { carriedOverDays: Number(carriedOverDays) } : {}),
        },
      })
      setNotice(`Saved ${name}'s ${year} ${selectedType.name.toLowerCase()} entitlement.`)
      balances.reload()
      onSaved(employee.id)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card title="Leave entitlements">
      <Field id="ent-employee" label="Employee">
        <EmployeePicker id="ent-employee" value={employee} onChange={choose} disabled={submitting} />
      </Field>

      {!employee ? (
        <Empty title="Choose an employee" hint="Search above to see and change someone's yearly entitlements." />
      ) : (
        <>
          <Field id="ent-year" label="Year">
            <select
              id="ent-year"
              value={year}
              onChange={(e) => {
                setNotice(null)
                setYear(e.target.value)
              }}
            >
              {years.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          {balances.loading ? (
            <Loading rows={2} />
          ) : balances.error ? (
            <ErrorState error={balances.error} />
          ) : !balances.data || balances.data.balances.length === 0 ? (
            <Empty
              title={`No entitlements for ${year}`}
              hint={`${employee.firstName} has no leave allocated for ${year} yet. Add one below.`}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Leave type</th>
                    <th scope="col">Entitled</th>
                    <th scope="col">Carried over</th>
                    <th scope="col">Used</th>
                    <th scope="col">Pending</th>
                    <th scope="col">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.data.balances.map((row) => (
                    <tr key={row.id}>
                      <td>{row.leaveTypeName}</td>
                      <td className="num">{row.entitledDays.toLocaleString()}</td>
                      <td className="num">{row.carriedOverDays.toLocaleString()}</td>
                      <td className="num">{row.usedDays.toLocaleString()}</td>
                      <td className="num">{row.pendingDays.toLocaleString()}</td>
                      <td className="num">
                        <strong>{row.availableDays.toLocaleString()}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {types.loading ? (
            <Loading rows={2} />
          ) : types.error ? (
            <ErrorState error={types.error} />
          ) : leaveTypes.length === 0 ? (
            <Empty title="No leave types yet" hint="A leave type is needed before an entitlement can be set." />
          ) : (
            <form onSubmit={onSubmit} className="card flat">
              <fieldset disabled={submitting}>
                <legend>{existing ? 'Change entitlement' : 'Set entitlement'}</legend>
                <div className="form-row">
                  <Field id="ent-type" label="Leave type">
                    <select
                      id="ent-type"
                      required
                      value={leaveTypeId}
                      onChange={(e) => {
                        setNotice(null)
                        setLeaveTypeId(e.target.value)
                      }}
                    >
                      <option value="">Choose a leave type…</option>
                      {leaveTypes.map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="ent-entitled" label="Entitled days">
                    <input
                      id="ent-entitled"
                      type="number"
                      required
                      min={0}
                      max={400}
                      step={0.5}
                      value={entitledDays}
                      onChange={(e) => {
                        setNotice(null)
                        setEntitledDays(e.target.value)
                      }}
                    />
                  </Field>
                  <Field id="ent-carried" label="Carried over (optional)">
                    <input
                      id="ent-carried"
                      type="number"
                      min={0}
                      max={400}
                      step={0.5}
                      value={carriedOverDays}
                      onChange={(e) => {
                        setNotice(null)
                        setCarriedOverDays(e.target.value)
                      }}
                    />
                  </Field>
                </div>
                {notice ? <Notice tone="ok">{notice}</Notice> : null}
                <SubmitError error={error} />
                <div className="form-actions">
                  <button className="primary" type="submit" disabled={submitting || !leaveTypeId}>
                    {submitting ? 'Saving…' : 'Save entitlement'}
                  </button>
                </div>
              </fieldset>
            </form>
          )}
        </>
      )}
    </Card>
  )
}

// --- Page --------------------------------------------------------------------

export default function LeavePage() {
  const { user } = useSession()
  const hasEmployee = Boolean(user?.employeeId)
  const canApprove = can(user, 'leave.approve.team') || can(user, 'leave.approve.all')
  const canReadAll = can(user, 'leave.read.all')
  const canManage = can(user, 'leave.manage')
  const canCancel = can(user, 'leave.cancel.self')
  const [currentYear] = useState(() => new Date().getFullYear())
  const years = [currentYear - 1, currentYear, currentYear + 1, currentYear + 2]

  const types = useApi<LeaveTypesResponse>('/leave/types')
  const balance = useApi<BalanceResponse>('/leave/balance/me')

  const [myStatus, setMyStatus] = useState('')
  const [myOffset, setMyOffset] = useState(0)
  const myRequests = useApi<Page<LeaveRequestRow>>(
    withQuery('/leave/requests/me', { limit: PAGE_SIZE, offset: myOffset, status: myStatus }),
  )

  const approvalsView: 'team' | 'all' = canReadAll ? 'all' : 'team'
  const [approvalStatus, setApprovalStatus] = useState('PENDING')
  const [approvalOffset, setApprovalOffset] = useState(0)
  const approvals = useApi<Page<LeaveRequestRow>>(
    canApprove
      ? withQuery('/leave/requests', {
          view: approvalsView,
          status: approvalStatus,
          limit: PAGE_SIZE,
          offset: approvalOffset,
        })
      : null,
  )
  // A one-row query just for the pending total, so the title stays right
  // whichever status filter is showing.
  const pending = useApi<Page<LeaveRequestRow>>(
    canApprove ? withQuery('/leave/requests', { view: approvalsView, status: 'PENDING', limit: 1, offset: 0 }) : null,
  )

  const [holidayYear, setHolidayYear] = useState(currentYear)
  const holidays = useApi<HolidaysResponse>(withQuery('/holidays', { year: holidayYear }))

  const refreshMine = () => {
    balance.reload()
    myRequests.reload()
  }

  return (
    <Shell>
      <PageHeader
        title="Leave"
        description="Your balance and requests, decisions for your team, and the holiday calendar."
      />

      {/* A single-column grid spaces the sections; the two-up row nests inside. */}
      <div className="grid">
        {canApprove ? (
          <ApprovalsCard
            state={approvals}
            pendingCount={pending.data?.total ?? null}
            status={approvalStatus}
            onStatus={(status) => {
              setApprovalStatus(status)
              setApprovalOffset(0)
            }}
            onOffset={setApprovalOffset}
            user={user}
            onDecided={() => {
              approvals.reload()
              pending.reload()
            }}
          />
        ) : null}

        <div className="grid two">
          <BalanceCard state={balance} hasEmployee={hasEmployee} />
          <RequestLeaveCard types={types} user={user} onCreated={refreshMine} />
        </div>

        <MyRequestsCard
          state={myRequests}
          status={myStatus}
          onStatus={(status) => {
            setMyStatus(status)
            setMyOffset(0)
          }}
          onOffset={setMyOffset}
          canCancel={canCancel && hasEmployee}
          onChanged={refreshMine}
        />

        <HolidaysCard
          state={holidays}
          year={holidayYear}
          years={years}
          onYear={setHolidayYear}
          canManage={canManage}
          onAdded={(year) => {
            if (year !== holidayYear) setHolidayYear(year)
            else holidays.reload()
          }}
        />

        {canManage ? (
          <EntitlementsCard
            types={types}
            defaultYear={currentYear}
            years={years}
            onSaved={(employeeId) => {
              if (user?.employeeId && employeeId === user.employeeId) balance.reload()
            }}
          />
        ) : null}
      </div>
    </Shell>
  )
}
