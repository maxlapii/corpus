'use client'

/**
 * Leave — self-service balance and requests, approvals for managers and HR,
 * the public holiday calendar, and balance administration
 * (CLAUDE.md §22, §33, §35).
 *
 * Permission checks in this file only decide what to draw. The API
 * re-authorises every call through the PolicyGateway, and every day count on
 * this page is one the server computed — the browser never calculates leave
 * (§22, §38).
 */

import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, ErrorState, Loading, formatDate, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import { api, ApiRequestError, can, type CurrentUser, type Page } from '@/lib/api'
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
  /** Always computed by the backend. */
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
  recurring: boolean
  region: string | null
}

interface HolidaysResponse {
  year: number
  holidays: Holiday[]
}

const PAGE_SIZE = 10

// --- Local helpers -----------------------------------------------------------

interface Issue {
  path?: string
  code?: string
  message: string
}

interface Failure {
  message: string
  issues: Issue[]
  forbidden: boolean
}

/**
 * Normalise an API failure. The API sends `details.issues` in two shapes:
 * `{ path, message }` from request validation and `{ code, message }` from the
 * leave business rules — both are listed, and path-bound ones are shown inline.
 */
function describeFailure(e: unknown): Failure {
  if (e instanceof ApiRequestError) {
    const raw = e.error.details?.issues
    const issues: Issue[] = []
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        if (typeof record.message !== 'string') continue
        issues.push({
          message: record.message,
          ...(typeof record.path === 'string' ? { path: record.path } : {}),
          ...(typeof record.code === 'string' ? { code: record.code } : {}),
        })
      }
    }
    return { message: e.error.message, issues, forbidden: e.isForbidden }
  }
  return {
    message: e instanceof Error ? e.message : 'The request failed.',
    issues: [],
    forbidden: false,
  }
}

function issueFor(failure: Failure | null, field: string): string | undefined {
  return failure?.issues.find((issue) => issue.path === field)?.message
}

