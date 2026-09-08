'use client'

/**
 * Session context.
 *
 * Holds the current user for UX decisions only. Every render that depends on a
 * permission is a convenience: the API re-checks with the PolicyGateway, so a
 * stale or tampered client state cannot yield data (CLAUDE.md §34).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { fetchCurrentUser, logout as apiLogout, type CurrentUser } from '@/lib/api'

interface SessionState {
  user: CurrentUser | null
  loading: boolean
  error: unknown
  refresh(): Promise<void>
  signOut(): Promise<void>
}

const SessionContext = createContext<SessionState>({
  user: null,
  loading: true,
  error: null,
  refresh: async () => {},
  signOut: async () => {},
})

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setUser(await fetchCurrentUser())
    } catch (e) {
      setError(e)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    await apiLogout()
    setUser(null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(
    () => ({ user, loading, error, refresh, signOut }),
    [user, loading, error, refresh, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  return useContext(SessionContext)
}

/** Convenience hook for UI gating. Not a security boundary. */
export function usePermission(permission: string): boolean {
  const { user } = useSession()
  return user?.permissions.includes(permission) ?? false
}
