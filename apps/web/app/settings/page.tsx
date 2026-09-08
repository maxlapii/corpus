'use client'

/**
 * Settings — the signed-in user's account, employee record, Telegram link,
 * the API's own health report, and the session (CLAUDE.md §33, §34).
 *
 * Nothing on this page is authoritative. Roles and permissions are shown for
 * orientation only, every action is re-authorised by the API, and the system
 * card renders the secret-free `/health` payload exactly as the server sends it.
 */

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Loading,
  formatDate,
  formatDateTime,
} from '@/components/ui'
import { useSession } from '@/components/session'
import { API_BASE, ApiRequestError, api, type ApiError } from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Response shapes (mirroring apps/api/src/routes/*) ----------------------

interface Employee {
  id: string
  tenantId: string
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

/** GET /employees/me */
interface MeResponse {
  employee: Employee | null
  note?: string
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

type FieldIssues = Record<string, string>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Per-field messages from a VALIDATION_FAILED response (`details.issues`). */
function issuesOf(error: ApiRequestError): FieldIssues {
  const raw = error.error.details?.issues
  const out: FieldIssues = {}
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const { path, message } = item
    if (typeof path !== 'string' || typeof message !== 'string') continue
    out[path] = out[path] ? `${out[path]}; ${message}` : message
  }
  return out
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
function flattenConfig(
  value: Record<string, unknown>,
  prefix = '',
): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = []
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v)) rows.push(...flattenConfig(v, key))
    else rows.push({ key, value: describeValue(v) })
  }
  return rows
}

const HEALTH_TONE: Record<string, string> = {
  ok: 'ok',
  degraded: 'warn',
  error: 'danger',
  r2: 'ok',
  ephemeral: 'warn',
}

function HealthBadge({ value }: { value: string }) {
  const tone = HEALTH_TONE[value.toLowerCase()] ?? 'muted'
  return <span className={`badge ${tone}`}>{value}</span>
}

const noteStyle = { fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' } as const
const rowHeaderStyle = { width: '34%', whiteSpace: 'normal' } as const

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
          throw new Error('The API returned a response that is not JSON.')
        }
        if (typeof payload.status === 'string' && typeof payload.database === 'string') {
          return payload as unknown as Health
        }
        const apiError = (payload.error as ApiError | undefined) ?? {
          code: 'UNKNOWN',
          message: 'The health check did not return a readable status.',
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
        setError(e instanceof TypeError ? new Error(`Could not reach the API at ${API_BASE}.`) : e)
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
  return (
    <Shell>
      <PageHeader
        title="Settings"
        description="Your account, employee record and Telegram link, plus the API's own health report. Roles and permissions shown here are for orientation only — the server decides on every request."
      />

      <div className="grid two" style={{ marginBottom: 14 }}>
        <AccountCard />
        <EmployeeCard />
      </div>

      <div style={{ marginBottom: 14 }}>
        <TelegramCard />
      </div>

      <div style={{ marginBottom: 14 }}>
        <SystemCard />
      </div>

      <SessionCard />
    </Shell>
  )
}

// --- Your account ------------------------------------------------------------

