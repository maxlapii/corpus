'use client'

/**
 * Session context.
 *
 * Holds the current user for UX decisions only. Every render that depends on a
 * permission is a convenience: the API re-checks with the PolicyGateway, so a
 * stale or tampered client state cannot yield data (CLAUDE.md §34).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { fetchCurrentUser, logout as apiLogout, type CurrentUser } from '@/lib/api'

interface SessionState {
  user: CurrentUser | null
  loading: boolean
  error: unknown
  /**
   * Re-fetch the current user. The first load shows the global loading state;
   * later calls refresh in place so an open page is not unmounted.
   */
  refresh(): Promise<void>
  /**
   * Replace the cached user with one the API just returned (e.g. right after
   * sign-in). Purely a cache update — it grants nothing.
   */
  setUser(user: CurrentUser | null): void
  signOut(): Promise<void>
}

const SessionContext = createContext<SessionState>({
  user: null,
  loading: true,
  error: null,
  refresh: async () => {},
  setUser: () => {},
  signOut: async () => {},
})

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const hasUser = useRef(false)
  hasUser.current = user !== null

  const refresh = useCallback(async () => {
    if (!hasUser.current) setLoading(true)
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
    () => ({ user, loading, error, refresh, setUser, signOut }),
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
