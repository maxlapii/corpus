'use client'

/**
 * Settings — the signed-in user's Telegram link, account, employee record and
 * (for system administrators) the system status (CLAUDE.md §33, §34).
 *
 * Nothing on this page is authoritative. Roles are shown for orientation only,
 * every action is re-authorised by the API, and the system card renders the
 * secret-free `/health` payload exactly as the server sends it. The Telegram
 * form can only ever link the caller's own account: the API checks that the
 * e-mail and the employee resolved from the code both belong to the session.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Facts,
  Field,
  Loading,
  Notice,
  SubmitError,
  formatDate,
  humanize,
  type BadgeTone,
} from '@/components/ui'
import { useSession } from '@/components/session'
import { API_BASE, ApiRequestError, api, can, type ApiError, type CurrentUser } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Response shapes (mirroring apps/api/src/routes/*) ----------------------

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
}

/** GET /employees/me */
interface MeResponse {
  employee: Employee | null
  note?: string
}

interface Department {
  id: string
  name: string
}

interface Position {
  id: string
  title: string
}

/** GET /health — returned with 200 (ok) or 503 (degraded), same body. */
interface Health {
  status: string
  version?: string
  database: string
  migrationsApplied: number
  documentStorage: string
  config: Record<string, unknown>
  configErrors?: string[]
  configWarnings?: string[]
}

/** POST /auth/telegram/link — 200 { accepted } or 202 { instructions }. */
type LinkResponse = { accepted: boolean } | { instructions: string }

/** POST /auth/telegram/verify */
interface VerifyResponse {
  linked: boolean
}

// --- Local helpers -----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.length === 0 ? '(none)' : value.map((v) => describeValue(v)).join(', ')
  }
  return JSON.stringify(value)
}

/** Flattens nested config objects into dotted keys for a key/value table. */
function flattenConfig(value: Record<string, unknown>, prefix = ''): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = []
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v)) rows.push(...flattenConfig(v, key))
    else rows.push({ key, value: describeValue(v) })
  }
  return rows
}

const STATUS_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  ok: { label: 'Healthy', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  error: { label: 'Error', tone: 'danger' },
}

const STORAGE_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  r2: { label: 'Durable', tone: 'ok' },
  ephemeral: { label: 'Temporary — uploads will not be kept', tone: 'warn' },
}

function StatusBadge({ value, labels }: { value: string; labels: Record<string, { label: string; tone: BadgeTone }> }) {
  const known = labels[value.toLowerCase()]
  return <Badge value={known?.label ?? humanize(value)} tone={known?.tone ?? 'muted'} />
}

/**
 * `/health` answers 503 with the *same* body when degraded, so the shared
 * `api()` helper — which treats every non-2xx response as an error — would
 * discard exactly the detail we want to show. This local fetch keeps the body
 * either way. The route is unauthenticated, so no cookie is sent.
 */