function FailureNotice({ failure, fields = [] }: { failure: Failure | null; fields?: string[] }) {
  if (!failure) return null
  const general = failure.issues.filter((issue) => !issue.path || !fields.includes(issue.path))
  const inlineCount = failure.issues.length - general.length
  return (
    <div className={`notice ${failure.forbidden ? 'warn' : 'error'}`} role="alert">
      <strong>{failure.forbidden ? 'Not permitted. ' : 'Could not complete this. '}</strong>
      {failure.issues.length === 0 ? failure.message : null}
      {inlineCount > 0 && general.length === 0 ? 'Please check the highlighted fields.' : null}
      {general.length > 0 ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {general.map((issue, index) => (
            <li key={`${issue.path ?? issue.code ?? 'issue'}-${index}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <div id={id} className="hint" style={{ color: 'var(--danger)' }}>
      {message}
    </div>
  )
}

/** The aria-live container exists before any message appears, so it announces. */
function LiveRegion({ children }: { children: ReactNode }) {
  return <div aria-live="polite">{children}</div>
}

function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice info" role="status">
      {children}
    </div>
  )
}

function fmtDays(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'day' : 'days'}`
}

function dateRange(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`
}

function titleCase(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

function listPath(base: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `${base}?${encoded}` : base
}

const FIELDSET: CSSProperties = { border: 0, padding: 0, margin: 0, minWidth: 0 }
const DL: CSSProperties = {
  margin: '10px 0 0',
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '2px 12px',
  fontSize: 12,
}
const DT: CSSProperties = { color: 'var(--text-muted)' }
const DD: CSSProperties = { margin: 0, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

function Pager({ page, onOffset }: { page: Page<unknown>; onOffset(offset: number): void }) {
  const from = page.total === 0 ? 0 : page.offset + 1
  const to = Math.min(page.offset + page.items.length, page.total)
  const paged = page.hasMore || page.offset > 0
  return (
    <div className="toolbar" style={{ marginTop: 12, marginBottom: 0, justifyContent: 'space-between' }}>
      <span className="kpi-sub" aria-live="polite">
        Showing {from}–{to} of {page.total.toLocaleString()}
      </span>
      {paged ? (
        <span style={{ display: 'flex', gap: 8 }}>
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
        </span>
      ) : null}
    </div>
  )
}

function StatusFilter({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange(value: string): void
}) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label htmlFor={id} className="kpi-label">
        Status
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>
        <option value="">All</option>
        {LEAVE_STATUSES.map((status) => (
          <option key={status} value={status}>
            {titleCase(status)}
          </option>
        ))}
      </select>
    </span>
  )
}

// --- My balance --------------------------------------------------------------

function BalanceSection({ state, hasEmployee }: { state: ApiState<BalanceResponse>; hasEmployee: boolean }) {
  const year = state.data?.year ?? null
  return (
    <Card title="My balance" actions={year !== null ? <span className="kpi-sub">Year {year}</span> : undefined}>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !state.data || state.data.balances.length === 0 ? (
        hasEmployee ? (
          <Empty
            title={`No leave balances for ${year ?? 'this year'}`}
            hint="HR has not allocated leave to you yet. Contact HR if you expected a balance here."
          />
        ) : (
          <Empty
            title="No employee record linked"
            hint="Your account is not linked to an employee record, so there is no balance to show and leave cannot be requested. Contact HR to have your account linked."
          />
        )
      ) : (
        <div className="grid kpi">
          {state.data.balances.map((row) => {
            const available = row.entitledDays + row.carriedOverDays - row.usedDays - row.pendingDays
            return (
              <div className="card" key={row.id} style={{ boxShadow: 'none', background: 'var(--surface-alt)' }}>
                <div className="kpi-label">{row.leaveTypeName}</div>
                <div className="kpi-value">{available.toLocaleString()}</div>
                <div className="kpi-sub">
                  available · {row.leaveTypeCode}
                </div>
                <dl style={DL}>
                  <dt style={DT}>Entitled</dt>
                  <dd style={DD}>{row.entitledDays.toLocaleString()}</dd>
                  <dt style={DT}>Carried over</dt>
                  <dd style={DD}>{row.carriedOverDays.toLocaleString()}</dd>
                  <dt style={DT}>Used</dt>
                  <dd style={DD}>{row.usedDays.toLocaleString()}</dd>
                  <dt style={DT}>Pending</dt>
                  <dd style={DD}>{row.pendingDays.toLocaleString()}</dd>
                </dl>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// --- Request leave -----------------------------------------------------------

const REQUEST_FIELDS = ['leaveTypeId', 'startDate', 'endDate', 'reason']

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
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [result, setResult] = useState<CreateLeaveResponse | null>(null)

  const leaveTypes = types.data?.leaveTypes ?? []
  const selected = leaveTypes.find((type) => type.id === leaveTypeId)
  const blocked = !allowed || !hasEmployee

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (blocked) return
    setSubmitting(true)
    setFailure(null)
    setResult(null)
    try {
      const trimmed = reason.trim()
      const created = await api<CreateLeaveResponse>('/leave/requests', {
        method: 'POST',
        body: {
          leaveTypeId,
          startDate,
          endDate,
          ...(trimmed ? { reason: trimmed } : {}),
        },
      })
      setResult(created)
      setStartDate('')
      setEndDate('')
      setReason('')
      onCreated()
    } catch (e) {
      setFailure(describeFailure(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card title="Request leave">
      {!hasEmployee ? (
        <div className="notice warn" role="status">
          <strong>No employee record linked. </strong>
          Leave can only be requested from an account linked to an employee record. Contact HR.
        </div>
      ) : !allowed ? (
        <div className="notice warn" role="status">
          <strong>Not available to your role. </strong>
          Your role does not include submitting leave requests.
        </div>
      ) : null}

      {types.loading ? (
        <Loading rows={2} />
      ) : types.error ? (
        <ErrorState error={types.error} />
      ) : leaveTypes.length === 0 ? (
        <Empty title="No leave types configured" hint="HR has not set up any leave types yet." />
      ) : (
        <form onSubmit={onSubmit}>
          <fieldset disabled={blocked || submitting} style={FIELDSET}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="req-type">Leave type</label>
                <select
                  id="req-type"
                  required
                  value={leaveTypeId}
                  onChange={(e) => setLeaveTypeId(e.target.value)}
                  aria-describedby="req-type-hint req-type-error"
                >
                  <option value="">Select a leave type…</option>
                  {leaveTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
                <FieldError id="req-type-error" message={issueFor(failure, 'leaveTypeId')} />
              </div>
              <div className="field">
                <label htmlFor="req-start">First day</label>
                <input
                  id="req-start"
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  aria-describedby="req-start-error"
                />
                <FieldError id="req-start-error" message={issueFor(failure, 'startDate')} />
              </div>
              <div className="field">
                <label htmlFor="req-end">Last day</label>
                <input
                  id="req-end"
                  type="date"
                  required
                  min={startDate || undefined}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  aria-describedby="req-end-error"
                />
                <FieldError id="req-end-error" message={issueFor(failure, 'endDate')} />
              </div>
            </div>
            <div className="hint" id="req-type-hint" style={{ marginBottom: 12 }}>
              {selected
                ? [
                    selected.requiresApproval
                      ? 'Requires approval by your manager.'
                      : 'Approved automatically on submission.',
                    selected.countsWorkingDaysOnly
                      ? 'Weekends and public holidays are not charged.'
                      : 'Every calendar day in the range is charged.',
                    selected.maxConsecutiveDays !== null
                      ? `At most ${selected.maxConsecutiveDays} consecutive days.`
                      : '',
                    selected.paid ? '' : 'This leave is unpaid.',
                  ]
                    .filter(Boolean)
                    .join(' ')
                : 'The server calculates working days when you submit: weekends, public holidays, overlaps and your balance are all checked there.'}
            </div>
            <div className="field">
              <label htmlFor="req-reason">
                Reason <span style={{ fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea
                id="req-reason"
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-describedby="req-reason-error"
              />
              <FieldError id="req-reason-error" message={issueFor(failure, 'reason')} />
            </div>
            <button className="primary" type="submit" disabled={blocked || submitting}>
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </fieldset>
        </form>
      )}

      <LiveRegion>
        {failure ? (
          <div style={{ marginTop: 14 }}>
            <FailureNotice failure={failure} fields={REQUEST_FIELDS} />
          </div>
        ) : null}
        {result ? (
          <div style={{ marginTop: 14 }}>
            <SuccessNotice>
              <strong>Request submitted. </strong>
              <Badge value={result.request.status} />{' '}
              for {dateRange(result.request.startDate, result.request.endDate)}.
              <div style={{ marginTop: 8 }}>
                Days as calculated by the server — this page did not count them:
              </div>
              <dl style={{ ...DL, maxWidth: 360, fontSize: 13 }}>
                <dt style={DT}>Calendar days in range</dt>
                <dd style={DD}>{result.breakdown.totalDays.toLocaleString()}</dd>
                <dt style={DT}>Weekend days (not charged)</dt>
                <dd style={DD}>{result.breakdown.weekendDays.toLocaleString()}</dd>
                <dt style={DT}>Public holidays (not charged)</dt>
                <dd style={DD}>{result.breakdown.holidayDays.toLocaleString()}</dd>
                <dt style={{ ...DT, fontWeight: 600 }}>Chargeable days</dt>
                <dd style={{ ...DD, fontWeight: 600 }}>{result.breakdown.chargeableDays.toLocaleString()}</dd>
                <dt style={DT}>Remaining after this request</dt>
                <dd style={DD}>{result.breakdown.remainingAfter.toLocaleString()}</dd>
              </dl>
            </SuccessNotice>
          </div>
        ) : null}
      </LiveRegion>
    </Card>
  )
}

// --- My requests -------------------------------------------------------------

function MyRequestsCard({
  state,
  status,
  onStatus,
  onOffset,
  user,
  onChanged,
}: {
  state: ApiState<Page<LeaveRequestRow>>
  status: string
  onStatus(status: string): void
  onOffset(offset: number): void
  user: CurrentUser | null
  onChanged(): void
}) {
  const allowedCancel = can(user, 'leave.cancel.self')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function cancel(row: LeaveRequestRow) {
    const approvedNote =
      row.status === 'APPROVED'
        ? ' This leave was already approved; cancelling returns the days to your balance.'
        : ''
    const confirmed = window.confirm(
      `Cancel your ${row.leaveTypeName} request for ${dateRange(row.startDate, row.endDate)} (${fmtDays(row.workingDays)})?${approvedNote}`,
    )
    if (!confirmed) return
    setBusyId(row.id)
    setFailure(null)
    setMessage(null)
    try {
      const response = await api<{ ok: boolean; daysReturned: number }>(
        `/leave/requests/${encodeURIComponent(row.id)}/cancel`,
        { method: 'POST' },
      )
      setMessage(
        `Request cancelled. ${fmtDays(response.daysReturned)} returned to your ${row.leaveTypeName} balance.`,
      )
      onChanged()
    } catch (e) {
      setFailure(describeFailure(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card title="My requests" actions={<StatusFilter id="my-status" value={status} onChange={onStatus} />}>
      <LiveRegion>
        {message ? <SuccessNotice>{message}</SuccessNotice> : null}
        <FailureNotice failure={failure} />
      </LiveRegion>

      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !state.data || state.data.items.length === 0 ? (
        <Empty
          title={status ? `No ${titleCase(status).toLowerCase()} requests` : 'No leave requests yet'}
          hint="Requests you submit appear here with their status and the days the server charged."
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
                  <th scope="col">Submitted</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((row) => {
                  const open = row.status === 'PENDING' || row.status === 'APPROVED'
                  return (
                    <tr key={row.id}>
                      <td>{row.leaveTypeName}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{dateRange(row.startDate, row.endDate)}</td>
                      <td className="num">{row.workingDays.toLocaleString()}</td>
                      <td>
                        <Badge value={row.status} />
                        {row.decidedAt ? <div className="kpi-sub">{formatDateTime(row.decidedAt)}</div> : null}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.submittedAt)}</td>
                      <td style={{ maxWidth: 260 }}>{row.reason ?? '—'}</td>
                      <td>
                        {allowedCancel && open ? (
                          <button type="button" disabled={busyId !== null} onClick={() => void cancel(row)}>
                            {busyId === row.id ? 'Cancelling…' : 'Cancel'}
                          </button>
                        ) : (
                          <span className="kpi-sub">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager page={state.data} onOffset={onOffset} />
        </>
      )}
    </Card>
  )
}

// --- Approvals ---------------------------------------------------------------

function ApprovalsCard({
  state,
  view,
  status,
  onStatus,
  onOffset,
  user,
  onDecided,
}: {
  state: ApiState<Page<LeaveRequestRow>>
  view: 'team' | 'all'
  status: string
  onStatus(status: string): void
  onOffset(offset: number): void
  user: CurrentUser | null
  onDecided(): void
}) {
  const [comments, setComments] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function decide(row: LeaveRequestRow, action: 'approve' | 'reject') {
    const comment = (comments[row.id] ?? '').trim()
    const verb = action === 'approve' ? 'Approve' : 'Reject'
    const confirmed = window.confirm(
      `${verb} the ${row.leaveTypeName} request from ${row.employeeName} for ${dateRange(row.startDate, row.endDate)} (${fmtDays(row.workingDays)})?${comment ? `\n\nComment: ${comment}` : ''}`,
    )
    if (!confirmed) return
    setBusyId(row.id)
    setFailure(null)
    setMessage(null)
    try {
      const response = await api<{ ok: boolean; decision: string; requestId: string }>(
        `/leave/requests/${encodeURIComponent(row.id)}/${action}`,
        { method: 'POST', body: comment ? { comment } : {} },
      )
      setMessage(`The request from ${row.employeeName} was ${response.decision.toLowerCase()}.`)
      setComments((current) => {
        const next = { ...current }
        delete next[row.id]
        return next
      })
      onDecided()
    } catch (e) {
      setFailure(describeFailure(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card title="Approvals" actions={<StatusFilter id="approval-status" value={status} onChange={onStatus} />}>
      <p className="kpi-sub" style={{ margin: '0 0 12px' }}>
        Showing requests from {view === 'all' ? 'all employees' : 'employees who report to you'}. The
        server checks that you may decide each request, and nobody can decide their own.
      </p>

      <LiveRegion>
        {message ? <SuccessNotice>{message}</SuccessNotice> : null}
        <FailureNotice failure={failure} />
      </LiveRegion>

      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !state.data || state.data.items.length === 0 ? (
        <Empty
          title={status ? `No ${titleCase(status).toLowerCase()} requests` : 'No requests to show'}
          hint={
            status === 'PENDING'
              ? 'Nothing is waiting for a decision right now.'
              : 'Change the status filter to see other requests.'
          }
        />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col">Type</th>
                  <th scope="col">Dates</th>
                  <th scope="col">Days</th>
                  <th scope="col">Status</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((row) => {
                  const pending = row.status === 'PENDING'
                  const isSelf = user?.employeeId !== null && user?.employeeId === row.employeeId
                  const busy = busyId !== null
                  return (
                    <tr key={row.id}>
                      <td>{row.employeeName}</td>
                      <td>{row.leaveTypeName}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{dateRange(row.startDate, row.endDate)}</td>
                      <td className="num">{row.workingDays.toLocaleString()}</td>
                      <td>
                        <Badge value={row.status} />
                        {row.decidedAt ? <div className="kpi-sub">{formatDateTime(row.decidedAt)}</div> : null}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.submittedAt)}</td>
                      <td style={{ maxWidth: 220 }}>{row.reason ?? '—'}</td>
                      <td style={{ minWidth: 260 }}>
                        {pending ? (
                          isSelf ? (
                            <span className="kpi-sub">You cannot decide your own request.</span>
                          ) : (
                            <div style={{ display: 'grid', gap: 6 }}>
                              <label className="visually-hidden" htmlFor={`comment-${row.id}`}>
                                Comment for the request from {row.employeeName} (optional)
                              </label>
                              <input
                                id={`comment-${row.id}`}
                                type="text"
                                placeholder="Comment (optional)"
                                maxLength={500}
                                value={comments[row.id] ?? ''}
                                disabled={busy}
                                onChange={(e) =>
                                  setComments((current) => ({ ...current, [row.id]: e.target.value }))
                                }
                              />
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  type="button"
                                  className="primary"
                                  disabled={busy}
                                  onClick={() => void decide(row, 'approve')}
                                >
                                  {busyId === row.id ? 'Working…' : 'Approve'}
                                </button>
                                <button type="button" disabled={busy} onClick={() => void decide(row, 'reject')}>
                                  Reject
                                </button>
                              </div>
                            </div>
                          )
                        ) : (
                          <span className="kpi-sub">Decided</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager page={state.data} onOffset={onOffset} />
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
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [region, setRegion] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setFailure(null)
    setMessage(null)
    try {
      const trimmedRegion = region.trim()
      const response = await api<{ holiday: Holiday }>('/holidays', {
        method: 'POST',
        body: {
          date,
          name: name.trim(),
          ...(trimmedRegion ? { region: trimmedRegion } : {}),
        },
      })
      setMessage(`Added ${response.holiday.name} on ${formatDate(response.holiday.date)}.`)
      setDate('')
      setName('')
      setRegion('')
      onAdded(Number(response.holiday.date.slice(0, 4)))
    } catch (e) {
      setFailure(describeFailure(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card
      title="Holidays"
      actions={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label htmlFor="holiday-year" className="kpi-label">
            Year
          </label>
          <select
            id="holiday-year"
            value={year}
            onChange={(e) => onYear(Number(e.target.value))}
            style={{ width: 'auto' }}
          >
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </span>
      }
    >
      <p className="kpi-sub" style={{ margin: '0 0 12px' }}>
        Public holidays are excluded from chargeable leave days by the server.
      </p>

      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !state.data || state.data.holidays.length === 0 ? (
        <Empty title={`No holidays recorded for ${year}`} hint="Holidays added here are used in every leave calculation." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Name</th>
                <th scope="col">Region</th>
                <th scope="col">Recurring</th>
              </tr>
            </thead>
            <tbody>
              {state.data.holidays.map((holiday) => (
                <tr key={holiday.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDate(holiday.date)}</td>
                  <td>{holiday.name}</td>
                  <td>{holiday.region ?? '—'}</td>
                  <td>{holiday.recurring ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage ? (
        <form onSubmit={onSubmit} style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 10 }}>Add a holiday</h3>
          <fieldset disabled={submitting} style={FIELDSET}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="holiday-date">Date</label>
                <input
                  id="holiday-date"
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  aria-describedby="holiday-date-error"
                />
                <FieldError id="holiday-date-error" message={issueFor(failure, 'date')} />
              </div>
              <div className="field">
                <label htmlFor="holiday-name">Name</label>
                <input
                  id="holiday-name"
                  type="text"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-describedby="holiday-name-error"
                />
                <FieldError id="holiday-name-error" message={issueFor(failure, 'name')} />
              </div>
              <div className="field">
                <label htmlFor="holiday-region">
                  Region <span style={{ fontWeight: 400 }}>(optional)</span>
                </label>
                <input
                  id="holiday-region"
                  type="text"
                  maxLength={40}
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  aria-describedby="holiday-region-error"
                />
                <FieldError id="holiday-region-error" message={issueFor(failure, 'region')} />
              </div>
            </div>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add holiday'}
            </button>
          </fieldset>
          <LiveRegion>
            {failure || message ? (
              <div style={{ marginTop: 14 }}>
                {message ? <SuccessNotice>{message}</SuccessNotice> : null}
                <FailureNotice failure={failure} fields={['date', 'name', 'region']} />
              </div>
            ) : null}
          </LiveRegion>
        </form>
      ) : null}
    </Card>
  )
}

// --- Balances admin ----------------------------------------------------------

function BalancesAdminCard({
  types,
  defaultYear,
  onSaved,
}: {
  types: ApiState<LeaveTypesResponse>
  defaultYear: number
  onSaved(employeeId: string): void
}) {
  const [employeeId, setEmployeeId] = useState('')
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [year, setYear] = useState(String(defaultYear))
  const [entitledDays, setEntitledDays] = useState('')
  const [carriedOverDays, setCarriedOverDays] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const leaveTypes = types.data?.leaveTypes ?? []
  const selected = leaveTypes.find((type) => type.id === leaveTypeId)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmedId = employeeId.trim()
    const typeName = selected?.name ?? 'the selected leave type'
    const confirmed = window.confirm(
      `Set the ${year} ${typeName} balance for employee ${trimmedId} to ${entitledDays || '0'} entitled day(s)` +
        `${carriedOverDays ? ` plus ${carriedOverDays} carried over` : ''}?\n\n` +
        'This replaces the existing entitlement for that employee, type and year. Used and pending days are kept.',
    )
    if (!confirmed) return
    setSubmitting(true)
    setFailure(null)
    setMessage(null)
    try {
      await api<{ ok: boolean }>('/leave/balance', {
        method: 'PUT',
        body: {
          employeeId: trimmedId,
          leaveTypeId,
          year: Number(year),
          entitledDays: Number(entitledDays),
          ...(carriedOverDays !== '' ? { carriedOverDays: Number(carriedOverDays) } : {}),
        },
      })
      setMessage(`Saved the ${year} ${typeName} balance for employee ${trimmedId}.`)
      onSaved(trimmedId)
    } catch (e) {
      setFailure(describeFailure(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card title="Balances admin">
      <p className="kpi-sub" style={{ margin: '0 0 12px' }}>
        Allocate or correct an entitlement. Used and pending days are never edited here; they move only
        through requests, approvals and cancellations.
      </p>

      {types.loading ? (
        <Loading rows={2} />
      ) : types.error ? (
        <ErrorState error={types.error} />
      ) : leaveTypes.length === 0 ? (
        <Empty title="No leave types configured" hint="A leave type is needed before a balance can be set." />
      ) : (
        <form onSubmit={onSubmit}>
          <fieldset disabled={submitting} style={FIELDSET}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="bal-employee">Employee ID</label>
                <input
                  id="bal-employee"
                  type="text"
                  required
                  maxLength={40}
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  aria-describedby="bal-employee-hint bal-employee-error"
                />
                <div className="hint" id="bal-employee-hint">
                  The internal record ID shown on the People page, not the employee number.
                </div>
                <FieldError id="bal-employee-error" message={issueFor(failure, 'employeeId')} />
              </div>
              <div className="field">
                <label htmlFor="bal-type">Leave type</label>
                <select
                  id="bal-type"
                  required
                  value={leaveTypeId}
                  onChange={(e) => setLeaveTypeId(e.target.value)}
                  aria-describedby="bal-type-error"
                >
                  <option value="">Select a leave type…</option>
                  {leaveTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
                <FieldError id="bal-type-error" message={issueFor(failure, 'leaveTypeId')} />
              </div>
              <div className="field">
                <label htmlFor="bal-year">Year</label>
                <input
                  id="bal-year"
                  type="number"
                  required
                  min={2000}
                  max={2100}
                  step={1}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  aria-describedby="bal-year-error"
                />
                <FieldError id="bal-year-error" message={issueFor(failure, 'year')} />
              </div>
              <div className="field">
                <label htmlFor="bal-entitled">Entitled days</label>
                <input
                  id="bal-entitled"
                  type="number"
                  required
                  min={0}
                  max={400}
                  step={0.5}
                  value={entitledDays}
                  onChange={(e) => setEntitledDays(e.target.value)}
                  aria-describedby="bal-entitled-error"
                />
                <FieldError id="bal-entitled-error" message={issueFor(failure, 'entitledDays')} />
              </div>
              <div className="field">
                <label htmlFor="bal-carried">
                  Carried over <span style={{ fontWeight: 400 }}>(optional)</span>
                </label>
                <input
                  id="bal-carried"
                  type="number"
                  min={0}
                  max={400}
                  step={0.5}
                  value={carriedOverDays}
                  onChange={(e) => setCarriedOverDays(e.target.value)}
                  aria-describedby="bal-carried-error"
                />
                <FieldError id="bal-carried-error" message={issueFor(failure, 'carriedOverDays')} />
              </div>
            </div>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save balance'}
            </button>
          </fieldset>
        </form>
      )}

      <LiveRegion>
        {failure || message ? (
          <div style={{ marginTop: 14 }}>
            {message ? <SuccessNotice>{message}</SuccessNotice> : null}
            <FailureNotice
              failure={failure}
              fields={['employeeId', 'leaveTypeId', 'year', 'entitledDays', 'carriedOverDays']}
            />
          </div>
        ) : null}
      </LiveRegion>
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
  const [currentYear] = useState(() => new Date().getFullYear())

  const types = useApi<LeaveTypesResponse>('/leave/types')
  const balance = useApi<BalanceResponse>('/leave/balance/me')

  const [myStatus, setMyStatus] = useState('')
  const [myOffset, setMyOffset] = useState(0)
  const myRequests = useApi<Page<LeaveRequestRow>>(
    listPath('/leave/requests/me', { limit: PAGE_SIZE, offset: myOffset, status: myStatus }),
  )

  const approvalsView: 'team' | 'all' = canReadAll ? 'all' : 'team'
  const [approvalStatus, setApprovalStatus] = useState('PENDING')
  const [approvalOffset, setApprovalOffset] = useState(0)
  const approvals = useApi<Page<LeaveRequestRow>>(
    canApprove
      ? listPath('/leave/requests', {
          view: approvalsView,
          status: approvalStatus,
          limit: PAGE_SIZE,
          offset: approvalOffset,
        })
      : null,
  )

  const [holidayYear, setHolidayYear] = useState(currentYear)
  const holidays = useApi<HolidaysResponse>(listPath('/holidays', { year: holidayYear }))
  const holidayYears = [currentYear - 1, currentYear, currentYear + 1, currentYear + 2]

  const refreshMine = () => {
    balance.reload()
    myRequests.reload()
  }

  return (
    <Shell>
      <PageHeader
        title="Leave"
        description="Your balance and requests, decisions for your team, and the public holiday calendar. Working days are always calculated by the server."
      />

      <div style={{ marginBottom: 14 }}>
        <BalanceSection state={balance} hasEmployee={hasEmployee} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <RequestLeaveCard types={types} user={user} onCreated={refreshMine} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <MyRequestsCard
          state={myRequests}
          status={myStatus}
          onStatus={(status) => {
            setMyStatus(status)
            setMyOffset(0)
          }}
          onOffset={setMyOffset}
          user={user}
          onChanged={refreshMine}
        />
      </div>

      {canApprove ? (
        <div style={{ marginBottom: 14 }}>
          <ApprovalsCard
            state={approvals}
            view={approvalsView}
            status={approvalStatus}
            onStatus={(status) => {
              setApprovalStatus(status)
              setApprovalOffset(0)
            }}
            onOffset={setApprovalOffset}
            user={user}
            onDecided={() => approvals.reload()}
          />
        </div>
      ) : null}

      <div className="grid two">
        <HolidaysCard
          state={holidays}
          year={holidayYear}
          years={holidayYears}
          onYear={setHolidayYear}
          canManage={canManage}
          onAdded={(year) => {
            if (year !== holidayYear) setHolidayYear(year)
            else holidays.reload()
          }}
        />
        {canManage ? (
          <BalancesAdminCard
            types={types}
            defaultYear={currentYear}
            onSaved={(employeeId) => {
              if (user?.employeeId && employeeId === user.employeeId) balance.reload()
            }}
          />
        ) : null}
      </div>
    </Shell>
  )
}
