'use client'

/**
 * Sign-in. Credentials go straight to the API over HTTPS; the browser only
 * ever receives an HttpOnly session cookie plus a CSRF token. The user object
 * cached here after sign-in drives navigation only — every later request is
 * re-checked by the API.
 */

import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { useSession } from '@/components/session'
import { Field, Loading, Notice } from '@/components/ui'
import { ApiRequestError, login } from '@/lib/api'

export default function LoginPage() {
  const router = useRouter()
  const { user, loading, setUser } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!loading && user) router.replace('/')
  }, [loading, user, router])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const me = await login(email, password)
      // Stays in the "Signing in…" state until the redirect above fires.
      setUser(me)
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError(
          e.status === 401
            ? 'That e-mail or password is not correct.'
            : e.status === 429
              ? 'Too many attempts. Please wait a few minutes and try again.'
              : e.error.message,
        )
      } else {
        setError('Could not connect. Please try again.')
      }
      setSubmitting(false)
    }
  }

  // A signed-in visitor is about to be redirected; show the same quiet card
  // as the initial session check rather than a form they should not fill in.
  const checking = loading || (user !== null && !submitting)

  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <div className="brand" style={{ padding: '0 0 14px' }}>
          CORPUS
          <span>HR Administration</span>
        </div>
        {checking ? (
          <Loading rows={3} label="Checking your session" />
        ) : (
          <form onSubmit={onSubmit} aria-labelledby="login-title">
            <h1 id="login-title" style={{ fontSize: 18, marginBottom: 14 }}>
              Sign in
            </h1>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <Field id="email" label="Work e-mail">
              <input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field id="password" label="Password">
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <button className="primary" type="submit" disabled={submitting} style={{ width: '100%' }}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="muted small-text">
              Access is limited to verified staff. Contact HR if you cannot sign in.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