function useHealth() {
  const [data, setData] = useState<Health | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/health`, { credentials: 'omit', signal: controller.signal })
      .then(async (response) => {
        const text = await response.text()
        let payload: Record<string, unknown>
        try {
          payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
        } catch {
          throw new Error('The status check returned an unreadable answer.')
        }
        if (typeof payload.status === 'string' && typeof payload.database === 'string') {
          return payload as unknown as Health
        }
        const apiError = (payload.error as ApiError | undefined) ?? {
          code: 'UNKNOWN',
          message: 'The status check did not return a readable status.',
        }
        throw new ApiRequestError(response.status, apiError)
      })
      .then((health) => {
        if (!controller.signal.aborted) setData(health)
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        // A network-level failure surfaces as a TypeError with an unhelpful
        // message; say what actually happened.
        setError(e instanceof TypeError ? new Error('Could not reach the system to check its status.') : e)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, loading, error, reload }
}

// --- Page --------------------------------------------------------------------

export default function SettingsPage() {
  const { user } = useSession()
  const me = useApi<MeResponse>(user ? '/employees/me' : null)
  const employee = me.data?.employee ?? null

  return (
    <Shell>
      <PageHeader title="Settings" description="Your Telegram link, your account and your employee record." />

      {user ? (
        <div className="grid">
          <TelegramCard user={user} />
          <div className="grid two">
            <AccountCard user={user} employee={employee} />
            <EmployeeCard state={me} />
          </div>
          {can(user, 'system.manage') ? <SystemCard /> : null}
        </div>
      ) : null}
    </Shell>
  )
}

// --- Telegram ----------------------------------------------------------------

const TELEGRAM_ID_PATTERN = /^\d{1,20}$/

function TelegramCard({ user }: { user: CurrentUser }) {
  const { refresh } = useSession()
  const [telegramUserId, setTelegramUserId] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'idle' | 'requesting' | 'verifying'>('idle')
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [justLinked, setJustLinked] = useState(false)

  const email = user.email

  function reset() {
    setError(null)
    setNotice(null)
  }

  /** Both buttons need a usable Telegram user ID; verify also needs the code. */
  function validate(withCode: boolean): boolean {
    if (!TELEGRAM_ID_PATTERN.test(telegramUserId.trim())) {
      setError(new Error('Enter your numeric Telegram user ID — digits only, not your @username.'))
      return false
    }
    if (withCode) {
      const trimmed = code.trim()
      if (trimmed.length < 4 || trimmed.length > 12) {
        setError(new Error('Enter the code from your e-mail.'))
        return false
      }
    }
    return true
  }

  async function requestCode() {
    reset()
    if (!validate(false)) return
    const id = telegramUserId.trim()
    setBusy('requesting')
    try {
      // The e-mail must be the signed-in user's own; the API rejects any other.
      const result = await api<LinkResponse>(`/auth/telegram/link?telegramUserId=${encodeURIComponent(id)}`, {
        method: 'POST',
        body: { email },
      })
      if ('accepted' in result) {
        if (result.accepted) {
          setNotice(
            `If that Telegram account and ${email} belong to the same employee, a code is on its way to your inbox. Codes are never sent through Telegram.`,
          )
        } else {
          setError(new Error('The request was not accepted. Please try again.'))
        }
      } else {
        setNotice(result.instructions)
      }
    } catch (e) {
      setError(e)
    } finally {
      setBusy('idle')
    }
  }

  async function onVerify(event: FormEvent) {
    event.preventDefault()
    reset()
    if (!validate(true)) return
    setBusy('verifying')
    try {
      const result = await api<VerifyResponse>('/auth/telegram/verify', {
        method: 'POST',
        body: { telegramUserId: telegramUserId.trim(), code: code.trim() },
      })
      if (result.linked) {
        setCode('')
        setJustLinked(true)
        // Re-read the session so the card flips to its linked state.
        await refresh()
      } else {
        setError(new Error('The link was not confirmed. Please try again.'))
      }
    } catch (e) {
      setError(e)
    } finally {
      setBusy('idle')
    }
  }

  const inFlight = busy !== 'idle'

  if (user.telegramLinked) {
    return (
      <Card title="Telegram">
        <Notice tone="ok">
          {justLinked ? <strong>Done. </strong> : null}
          Your Telegram account is linked to the employee bot.
        </Notice>
        <p className="muted small-text">
          To link a different Telegram account, open the employee bot and send <code>/verify</code> with your work
          e-mail again.
        </p>
      </Card>
    )
  }

  if (!user.employeeId) {
    return (
      <Card title="Telegram">
        <Empty
          title="Nothing to link"
          hint="This account has no employee record, so the employee bot cannot recognise it. Ask HR if you think it should."
        />
      </Card>
    )
  }

  return (
    <Card title="Telegram">
      <p className="muted small-text">
        The employee bot only answers staff it recognises. Link your Telegram account once with a one-time code.
      </p>
      <ol>
        <li>Open Telegram and start the CORPUS employee bot.</li>
        <li>
          Send <code>/verify {email}</code>. A code arrives by e-mail — never through Telegram.
        </li>
        <li>
          Send <code>/code 123456</code> to the bot with the digits you received.
        </li>
      </ol>

      <details className="more">
        <summary>Link from here instead</summary>
        <form onSubmit={onVerify} aria-describedby="telegram-form-note">
          <p id="telegram-form-note" className="muted small-text">
            Enter your numeric Telegram user ID (not your @username), ask for a code — it is e-mailed to {email} —
            then enter the code below.
          </p>

          <SubmitError error={error} />
          {notice ? <Notice tone="info">{notice}</Notice> : null}

          <div className="form-row">
            <Field id="telegram-user-id" label="Telegram user ID" hint="Digits only, as shown in your Telegram account.">
              <input
                id="telegram-user-id"
                inputMode="numeric"
                autoComplete="off"
                maxLength={32}
                value={telegramUserId}
                onChange={(e) => setTelegramUserId(e.target.value)}
                disabled={inFlight}
              />
            </Field>
            <Field id="telegram-code" label="Code from your e-mail">
              <input
                id="telegram-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={inFlight}
              />
            </Field>
          </div>

          <div className="form-actions">
            <button type="button" onClick={() => void requestCode()} disabled={inFlight}>
              {busy === 'requesting' ? 'Sending…' : 'E-mail me a code'}
            </button>
            <button className="primary" type="submit" disabled={inFlight}>
              {busy === 'verifying' ? 'Checking…' : 'Verify and link'}
            </button>
          </div>
        </form>
      </details>
    </Card>
  )
}

// --- Your account ------------------------------------------------------------

function AccountCard({ user, employee }: { user: CurrentUser; employee: Employee | null }) {
  return (
    <Card title="Your account">
      <Facts
        items={[
          { label: 'Name', value: user.displayName },
          { label: 'E-mail', value: user.email },
          { label: 'Roles', value: user.roles.length ? user.roles.map((r) => humanize(r)).join(', ') : '—' },
          ...(employee ? [{ label: 'Employee no.', value: employee.employeeNo }] : []),
        ]}
      />
    </Card>
  )
}

// --- Your employee record ----------------------------------------------------

function EmployeeCard({
  state,
}: {
  state: { data: MeResponse | null; loading: boolean; error: unknown }
}) {
  const employee = state.data?.employee ?? null

  const departments = useApi<{ departments: Department[] }>(employee?.departmentId ? '/departments' : null)
  const positions = useApi<{ positions: Position[] }>(employee?.positionId ? '/positions' : null)
  const manager = useApi<{ employee: Employee }>(
    employee?.managerId ? `/employees/${encodeURIComponent(employee.managerId)}` : null,
  )

  const departmentName = useMemo(
    () => departments.data?.departments.find((d) => d.id === employee?.departmentId)?.name ?? '—',
    [departments.data, employee?.departmentId],
  )
  const positionTitle = useMemo(
    () => positions.data?.positions.find((p) => p.id === employee?.positionId)?.title ?? '—',
    [positions.data, employee?.positionId],
  )
  const managerName = manager.data?.employee
    ? `${manager.data.employee.firstName} ${manager.data.employee.lastName}`
    : '—'

  return (
    <Card title="Your employee record">
      {state.loading ? (
        <Loading rows={6} label="Loading your employee record" />
      ) : state.error ? (
        <ErrorState error={state.error} />
      ) : !employee ? (
        <Empty
          title="No employee record"
          hint="This sign-in is not connected to an employee record. Ask HR if you think it should be."
        />
      ) : (
        <>
          <Facts
            items={[
              { label: 'Employee no.', value: employee.employeeNo },
              // Rows that need a lookup are hidden when that lookup fails.
              ...(departments.error ? [] : [{ label: 'Department', value: departments.loading ? '…' : departmentName }]),
              ...(positions.error ? [] : [{ label: 'Position', value: positions.loading ? '…' : positionTitle }]),
              { label: 'Manager', value: manager.loading ? '…' : managerName },
              { label: 'Hire date', value: formatDate(employee.hireDate) },
              { label: 'Employment type', value: humanize(employee.employmentType) },
              { label: 'Status', value: <Badge value={employee.status} /> },
            ]}
          />
          <p className="muted small-text">To correct any of these details, contact HR.</p>
        </>
      )}
    </Card>
  )
}

// --- System (system administrators only) ------------------------------------

function SystemCard() {
  const health = useHealth()
  const data = health.data
  const problems = [
    ...(data?.configErrors ?? []).map((text) => ({ text, tone: 'danger' as const })),
    ...(data?.configWarnings ?? []).map((text) => ({ text, tone: 'warn' as const })),
  ]
  const configRows = data && isPlainObject(data.config) ? flattenConfig(data.config) : []

  return (
    <Card
      title="System"
      actions={
        <button type="button" className="small" onClick={health.reload} disabled={health.loading}>
          Refresh
        </button>
      }
    >
      {health.loading ? (
        <Loading rows={4} label="Checking system status" />
      ) : health.error ? (
        <ErrorState error={health.error} />
      ) : !data ? (
        <Empty title="No status available" />
      ) : (
        <div className="grid">
          <Facts
            items={[
              { label: 'Status', value: <StatusBadge value={data.status} labels={STATUS_LABELS} /> },
              { label: 'Database', value: <StatusBadge value={data.database} labels={STATUS_LABELS} /> },
              { label: 'Document storage', value: <StatusBadge value={data.documentStorage} labels={STORAGE_LABELS} /> },
              { label: 'Version', value: data.version ?? '—' },
            ]}
          />

          {problems.length === 0 ? (
            <Notice tone="ok">No problems reported.</Notice>
          ) : (
            <Notice tone={problems.some((p) => p.tone === 'danger') ? 'error' : 'warn'}>
              <strong>Reported problems</strong>
              <ul>
                {problems.map((problem) => (
                  <li key={problem.text}>{problem.text}</li>
                ))}
              </ul>
            </Notice>
          )}

          <details className="more">
            <summary>Show configuration</summary>
            {configRows.length === 0 ? (
              <Empty title="No configuration reported" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Setting</th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configRows.map((row) => (
                      <tr key={row.key}>
                        <td className="mono">{row.key}</td>
                        <td>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </div>
      )}
    </Card>
  )
}
