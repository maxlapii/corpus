'use client'

/**
 * Security — security events and the append-only audit trail (CLAUDE.md §28, §33).
 *
 * Two tabs:
 *   • Events      — GET /security/events(/summary), POST /security/events/:id/acknowledge
 *   • Audit trail — GET /audit
 *
 * Permission checks here (`can(user, …)`) only decide what to render; every
 * request is re-authorised by the PolicyGateway and a 403 from the API is shown
 * as-is. Filters are applied explicitly (a form submit) rather than on every
 * keystroke because reading the audit trail is itself audited — chatty
 * requests would litter the very log being inspected.
 */

import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, BarChart, Card, Empty, ErrorState, Kpi, Loading, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import { ApiRequestError, api, can, type Page } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Types mirrored from the API (packages/db/src/repositories/audit.ts) ----

type SecuritySeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
type AuditDecision = 'ALLOW' | 'DENY' | 'ERROR'

interface SecurityEventRecord {
  id: string
  timestamp: string
  tenantId: string | null
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
}

interface AuditRecord {
  id: string
  timestamp: string
  tenantId: string | null
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
  requestId: string | null
  metadata?: Record<string, unknown>
}

// --- Constants ---------------------------------------------------------------

const KNOWN_EVENT_TYPES = [
  'BLOCKED_REQUEST',
  'PROMPT_INJECTION',
  'CROSS_USER_ACCESS',
  'RESTRICTED_DATA_REQUEST',
  'UNKNOWN_USER',
  'RATE_LIMIT',
  'AUTH_FAILURE',
  'TOOL_DENIED',
  'TENANT_ACCESS_VIOLATION',
  'DOCUMENT_INJECTION',
  'IDENTITY_SPOOF_ATTEMPT',
  'SCOPE_VIOLATION',
] as const

const SEVERITIES: SecuritySeverity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const DECISIONS: AuditDecision[] = ['ALLOW', 'DENY', 'ERROR']

const PAGE_SIZE = 25

type Tab = 'events' | 'audit'

// --- Local helpers -----------------------------------------------------------

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

function truncate(value: string, max = 18): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.error.message
  if (e instanceof Error) return e.message
  return 'Something went wrong.'
}

function JsonBlock({ id, value }: { id: string; value: unknown }) {
  const text = value === undefined || value === null ? null : JSON.stringify(value, null, 2)
  return (
    <div id={id}>
      {text && text !== '{}' ? (
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 10,
            background: 'var(--surface-alt)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflow: 'auto',
          }}
        >
          {text}
        </pre>
      ) : (
        <span style={{ color: 'var(--text-faint)' }}>No additional detail recorded.</span>
      )}
    </div>
  )
}

function Pager({
  total,
  offset,
  count,
  hasMore,
  onPrev,
  onNext,
}: {
  total: number
  offset: number
  count: number
  hasMore: boolean
  onPrev(): void
  onNext(): void
}) {
  const from = total === 0 ? 0 : offset + 1
  const to = offset + count
  return (
    <div className="toolbar" style={{ marginTop: 12, marginBottom: 0, justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }} aria-live="polite">
        Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      {offset > 0 || hasMore ? (
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onPrev} disabled={offset === 0}>
            Previous
          </button>
          <button type="button" onClick={onNext} disabled={!hasMore}>
            Next
          </button>
        </span>
      ) : null}
    </div>
  )
}

function Subject({ userId, telegramId, subjectKey }: { userId: string | null; telegramId: string | null; subjectKey: string | null }) {
  const [label, value] = userId
    ? ['user', userId]
    : telegramId
      ? ['telegram', telegramId]
      : subjectKey
        ? ['key', subjectKey]
        : [null, null]
  if (!value) return <span style={{ color: 'var(--text-faint)' }}>—</span>
  return (
    <span title={`${label}: ${value}`}>
      <span style={{ color: 'var(--text-faint)', fontSize: 11, marginRight: 4 }}>{label}</span>
      <span className="mono">{truncate(value)}</span>
    </span>
  )
}

function PermissionNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice warn" role="status">
      <strong>Not available to your role. </strong>
      {children}
    </div>
  )
}

// --- Page --------------------------------------------------------------------

export default function SecurityPage() {
  const { user } = useSession()
  const canSecurity = can(user, 'security.read')
  const canAudit = can(user, 'audit.read')

  // The session may still be loading on first render, so the default tab is
  // derived from the current user until the user picks one explicitly.
  const [chosen, setTab] = useState<Tab | null>(null)
  const tab: Tab = chosen ?? (canSecurity || !canAudit ? 'events' : 'audit')

  return (
    <Shell>
      <PageHeader
        title="Security"
        description="Blocked requests, injection attempts and every authorisation decision the backend has made. The assistant never decides access — these records show the PolicyGateway deciding."
      />

      <div role="tablist" aria-label="Security views" className="toolbar" style={{ gap: 6 }}>
        <TabButton id="events" active={tab === 'events'} onSelect={setTab}>
          Events
        </TabButton>
        <TabButton id="audit" active={tab === 'audit'} onSelect={setTab}>
          Audit trail
        </TabButton>
      </div>

      {tab === 'events' ? (
        <div role="tabpanel" id="panel-events" aria-labelledby="tab-events">
          {canSecurity ? (
            <EventsTab />
          ) : (
            <PermissionNotice>Viewing security events requires the security.read permission.</PermissionNotice>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="panel-audit" aria-labelledby="tab-audit">
          {canAudit ? (
            <AuditTab />
          ) : (
            <PermissionNotice>Viewing the audit trail requires the audit.read permission.</PermissionNotice>
          )}
        </div>
      )}
    </Shell>
  )
}

function TabButton({
  id,
  active,
  onSelect,
  children,
}: {
  id: Tab
  active: boolean
  onSelect(tab: Tab): void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={active}
      aria-controls={`panel-${id}`}
      className={active ? 'primary' : undefined}
      onClick={() => onSelect(id)}
    >
      {children}
    </button>
  )
}

// --- Events tab --------------------------------------------------------------

interface EventFilters {
  eventType: string
  severity: string
  unacknowledgedOnly: boolean
  since: string
}

const EMPTY_EVENT_FILTERS: EventFilters = { eventType: '', severity: '', unacknowledgedOnly: false, since: '' }

function EventsTab() {
  const { user } = useSession()
  const canAck = can(user, 'security.read')

  const [draft, setDraft] = useState<EventFilters>(EMPTY_EVENT_FILTERS)
  const [applied, setApplied] = useState<EventFilters>(EMPTY_EVENT_FILTERS)
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [ackingId, setAckingId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const summary = useApi<SecuritySummary>('/security/events/summary')

  const listPath = useMemo(
    () =>
      `/security/events${buildQuery({
        eventType: applied.eventType.trim() || undefined,
        severity: applied.severity || undefined,
        unacknowledgedOnly: applied.unacknowledgedOnly ? 'true' : undefined,
        since: sinceIso(applied.since),
        limit: PAGE_SIZE,
        offset,
      })}`,
    [applied, offset],
  )
  const events = useApi<Page<SecurityEventRecord>>(listPath)

  function applyFilters(event: FormEvent) {
    event.preventDefault()
    setApplied(draft)
    setOffset(0)
    setExpanded(new Set())
  }

  function clearFilters() {
    setDraft(EMPTY_EVENT_FILTERS)
    setApplied(EMPTY_EVENT_FILTERS)
    setOffset(0)
    setExpanded(new Set())
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function acknowledge(row: SecurityEventRecord) {
    const ok = window.confirm(
      `Acknowledge this ${row.eventType.replace(/_/g, ' ').toLowerCase()} event?\n\n"${row.summary}"\n\nAcknowledgement is recorded against your account and cannot be undone.`,
    )
    if (!ok) return
    setAckingId(row.id)
    setStatus(null)
    try {
      await api<{ ok: boolean }>(`/security/events/${encodeURIComponent(row.id)}/acknowledge`, { method: 'POST' })
      setStatus({ tone: 'ok', text: 'Event acknowledged.' })
      events.reload()
    } catch (e) {
      setStatus({ tone: 'error', text: errorMessage(e) })
    } finally {
      setAckingId(null)
    }
  }

  const totalEvents = (summary.data?.byType ?? []).reduce((sum, row) => sum + row.count, 0)
  const decisions = summary.data?.authorisation ?? {}

  return (
    <>
      {summary.error ? <ErrorState error={summary.error} /> : null}
      <div className="grid kpi" style={{ marginBottom: 16 }}>
        {summary.loading || !summary.data ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div className="card" key={i}>
              <Loading rows={2} />
            </div>
          ))
        ) : (
          <>
            <Kpi label="Security events" value={totalEvents} sub="last 30 days" />
            <Kpi label="Allowed" value={decisions.ALLOW ?? 0} sub="authorisation decisions, 30 days" />
            <Kpi label="Denied" value={decisions.DENY ?? 0} sub="authorisation decisions, 30 days" />
            <Kpi label="Errors" value={decisions.ERROR ?? 0} sub="authorisation decisions, 30 days" />
          </>
        )}
      </div>

      <div className="grid two" style={{ marginBottom: 16 }}>
        <Card title="Events by type — last 30 days">
          {summary.loading ? (
            <Loading />
          ) : summary.error ? (
            <ErrorState error={summary.error} />
          ) : (
            <BarChart
              emptyLabel="No security events in the last 30 days"
              data={(summary.data?.byType ?? []).map((row) => ({
                label: row.eventType.replace(/_/g, ' '),
                value: row.count,
              }))}
            />
          )}
        </Card>
        <Card title="Authorisation outcomes — last 30 days">
          {summary.loading ? (
            <Loading />
          ) : summary.error ? (
            <ErrorState error={summary.error} />
          ) : (
            <BarChart
              emptyLabel="No authorisation decisions recorded yet"
              data={DECISIONS.map((decision) => ({ label: decision, value: decisions[decision] ?? 0 }))}
            />
          )}
        </Card>
      </div>

      <Card title="Security events">
        <form className="toolbar" onSubmit={applyFilters} aria-label="Filter security events">
          <div>
            <label htmlFor="evt-type" className="visually-hidden">
              Event type
            </label>
            <input
              id="evt-type"
              list="evt-type-options"
              placeholder="Event type (any)"
              maxLength={40}
              value={draft.eventType}
              onChange={(e) => setDraft({ ...draft, eventType: e.target.value.toUpperCase() })}
            />
            <datalist id="evt-type-options">
              {KNOWN_EVENT_TYPES.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="evt-severity" className="visually-hidden">
              Severity
            </label>
            <select
              id="evt-severity"
              value={draft.severity}
              onChange={(e) => setDraft({ ...draft, severity: e.target.value })}
            >
              <option value="">Any severity</option>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="evt-since" className="visually-hidden">
              Since date
            </label>
            <input
              id="evt-since"
              type="date"
              value={draft.since}
              onChange={(e) => setDraft({ ...draft, since: e.target.value })}
            />
          </div>
          <label htmlFor="evt-unack" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <input
              id="evt-unack"
              type="checkbox"
              style={{ width: 'auto' }}
              checked={draft.unacknowledgedOnly}
              onChange={(e) => setDraft({ ...draft, unacknowledgedOnly: e.target.checked })}
            />
            Unacknowledged only
          </label>
          <button type="submit" className="primary">
            Apply filters
          </button>
          <button type="button" onClick={clearFilters}>
            Clear
          </button>
        </form>

        {status ? (
          <div className={`notice ${status.tone === 'ok' ? 'info' : 'error'}`} role="status" aria-live="polite">
            {status.text}
          </div>
        ) : null}

        {events.loading && !events.data ? (
          <Loading rows={5} />
        ) : events.error ? (
          <ErrorState error={events.error} />
        ) : !events.data || events.data.items.length === 0 ? (
          <Empty
            title="No security events match"
            hint={
              applied.eventType || applied.severity || applied.since || applied.unacknowledgedOnly
                ? 'Try widening the filters.'
                : 'Blocked requests and injection attempts will appear here as they are detected.'
            }
          />
        ) : (
          <>
            <div className="table-wrap" aria-busy={events.loading}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Type</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Summary</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Acknowledged</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.items.map((row) => {
                    const open = expanded.has(row.id)
                    const detailId = `evt-detail-${row.id}`
                    return (
                      <Row key={row.id} open={open} detailId={detailId} colSpan={8} detail={row.detail}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.timestamp)}</td>
                        <td>
                          <Badge value={row.eventType} />
                        </td>
                        <td>
                          <Badge value={row.severity} />
                        </td>
                        <td>{row.channel}</td>
                        <td style={{ minWidth: 220, maxWidth: 460 }}>{row.summary}</td>
                        <td>
                          <Subject userId={row.userId} telegramId={row.telegramId} subjectKey={row.subjectKey} />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {row.acknowledgedAt ? (
                            <>
                              <span className="badge ok">Acknowledged</span>
                              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                                {formatDateTime(row.acknowledgedAt)}
                              </div>
                            </>
                          ) : (
                            <span className="badge warn">Open</span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              type="button"
                              style={{ padding: '4px 9px', fontSize: 12 }}
                              aria-expanded={open}
                              aria-controls={detailId}
                              onClick={() => toggle(row.id)}
                            >
                              {open ? 'Hide' : 'Details'}
                            </button>
                            {canAck && !row.acknowledgedAt ? (
                              <button
                                type="button"
                                style={{ padding: '4px 9px', fontSize: 12 }}
                                disabled={ackingId !== null}
                                onClick={() => void acknowledge(row)}
                              >
                                {ackingId === row.id ? 'Acknowledging…' : 'Acknowledge'}
                              </button>
                            ) : null}
                          </span>
                        </td>
                      </Row>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              total={events.data.total}
              offset={events.data.offset}
              count={events.data.items.length}
              hasMore={events.data.hasMore}
              onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              onNext={() => setOffset(offset + PAGE_SIZE)}
            />
          </>
        )}
      </Card>
    </>
  )
}

/** A table row plus an optional expanded detail row beneath it. */
function Row({
  open,
  detailId,
  colSpan,
  detail,
  children,
}: {
  open: boolean
  detailId: string
  colSpan: number
  detail: unknown
  children: ReactNode
}) {
  return (
    <>
      <tr>{children}</tr>
      {open ? (
        <tr>
          <td colSpan={colSpan} style={{ background: 'var(--surface-alt)' }}>
            <JsonBlock id={detailId} value={detail} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

// --- Audit tab ---------------------------------------------------------------

interface AuditFilters {
  decision: string
  resource: string
  userId: string
  since: string
}

const EMPTY_AUDIT_FILTERS: AuditFilters = { decision: '', resource: '', userId: '', since: '' }

function AuditTab() {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const listPath = useMemo(
    () =>
      `/audit${buildQuery({
        decision: applied.decision || undefined,
        resource: applied.resource.trim() || undefined,
        userId: applied.userId.trim() || undefined,
        since: sinceIso(applied.since),
        limit: PAGE_SIZE,
        offset,
      })}`,
    [applied, offset],
  )
  const audit = useApi<Page<AuditRecord>>(listPath)

  function applyFilters(event: FormEvent) {
    event.preventDefault()
    setApplied(draft)
    setOffset(0)
    setExpanded(new Set())
  }

  function clearFilters() {
    setDraft(EMPTY_AUDIT_FILTERS)
    setApplied(EMPTY_AUDIT_FILTERS)
    setOffset(0)
    setExpanded(new Set())
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filtered = Boolean(applied.decision || applied.resource || applied.userId || applied.since)

  return (
    <>
      <div className="notice info" role="note">
        <strong>Append-only. </strong>
        Every authorisation decision is written once and can never be edited or deleted; there is no API
        that changes a past entry. Viewing this trail is itself recorded as an audit entry.
      </div>

      <Card title="Audit trail">
        <form className="toolbar" onSubmit={applyFilters} aria-label="Filter audit trail">
          <div>
            <label htmlFor="aud-decision" className="visually-hidden">
              Decision
            </label>
            <select
              id="aud-decision"
              value={draft.decision}
              onChange={(e) => setDraft({ ...draft, decision: e.target.value })}
            >
              <option value="">Any decision</option>
              {DECISIONS.map((decision) => (
                <option key={decision} value={decision}>
                  {decision}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="aud-resource" className="visually-hidden">
              Resource
            </label>
            <input
              id="aud-resource"
              placeholder="Resource (e.g. leave.request)"
              maxLength={60}
              value={draft.resource}
              onChange={(e) => setDraft({ ...draft, resource: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="aud-user" className="visually-hidden">
              User ID
            </label>
            <input
              id="aud-user"
              placeholder="User ID"
              maxLength={40}
              className="mono"
              value={draft.userId}
              onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="aud-since" className="visually-hidden">
              Since date
            </label>
            <input
              id="aud-since"
              type="date"
              value={draft.since}
              onChange={(e) => setDraft({ ...draft, since: e.target.value })}
            />
          </div>
          <button type="submit" className="primary">
            Apply filters
          </button>
          <button type="button" onClick={clearFilters}>
            Clear
          </button>
        </form>

        {audit.loading && !audit.data ? (
          <Loading rows={5} />
        ) : audit.error ? (
          <ErrorState error={audit.error} />
        ) : !audit.data || audit.data.items.length === 0 ? (
          <Empty
            title="No audit entries match"
            hint={filtered ? 'Try widening the filters.' : 'Authorisation decisions will appear here as the system is used.'}
          />
        ) : (
          <>
            <div className="table-wrap" aria-busy={audit.loading}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Decision</th>
                    <th scope="col">Resource</th>
                    <th scope="col">Action</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Intent</th>
                    <th scope="col">Risk</th>
                    <th scope="col">Channel</th>
                    <th scope="col">User</th>
                    <th scope="col">Request</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.items.map((row) => {
                    const open = expanded.has(row.id)
                    const detailId = `aud-detail-${row.id}`
                    return (
                      <Row key={row.id} open={open} detailId={detailId} colSpan={11} detail={row.metadata}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.timestamp)}</td>
                        <td>
                          <Badge value={row.decision} />
                        </td>
                        <td>
                          {row.resource}
                          {row.resourceId ? (
                            <div className="mono" style={{ color: 'var(--text-faint)', fontSize: 11 }} title={row.resourceId}>
                              {truncate(row.resourceId, 22)}
                            </div>
                          ) : null}
                        </td>
                        <td>{row.action}</td>
                        <td>{row.reasonCode ? <span className="mono">{row.reasonCode}</span> : <Dash />}</td>
                        <td>{row.intent ?? <Dash />}</td>
                        <td>{row.risk ? <Badge value={row.risk} /> : <Dash />}</td>
                        <td>
                          {row.channel}
                          {row.bot ? <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>{row.bot}</div> : null}
                        </td>
                        <td>
                          <Subject userId={row.userId} telegramId={row.telegramId} subjectKey={null} />
                        </td>
                        <td className="mono" title={row.requestId ?? undefined}>
                          {row.requestId ? truncate(row.requestId, 14) : <Dash />}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            style={{ padding: '4px 9px', fontSize: 12 }}
                            aria-expanded={open}
                            aria-controls={detailId}
                            onClick={() => toggle(row.id)}
                          >
                            {open ? 'Hide' : 'Metadata'}
                          </button>
                        </td>
                      </Row>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              total={audit.data.total}
              offset={audit.data.offset}
              count={audit.data.items.length}
              hasMore={audit.data.hasMore}
              onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              onNext={() => setOffset(offset + PAGE_SIZE)}
            />
          </>
        )}
      </Card>
    </>
  )
}

function Dash() {
  return <span style={{ color: 'var(--text-faint)' }}>—</span>
}
