'use client'

/**
 * Reports — aggregate analytics across people, recruitment, leave and the
 * assistant (CLAUDE.md §33, §35).
 *
 * Every figure here is an aggregate served by `/reports/*`, all of which
 * require `report.read` at the PolicyGateway. The `can()` check below only
 * decides how eagerly we fetch; the API's answer is what the user sees.
 */

import { useState } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, BarChart, Card, Empty, ErrorState, Loading, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import { api, ApiRequestError, can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Response shapes (mirrors apps/api/src/routes/reports.ts) ---------------

interface DayPoint {
  day: string
  count: number
}

interface HeadcountReport {
  byDepartment: { departmentId: string | null; departmentName: string; count: number }[]
  byStatus: Record<string, number>
}

interface RecruitmentReport {
  funnel: { stage: string; count: number }[]
  applicationsOverTime: DayPoint[]
  bySource: { source: string; count: number }[]
}

interface LeaveReport {
  year: number
  utilisation: { leaveTypeName: string; entitled: number; used: number; pending: number }[]
  requestsByStatus: Record<string, number>
}

interface UnansweredQuestion {
  id: string
  tenantId: string
  conversationId: string | null
  question: string
  channel: string
  askedByUserId: string | null
  resolvedAt: string | null
  createdAt: string
}

interface BotReport {
  questionVolume: DayPoint[]
  toolCalls: { toolName: string; allowed: number; denied: number }[]
  unansweredCount: number
  unanswered: UnansweredQuestion[]
  authorisationDecisions: Record<string, number>
}

type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'

interface HrTicket {
  id: string
  tenantId: string
  subject: string
  body: string
  raisedByUserId: string | null
  status: TicketStatus
  createdAt: string
  updatedAt: string
}

// --- Constants ---------------------------------------------------------------

const PIPELINE_STAGES = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'TECHNICAL', 'FINAL', 'OFFER', 'HIRED']
const EXIT_STAGES = ['REJECTED', 'WITHDRAWN']
const TICKET_STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']
const PAGE_SIZE = 25
/** Above this many daily points a bar chart becomes unreadable; roll up to weeks. */
const MAX_DAILY_POINTS = 20

// --- Local helpers -----------------------------------------------------------

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiRequestError && error.isForbidden
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

/** ISO date (YYYY-MM-DD) of the Monday that starts the week containing `day`. */
function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  const sinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - sinceMonday)
  return date.toISOString().slice(0, 10)
}

/**
 * Daily series straight from the API; rolled up into weeks client-side when
 * there are too many points to read as individual bars.
 */
function seriesForChart(points: DayPoint[]): { rows: { label: string; value: number }[]; weekly: boolean } {
  if (points.length <= MAX_DAILY_POINTS) {
    return { rows: points.map((p) => ({ label: p.day.slice(5), value: p.count })), weekly: false }
  }
  const buckets = new Map<string, number>()
  for (const p of points) {
    const key = weekStart(p.day)
    buckets.set(key, (buckets.get(key) ?? 0) + p.count)
  }
  const rows = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ label: `Wk of ${key.slice(5)}`, value }))
  return { rows, weekly: true }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

// --- Small local components --------------------------------------------------

