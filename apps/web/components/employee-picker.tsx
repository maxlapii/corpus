'use client'

/**
 * Employee picker: search by name, e-mail or employee number and choose one
 * person. Used wherever a form needs an employee reference so HR never has to
 * type an internal id (CLAUDE.md §39).
 *
 * The list comes from GET /employees, which the API narrows to the caller's
 * grant (own team for a manager, everyone for HR). Nothing here widens that.
 */

import { useEffect, useState } from 'react'
import { api, type Page } from '@/lib/api'

export interface PickedEmployee {
  id: string
  employeeNo: string
  firstName: string
  lastName: string
  email: string
}

export function employeeLabel(e: PickedEmployee): string {
  return `${e.firstName} ${e.lastName} · ${e.employeeNo}`
}

export function EmployeePicker({
  id,
  value,
  onChange,
  disabled,
  placeholder = 'Search by name, e-mail or employee number',
}: {
  id: string
  value: PickedEmployee | null
  onChange(employee: PickedEmployee | null): void
  disabled?: boolean
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PickedEmployee[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      setError(null)
      api<Page<PickedEmployee>>(`/employees?query=${encodeURIComponent(term)}&limit=8&offset=0`)
        .then((page) => {
          if (!cancelled) setResults(page.items)
        })
        .catch(() => {
          if (!cancelled) setError('Could not search employees.')
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  if (value) {
    return (
      <div className="actions" style={{ justifyContent: 'space-between' }}>
        <span>
          <strong>
            {value.firstName} {value.lastName}
          </strong>{' '}
          <span style={{ color: 'var(--text-muted)' }}>
            {value.employeeNo} · {value.email}
          </span>
        </span>
        <button type="button" className="small" disabled={disabled} onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    )
  }

  const listId = `${id}-results`
  return (
    <div>
      <input
        id={id}
        type="search"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        aria-controls={listId}
        aria-expanded={results.length > 0}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error ? (
        <div className="hint" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}
      {searching ? <div className="hint">Searching…</div> : null}
      {results.length > 0 ? (
        <ul id={listId} className="picker-results" role="listbox">
          {results.map((e) => (
            <li key={e.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="picker-option"
                onClick={() => {
                  onChange(e)
                  setQuery('')
                  setResults([])
                }}
              >
                <span>
                  {e.firstName} {e.lastName}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {e.employeeNo} · {e.email}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim().length >= 2 && !searching ? (
        <div className="hint">No one matches.</div>
      ) : null}
    </div>
  )
}
