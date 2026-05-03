'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useCounts, useCategories, useCategoryCounts } from '@/lib/hooks'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const SIDEBAR_COLOURS: Record<string, string> = {
  harbour:        '#1e3a4a',
  chalk:          '#1a1814',
  sand:           '#1a1710',
  slate:          '#141820',
  dusk:           '#130f1c',
  sage:           '#101810',
  neon:           '#08080e',
  neopastel:      '#1e1b4b',
  'electric-blue': '#0f0f0f',
  'electric-lime': '#0f0f0f',
}

const ICON_PATHS: Record<string, string> = {
  banknote:   'M2 6h20v12H2zM12 12m-2 0a2 2 0 104 0 2 2 0 00-4 0',
  graduation: 'M22 10v6M2 10l10-5 10 5-10 5zM6 12v5c3 3 9 3 12 0v-5',
  home:       'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2zM9 22V12h6v10',
  users:      'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  heart:      'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z',
  plane:      'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z',
  tag:        'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z',
}

function KeelLogo() {
  return (
    <svg width="56" height="56" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <circle cx="128" cy="128" r="110" fill="none" stroke="#B8964E" strokeWidth="8"/>
      <path d="M 108 83 L 128 93 L 148 83" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 110 101 L 128 111 L 146 101" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 112 119 L 128 129 L 144 119" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 114 137 L 128 147 L 142 137" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 116 155 L 128 165 L 140 155" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 118 173 L 128 183 L 138 173" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  )
}

function NavBadge({ count, variant = 'dark' }: { count: number; variant?: 'dark' | 'warn' | 'mute' }) {
  if (count === 0) return null
  const styles: Record<string, React.CSSProperties> = {
    dark: { background: '#B8964E', color: '#1C2A2E' },
    warn: { background: '#c45048', color: 'white' },
    mute: { background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.15)' },
  }
  return (
    <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', padding: '2px 7px', borderRadius: 10, minWidth: 20, textAlign: 'center', ...styles[variant] }}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

function CategoryItem({ cat, uid, navStyle, count }: {
  cat:      { categoryId: string; name: string; icon: string; itemCount: number }
  uid:      string
  navStyle: (active: boolean) => React.CSSProperties
  count:    number
}) {
  const [dragging, setDragging] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  return (
    <div
      draggable
      onDragStart={e => { setDragging(true); e.dataTransfer.setData('categoryId', cat.categoryId) }}
      onDragEnd={() => { setDragging(false); setDragOver(false) }}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault(); setDragOver(false)
        const draggedId = e.dataTransfer.getData('categoryId')
        if (!draggedId || draggedId === cat.categoryId) return
        window.dispatchEvent(new CustomEvent('keel:reorder-categories', { detail: { draggedId, targetId: cat.categoryId } }))
      }}
      style={{ ...navStyle(false), position: 'relative', opacity: dragging ? 0.4 : 1, borderTop: dragOver ? '2px solid var(--color-accent)' : '2px solid transparent', cursor: 'grab' }}
    >
      <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 'var(--fs-sm)', flexShrink: 0, letterSpacing: '-1px', userSelect: 'none' }}>&#8942;&#8942;</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{cat.name}</span>
      {count > 0 && <NavBadge count={count} variant="mute" />}
    </div>
  )
}