function AccountCard() {
  const { user } = useSession()
  if (!user) return null

  const permissions = [...user.permissions].sort()

  return (
    <Card title="Your account">
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th scope="row" style={rowHeaderStyle}>
                Name
              </th>
              <td>{user.displayName}</td>
            </tr>
            <tr>
              <th scope="row" style={rowHeaderStyle}>
                E-mail
              </th>
              <td>{user.email}</td>
            </tr>
            <tr>
              <th scope="row" style={rowHeaderStyle}>
                Roles
              </th>
              <td>
                {user.roles.length === 0 ? (
                  '—'
                ) : (
                  <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                    {user.roles.map((role) => (
                      <Badge key={role} value={role} />
                    ))}
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={rowHeaderStyle}>
                Employee ID
              </th>
              <td className={user.employeeId ? 'mono' : undefined}>
                {user.employeeId ?? 'Not linked to an employee record'}
              </td>
            </tr>
            <tr>
              <th scope="row" style={rowHeaderStyle}>
                Direct reports
              </th>
              <td>{user.managedEmployeeCount.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          Effective permissions ({permissions.length})
        </summary>
        <p style={{ ...noteStyle, margin: '8px 0 10px' }}>
          Informational only. This is the list the server reported for your roles so you know what
          to expect; it grants nothing. Every request is authorised by the server, which may still
          refuse an action that appears here.
        </p>
        {permissions.length === 0 ? (
          <Empty title="No permissions reported" />
        ) : (
          <ul
            className="mono"
            style={{
              margin: 0,
              paddingLeft: 18,
              columns: '2 200px',
              columnGap: 18,
              lineHeight: 1.9,
            }}
          >
            {permissions.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
        )}
      </details>
    </Card>
  )
}

// --- Your employee record ----------------------------------------------------

function EmployeeCard() {
  const { user } = useSession()
  const me = useApi<MeResponse>(user ? '/employees/me' : null)

  const employee = me.data?.employee ?? null

  return (
    <Card
      title="Your employee record"
      actions={
        <button type="button" onClick={me.reload} disabled={me.loading}>
          Refresh
        </button>
      }
    >
      {me.loading ? (
        <Loading rows={6} label="Loading your employee record" />
      ) : me.error ? (
        <ErrorState error={me.error} />
      ) : !employee ? (
        <Empty
          title="No employee record linked"
          hint={me.data?.note ?? 'This account is not linked to an employee record.'}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Employee no.
                </th>
                <td className="mono">{employee.employeeNo}</td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Name
                </th>
                <td>
                  {employee.firstName} {employee.lastName}
                </td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  E-mail
                </th>
                <td>{employee.email}</td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Phone
                </th>
                <td>{employee.phone ?? '—'}</td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Status
                </th>
                <td>
                  <Badge value={employee.status} />
                </td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Employment type
                </th>
                <td>{employee.employmentType.replace(/_/g, ' ')}</td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Hire date
                </th>
                <td>{formatDate(employee.hireDate)}</td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Department ID
                </th>
                <td className={employee.departmentId ? 'mono' : undefined}>
                  {employee.departmentId ?? '—'}
                </td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Position ID
                </th>
                <td className={employee.positionId ? 'mono' : undefined}>
                  {employee.positionId ?? '—'}
                </td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Manager ID
                </th>
                <td className={employee.managerId ? 'mono' : undefined}>
                  {employee.managerId ?? '—'}
                </td>
              </tr>
              <tr>
                <th scope="row" style={rowHeaderStyle}>
                  Last updated
                </th>
                <td>{formatDateTime(employee.updatedAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p style={{ ...noteStyle, margin: '12px 0 0' }}>
        To correct any of these details, contact HR — they cannot be edited here.
      </p>
    </Card>
  )
}

// --- Telegram ----------------------------------------------------------------

const TELEGRAM_ID_PATTERN = /^\d{1,20}$/

function TelegramCard() {
  const { user } = useSession()
  const [telegramUserId, setTelegramUserId] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'idle' | 'requesting' | 'verifying'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<FieldIssues>({})
  const [notice, setNotice] = useState<string | null>(null)

  if (!user) return null
  // Captured after the guard so the hoisted handlers below see a plain string.
  const email = user.email
  const canLink = user.employeeId !== null

  function reset() {
    setError(null)
    setIssues({})
    setNotice(null)
  }

  function fail(e: unknown) {
    if (e instanceof ApiRequestError) {
      setError(e.error.message)
      setIssues(issuesOf(e))
    } else {
      setError('Could not reach the server. Please try again.')
    }
  }

  async function requestCode() {
    reset()
    const id = telegramUserId.trim()
    if (!TELEGRAM_ID_PATTERN.test(id)) {
      setIssues({ telegramUserId: 'must be your numeric Telegram user ID (digits only)' })
      return
    }
    setBusy('requesting')
    try {
      // The e-mail must be the signed-in user's own; the server rejects any other.
      const result = await api<LinkResponse>(
        `/auth/telegram/link?telegramUserId=${encodeURIComponent(id)}`,
        { method: 'POST', body: { email } },
      )
      if ('accepted' in result) {
        if (result.accepted) {
          setNotice(
            `Request accepted. If Telegram ID ${id} and ${email} match an employee record, a 6-digit code is on its way to your inbox. Codes are never sent through Telegram.`,
          )
        } else {
          setError('The server did not accept the request.')
        }
      } else {
        setNotice(result.instructions)
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy('idle')
    }
  }

  async function onVerify(event: FormEvent) {
    event.preventDefault()
    reset()
    setBusy('verifying')
    try {
      const result = await api<VerifyResponse>('/auth/telegram/verify', {
        method: 'POST',
        body: { telegramUserId: telegramUserId.trim(), code: code.trim() },
      })
      if (result.linked) {
        setNotice('Telegram account linked. You can now use the internal HR bot with this account.')
        setCode('')
      } else {
        setError('The server did not confirm the link.')
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy('idle')
    }
  }

  const inFlight = busy !== 'idle'

  return (
    <Card title="Telegram">
      <div className="grid two">
        <div>
          <h3 style={{ marginBottom: 8 }}>Link from Telegram</h3>
          <p style={noteStyle}>
            The internal HR bot only answers verified employees. Your Telegram username never
            identifies you on its own, so a one-time code is required.
          </p>
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
            <li>Open Telegram and start the CORPUS internal HR bot.</li>
            <li>
              Send <code className="mono">/verify your.name@company.com</code> using your company
              e-mail address.
            </li>
            <li>
              A 6-digit code arrives <strong>by e-mail</strong> — never via Telegram. It expires
              after 10 minutes.
            </li>
            <li>
              Send <code className="mono">/code 123456</code> to the bot with the digits you
              received.
            </li>
          </ol>
        </div>

        <div>
          <h3 style={{ marginBottom: 8 }}>Or verify from here</h3>
          {!canLink ? (
            <div className="notice warn" role="status">
              <strong>Not available for this account. </strong>
              Your sign-in is not linked to an employee record, so there is nothing to link a
              Telegram account to. Contact HR if you believe this is wrong.
            </div>
          ) : (
            <form onSubmit={onVerify} aria-describedby="telegram-form-note">
              <p id="telegram-form-note" style={noteStyle}>
                Enter your numeric Telegram user ID (not your @username). Request a code — it is
                e-mailed to {user.email} — then enter it below. The link is only ever made to your
                own employee record.
              </p>

              {error ? (
                <div className="notice error" role="alert">
                  {error}
                </div>
              ) : null}
              {notice ? (
                <div className="notice info" role="status">
                  {notice}
                </div>
              ) : null}

              <div className="form-row">
                <div className="field">
                  <label htmlFor="telegram-user-id">Telegram user ID</label>
                  <input
                    id="telegram-user-id"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    maxLength={32}
                    value={telegramUserId}
                    onChange={(e) => setTelegramUserId(e.target.value)}
                    aria-invalid={issues.telegramUserId ? true : undefined}
                    aria-describedby={issues.telegramUserId ? 'telegram-user-id-error' : undefined}
                    disabled={inFlight}
                  />
                  {issues.telegramUserId ? (
                    <div
                      id="telegram-user-id-error"
                      className="hint"
                      style={{ color: 'var(--danger)' }}
                    >
                      {issues.telegramUserId}
                    </div>
                  ) : (
                    <div className="hint">Digits only, as shown in your Telegram account.</div>
                  )}
                </div>

                <div className="field">
                  <label htmlFor="telegram-code">Verification code</label>
                  <input
                    id="telegram-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    minLength={4}
                    maxLength={12}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    aria-invalid={issues.code ? true : undefined}
                    aria-describedby={issues.code ? 'telegram-code-error' : undefined}
                    disabled={inFlight}
                  />
                  {issues.code ? (
                    <div
                      id="telegram-code-error"
                      className="hint"
                      style={{ color: 'var(--danger)' }}
                    >
                      {issues.code}
                    </div>
                  ) : (
                    <div className="hint">The 6-digit code from your e-mail.</div>
                  )}
                </div>
              </div>

              <div className="toolbar" style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  onClick={() => void requestCode()}
                  disabled={inFlight || telegramUserId.trim().length === 0}
                >
                  {busy === 'requesting' ? 'Requesting…' : 'E-mail me a code'}
                </button>
                <button className="primary" type="submit" disabled={inFlight}>
                  {busy === 'verifying' ? 'Verifying…' : 'Verify and link'}
                </button>
                <span aria-live="polite" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  {busy === 'requesting'
                    ? 'Asking the server to e-mail a code…'
                    : busy === 'verifying'
                      ? 'Checking the code…'
                      : ''}
                </span>
              </div>
            </form>
          )}
        </div>
      </div>
    </Card>
  )
}

// --- System ------------------------------------------------------------------

function SystemCard() {
  const health = useHealth()
  const data = health.data
  const configErrors = data?.configErrors ?? []
  const configWarnings = data?.configWarnings ?? []
  const configRows = data && isPlainObject(data.config) ? flattenConfig(data.config) : []

  return (
    <Card
      title="System"
      actions={
        <button type="button" onClick={health.reload} disabled={health.loading}>
          Refresh
        </button>
      }
    >
      <p style={noteStyle}>
        Live from <code className="mono">GET /health</code>. That route is unauthenticated and
        secret-free by design: it reports configuration as names, flags and limits, never values.
      </p>

      {health.loading ? (
        <Loading rows={5} label="Checking system health" />
      ) : health.error ? (
        <ErrorState error={health.error} />
      ) : !data ? (
        <Empty title="No health data" hint="The API did not return a status." />
      ) : (
        <>
          <div className="grid kpi" style={{ marginBottom: 14 }}>
            <div>
              <div className="kpi-label">Status</div>
              <div style={{ marginTop: 6 }}>
                <HealthBadge value={data.status} />
              </div>
            </div>
            <div>
              <div className="kpi-label">Database</div>
              <div style={{ marginTop: 6 }}>
                <HealthBadge value={data.database} />
              </div>
            </div>
            <div>
              <div className="kpi-label">Migrations applied</div>
              <div className="kpi-value">{data.migrationsApplied.toLocaleString()}</div>
            </div>
            <div>
              <div className="kpi-label">Document storage</div>
              <div style={{ marginTop: 6 }}>
                <HealthBadge value={data.documentStorage} />
              </div>
              {data.documentStorage === 'ephemeral' ? (
                <div className="kpi-sub">No R2 bucket bound — uploads will not persist.</div>
              ) : null}
            </div>
            {data.version ? (
              <div>
                <div className="kpi-label">API version</div>
                <div className="kpi-value mono" style={{ fontSize: 18 }}>
                  {data.version}
                </div>
              </div>
            ) : null}
          </div>

          {configErrors.length > 0 ? (
            <div className="notice error" role="alert">
              <strong>Configuration errors</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {configErrors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {configWarnings.length > 0 ? (
            <div className="notice warn" role="status">
              <strong>Configuration warnings</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {configWarnings.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {configErrors.length === 0 && configWarnings.length === 0 ? (
            <div className="notice info" role="status">
              No configuration problems reported.
            </div>
          ) : null}

          <h3 style={{ margin: '0 0 8px' }}>Configuration</h3>
          {configRows.length === 0 ? (
            <Empty title="No configuration reported" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
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
        </>
      )}
    </Card>
  )
}

// --- Session -----------------------------------------------------------------

function SessionCard() {
  const { signOut } = useSession()
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSignOut() {
    setSigningOut(true)
    setError(null)
    try {
      await signOut()
      router.replace('/login')
    } catch (e) {
      // A 401 means the session was already gone server-side — that is signed out.
      if (e instanceof ApiRequestError && e.isUnauthenticated) {
        router.replace('/login')
        return
      }
      setError(
        e instanceof ApiRequestError
          ? e.error.message
          : 'Could not reach the server. Please try again.',
      )
      setSigningOut(false)
    }
  }

  return (
    <Card title="Session">
      <p style={noteStyle}>
        Signing out revokes this browser session on the server and clears the session cookie.
      </p>
      {error ? (
        <div className="notice error" role="alert">
          <strong>Could not sign out. </strong>
          {error}
        </div>
      ) : null}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button type="button" onClick={() => void onSignOut()} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
        <span aria-live="polite" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          {signingOut ? 'Ending your session…' : ''}
        </span>
      </div>
    </Card>
  )
}
