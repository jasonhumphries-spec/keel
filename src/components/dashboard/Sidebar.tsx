'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useCounts, useCategories, useCategoryCounts } from '@/lib/hooks'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { useCategoryFilter } from '@/contexts/CategoryFilterContext'

// Sidebar uses the same warm background as the dashboard throughout

function KeelLogo() {
  return (
    <svg width="44" height="44" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
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
    dark: { background: '#B8964E', color: '#fff' },
    warn: { background: '#c45048', color: 'white' },
    mute: { background: 'rgba(44,40,36,0.10)', color: 'rgba(44,40,36,0.68)', border: '1px solid rgba(44,40,36,0.20)' },
  }
  return (
    <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', padding: '2px 7px', borderRadius: 10, minWidth: 20, textAlign: 'center', ...styles[variant] }}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)',
  color: 'rgba(44,40,36,0.58)', letterSpacing: '0.12em',
  textTransform: 'uppercase', padding: '0 8px', marginBottom: 4,
}

const catSectionLabel: React.CSSProperties = {
  fontFamily: 'var(--font-dm-mono)', fontSize: 10, letterSpacing: '0.08em',
  textTransform: 'uppercase' as const, color: 'rgba(44,40,36,0.58)',
  padding: '6px 8px 4px', flexShrink: 0,
}

function CategoryFilterHeader({ categories }: { categories: { categoryId: string }[] }) {
  const { selectedIds, selectAll, selectNone } = useCategoryFilter()
  const allIds     = categories.map(c => c.categoryId)
  const isFiltered = selectedIds !== null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2, padding: '0 8px' }}>
      <div style={catSectionLabel}>Categories</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isFiltered ? (
          <button onClick={selectAll} title="Show all categories"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-accent)', padding: 0, letterSpacing: '0.04em' }}>
            show all
          </button>
        ) : (
          <button onClick={() => selectNone(allIds)} title="Deselect all categories"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'rgba(44,40,36,0.55)', padding: 0, letterSpacing: '0.04em' }}>
            none
          </button>
        )}
        <Link href="/categories"
          style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'rgba(44,40,36,0.55)', textDecoration: 'none', letterSpacing: '0.06em' }}
          title="Edit categories and AI descriptions">
          edit →
        </Link>
      </div>
    </div>
  )
}

function CategoryFilterItem({ cat, allIds, count }: {
  cat: { categoryId: string; name: string; icon: string }
  allIds: string[]
  count: number
}) {
  const { selectedIds, isVisible, toggle, selectOnly } = useCategoryFilter()
  const checked   = isVisible(cat.categoryId)
  const isOnlyOne = selectedIds?.size === 1 && selectedIds.has(cat.categoryId)
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer', transition: 'background 0.1s', userSelect: 'none' as React.CSSProperties['userSelect'], pointerEvents: 'auto', position: 'relative' }}
      onMouseOver={e => e.currentTarget.style.background = 'rgba(44,40,36,0.05)'}
      onMouseOut={e => e.currentTarget.style.background = 'transparent'}
      onClick={() => toggle(cat.categoryId, allIds)}
    >
      <div style={{ width: 14, height: 14, borderRadius: 3, border: `1.5px solid ${checked ? 'var(--color-accent)' : 'rgba(44,40,36,0.45)'}`, background: checked ? 'var(--color-accent)' : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', pointerEvents: 'none' }}>
        {checked && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </div>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontSize: 'var(--fs-md)', color: checked ? 'var(--color-text-primary)' : 'rgba(44,40,36,0.72)', transition: 'color 0.15s', pointerEvents: 'none' }}>
        {cat.name}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {count > 0 && (
          <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'rgba(44,40,36,0.58)', minWidth: 18, textAlign: 'right' as const, pointerEvents: 'none' }}>
            {count}
          </span>
        )}
        {!isOnlyOne && (
          <button
            onClick={e => { e.stopPropagation(); selectOnly(cat.categoryId) }}
            title="Show only this category"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(44,40,36,0.50)', fontSize: 10, padding: '1px 4px', lineHeight: 1, fontFamily: 'var(--font-dm-mono)', borderRadius: 3, pointerEvents: 'auto' }}
            onMouseOver={e => { e.stopPropagation(); e.currentTarget.style.color = 'var(--color-accent)'; e.currentTarget.style.background = 'rgba(184,150,78,0.12)' }}
            onMouseOut={e => { e.currentTarget.style.color = 'rgba(44,40,36,0.50)'; e.currentTarget.style.background = 'transparent' }}
          >
            only
          </button>
        )}
      </div>
    </div>
  )
}