function SidebarInner() {
  const { user, signOut } = useAuth()
  const { theme }         = useTheme()
  const counts         = useCounts()
  const { categories } = useCategories()
  const categoryCounts = useCategoryCounts()
  const sidebarBg      = SIDEBAR_COLOURS[theme] ?? '#1e3a4a'

  // Handle drag-to-reorder
  useEffect(() => {
    const handler = async (e: Event) => {
      const { draggedId, targetId } = (e as CustomEvent).detail
      const ids = categories.map(c => c.categoryId)
      const fromIdx = ids.indexOf(draggedId)
      const toIdx   = ids.indexOf(targetId)
      if (fromIdx === -1 || toIdx === -1) return
      const reordered = [...ids]
      reordered.splice(fromIdx, 1)
      reordered.splice(toIdx, 0, draggedId)
      // Write new order values to Firestore
      const { doc: fDoc, updateDoc, Timestamp: TS } = await import('firebase/firestore')
      const { db: fDb } = await import('@/lib/firebase')
      await Promise.all(reordered.map((catId, i) =>
        updateDoc(fDoc(fDb, `users/${user!.uid}/categories`, catId), { order: i + 1, updatedAt: TS.now() })
      ))
    }
    window.addEventListener('keel:reorder-categories', handler)
    return () => window.removeEventListener('keel:reorder-categories', handler)
  }, [categories, user])

  const navItems = [
    { label: 'Dashboard',       href: '/dashboard',      icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', count: counts.dashboard,     badgeVariant: 'dark' as const },
    { label: 'Awaiting Reply',  href: '/awaiting-reply', icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',             count: counts.awaitingReply, badgeVariant: 'warn' as const },
    { label: 'Ignored',  href: '/quietly-logged', icon: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',                                                  count: counts.quietlyLogged, badgeVariant: 'mute' as const },
    { label: 'Payment History', href: '/payments',       icon: 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 10h8M8 14h8', count: 0, badgeVariant: 'dark' as const },
  ]

  const sectionLabel: React.CSSProperties = {
    fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)',
    color: 'rgba(255,255,255,0.25)', letterSpacing: '0.12em',
    textTransform: 'uppercase', padding: '0 8px', marginBottom: 4,
  }

  const navStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 8px', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: 'var(--fs-md)',
    fontFamily: 'var(--font-dm-sans)',
    textDecoration: 'none',
    color: active ? '#ffffff' : 'rgba(255,255,255,0.55)',
    fontWeight: active ? 500 : 400,
    background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
    transition: 'background 0.15s, color 0.15s',
  })

  const pathname       = usePathname()
  const searchParams   = useSearchParams()
  const currentFilter  = searchParams.get('priority') ?? ''

  const isActive = (href: string) => pathname === href

  return (
    <div style={{ width: 'var(--sidebar-width)', flexShrink: 0, background: sidebarBg, display: 'flex', flexDirection: 'column', overflow: 'hidden', transition: 'background 0.3s ease' }}>

      {/* Logo */}
      <div style={{ padding: '22px 18px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 13 }}>
        <KeelLogo />
        <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 600, color: '#B8964E', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-dm-sans)' }}>Keel</div>
      </div>

      {/* Views */}
      <div style={{ padding: '14px 8px 4px' }}>
        <div style={sectionLabel}>Views</div>

        {/* Dashboard — main view */}
        <Link href="/dashboard" scroll={false} style={navStyle(isActive('/dashboard') && !currentFilter)}>
          <span style={{ color: 'rgba(255,255,255,0.35)' }}><Icon d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" /></span>
          Dashboard
          <NavBadge count={counts.dashboard} variant="dark" />
        </Link>

        {/* Awaiting Reply — indented filter */}
        <Link href="/awaiting-reply" scroll={false} style={{ ...navStyle(isActive('/awaiting-reply')), paddingLeft: 28, fontSize: 'var(--fs-base)' }}>
          <span style={{ color: 'rgba(255,255,255,0.25)' }}><Icon d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" size={13} /></span>
          Awaiting Reply
          <NavBadge count={counts.awaitingReply} variant="warn" />
        </Link>

        {/* Priority filters — indented under Dashboard */}
        {[
          { label: 'High & above', filter: '3', minLevel: 3, colour: '#d4a017', count: counts.highPlus },
          { label: 'Urgent only',  filter: '4', minLevel: 4, colour: '#c45048', count: counts.urgentOnly },
        ].map(({ label, filter, minLevel, colour, count }) => {
          const isFilterActive = isActive('/dashboard') && currentFilter === filter
          return (
            <Link
              key={filter}
              href={`/dashboard?priority=${filter}`}
              scroll={false}
              style={{ ...navStyle(isFilterActive), paddingLeft: 28, fontSize: 'var(--fs-base)' }}
            >
              <span style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, flexShrink: 0 }}>
                {[1,2,3,4].map(bar => (
                  <div key={bar} style={{ width: 3, height: bar * 3, borderRadius: 1, background: bar >= minLevel ? colour : 'rgba(255,255,255,0.2)' }} />
                ))}
              </span>
              <span style={{ color: isFilterActive ? colour : 'rgba(255,255,255,0.45)' }}>{label}</span>
              <NavBadge count={count} variant="mute" />
            </Link>
          )
        })}
      </div>

      <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '8px 8px' }} />

      {/* Distinct views */}
      <div style={{ padding: '4px 8px' }}>
        <div style={sectionLabel}>Other views</div>
        {counts.uncategorised > 0 && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('keel:open-categorise'))}
            style={{ ...navStyle(false), width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' as React.CSSProperties['textAlign'] }}
          >
            <span style={{ color: 'rgba(255,255,255,0.35)' }}><Icon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></span>
            To categorise
            <NavBadge count={counts.uncategorised} variant="warn" />
          </button>
        )}
        <Link href="/quietly-logged" scroll={false} style={navStyle(isActive('/quietly-logged'))}>
          <span style={{ color: 'rgba(255,255,255,0.35)' }}><Icon d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" /></span>
          Ignored
          <NavBadge count={counts.quietlyLogged} variant="mute" />
        </Link>
        <Link href="/payments" scroll={false} style={navStyle(isActive('/payments'))}>
          <span style={{ color: 'rgba(255,255,255,0.35)' }}><Icon d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 10h8M8 14h8" /></span>
          Payment History
        </Link>
      </div>

      {/* Categories — live from Firestore, editable */}
      <div style={{ padding: '4px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          <div style={sectionLabel}>Categories</div>
          <Link
            href="/categories"
            style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.3)', textDecoration: 'none', letterSpacing: '0.06em', padding: '2px 0', flexShrink: 0 }}
            title="Edit categories and AI descriptions"
          >
            Edit all →
          </Link>
        </div>
        {/* Scrollable container — fixed height so sidebar footer stays anchored */}
        <div style={{ maxHeight: 240, overflowY: 'auto', overflowX: 'hidden' }}>
          {categories.map(cat => (
            <CategoryItem key={cat.categoryId} cat={cat} uid={user?.uid ?? ''} navStyle={navStyle} count={categoryCounts.get(cat.categoryId) ?? 0} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '8px 10px 10px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
        {/* Account + sign out */}
        <button onClick={signOut} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer', width: '100%', background: 'transparent', border: 'none', textAlign: 'left', fontFamily: 'var(--font-dm-sans)', transition: 'background 0.15s' }}
          onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
          onMouseOut={e => e.currentTarget.style.background = 'transparent'}
        >
          {user?.photoURL
            ? <img src={user.photoURL} alt="" width={30} height={30} style={{ borderRadius: '50%', flexShrink: 0 }} />
            : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(184,150,78,0.3)', border: '1px solid #B8964E', flexShrink: 0 }} />
          }
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 'var(--fs-base)', fontWeight: 500, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.displayName ?? 'Account'}
            </div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.45)', marginTop: 1 }}>Sign out</div>
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
          </svg>
        </button>

        {/* Separator */}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '6px 8px' }} />

        {/* Version + Feedback + Privacy row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px' }}>
          <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.04em', userSelect: 'none' }}>
            Keel · Alpha · v{process.env.NEXT_PUBLIC_APP_VERSION ?? '0.x.x'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px' }}>
          <a
            href="mailto:feedback@keel.app?subject=Keel feedback"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'rgba(184,150,78,0.7)', textDecoration: 'none', letterSpacing: '0.04em', padding: '4px 4px', transition: 'color 0.15s' }}
            onMouseOver={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = 'rgba(184,150,78,1)'}
            onMouseOut={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = 'rgba(184,150,78,0.7)'}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            Feedback
          </a>
          <Link
            href="/privacy"
            style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'rgba(255,255,255,0.35)', textDecoration: 'none', padding: '4px 4px', letterSpacing: '0.04em', transition: 'color 0.15s' }}
            onMouseOver={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = 'rgba(255,255,255,0.65)'}
            onMouseOut={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = 'rgba(255,255,255,0.35)'}
          >
            Privacy &amp; GDPR
          </Link>
        </div>
      </div>

    </div>
  )
}


export function Sidebar() {
  return (
    <Suspense fallback={<div style={{ width: 'var(--sidebar-width)', flexShrink: 0 }} />}>
      <SidebarInner />
    </Suspense>
  )
}
