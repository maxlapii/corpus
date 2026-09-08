/**
 * API client.
 *
 * The dashboard never holds a secret (CLAUDE.md §34). Authentication is the
 * HttpOnly session cookie set by the API; the CSRF token is kept in memory and
 * sent on every state-changing request.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:8787'

export const CSRF_HEADER = 'x-corpus-csrf'

export interface ApiError {
  code: string
  message: string
  details?: Record<string, unknown>
  requestId?: string
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message)
    this.name = 'ApiRequestError'
  }

  /** True when the failure is an authorisation refusal rather than a bug. */
  get isForbidden(): boolean {
    return this.status === 403
  }

  get isUnauthenticated(): boolean {
    return this.status === 401
  }
}

let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
  if (typeof window !== 'undefined') {
    // sessionStorage, not localStorage: the token dies with the tab, and it is
    // not a credential on its own — the HttpOnly cookie is.
    try {
      if (token) window.sessionStorage.setItem('corpus_csrf', token)
      else window.sessionStorage.removeItem('corpus_csrf')
    } catch {
      // Storage may be unavailable (private mode); the in-memory copy suffices.
    }
  }
}

export function getCsrfToken(): string | null {
  if (csrfToken) return csrfToken
  if (typeof window === 'undefined') return null
  try {
    csrfToken = window.sessionStorage.getItem('corpus_csrf')
  } catch {
    csrfToken = null
  }
  return csrfToken
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = {}

  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') {
    const token = getCsrfToken()
    if (token) headers[CSRF_HEADER] = token
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    // The session cookie must accompany every request.
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}

  if (!response.ok) {
    const error = (payload.error as ApiError | undefined) ?? {
      code: 'UNKNOWN',
      message: 'The request failed.',
    }
    throw new ApiRequestError(response.status, error)
  }
  return payload as T
}

// --- Response shapes -------------------------------------------------------

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface CurrentUser {
  id: string
  email: string
  displayName: string
  employeeId: string | null
  roles: string[]
  /** For UX only. The backend is authoritative (CLAUDE.md §34). */
  permissions: string[]
  managedEmployeeCount: number
}

export async function login(email: string, password: string): Promise<CurrentUser> {
  const result = await api<{ user: { id: string; displayName: string; roles: string[] }; csrfToken: string }>(
    '/auth/login',
    { method: 'POST', body: { email, password } },
  )
  setCsrfToken(result.csrfToken)
  const me = await api<{ user: CurrentUser; csrfToken: string }>('/auth/me')
  setCsrfToken(me.csrfToken)
  return me.user
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' })
  } finally {
    setCsrfToken(null)
  }
}

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const me = await api<{ user: CurrentUser; csrfToken: string }>('/auth/me')
    setCsrfToken(me.csrfToken)
    return me.user
  } catch (e) {
    if (e instanceof ApiRequestError && e.isUnauthenticated) return null
    throw e
  }
}

/**
 * Frontend permission check — for showing and hiding UI only.
 *
 * A hidden control is a convenience, never a security boundary: every route
 * re-checks with the PolicyGateway, so a user who forges their way to a page
 * still receives 403 from the API.
 */
export function can(user: CurrentUser | null, permission: string): boolean {
  return user?.permissions.includes(permission) ?? false
}
