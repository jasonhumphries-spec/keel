'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useCounts } from '@/lib/hooks'
import { Suspense } from 'react'

function NavPill({ count }: { count: number }) {
  if (!count) return null
  return (
    <div style={{
      position: 'absolute', top: 6, right: '50%', transform: 'translateX(16px)',
      background: 'var(--color-status-urgent)', color: 'white',
      borderRadius: 8, fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-dm-mono)',
      padding: '1px 5px', minWidth: 16, textAlign: 'center', lineHeight: 1.4,
    }}>
      {count > 99 ? '99+' : count}
    </div>
  )
}

function BottomNavInner({ onSettingsOpen }: { onSettingsOpen: () => void }) {
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const counts       = useCounts()
  const filter       = searchParams.get('priority') ?? ''

  const tabs = [
    {
      href: '/dashboard',
      label: 'Dashboard',
      count: counts.dashboard,
      active: pathname === '/dashboard' && !filter,
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
    },
    {
      href: '/awaiting-reply',
      label: 'Awaiting',
      count: counts.awaitingReply,
      active: pathname === '/awaiting-reply',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>,
    },
    {
      href: '/dashboard?priority=3',
      label: 'High+',
      count: counts.highPlus,
      active: pathname === '/dashboard' && filter === '3',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
    },
    {
      href: '/quietly-logged',
      label: 'Ignored',
      count: counts.quietlyLogged,
      active: pathname === '/quietly-logged',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="22" height="5"/><path d="M21 8v13H3V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>,
    },
  ]

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
      background: 'var(--color-surface)',
      borderTop: '1px solid var(--color-border)',
      display: 'flex',
      paddingBottom: 'env(safe-area-inset-bottom, 8px)',
      boxShadow: '0 -4px 20px rgba(0,0,0,0.08)',
    }}>
      {tabs.map(tab => (
        <Link
          key={tab.href}
          href={tab.href}
          scroll={false}
          style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '10px 4px 6px', gap: 3, position: 'relative',
            color: tab.active ? 'var(--color-accent)' : 'var(--color-text-muted)',
            textDecoration: 'none',
            borderTop: `2px solid ${tab.active ? 'var(--color-accent)' : 'transparent'}`,
            transition: 'color 0.15s',
          }}
        >
          {tab.icon}
          <span style={{ fontSize: 10, fontFamily: 'var(--font-dm-mono)', letterSpacing: '0.02em', fontWeight: tab.active ? 600 : 400 }}>
            {tab.label}
          </span>
          <NavPill count={tab.count} />
        </Link>
      ))}
      <button
        onClick={onSettingsOpen}
        style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '10px 4px 6px', gap: 3, background: 'transparent',
          border: 'none', borderTop: '2px solid transparent', cursor: 'pointer',
          color: 'var(--color-text-muted)',
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-dm-mono)', letterSpacing: '0.02em' }}>Settings</span>
      </button>
    </div>
  )
}

export function BottomNav({ onSettingsOpen }: { onSettingsOpen: () => void }) {
  return (
    <Suspense fallback={null}>
      <BottomNavInner onSettingsOpen={onSettingsOpen} />
    </Suspense>
  )
}
