'use client'

/**
 * Dashboard home — the day's headline figures and the work the Telegram bots
 * have handed to people (CLAUDE.md §33).
 *
 * Three things, nothing more: KPIs, a "needs attention" list that links to the
 * page where the work is done, and the open HR tickets the employee bot raised
 * when it could not answer. Every figure is an aggregate served by
 * `/reports/*`, which requires `report.read` at the PolicyGateway. The `can()`
 * check only decides whether to ask; the API's answer is what the user sees.
 */

import Link from 'next/link'
import { useState } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, ErrorState, Kpi, Loading, Pager, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import { can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Response shapes (mirrors apps/api/src/routes/reports.ts) ---------------

interface Summary {
  employees: { active: number; onLeave: number; total: number }
  jobs: { open: number; draft: number; closed: number }
  candidates: number
  applications: number
  leave: { pending: number; approved: number }
  hiresLast90Days: number
  documents: number
}

interface BotReport {
  unansweredCount: number
  authorisationDecisions: Record<string, number>
}

type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'

interface HrTicket {
  id: string
  subject: string
  body: string
  raisedByUserId: string | null
  status: TicketStatus
  createdAt: string
  updatedAt: string
}

const TICKET_PAGE_SIZE = 10

export default function DashboardPage() {
  const { user } = useSession()
  const canReport = can(user, 'report.read')

  return (
    <Shell>
      <PageHeader
        title="Dashboard"
        description={
          canReport
            ? 'Headline figures, and what the Telegram bots need a person for.'
            : 'Welcome. Use the navigation to view your own leave or read HR policies.'
        }
      />
      {canReport ? <HrDashboard /> : <QuickLinks />}
    </Shell>
  )
}

/** Employees and managers without `report.read`: point them at what they can do. */
function QuickLinks() {
  return (
    <Card title="Your quick links">
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 2 }}>
        <li>
          <Link href="/leave">My leave balance and requests</Link>
        </li>
        <li>
          <Link href="/knowledge">HR policies and handbook</Link>
        </li>
        <li>
          <Link href="/settings">Link my Telegram account to the employee bot</Link>
        </li>
      </ul>
    </Card>
  )
}

function HrDashboard() {
  const [ticketOffset, setTicketOffset] = useState(0)

  const summary = useApi<Summary>('/reports/summary')
  const bot = useApi<BotReport>('/reports/bot')
  const tickets = useApi<Page<HrTicket>>(
    `/reports/tickets?status=OPEN&limit=${TICKET_PAGE_SIZE}&offset=${ticketOffset}`,
  )

  return (
    <>
      {summary.error ? <ErrorState error={summary.error} /> : null}

      <div className="grid kpi" style={{ marginBottom: 16 }}>
        {summary.loading || !summary.data ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div className="card" key={i}>
              <Loading rows={2} />
            </div>
          ))
        ) : (
          <>
            <Kpi
              label="Employees"
              value={summary.data.employees.active}
              sub={`${summary.data.employees.onLeave} on leave`}
            />
            <Kpi label="Open jobs" value={summary.data.jobs.open} sub={`${summary.data.jobs.draft} in draft`} />
            <Kpi label="Candidates" value={summary.data.candidates} />
            <Kpi label="Applications" value={summary.data.applications} />
            <Kpi
              label="Pending leave"
              value={summary.data.leave.pending}
              sub={`${summary.data.leave.approved} approved`}
            />
            <Kpi label="Hires (90 days)" value={summary.data.hiresLast90Days} />
          </>
        )}
      </div>

      <div className="grid two">
        <Card title="Needs attention">
          {summary.loading && bot.loading ? (
            <Loading rows={3} />
          ) : (
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', lineHeight: 2 }}>
              <AttentionRow
                count={summary.data?.leave.pending}
                error={summary.error}
                label="leave requests waiting for approval"
                href="/leave"
                cta="Review leave"
              />
              <AttentionRow
                count={bot.data?.unansweredCount}
                error={bot.error}
                label="bot questions without an answer"
                href="/knowledge/training"
                cta="Write answers"
              />
              <AttentionRow
                count={tickets.data?.total}
                error={tickets.error}
                label="open HR tickets from the employee bot"
                href="#hr-tickets"
                cta="See below"
              />
            </ul>
          )}
        </Card>

        <Card title="Bot requests — last 30 days">
          {bot.loading ? (
            <Loading rows={2} />
          ) : bot.error ? (
            <ErrorState error={bot.error} />
          ) : (
            <>
              <div className="grid kpi" style={{ marginBottom: 8 }}>
                <div>
                  <div className="kpi-label">Allowed</div>
                  <div className="kpi-value">{bot.data?.authorisationDecisions.ALLOW ?? 0}</div>
                </div>
                <div>
                  <div className="kpi-label">Refused</div>
                  <div className="kpi-value">{bot.data?.authorisationDecisions.DENY ?? 0}</div>
                </div>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                A refusal is normal when someone asks the bot for something outside their role. A
                sudden rise is worth a look on the <Link href="/security">Security</Link> page.
              </p>
            </>
          )}
        </Card>
      </div>

      <div id="hr-tickets" style={{ marginTop: 16 }}>
        <Card title="Open HR tickets">
          {tickets.loading && !tickets.data ? (
            <Loading rows={4} />
          ) : tickets.error ? (
            <ErrorState error={tickets.error} />
          ) : tickets.data ? (
            tickets.data.items.length === 0 ? (
              <Empty
                title="No open HR tickets"
                hint="The employee bot raises a ticket when it cannot answer a question from policy."
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
    </>
  )
}

function AttentionRow({
  count,
  error,
  label,
  href,
  cta,
}: {
  count: number | undefined
  error: unknown
  label: string
  href: string
  cta: string
}) {
  if (error) {
    return (
      <li style={{ color: 'var(--text-muted)' }}>
        Could not load {label}.
      </li>
    )
  }
  const value = count ?? 0
  return (
    <li style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      <strong style={{ fontSize: 18, minWidth: 32 }}>{value.toLocaleString()}</strong>
      <span style={{ flex: 1 }}>{label}</span>
      {value > 0 ? <Link href={href}>{cta}</Link> : null}
    </li>
  )
}
