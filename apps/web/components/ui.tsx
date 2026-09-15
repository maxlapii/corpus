'use client'

/**
 * Shared presentational pieces: loading, empty, error and permission-denied
 * states, plus small chart primitives (CLAUDE.md §39).
 *
 * A permission-denied state is a first-class UI outcome here, not an error —
 * the API refusing is expected behaviour, and the message it returns is what
 * the user sees.
 */

import { ApiRequestError, type Page } from '@/lib/api'
import { useId, type ReactNode } from 'react'

export function Card({
  title,
  actions,
  children,
}: {
  title?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-header">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Loading({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}…</span>
      <div style={{ display: 'grid', gap: 8 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton" style={{ width: `${100 - i * 12}%` }} />
        ))}
      </div>
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {hint}
    </div>
  )
}

/**
 * Renders the right thing for a failed request: a clear, non-alarming
 * permission message for a 403, an error for anything else.
 */
export function ErrorState({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && error.isForbidden) {
    return (
      <div className="notice warn" role="status">
        <strong>Not available to your role. </strong>
        {error.error.message}
      </div>
    )
  }
  const message =
    error instanceof ApiRequestError
      ? error.error.message
      : error instanceof Error
        ? error.message
        : 'Something went wrong.'
  const requestId = error instanceof ApiRequestError ? error.error.requestId : undefined
  return (
    <div className="notice error" role="alert">
      <strong>Could not load this. </strong>
      {message}
      {requestId ? (
        <div className="mono" style={{ marginTop: 6, fontSize: 11 }}>
          Reference: {requestId}
        </div>
      ) : null}
    </div>
  )
}

export function Kpi({
  label,
  value,
  sub,
}: {
  label: string
  value: number | string
  sub?: string
}) {
  return (
    <div className="card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  )
}

export function BarChart({
  data,
  emptyLabel = 'No data yet',
}: {
  data: { label: string; value: number }[]
  emptyLabel?: string
}) {
  if (data.length === 0) return <Empty title={emptyLabel} />
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="bars">
      {data.map((row) => (
        <div className="bar-row" key={row.label}>
          <span title={row.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.label}
          </span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
              role="img"
              aria-label={`${row.label}: ${row.value}`}
            />
          </div>
          <span className="bar-value">{row.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

const BADGE_TONE: Record<string, string> = {
  ACTIVE: 'ok',
  APPROVED: 'ok',
  PUBLISHED: 'ok',
  HIRED: 'ok',
  ALLOW: 'ok',
  OK: 'ok',
  PENDING: 'warn',
  DRAFT: 'muted',
  ON_LEAVE: 'warn',
  SCREENING: 'info',
  SHORTLISTED: 'info',
  INTERVIEW: 'info',
  TECHNICAL: 'info',
  FINAL: 'info',
  OFFER: 'info',
  APPLIED: 'muted',
  REJECTED: 'danger',
  DENY: 'danger',
  CANCELLED: 'muted',
  WITHDRAWN: 'muted',
  CLOSED: 'muted',
  SUSPENDED: 'danger',
  TERMINATED: 'danger',
  ARCHIVED: 'muted',
  PUBLIC: 'muted',
  INTERNAL: 'info',
  CONFIDENTIAL: 'warn',
  RESTRICTED: 'danger',
  INFO: 'muted',
  LOW: 'muted',
  MEDIUM: 'warn',
  HIGH: 'danger',
  CRITICAL: 'danger',
}

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted'

/**
 * Status chip. Enum values (APPROVED, PENDING…) pick their tone automatically;
 * free text needs an explicit `tone` or it renders muted.
 */
export function Badge({ value, tone }: { value: string; tone?: BadgeTone }) {
  const resolved = tone ?? BADGE_TONE[value.toUpperCase()] ?? 'muted'
  return <span className={`badge ${resolved}`}>{value.replace(/_/g, ' ')}</span>
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// --- Shared form and layout primitives --------------------------------------

/** Labelled form control with optional hint; the label is wired by `id`. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

/** Inline status message. `error` uses role=alert; the others are polite. */
export function Notice({
  tone,
  children,
  style,
}: {
  tone: 'ok' | 'info' | 'warn' | 'error'
  children: ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'} style={style}>
      {children}
    </div>
  )
}

/** Renders the API's own message for a failed write: 403 as warn, else error. */
export function SubmitError({ error }: { error: unknown }) {
  if (!error) return null
  if (error instanceof ApiRequestError && error.isForbidden) {
    return <Notice tone="warn">{error.error.message}</Notice>
  }
  const message =
    error instanceof ApiRequestError
      ? error.error.message
      : error instanceof Error
        ? error.message
        : 'Something went wrong.'
  return <Notice tone="error">{message}</Notice>
}

/** Previous / next controls for a paged API response. */
export function Pager<T>({ page, onChange }: { page: Page<T>; onChange(offset: number): void }) {
  const from = page.total === 0 ? 0 : page.offset + 1
  const to = page.offset + page.items.length
  const showControls = page.hasMore || page.offset > 0
  return (
    <div className="toolbar" style={{ marginTop: 12, marginBottom: 0, justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }} aria-live="polite">
        {from.toLocaleString()}–{to.toLocaleString()} of {page.total.toLocaleString()}
      </span>
      {showControls ? (
        <span className="actions">
          <button
            type="button"
            className="small"
            disabled={page.offset === 0}
            onClick={() => onChange(Math.max(0, page.offset - page.limit))}
          >
            Previous
          </button>
          <button
            type="button"
            className="small"
            disabled={!page.hasMore}
            onClick={() => onChange(page.offset + page.limit)}
          >
            Next
          </button>
        </span>
      ) : null}
    </div>
  )
}

/** Horizontal tab strip. Tabs switch a page region; they are not routes. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { key: K; label: string; count?: number }[]
  value: K
  onChange(key: K): void
  label: string
}) {
  const id = useId()
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`${id}-${tab.key}`}
          aria-selected={tab.key === value}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {typeof tab.count === 'number' ? (
            <span className="badge muted" style={{ marginLeft: 6 }}>
              {tab.count.toLocaleString()}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

/** Read-only label/value pairs for a record; stacks on narrow screens. */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="facts">
      {items.map((item) => (
        <FactRow key={item.label} label={item.label} value={item.value} />
      ))}
    </dl>
  )
}

function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
    </>
  )
}

/** "Title Case" from an UPPER_SNAKE enum value. */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—'
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
}
