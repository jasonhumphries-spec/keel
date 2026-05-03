'use client'

import { useState, useCallback, useEffect } from 'react'
import { doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { Sidebar }           from './Sidebar'
import { Topbar }            from './Topbar'
import { CategoryGrid }      from './CategoryGrid'
import { CalendarColumn }    from './CalendarColumn'
import { ItemExpandedPanel } from './ItemExpandedPanel'
import { SettingsPanel }     from '../settings/SettingsPanel'
import { CategoriseModal }   from './CategoriseModal'
import { BottomNav }         from './BottomNav'
import { useAllSignals, useUncategorised, useBreakpoint } from '@/lib/hooks'
import { DevTools }          from '../dev/DevTools'
import type { KeelItem }     from '@/lib/types'

function MobileScanButton() {
  const { scanProgress, triggerScan } = useAuth()
  const isScanning = scanProgress.status === 'scanning'
  const isDone     = scanProgress.status === 'done'
  return (
    <button
      onClick={() => triggerScan('manual')}
      disabled={isScanning}
      style={{ display: 'flex', alignItems: 'center', gap: 5, background: isDone ? '#f0f6f2' : 'var(--color-surface-recessed)', border: `1px solid ${isDone ? '#2e6848' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', padding: '6px 10px', fontSize: 12, fontWeight: 500, color: isDone ? '#2e6848' : isScanning ? 'var(--color-accent)' : 'var(--color-text-secondary)', cursor: isScanning ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-dm-sans)', opacity: isScanning ? 0.7 : 1 }}
    >
      {isScanning ? (<><div style={{ width: 11, height: 11, border: '2px solid var(--color-accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Scanning</>) :
       isDone ?     (<><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2e6848" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Done</>) :
                    (<><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>Refresh</>)
      }
    </button>
  )
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  )
}

export function DashboardShell({ priorityFilter = '' }: { priorityFilter?: string }) {
  const { user, lastScanned } = useAuth()
  const { isMobile, isTablet } = useBreakpoint()
  const scanDaysBack = typeof window !== 'undefined'
    ? parseInt(localStorage.getItem('keel_scan_days_back') ?? '7', 10)
    : 7

  const [settingsOpen,   setSettingsOpen]   = useState(false)
  const [categoriseOpen, setCategoriseOpen] = useState(false)
  const [selectedItem,   setSelectedItem]   = useState<KeelItem | null>(null)
  const [resolvedItems,  setResolvedItems]  = useState<Map<string, KeelItem>>(new Map())
  const [sidebarOpen,    setSidebarOpen]    = useState(false)

  const { signals }           = useAllSignals()
  const { items: uncatItems } = useUncategorised()

  const greeting = () => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  }
  const firstName = user?.displayName?.split(' ')[0] ?? 'there'

  // Allow sidebar "To categorise" button to open the modal via custom event
  useEffect(() => {
    const handler = () => setCategoriseOpen(true)
    window.addEventListener('keel:open-categorise', handler)
    return () => window.removeEventListener('keel:open-categorise', handler)
  }, [])

  const handleResolved = useCallback((item: KeelItem) => {
    setResolvedItems(prev => new Map([...prev, [item.itemId, item]]))
    setSelectedItem(null)
  }, [])

  const handleUndo = useCallback(async (item: KeelItem) => {
    if (!user) return
    setResolvedItems(prev => { const n = new Map(prev); n.delete(item.itemId); return n })
    await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
      status: 'awaiting_action', resolvedAt: null, updatedAt: Timestamp.now(),
    })
    setSelectedItem(null)
  }, [user])

  const resolvedIds = new Set(resolvedItems.keys())

  const commonPanels = (
    <>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ItemExpandedPanel
        item={selectedItem} signals={signals}
        isResolved={selectedItem ? resolvedIds.has(selectedItem.itemId) : false}
        onClose={() => setSelectedItem(null)}
        onResolved={handleResolved} onUndo={handleUndo}
      />
      {categoriseOpen && <CategoriseModal items={uncatItems} onClose={() => setCategoriseOpen(false)} />}
      <DevTools />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )

  const gridProps = {
    onItemClick: (item: KeelItem) => setSelectedItem(item),
    resolvedItems, signals, lastScanned, scanDaysBack, priorityFilter,
  }

  // ---- Mobile (<768px) ----
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--color-bg)', overflow: 'hidden' }}>
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>{greeting()}, {firstName}</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
              {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <MobileScanButton />
            <button onClick={() => setSettingsOpen(true)} style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 9px', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
              <SettingsIcon />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '12px 12px 80px' }}>
          <CategoryGrid {...gridProps} singleColumn />
        </div>
        <BottomNav onSettingsOpen={() => setSettingsOpen(true)} />
        {commonPanels}
      </div>
    )
  }

  // ---- Tablet (768–1023px) ----
  if (isTablet) {
    return (
      <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg)', overflow: 'hidden' }}>
        {sidebarOpen && (
          <>
            <div onClick={() => setSidebarOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 150, background: 'rgba(0,0,0,0.4)' }} />
            <div style={{ position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 151, width: 'var(--sidebar-width)' }}>
              <Sidebar />
            </div>
          </>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 16px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <button onClick={() => setSidebarOpen(o => !o)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 4 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <div style={{ flex: 1, fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>{greeting()}, {firstName}</div>
            <MobileScanButton />
            <button onClick={() => setSettingsOpen(true)} style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 9px', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
              <SettingsIcon />
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '14px 16px' }}>
            <CategoryGrid {...gridProps} />
          </div>
        </div>
        {commonPanels}
      </div>
    )
  }

  // ---- Desktop (>=1024px) ----
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--color-bg)' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <Topbar
          greeting={`${greeting()}, ${firstName}`}
          onSettingsOpen={() => setSettingsOpen(true)}
          onCategoriseOpen={() => setCategoriseOpen(true)}
        />
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '14px 14px 14px 18px' }}>
            <CategoryGrid {...gridProps} />
          </div>
          <div style={{ flexShrink: 0 }}>
            <CalendarColumn onSettingsOpen={() => setSettingsOpen(true)} onItemClick={item => setSelectedItem(item)} />
          </div>
        </div>
      </div>
      {commonPanels}
    </div>
  )
}
