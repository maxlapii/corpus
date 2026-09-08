'use client'

/**
 * Application shell: sidebar navigation plus auth gate.
 *
 * Navigation entries are filtered by the user's permissions for UX only. A
 * hidden entry is not a security control — every API route re-authorises
 * (CLAUDE.md §34, §39).
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { useSession } from '@/components/session'
import { Loading } from '@/components/ui'
import { can } from '@/lib/api'

interface NavItem {
  href: string
  label: string
  /** Any one of these permissions shows the entry. Empty = everyone. */
  anyOf: string[]
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', anyOf: [] },
  { href: '/people', label: 'People', anyOf: ['employee.read.team', 'employee.read.all'] },
  { href: '/recruitment', label: 'Recruitment', anyOf: ['job.read.internal'] },
  { href: '/leave', label: 'Leave', anyOf: [] },
  { href: '/knowledge', label: 'Knowledge', anyOf: ['policy.read'] },
  { href: '/knowledge/training', label: 'Bot training', anyOf: ['faq.manage'] },
  { href: '/assistant', label: 'Assistant', anyOf: [] },
  { href: '/reports', label: 'Reports', anyOf: ['report.read'] },
  { href: '/security', label: 'Security', anyOf: ['audit.read', 'security.read'] },
  { href: '/settings', label: 'Settings', anyOf: [] },
]

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useSession()
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !user) router.replace('/login')
  }, [loading, user, router])

  if (loading) {
    return (
      <div className="auth-shell">
        <div className="auth-card card">
          <Loading rows={3} label="Checking your session" />
        </div>
      </div>
    )
  }
  if (!user) return null

  const visible = NAV.filter((item) => item.anyOf.length === 0 || item.anyOf.some((p) => can(user, p)))

  // Longest matching prefix wins, so /knowledge/training highlights itself
  // rather than lighting up /knowledge as well.
  const activeHref = visible
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Primary">
        <div className="brand">
          CORPUS
          <span>HR Administration</span>
        </div>
        {visible.map((item) => {
          const current = item.href === activeHref
          return (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link"
              aria-current={current ? 'page' : undefined}
            >
              {item.label}
            </Link>
          )
        })}
        <div className="sidebar-footer">
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>{user.displayName}</div>
          <div>{user.roles.join(', ')}</div>
          <button
            type="button"
            style={{ marginTop: 8, padding: '4px 9px', fontSize: 12 }}
            onClick={() => {
              void signOut().then(() => router.replace('/login'))
            }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="main" id="main">
        {children}
      </main>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions}
    </header>
  )
}