function SidebarInner() {
  const { user, signOut } = useAuth()
  const counts         = useCounts()
  const { categories } = useCategories()
  const categoryCounts = useCategoryCounts()

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
      const { doc: fDoc, updateDoc, Timestamp: TS } = await import('firebase/firestore')
      const { db: fDb } = await import('@/lib/firebase')
      await Promise.all(reordered.map((catId, i) =>
        updateDoc(fDoc(fDb, `users/${user!.uid}/categories`, catId), { order: i + 1, updatedAt: TS.now() })
      ))
    }
    window.addEventListener('keel:reorder-categories', handler)
    return () => window.removeEventListener('keel:reorder-categories', handler)
  }, [categories, user])

  const pathname = usePathname()
  const isActive = (href: string) => pathname === href

  const navStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 10,
    padding: active ? '8px 8px 8px 6px' : '8px 8px',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: 'var(--fs-md)',
    fontFamily: 'var(--font-dm-sans)',
    textDecoration: 'none',
    color: active ? 'var(--color-text-primary)' : 'rgba(44,40,36,0.72)',
    fontWeight: active ? 600 : 400,
    background: active ? 'rgba(184,150,78,0.09)' : 'transparent',
    borderLeft: active ? '2px solid var(--color-accent)' : '2px solid transparent',
    transition: 'background 0.12s, color 0.12s',
  })

  return (
    <div style={{ width: 'var(--sidebar-width)', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '1px 0 0 var(--color-border)' }}>

      {/* ── Logo — boxShadow instead of borderBottom so height calc is identical to Topbar ── */}
      <div style={{
        background: 'var(--color-surface)', flexShrink: 0,
        height: 'var(--topbar-height)',
        display: 'flex', alignItems: 'center',
        padding: '0 16px', gap: 12,
        boxShadow: '0 1px 0 var(--color-border)',
      }}>
        <KeelLogo />
        <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 600, color: '#B8964E', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-dm-mono)' }}>
          Keel
        </div>
      </div>

      {/* ── Nav body — same warm bg as dashboard ── */}
      <div style={{ background: 'var(--color-surface)', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Views */}
        <div style={{ padding: '12px 8px 4px' }}>
          <div style={sectionLabel}>Views</div>
          <Link href="/dashboard2" scroll={false} style={navStyle(isActive('/dashboard2') || isActive('/dashboard'))}
            onMouseOver={e => { if (!isActive('/dashboard2') && !isActive('/dashboard')) e.currentTarget.style.background = 'rgba(44,40,36,0.04)' }}
            onMouseOut={e => { if (!isActive('/dashboard2') && !isActive('/dashboard')) e.currentTarget.style.background = 'transparent' }}
          >
            <span style={{ color: 'rgba(44,40,36,0.52)', flexShrink: 0 }}><Icon d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" /></span>
            Dashboard
            <NavBadge count={counts.dashboard} variant="dark" />
          </Link>
        </div>

        <div style={{ height: 1, background: 'rgba(44,40,36,0.08)', margin: '4px 8px' }} />

        {/* Other views */}
        <div style={{ padding: '4px 8px' }}>
          <div style={sectionLabel}>Other views</div>
          {counts.uncategorised > 0 && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('keel:open-categorise'))}
              style={{ ...navStyle(false), width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' as React.CSSProperties['textAlign'] }}
              onMouseOver={e => e.currentTarget.style.background = 'rgba(44,40,36,0.04)'}
              onMouseOut={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ color: 'rgba(44,40,36,0.52)', flexShrink: 0 }}><Icon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></span>
              To categorise
              <NavBadge count={counts.uncategorised} variant="warn" />
            </button>
          )}
          {[
            { label: 'Ignored',         href: '/quietly-logged', icon: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4', count: counts.quietlyLogged, v: 'mute' as const },
            { label: 'Payment History', href: '/payments',       icon: 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 10h8M8 14h8', count: 0, v: 'dark' as const },
            { label: 'All Mail',        href: '/all-mail',       icon: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6', count: 0, v: 'mute' as const },
          ].map(item => (
            <Link key={item.href} href={item.href} scroll={false} style={navStyle(isActive(item.href))}
              onMouseOver={e => { if (!isActive(item.href)) e.currentTarget.style.background = 'rgba(44,40,36,0.04)' }}
              onMouseOut={e => { if (!isActive(item.href)) e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ color: 'rgba(44,40,36,0.52)', flexShrink: 0 }}><Icon d={item.icon} /></span>
              {item.label}
              <NavBadge count={item.count} variant={item.v} />
            </Link>
          ))}
        </div>

        {/* Categories */}
        <div style={{ height: 1, background: 'rgba(44,40,36,0.08)', margin: '4px 16px' }} />
        <div style={{ padding: '4px 8px', flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <CategoryFilterHeader categories={categories} />
          <div style={{ maxHeight: 300, overflowY: 'auto', overflowX: 'hidden' }}>
            {categories.map(cat => (
              <CategoryFilterItem
                key={cat.categoryId}
                cat={cat}
                allIds={categories.map(c => c.categoryId)}
                count={categoryCounts.get(cat.categoryId) ?? 0}
              />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '8px 10px 12px', borderTop: '1px solid rgba(44,40,36,0.1)', flexShrink: 0 }}>
          <button onClick={signOut}
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer', width: '100%', background: 'transparent', border: 'none', textAlign: 'left', fontFamily: 'var(--font-dm-sans)', transition: 'background 0.15s' }}
            onMouseOver={e => e.currentTarget.style.background = 'rgba(44,40,36,0.05)'}
            onMouseOut={e => e.currentTarget.style.background = 'transparent'}
          >
            {user?.photoURL
              ? <img src={user.photoURL} alt="" width={30} height={30} style={{ borderRadius: '50%', flexShrink: 0 }} />
              : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(184,150,78,0.2)', border: '1px solid #B8964E', flexShrink: 0 }} />
            }
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 'var(--fs-md)', fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.displayName ?? 'Account'}
              </div>
              <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', marginTop: 1 }}>Sign out</div>
            </div>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(44,40,36,0.45)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
            </svg>
          </button>

          <div style={{ height: 1, background: 'rgba(44,40,36,0.08)', margin: '6px 8px' }} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px' }}>
            <a href="mailto:feedback@keel.app?subject=Keel feedback"
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'rgba(184,150,78,0.8)', textDecoration: 'none', letterSpacing: '0.04em', padding: '4px 4px', transition: 'color 0.15s' }}
              onMouseOver={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = '#B8964E'}
              onMouseOut={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = 'rgba(184,150,78,0.8)'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
              Feedback
            </a>
            <Link href="/privacy"
              style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'rgba(44,40,36,0.58)', textDecoration: 'none', padding: '4px 4px', letterSpacing: '0.04em', transition: 'color 0.15s' }}
              onMouseOver={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = 'var(--color-text-secondary)'}
              onMouseOut={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = 'rgba(44,40,36,0.58)'}
            >
              Privacy
            </Link>
          </div>

          <div style={{ padding: '4px 8px 0', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'rgba(44,40,36,0.58)', letterSpacing: '0.04em', userSelect: 'none' }}>
            Keel · Alpha · v{process.env.NEXT_PUBLIC_APP_VERSION ?? '0.x.x'}
          </div>
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