function CountTable({
  counts,
  heading,
  emptyTitle,
}: {
  counts: Record<string, number>
  heading: string
  emptyTitle: string
}) {
  const rows = Object.entries(counts).sort(([, a], [, b]) => b - a)
  if (rows.length === 0) return <Empty title={emptyTitle} />
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col" style={{ textAlign: 'right' }}>
              Count
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td>
                <Badge value={key} />
              </td>
              <td className="num">{value.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Pager<T>({ page, onChange }: { page: Page<T>; onChange(offset: number): void }) {
  const from = page.total === 0 ? 0 : page.offset + 1
  const to = page.offset + page.items.length
  const showControls = page.hasMore || page.offset > 0
  return (
    <div className="toolbar" style={{ marginTop: 12, marginBottom: 0, justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }} aria-live="polite">
        Showing {from.toLocaleString()}–{to.toLocaleString()} of {page.total.toLocaleString()}
      </span>
      {showControls ? (
        <span style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={page.offset === 0}
            onClick={() => onChange(Math.max(0, page.offset - page.limit))}
          >
            Previous
          </button>
          <button type="button" disabled={!page.hasMore} onClick={() => onChange(page.offset + page.limit)}>
            Next
          </button>
        </span>
      ) : null}
    </div>
  )
}

function UnansweredTable({
  items,
  busyId,
  onResolve,
  compact = false,
}: {
  items: UnansweredQuestion[]
  busyId: string | null
  onResolve(question: UnansweredQuestion): void
  compact?: boolean
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col">Channel</th>
            {compact ? null : <th scope="col">Asked by</th>}
            <th scope="col">Asked</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((q) => (
            <tr key={q.id}>
              <td style={{ minWidth: 240, whiteSpace: 'pre-wrap' }}>{q.question}</td>
              <td>
                <Badge value={q.channel} />
              </td>
              {compact ? null : <td className="mono">{q.askedByUserId ?? '—'}</td>}
              <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(q.createdAt)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {q.resolvedAt ? (
                  <span title={formatDateTime(q.resolvedAt)}>
                    <Badge value="RESOLVED" />
                  </span>
                ) : (
                  <Badge value="OPEN" />
                )}
              </td>
              <td style={{ textAlign: 'right' }}>
                {q.resolvedAt ? null : (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => onResolve(q)}
                    style={{ padding: '4px 9px', fontSize: 12 }}
                  >
                    {busyId === q.id ? 'Resolving…' : 'Mark resolved'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- Page --------------------------------------------------------------------

export default function ReportsPage() {
  const { user } = useSession()
  const canReport = can(user, 'report.read')
  const currentYear = new Date().getFullYear()

  const [year, setYear] = useState<number>(currentYear)
  const [unansweredFilter, setUnansweredFilter] = useState<'false' | 'true' | 'all'>('false')
  const [unansweredOffset, setUnansweredOffset] = useState(0)
  const [ticketStatus, setTicketStatus] = useState<'' | TicketStatus>('')
  const [ticketOffset, setTicketOffset] = useState(0)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<{ tone: 'info' | 'error' | 'warn'; text: string } | null>(null)

  // The headcount request doubles as the authorisation probe: it always runs,
  // so a user the session thinks is unauthorised still sees the API's own
  // verdict. The remaining reports load in parallel when the session says we
  // may, or after the probe has succeeded.
  const headcount = useApi<HeadcountReport>('/reports/headcount')
  const forbidden = isForbidden(headcount.error)
  const gate = !forbidden && (canReport || headcount.data !== null)

  const recruitment = useApi<RecruitmentReport>(gate ? '/reports/recruitment' : null)
  const leave = useApi<LeaveReport>(gate ? `/reports/leave${buildQuery({ year })}` : null)
  const bot = useApi<BotReport>(gate ? '/reports/bot' : null)
  const unanswered = useApi<Page<UnansweredQuestion>>(
    gate
      ? `/reports/unanswered${buildQuery({
          limit: PAGE_SIZE,
          offset: unansweredOffset,
          resolved: unansweredFilter === 'all' ? undefined : unansweredFilter,
        })}`
      : null,
  )
  const tickets = useApi<Page<HrTicket>>(
    gate
      ? `/reports/tickets${buildQuery({ limit: PAGE_SIZE, offset: ticketOffset, status: ticketStatus })}`
      : null,
  )

  async function resolveQuestion(question: UnansweredQuestion) {
    const preview = question.question.length > 80 ? `${question.question.slice(0, 80)}…` : question.question
    if (!window.confirm(`Mark this question as resolved?\n\n"${preview}"\n\nIt will leave the open backlog.`)) {
      return
    }
    setBusyId(question.id)
    setActionNotice(null)
    try {
      await api<{ ok: boolean }>(`/reports/unanswered/${encodeURIComponent(question.id)}/resolve`, {
        method: 'POST',
      })
      setActionNotice({ tone: 'info', text: 'Question marked as resolved.' })
      bot.reload()
      unanswered.reload()
    } catch (e) {
      setActionNotice({ tone: isForbidden(e) ? 'warn' : 'error', text: describeError(e) })
    } finally {
      setBusyId(null)
    }
  }

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 3 + i)
  const applicationsSeries = seriesForChart(recruitment.data?.applicationsOverTime ?? [])
  const questionSeries = seriesForChart(bot.data?.questionVolume ?? [])

  return (
    <Shell>
      <PageHeader
        title="Reports"
        description="Aggregate analytics across people, recruitment, leave and the assistant. No report contains individual compensation."
      />

      {forbidden ? (
        <ErrorState error={headcount.error} />
      ) : !gate ? (
        headcount.loading ? (
          <Card>
            <Loading rows={3} label="Checking report access" />
          </Card>
        ) : headcount.error ? (
          <ErrorState error={headcount.error} />
        ) : null
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {/* --- Headcount ------------------------------------------------- */}
          <div className="grid two">
            <Card title="Headcount by department">
              {headcount.loading ? (
                <Loading />
              ) : headcount.error ? (
                <ErrorState error={headcount.error} />
              ) : (
                <>
                  <BarChart
                    emptyLabel="No active employees yet"
                    data={(headcount.data?.byDepartment ?? []).map((d) => ({
                      label: d.departmentName,
                      value: d.count,
                    }))}
                  />
                  {headcount.data && headcount.data.byDepartment.length > 0 ? (
                    <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                      Active employees only. Total {sum(headcount.data.byDepartment.map((d) => d.count)).toLocaleString()}.
                    </p>
                  ) : null}
                </>
              )}
            </Card>

            <Card title="Headcount by status">
              {headcount.loading ? (
                <Loading />
              ) : headcount.error ? (
                <ErrorState error={headcount.error} />
              ) : (
                <CountTable
                  counts={headcount.data?.byStatus ?? {}}
                  heading="Status"
                  emptyTitle="No employees yet"
                />
              )}
            </Card>
          </div>

          {/* --- Recruitment ----------------------------------------------- */}
          <div className="grid two">
            <Card title="Recruitment funnel">
              {recruitment.loading ? (
                <Loading />
              ) : recruitment.error ? (
                <ErrorState error={recruitment.error} />
              ) : (recruitment.data?.funnel ?? []).length === 0 ? (
                <Empty title="No applications yet" />
              ) : (
                <>
                  <BarChart
                    data={PIPELINE_STAGES.map((stage) => ({
                      label: titleCase(stage),
                      value: recruitment.data?.funnel.find((f) => f.stage === stage)?.count ?? 0,
                    }))}
                  />
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, fontSize: 12 }}>
                    {EXIT_STAGES.map((stage) => (
                      <span key={stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Badge value={stage} />
                        <span style={{ color: 'var(--text-muted)' }}>
                          {(recruitment.data?.funnel.find((f) => f.stage === stage)?.count ?? 0).toLocaleString()}
                        </span>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </Card>

            <Card title="Applications — last 90 days">
              {recruitment.loading ? (
                <Loading />
              ) : recruitment.error ? (
                <ErrorState error={recruitment.error} />
              ) : (
                <>
                  <BarChart emptyLabel="No applications in the last 90 days" data={applicationsSeries.rows} />
                  {applicationsSeries.rows.length > 0 ? (
                    <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                      {applicationsSeries.weekly ? 'Grouped by week (Monday start). ' : 'Daily counts. '}
                      Total {sum(recruitment.data?.applicationsOverTime.map((p) => p.count) ?? []).toLocaleString()}.
                    </p>
                  ) : null}
                </>
              )}
            </Card>

            <Card title="Hiring source">
              {recruitment.loading ? (
                <Loading />
              ) : recruitment.error ? (
                <ErrorState error={recruitment.error} />
              ) : (
                <BarChart
                  emptyLabel="No applications yet"
                  data={(recruitment.data?.bySource ?? []).map((s) => ({
                    label: s.source ? titleCase(s.source) : 'Unknown',
                    value: s.count,
                  }))}
                />
              )}
            </Card>
          </div>

          {/* --- Leave ----------------------------------------------------- */}
          <div className="grid two">
            <Card
              title={`Leave utilisation ${year}`}
              actions={
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }} htmlFor="leave-year">
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Year</span>
                  <select
                    id="leave-year"
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value))}
                    style={{ width: 'auto', padding: '4px 8px' }}
                  >
                    {yearOptions.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </label>
              }
            >
              {leave.loading ? (
                <Loading />
              ) : leave.error ? (
                <ErrorState error={leave.error} />
              ) : (leave.data?.utilisation ?? []).length === 0 ? (
                <Empty title={`No leave balances for ${year}`} hint="Balances appear once entitlements are allocated." />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Leave type</th>
                        <th scope="col" style={{ textAlign: 'right' }}>
                          Entitled
                        </th>
                        <th scope="col" style={{ textAlign: 'right' }}>
                          Used
                        </th>
                        <th scope="col" style={{ textAlign: 'right' }}>
                          Pending
                        </th>
                        <th scope="col" style={{ minWidth: 140 }}>
                          Used of entitled
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(leave.data?.utilisation ?? []).map((row) => {
                        const width = row.entitled > 0 ? Math.min(100, (row.used / row.entitled) * 100) : 0
                        return (
                          <tr key={row.leaveTypeName}>
                            <td>{row.leaveTypeName}</td>
                            <td className="num">{row.entitled.toLocaleString()}</td>
                            <td className="num">{row.used.toLocaleString()}</td>
                            <td className="num">{row.pending.toLocaleString()}</td>
                            <td>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                                <div className="bar-track">
                                  <div
                                    className="bar-fill"
                                    style={{ width: `${width}%` }}
                                    role="img"
                                    aria-label={`${row.leaveTypeName}: ${row.used} of ${row.entitled} days used`}
                                  />
                                </div>
                                <span className="bar-value">{percent(row.used, row.entitled)}</span>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Leave requests by status">
              {leave.loading ? (
                <Loading />
              ) : leave.error ? (
                <ErrorState error={leave.error} />
              ) : (
                <>
                  <CountTable
                    counts={leave.data?.requestsByStatus ?? {}}
                    heading="Status"
                    emptyTitle="No leave requests yet"
                  />
                  <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                    All-time counts; not filtered by year.
                  </p>
                </>
              )}
            </Card>
          </div>

          {/* --- Assistant ------------------------------------------------- */}
          <Card title="Assistant — last 30 days">
            {bot.loading ? (
              <Loading rows={5} />
            ) : bot.error ? (
              <ErrorState error={bot.error} />
            ) : bot.data ? (
              <>
                <div className="grid kpi" style={{ marginBottom: 16 }}>
                  <div>
                    <div className="kpi-label">Questions asked</div>
                    <div className="kpi-value">{sum(bot.data.questionVolume.map((p) => p.count)).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="kpi-label">Decisions allowed</div>
                    <div className="kpi-value">{(bot.data.authorisationDecisions.ALLOW ?? 0).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="kpi-label">Decisions denied</div>
                    <div className="kpi-value">{(bot.data.authorisationDecisions.DENY ?? 0).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="kpi-label">Open unanswered</div>
                    <div className="kpi-value">{bot.data.unansweredCount.toLocaleString()}</div>
                  </div>
                </div>

                <div className="grid two">
                  <section aria-labelledby="bot-volume-heading">
                    <h3 id="bot-volume-heading" style={{ marginBottom: 10 }}>
                      Question volume
                    </h3>
                    <BarChart emptyLabel="No questions in the last 30 days" data={questionSeries.rows} />
                    {questionSeries.weekly ? (
                      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                        Grouped by week (Monday start).
                      </p>
                    ) : null}
                  </section>

                  <section aria-labelledby="bot-decisions-heading">
                    <h3 id="bot-decisions-heading" style={{ marginBottom: 10 }}>
                      Authorisation decisions
                    </h3>
                    <CountTable
                      counts={bot.data.authorisationDecisions}
                      heading="Decision"
                      emptyTitle="No audited decisions in the last 30 days"
                    />
                  </section>
                </div>

                <section aria-labelledby="bot-tools-heading" style={{ marginTop: 18 }}>
                  <h3 id="bot-tools-heading" style={{ marginBottom: 10 }}>
                    Tool calls — allowed vs denied
                  </h3>
                  {bot.data.toolCalls.length === 0 ? (
                    <Empty title="No tool calls in the last 30 days" />
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Tool</th>
                            <th scope="col" style={{ textAlign: 'right' }}>
                              Allowed
                            </th>
                            <th scope="col" style={{ textAlign: 'right' }}>
                              Denied
                            </th>
                            <th scope="col" style={{ textAlign: 'right' }}>
                              Total
                            </th>
                            <th scope="col" style={{ textAlign: 'right' }}>
                              Denial rate
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {bot.data.toolCalls.map((t) => (
                            <tr key={t.toolName}>
                              <td className="mono">{t.toolName}</td>
                              <td className="num">{t.allowed.toLocaleString()}</td>
                              <td className="num">{t.denied.toLocaleString()}</td>
                              <td className="num">{(t.allowed + t.denied).toLocaleString()}</td>
                              <td className="num">{percent(t.denied, t.allowed + t.denied)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section aria-labelledby="bot-unanswered-heading" style={{ marginTop: 18 }}>
                  <h3 id="bot-unanswered-heading" style={{ marginBottom: 10 }}>
                    Recent unanswered questions
                  </h3>
                  {bot.data.unanswered.length === 0 ? (
                    <Empty
                      title="Nothing unanswered"
                      hint="Questions the assistant could not answer from verified sources appear here."
                    />
                  ) : (
                    <UnansweredTable items={bot.data.unanswered} busyId={busyId} onResolve={resolveQuestion} compact />
                  )}
                </section>
              </>
            ) : (
              <Empty title="No assistant data" />
            )}
          </Card>

          {/* --- Unanswered backlog ---------------------------------------- */}
          <Card
            title="Unanswered questions"
            actions={
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }} htmlFor="unanswered-filter">
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Show</span>
                <select
                  id="unanswered-filter"
                  value={unansweredFilter}
                  onChange={(e) => {
                    setUnansweredFilter(e.target.value as 'false' | 'true' | 'all')
                    setUnansweredOffset(0)
                  }}
                  style={{ width: 'auto', padding: '4px 8px' }}
                >
                  <option value="false">Open</option>
                  <option value="true">Resolved</option>
                  <option value="all">All</option>
                </select>
              </label>
            }
          >
            {actionNotice ? (
              <div className={`notice ${actionNotice.tone}`} role={actionNotice.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
                {actionNotice.tone === 'warn' ? <strong>Not permitted. </strong> : null}
                {actionNotice.text}
              </div>
            ) : null}
            {unanswered.loading && !unanswered.data ? (
              <Loading rows={4} />
            ) : unanswered.error ? (
              <ErrorState error={unanswered.error} />
            ) : unanswered.data ? (
              unanswered.data.items.length === 0 ? (
                <Empty
                  title={unansweredFilter === 'false' ? 'No open unanswered questions' : 'No questions match this filter'}
                  hint={
                    unansweredFilter === 'false'
                      ? 'When the assistant lacks verified information it records the question here instead of guessing.'
                      : undefined
                  }
                />
              ) : (
                <>
                  <div aria-busy={unanswered.loading || undefined}>
                    <UnansweredTable items={unanswered.data.items} busyId={busyId} onResolve={resolveQuestion} />
                  </div>
                  <Pager page={unanswered.data} onChange={setUnansweredOffset} />
                </>
              )
            ) : null}
          </Card>

          {/* --- HR tickets ------------------------------------------------ */}
          <Card
            title="HR tickets"
            actions={
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }} htmlFor="ticket-status">
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Status</span>
                <select
                  id="ticket-status"
                  value={ticketStatus}
                  onChange={(e) => {
                    setTicketStatus(e.target.value as '' | TicketStatus)
                    setTicketOffset(0)
                  }}
                  style={{ width: 'auto', padding: '4px 8px' }}
                >
                  <option value="">All</option>
                  {TICKET_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {titleCase(s)}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            {tickets.loading && !tickets.data ? (
              <Loading rows={4} />
            ) : tickets.error ? (
              <ErrorState error={tickets.error} />
            ) : tickets.data ? (
              tickets.data.items.length === 0 ? (
                <Empty
                  title={ticketStatus ? `No ${titleCase(ticketStatus).toLowerCase()} tickets` : 'No HR tickets yet'}
                  hint="Tickets are raised when the assistant hands a question to HR."
                />
              ) : (
                <>
                  <div className="table-wrap" aria-busy={tickets.loading || undefined}>
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Subject</th>
                          <th scope="col">Status</th>
                          <th scope="col">Raised by</th>
                          <th scope="col">Created</th>
                          <th scope="col">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tickets.data.items.map((t) => (
                          <tr key={t.id}>
                            <td style={{ minWidth: 260 }}>
                              <details>
                                <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{t.subject}</summary>
                                <p
                                  style={{
                                    margin: '8px 0 0',
                                    whiteSpace: 'pre-wrap',
                                    color: 'var(--text-muted)',
                                    maxWidth: '70ch',
                                  }}
                                >
                                  {t.body}
                                </p>
                                <div className="mono" style={{ marginTop: 6, color: 'var(--text-faint)' }}>
                                  {t.id}
                                </div>
                              </details>
                            </td>
                            <td>
                              <Badge value={t.status} />
                            </td>
                            <td className="mono">{t.raisedByUserId ?? '—'}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(t.createdAt)}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(t.updatedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={tickets.data} onChange={setTicketOffset} />
                </>
              )
            ) : null}
          </Card>
        </div>
      )}
    </Shell>
  )
}
