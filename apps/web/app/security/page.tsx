'use client'

/**
 * Security — refused or flagged requests, and the record of every decision
 * (CLAUDE.md §28, §33).
 *
 * Two tabs, each shown only when the user holds the matching permission:
 *   • Events      — GET /security/events(/summary), POST /security/events/:id/acknowledge
 *   • Audit trail — GET /audit
 *
 * Permission checks here (`can(user, …)`) only decide what to draw; every
 * request is re-authorised by the PolicyGateway and a 403 from the API is shown
 * as-is. Records are rendered in plain words — event types, reasons and
 * resource types are mapped to phrases and no identifiers are shown; the raw
 * record stays available behind a disclosure for investigation.
 */

import { useMemo, useState } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import {
  Badge,
  BarChart,
  Card,
  Empty,
  ErrorState,
  Facts,
  Kpi,
  Loading,
  Notice,
  Pager,
  SubmitError,
  Tabs,
  formatDateTime,
  humanize,
  type BadgeTone,
} from '@/components/ui'
import { useSession } from '@/components/session'
import { api, can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Types mirrored from the API (packages/db/src/repositories/audit.ts) ----

type SecuritySeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
type AuditDecision = 'ALLOW' | 'DENY' | 'ERROR'

interface SecurityEventRecord {
  id: string
  timestamp: string
  eventType: string
  severity: SecuritySeverity
  userId: string | null
  telegramId: string | null
  subjectKey: string | null
  channel: string
  summary: string
  detail: Record<string, unknown> | null
  acknowledgedAt: string | null
}

interface SecuritySummary {
  byType: { eventType: string; count: number }[]
  authorisation: Record<string, number>
  /** Not sent by every API version; the total is used when absent. */
  unacknowledged?: number
}

interface AuditRecord {
  id: string
  timestamp: string
  userId: string | null
  telegramId: string | null
  channel: string
  bot: string | null
  intent: string | null
  resource: string
  resourceId: string | null
  action: string
  decision: AuditDecision
  reasonCode: string | null
  risk: string | null
  source: string | null
  metadata?: Record<string, unknown>
}

// --- Labels ------------------------------------------------------------------

const EVENT_LABELS: Record<string, string> = {
  BLOCKED_REQUEST: 'Blocked request',
  PROMPT_INJECTION: 'Instruction injection attempt',
  CROSS_USER_ACCESS: "Tried to access another person's data",
  RESTRICTED_DATA_REQUEST: 'Asked for restricted data',
  UNKNOWN_USER: 'Unknown user',
  RATE_LIMIT: 'Too many requests',
  AUTH_FAILURE: 'Sign-in failure',
  TOOL_DENIED: 'Action refused',
  TENANT_ACCESS_VIOLATION: 'Cross-company access',
  IDENTITY_SPOOF_ATTEMPT: 'Claimed to be someone else',
  DOCUMENT_INJECTION: 'Instructions hidden in a document',
  SCOPE_VIOLATION: 'Asked for something not available here',
}

const KNOWN_EVENT_TYPES = Object.keys(EVENT_LABELS)

const SEVERITIES: SecuritySeverity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const DECISIONS: AuditDecision[] = ['ALLOW', 'DENY', 'ERROR']
const DECISION_LABELS: Record<AuditDecision, string> = {
  ALLOW: 'Allowed',
  DENY: 'Refused',
  ERROR: 'Error',
}

const CHANNEL_LABELS: Record<string, string> = {
  TELEGRAM_EXTERNAL: 'Recruitment bot',
  TELEGRAM_INTERNAL: 'Employee bot',
  WEB: 'Dashboard',
  DASHBOARD: 'Dashboard',
}

const PAGE_SIZE = 25

type Tab = 'events' | 'audit'

// --- Local helpers -----------------------------------------------------------

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? humanize(type)
}

function severityTone(severity: SecuritySeverity): BadgeTone {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'danger'
  if (severity === 'MEDIUM') return 'warn'
  return 'muted'
}

function channelLabel(channel: string | null | undefined): string {
  if (!channel) return '—'
  return CHANNEL_LABELS[channel] ?? humanize(channel)
}

/** "leave.request" → "Leave request"; "EMPLOYEE_COMPENSATION" → "Employee compensation". */
function resourceLabel(resource: string | null | undefined): string {
  if (!resource) return '—'
  return humanize(resource.replace(/\./g, '_'))
}

