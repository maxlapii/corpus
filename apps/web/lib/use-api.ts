'use client'

/**
 * Tiny data-fetching hook. Re-runs when `path` changes; exposes loading, error
 * and a manual `reload`. No caching layer — the API is the source of truth and
 * every request is re-authorised there.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface ApiState<T> {
  data: T | null
  loading: boolean
  error: unknown
  reload(): void
}

export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(path !== null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (path === null) {
      setData(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [path, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, loading, error, reload }
}
