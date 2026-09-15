'use client'

/**
 * Application shell: grouped sidebar navigation, a compact header on small
 * screens, and the auth gate.
 *
 * Navigation entries are filtered by the user's permissions for UX only. A
 * hidden entry is not a security control — every API route re-authorises
 * (CLAUDE.md §34, §39).
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { LogoMark } from '@/components/logo'
import { useSession } from '@/components/session'
import { Loading } from '@/components/ui'
import { can } from '@/lib/api'

type IconName =
  | 'home'
  | 'people'
  | 'calendar'
  | 'briefcase'
  | 'document'
  | 'book'
  | 'chat'
  | 'shield'
  | 'settings'

interface NavItem {
  href: string
  label: string
  icon: IconName
  /** Any one of these permissions shows the entry. Empty = everyone. */
  anyOf: string[]
}

const ROLE_LABEL: Record<string, string> = {
  EMPLOYEE: 'Employee',
  MANAGER: 'Manager',
  HR: 'HR',
  HR_ADMIN: 'HR admin',
  SYSTEM_ADMIN: 'System admin',
}

/** Small stroke icons, inline so the page loads no icon font. */
function Icon({ name }: { name: IconName }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 11l9-8 9 8" />
          <path d="M5 10v10h14V10" />
        </svg>
      )
    case 'people':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
          <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
          <path d="M17.5 14c2.6.5 4 2.6 4 6" />
        </svg>
      )
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      )
    case 'briefcase':
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" />
        </svg>
      )
    case 'document':
      return (
        <svg {...common}>
          <path d="M7 3h7l5 5v13H7z" />
          <path d="M14 3v5h5M10 13h6M10 17h6" />
        </svg>
      )
    case 'book':
      return (
        <svg {...common}>
          <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
          <path d="M4 19a2 2 0 0 1 2-2h13" />
        </svg>
      )
    case 'chat':
      return (
        <svg {...common}>
          <path d="M4 5h16v11H9l-5 4z" />
          <path d="M8 9h8M8 12.5h5" />
        </svg>
      )
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      )
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

interface NavGroup {
  label: string | null
  items: NavItem[]
}

const NAV: NavGroup[] = [
  {
    label: null,
    items: [{ href: '/', label: 'Dashboard', icon: 'home', anyOf: [] }],
  },
  {
    label: 'HR',
    items: [
      { href: '/people', label: 'People', icon: 'people', anyOf: ['employee.read.team', 'employee.read.all'] },
      { href: '/leave', label: 'Leave', icon: 'calendar', anyOf: [] },
      { href: '/recruitment', label: 'Recruitment', icon: 'briefcase', anyOf: ['job.read.internal'] },
      { href: '/recruitment/cvs', label: 'CVs', icon: 'document', anyOf: ['candidate.document.read'] },
      { href: '/knowledge', label: 'Policies', icon: 'book', anyOf: ['policy.read'] },
    ],
  },
  {
    label: 'Telegram',
    items: [{ href: '/knowledge/training', label: 'Bot answers', icon: 'chat', anyOf: ['faq.manage'] }],
  },
  {
    label: 'Account',
    items: [
      { href: '/security', label: 'Security', icon: 'shield', anyOf: ['audit.read', 'security.read'] },
      { href: '/settings', label: 'Settings', icon: 'settings', anyOf: [] },
    ],
  },
]

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useSession()
  const pathname = usePathname()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!loading && !user) router.replace('/login')
  }, [loading, user, router])

  // A route change closes the small-screen menu.
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

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

  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.anyOf.length === 0 || item.anyOf.some((p) => can(user, p))),
  })).filter((group) => group.items.length > 0)
  const visible = groups.flatMap((g) => g.items)

  // Longest matching prefix wins, so /knowledge/training highlights itself
  // rather than lighting up /knowledge as well.
  const active = visible
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]

  const signOutButton = (
    <button
      type="button"
      className="small"
      onClick={() => {
        void signOut().then(() => router.replace('/login'))
      }}
    >
      Sign out
    </button>
  )

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <LogoMark size={32} />
          <span className="brand-text">
            <strong>CORPUS</strong>
            <span>{active?.label ?? 'HR Administration'}</span>
          </span>
        </Link>
        <button
          type="button"
          className="small"
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </header>

      <nav className="sidebar" id="primary-nav" aria-label="Primary" data-open={menuOpen || undefined}>
        <Link href="/" className="brand sidebar-brand">
          <LogoMark size={34} />
          <span className="brand-text">
            <strong>CORPUS</strong>
            <span>HR Administration</span>
          </span>
        </Link>
        {groups.map((group, index) => (
          <div className="nav-group" key={group.label ?? index}>
            {group.label ? <div className="nav-group-label">{group.label}</div> : null}
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="nav-link"
                aria-current={item.href === active?.href ? 'page' : undefined}
              >
                <Icon name={item.icon} />
                {item.label}
              </Link>
            ))}
          </div>
        ))}
        <div className="sidebar-footer">
          <span className="avatar" aria-hidden="true">
            {initials(user.displayName)}
          </span>
          <div className="sidebar-user">
            <div>
              <strong>{user.displayName}</strong>
            </div>
            <div>{user.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</div>
          </div>
          {signOutButton}
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
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}