/** A person label without ever showing an identifier. */
function subjectLabel(row: {
  userId: string | null
  telegramId: string | null
  detail?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}): string {
  const bag = row.detail ?? row.metadata ?? null
  for (const key of ['displayName', 'employeeName', 'name']) {
    const value = bag?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  if (row.userId) return 'Employee'
  if (row.telegramId) return 'Telegram user'
  return 'Unknown'
}

function stringField(bag: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = bag?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** Builds "?a=b&c=d" from defined, non-empty values only. */
function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** A date picked in the browser (YYYY-MM-DD) → ISO instant at local midnight. */
function sinceIso(date: string): string | undefined {
  if (!date) return undefined
  const instant = new Date(`${date}T00:00:00`)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

function RawRecord({ value }: { value: unknown }) {
  const text = value === undefined || value === null ? null : JSON.stringify(value, null, 2)
  return (
    <details className="more">
      <summary>Show raw record</summary>
      {text && text !== '{}' ? (
        <pre className="plain small-text">{text}</pre>
      ) : (
        <span className="faint small-text">Nothing more was recorded.</span>
      )}
    </details>
  )
}

// --- Page --------------------------------------------------------------------

export default function SecurityPage() {
  const { user } = useSession()
  const canEvents = can(user, 'security.read')
  const canAudit = can(user, 'audit.read')

  // The Shell only renders children once the session is known, so deriving
  // the default from `user` here cannot flicker between tabs.
  const [chosen, setChosen] = useState<Tab | null>(null)
  const tabs: { key: Tab; label: string }[] = [
    ...(canEvents ? [{ key: 'events' as const, label: 'Events' }] : []),
    ...(canAudit ? [{ key: 'audit' as const, label: 'Audit trail' }] : []),
  ]
  const tab: Tab | null = tabs.some((t) => t.key === chosen) ? chosen : (tabs[0]?.key ?? null)

  return (
    <Shell>
      <PageHeader
        title="Security"
        description="Access requests the system refused or flagged, and the record of every decision."
      />

      {tab === null ? (
        <Card>
          <Empty title="You do not have access to security records" hint="Ask an HR administrator." />
        </Card>
      ) : (
        <>
          {tabs.length > 1 ? (
            <Tabs<Tab> tabs={tabs} value={tab} onChange={(key) => setChosen(key)} label="Security views" />
          ) : null}
          {tab === 'events' ? <EventsTab /> : <AuditTab />}
        </>
      )}
    </Shell>
  )
}

// --- Events tab --------------------------------------------------------------

interface EventFilters {
  review: 'needs' | 'all'
  eventType: string
  severity: string
  since: string
}

const EMPTY_EVENT_FILTERS: EventFilters = { review: 'all', eventType: '', severity: '', since: '' }

function EventsTab() {
  const [filters, setFilters] = useState<EventFilters>(EMPTY_EVENT_FILTERS)
  const [offset, setOffset] = useState(0)
  const [ackingId, setAckingId] = useState<string | null>(null)
  const [ackError, setAckError] = useState<unknown>(null)
  const [ackDone, setAckDone] = useState(false)

  const summary = useApi<SecuritySummary>('/security/events/summary')

  const listPath = useMemo(
    () =>
      `/security/events${buildQuery({
        eventType: filters.eventType || undefined,
        severity: filters.severity || undefined,
        unacknowledgedOnly: filters.review === 'needs' ? 'true' : undefined,
        since: sinceIso(filters.since),
        limit: PAGE_SIZE,
        offset,
      })}`,
    [filters, offset],
  )
  const events = useApi<Page<SecurityEventRecord>>(listPath)

  function update(patch: Partial<EventFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setOffset(0)
    setAckDone(false)
    setAckError(null)
  }

  const filtered =
    filters.review !== 'all' || Boolean(filters.eventType) || Boolean(filters.severity) || Boolean(filters.since)

  async function acknowledge(row: SecurityEventRecord) {
    setAckingId(row.id)
    setAckError(null)
    setAckDone(false)
    try {
      await api<{ ok: boolean }>(`/security/events/${encodeURIComponent(row.id)}/acknowledge`, { method: 'POST' })
      setAckDone(true)
      events.reload()
    } catch (e) {
      setAckError(e)
    } finally {
      setAckingId(null)
    }
  }

  const totalEvents = (summary.data?.byType ?? []).reduce((sum, row) => sum + row.count, 0)
  const decisions = summary.data?.authorisation ?? {}
  const needsReview = summary.data?.unacknowledged ?? totalEvents

  return (
    <>
      {summary.error ? <ErrorState error={summary.error} /> : null}

      <div className="grid">
        <div className="grid kpi">
          {summary.loading || !summary.data ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div className="card" key={i}>
                <Loading rows={2} />
              </div>
            ))
          ) : (
            <>
              <Kpi label="Needs review" value={needsReview} sub="last 30 days" />
              <Kpi label="Refused (30 days)" value={decisions.DENY ?? 0} />
              <Kpi label="Errors (30 days)" value={decisions.ERROR ?? 0} />
            </>
          )}
        </div>

        <Card title="Events by type — last 30 days">
          {summary.loading ? (
            <Loading />
          ) : summary.error ? (
            <Empty title="Not available right now" />
          ) : (
            <BarChart
              emptyLabel="Nothing flagged in the last 30 days"
              data={(summary.data?.byType ?? []).map((row) => ({
                label: eventLabel(row.eventType),
                value: row.count,
              }))}
            />
          )}
        </Card>

        <Card title="Events">
          <div className="toolbar" role="group" aria-label="Filter events">
            <span className="actions">
              <button
                type="button"
                className={filters.review === 'needs' ? 'primary' : undefined}
                aria-pressed={filters.review === 'needs'}
                onClick={() => update({ review: 'needs' })}
              >
                Needs review
              </button>
              <button
                type="button"
                className={filters.review === 'all' ? 'primary' : undefined}
                aria-pressed={filters.review === 'all'}
                onClick={() => update({ review: 'all' })}
              >
                All
              </button>
            </span>
            <label htmlFor="evt-type" className="visually-hidden">
              What happened
            </label>
            <select id="evt-type" value={filters.eventType} onChange={(e) => update({ eventType: e.target.value })}>
              <option value="">Anything</option>
              {KNOWN_EVENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {eventLabel(type)}
                </option>
              ))}
            </select>
            <label htmlFor="evt-severity" className="visually-hidden">
              Severity
            </label>
            <select id="evt-severity" value={filters.severity} onChange={(e) => update({ severity: e.target.value })}>
              <option value="">Any severity</option>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {humanize(severity)}
                </option>
              ))}
            </select>
            <label htmlFor="evt-since" className="visually-hidden">
              Since
            </label>
            <input
              id="evt-since"
              type="date"
              aria-label="Since"
              value={filters.since}
              onChange={(e) => update({ since: e.target.value })}
            />
            {filtered ? (
              <button type="button" onClick={() => update(EMPTY_EVENT_FILTERS)}>
                Clear
              </button>
            ) : null}
          </div>

          {ackDone ? <Notice tone="ok">Marked as reviewed.</Notice> : null}
          <SubmitError error={ackError} />

          {events.loading && !events.data ? (
            <Loading rows={5} />
          ) : events.error ? (
            <ErrorState error={events.error} />
          ) : !events.data || events.data.items.length === 0 ? (
            <Empty
              title={filters.review === 'needs' ? 'Nothing waiting for review' : 'No events match'}
              hint={
                filtered
                  ? 'Try widening the filters.'
                  : 'Refused and flagged requests appear here as they happen.'
              }
            />
          ) : (
            <>
              <div className="table-wrap" aria-busy={events.loading}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">What</th>
                      <th scope="col">Who</th>
                      <th scope="col">Summary</th>
                      <th scope="col">
                        <span className="visually-hidden">Review</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.data.items.map((row) => (
                      <EventRow
                        key={row.id}
                        row={row}
                        busy={ackingId === row.id}
                        onAcknowledge={() => void acknowledge(row)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={events.data} onChange={setOffset} />
            </>
          )}
        </Card>
      </div>
    </>
  )
}

function EventRow({
  row,
  busy,
  onAcknowledge,
}: {
  row: SecurityEventRecord
  busy: boolean
  onAcknowledge(): void
}) {
  const reason = stringField(row.detail, 'reason', 'reasonCode')
  const resource = stringField(row.detail, 'resource', 'resourceType')
  const facts = [
    { label: 'Channel', value: channelLabel(row.channel) },
    ...(reason ? [{ label: 'Reason', value: humanize(reason) }] : []),
    ...(resource ? [{ label: 'About', value: resourceLabel(resource) }] : []),
    ...(row.acknowledgedAt ? [{ label: 'Reviewed', value: formatDateTime(row.acknowledgedAt) }] : []),
  ]
  return (
    <tr>
      <td>{formatDateTime(row.timestamp)}</td>
      <td>
        <Badge value={eventLabel(row.eventType)} tone={severityTone(row.severity)} />
      </td>
      <td>{subjectLabel(row)}</td>
      <td>
        {row.summary}
        <details className="more">
          <summary>Details</summary>
          <Facts items={facts} />
          <RawRecord value={row.detail} />
        </details>
      </td>
      <td>
        {row.acknowledgedAt ? (
          <span className="muted small-text">Reviewed</span>
        ) : (
          <button type="button" className="small" disabled={busy} onClick={onAcknowledge}>
            {busy ? 'Saving…' : 'Mark reviewed'}
          </button>
        )}
      </td>
    </tr>
  )
}

// --- Audit tab ---------------------------------------------------------------

interface AuditFilters {
  decision: string
  since: string
}

const EMPTY_AUDIT_FILTERS: AuditFilters = { decision: '', since: '' }

function AuditTab() {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [offset, setOffset] = useState(0)

  const listPath = useMemo(
    () =>
      `/audit${buildQuery({
        decision: filters.decision || undefined,
        since: sinceIso(filters.since),
        limit: PAGE_SIZE,
        offset,
      })}`,
    [filters, offset],
  )
  const audit = useApi<Page<AuditRecord>>(listPath)

  function update(patch: Partial<AuditFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setOffset(0)
  }

  const filtered = Boolean(filters.decision || filters.since)

  return (
    <Card title="Audit trail">
      <p className="muted small-text">
        Every decision is written once and never changed. Looking at this list is recorded too.
      </p>
      <div className="toolbar" role="group" aria-label="Filter the audit trail">
        <label htmlFor="aud-decision" className="visually-hidden">
          Decision
        </label>
        <select id="aud-decision" value={filters.decision} onChange={(e) => update({ decision: e.target.value })}>
          <option value="">Any decision</option>
          {DECISIONS.map((decision) => (
            <option key={decision} value={decision}>
              {DECISION_LABELS[decision]}
            </option>
          ))}
        </select>
        <label htmlFor="aud-since" className="visually-hidden">
          Since
        </label>
        <input
          id="aud-since"
          type="date"
          aria-label="Since"
          value={filters.since}
          onChange={(e) => update({ since: e.target.value })}
        />
        {filtered ? (
          <button type="button" onClick={() => update(EMPTY_AUDIT_FILTERS)}>
            Clear
          </button>
        ) : null}
      </div>

      {audit.loading && !audit.data ? (
        <Loading rows={5} />
      ) : audit.error ? (
        <ErrorState error={audit.error} />
      ) : !audit.data || audit.data.items.length === 0 ? (
        <Empty
          title="No entries match"
          hint={filtered ? 'Try widening the filters.' : 'Decisions appear here as people use the system.'}
        />
      ) : (
        <>
          <div className="table-wrap" aria-busy={audit.loading}>
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Resource</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.items.map((row) => (
                  <AuditRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={audit.data} onChange={setOffset} />
        </>
      )}
    </Card>
  )
}

function AuditRow({ row }: { row: AuditRecord }) {
  const facts = [
    { label: 'Channel', value: channelLabel(row.channel) },
    ...(row.reasonCode ? [{ label: 'Reason', value: humanize(row.reasonCode) }] : []),
    ...(row.intent ? [{ label: 'Request', value: humanize(row.intent) }] : []),
    ...(row.risk ? [{ label: 'Sensitivity', value: humanize(row.risk) }] : []),
  ]
  return (
    <tr>
      <td>{formatDateTime(row.timestamp)}</td>
      <td>{subjectLabel(row)}</td>
      <td>
        {humanize(row.action)}
        <details className="more">
          <summary>Details</summary>
          <Facts items={facts} />
          <RawRecord value={row.metadata} />
        </details>
      </td>
      <td>{resourceLabel(row.resource)}</td>
      <td>
        <Badge value={DECISION_LABELS[row.decision] ?? humanize(row.decision)} tone={decisionTone(row.decision)} />
      </td>
    </tr>
  )
}

function decisionTone(decision: AuditDecision): BadgeTone {
  if (decision === 'ALLOW') return 'ok'
  if (decision === 'DENY') return 'danger'
  return 'warn'
}
