'use client'

/**
 * Sign-in. Credentials go straight to the API over HTTPS; the browser only
 * ever receives an HttpOnly session cookie plus a CSRF token.
 */

import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { useSession } from '@/components/session'
import { ApiRequestError, login } from '@/lib/api'

export default function LoginPage() {
  const router = useRouter()
  const { user, loading, refresh } = useSession()
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
      await login(email, password)
      await refresh()
      router.replace('/')
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError(
          e.status === 429
            ? 'Too many attempts. Please wait a few minutes and try again.'
            : e.error.message,
        )
      } else {
        setError('Could not reach the server. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card card" onSubmit={onSubmit} aria-labelledby="login-title">
        <div className="brand" style={{ padding: '0 0 14px' }}>
          CORPUS
          <span>HR Administration</span>
        </div>
        <h1 id="login-title" style={{ fontSize: 18, marginBottom: 14 }}>
          Sign in
        </h1>
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="email">Work e-mail</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button className="primary" type="submit" disabled={submitting} style={{ width: '100%' }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="hint" style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 14 }}>
          Access is limited to verified staff. Your role and permissions are determined by the
          server on every request.
        </p>
      </form>
    </div>
  )
}
