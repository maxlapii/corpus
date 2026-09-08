'use client'

/**
 * Dashboard home — KPIs and headline charts (CLAUDE.md §33).
 *
 * This page is the reference pattern for every other page: a Shell, a
 * PageHeader, data via useApi(), and explicit loading / error / empty /
 * permission-denied states.
 */

import { PageHeader, Shell } from '@/components/shell'
import { BarChart, Card, ErrorState, Kpi, Loading } from '@/components/ui'
import { useSession } from '@/components/session'
import { can } from '@/lib/api'
import { useApi } from '@/lib/use-api'

interface Summary {
  employees: { active: number; onLeave: number; total: number }
  jobs: { open: number; draft: number; closed: number }
  candidates: number
  applications: number
  leave: { pending: number; approved: number }
  hiresLast90Days: number
  documents: number
}

interface Headcount {
  byDepartment: { departmentName: string; count: number }[]
}

interface Recruitment {
  funnel: { stage: string; count: number }[]
  applicationsOverTime: { day: string; count: number }[]
}

interface BotReport {
  toolCalls: { toolName: string; allowed: number; denied: number }[]
  unansweredCount: number
  authorisationDecisions: Record<string, number>
}

const FUNNEL_ORDER = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'TECHNICAL', 'FINAL', 'OFFER', 'HIRED']

export default function DashboardPage() {
  const { user } = useSession()
  const canReport = can(user, 'report.read')

  const summary = useApi<Summary>(canReport ? '/reports/summary' : null)
  const headcount = useApi<Headcount>(canReport ? '/reports/headcount' : null)
  const recruitment = useApi<Recruitment>(canReport ? '/reports/recruitment' : null)
  const bot = useApi<BotReport>(canReport ? '/reports/bot' : null)

  return (
    <Shell>
      <PageHeader
        title="Dashboard"
        description={
          canReport
            ? 'Headline figures across people, recruitment, leave and the assistant.'
            : 'Welcome. Use the navigation to view your own leave, ask the assistant, or read HR policies.'
        }
      />

      {!canReport ? (
        <Card title="Your quick links">
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 2 }}>
            <li>
              <a href="/leave">My leave balance and requests</a>
            </li>
            <li>
              <a href="/assistant">Ask the HR assistant</a>
            </li>
            <li>
              <a href="/knowledge">HR policies and handbook</a>
            </li>
          </ul>
        </Card>
      ) : null}

      {canReport ? (
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
                <Kpi label="Employees" value={summary.data.employees.active} sub={`${summary.data.employees.onLeave} on leave`} />
                <Kpi label="Open jobs" value={summary.data.jobs.open} sub={`${summary.data.jobs.draft} in draft`} />
                <Kpi label="Candidates" value={summary.data.candidates} />
                <Kpi label="Applications" value={summary.data.applications} />
                <Kpi label="Pending leave" value={summary.data.leave.pending} sub={`${summary.data.leave.approved} approved`} />
                <Kpi label="Hires (90 days)" value={summary.data.hiresLast90Days} />
              </>
            )}
          </div>

          <div className="grid two">
            <Card title="Headcount by department">
              {headcount.loading ? (
                <Loading />
              ) : headcount.error ? (
                <ErrorState error={headcount.error} />
              ) : (
                <BarChart
                  data={(headcount.data?.byDepartment ?? []).map((d) => ({
                    label: d.departmentName,
                    value: d.count,
                  }))}
                />
              )}
            </Card>

            <Card title="Recruitment funnel">
              {recruitment.loading ? (
                <Loading />
              ) : recruitment.error ? (
                <ErrorState error={recruitment.error} />
              ) : (
                <BarChart
                  data={FUNNEL_ORDER.map((stage) => ({
                    label: stage.charAt(0) + stage.slice(1).toLowerCase(),
                    value: recruitment.data?.funnel.find((f) => f.stage === stage)?.count ?? 0,
                  }))}
                />
              )}
            </Card>

            <Card title="Applications — last 90 days">
              {recruitment.loading ? (
                <Loading />
              ) : recruitment.error ? (
                <ErrorState error={recruitment.error} />
              ) : (
                <BarChart
                  emptyLabel="No applications in the last 90 days"
                  data={(recruitment.data?.applicationsOverTime ?? []).slice(-14).map((d) => ({
                    label: d.day.slice(5),
                    value: d.count,
                  }))}
                />
              )}
            </Card>

            <Card title="Assistant — tool decisions (30 days)">
              {bot.loading ? (
                <Loading />
              ) : bot.error ? (
                <ErrorState error={bot.error} />
              ) : (
                <>
                  <div className="grid kpi" style={{ marginBottom: 12 }}>
                    <div>
                      <div className="kpi-label">Allowed</div>
                      <div className="kpi-value">{bot.data?.authorisationDecisions.ALLOW ?? 0}</div>
                    </div>
                    <div>
                      <div className="kpi-label">Denied</div>
                      <div className="kpi-value">{bot.data?.authorisationDecisions.DENY ?? 0}</div>
                    </div>
                    <div>
                      <div className="kpi-label">Unanswered</div>
                      <div className="kpi-value">{bot.data?.unansweredCount ?? 0}</div>
                    </div>
                  </div>
                  <BarChart
                    emptyLabel="No assistant activity yet"
                    data={(bot.data?.toolCalls ?? []).slice(0, 8).map((t) => ({
                      label: t.toolName,
                      value: t.allowed + t.denied,
                    }))}
                  />
                </>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </Shell>
  )
}
