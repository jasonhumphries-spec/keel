'use client'

import { useState, useCallback, useEffect, type CSSProperties, type ReactNode, type MouseEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useAllSignals, useUncategorised, useBreakpoint, useDashboardData } from '@/lib/hooks'
import { Sidebar }           from './Sidebar'
import { Topbar }            from './Topbar'
import { ItemExpandedPanel } from './ItemExpandedPanel'
import { SettingsPanel }     from '../settings/SettingsPanel'
import { CategoriseModal }   from './CategoriseModal'
import { BottomNav }         from './BottomNav'
import { DevTools }          from '../dev/DevTools'
import { CategoryCard, scoreToLevel, getPriorityColour } from './CategoryGrid'
import type { KeelItem, KeelSignal, CategoryWithItems } from '@/lib/types'

// ─── Priority band helpers ────────────────────────────────────────────────────

function filterByBand(
  categoryData: CategoryWithItems[],
  minLevel: number,
  maxLevel: number,
  resolvedItems: Map<string, KeelItem>,
): CategoryWithItems[] {
  return categoryData
    .map(d => ({
      ...d,
      items: d.items.filter(i => {
        if (resolvedItems.has(i.itemId)) return false
        const l = scoreToLevel(i.aiImportanceScore ?? 0.5)
        return l >= minLevel && l <= maxLevel
      }),
    }))
    .filter(d => d.items.length > 0)
}

function calSignalsForBand(
  categoryData: CategoryWithItems[],
  signals: KeelSignal[],
  minLevel: number,
  maxLevel: number,
): { signal: KeelSignal; item: KeelItem }[] {
  const itemMap = new Map<string, KeelItem>()
  categoryData.forEach(d => d.items.forEach(i => itemMap.set(i.itemId, i)))

  const bandItemIds = new Set(
    categoryData
      .flatMap(d => d.items)
      .filter(i => {
        const l = scoreToLevel(i.aiImportanceScore ?? 0.5)
        return l >= minLevel && l <= maxLevel
      })
      .map(i => i.itemId),
  )

  return signals
    .filter(s =>
      bandItemIds.has(s.itemId) &&
      ['event', 'rsvp', 'deadline'].includes(s.type) &&
      s.detectedDate != null &&
      s.status === 'active' &&
      s.calendarStatus !== 'ignored',
    )
    .sort((a, b) => a.detectedDate!.getTime() - b.detectedDate!.getTime())
    .map(s => ({ signal: s, item: itemMap.get(s.itemId)! }))
    .filter(x => x.item != null)
}

// ─── Calendar band event row ──────────────────────────────────────────────────

function CalBandEvent({
  signal,
  item,
  uid,
  bandColour,
}: {
  signal:     KeelSignal
  item:       KeelItem
  uid:        string
  bandColour: string
}) {
  const [status, setStatus] = useState(signal.calendarStatus)
  const [acting, setActing] = useState(false)

  const isOnCal  = status === 'on_cal'
  const isPending = status === 'pending'

  const dotColour = isOnCal || isPending ? '#3D7A6B' : bandColour

  const formatDate = (d: Date) => {
    const now   = new Date()
    const today = now.toDateString() === d.toDateString()
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
    return today ? 'Today' : d.toLocaleDateString('en-GB', opts)
  }

  const buildCalUrl = () => {
    const date = signal.detectedDate!
    const pad  = (n: number) => String(n).padStart(2, '0')
    const fmt  = (d: Date) =>
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
    const start  = fmt(date)
    const end    = fmt(new Date(date.getTime() + 60 * 60 * 1000))
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text:   item.aiTitle || signal.description || 'Event',
      dates:  `${start}/${end}`,
      details: signal.description || 'Added by Keel.',
      ctz:    Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    return `https://calendar.google.com/calendar/render?${params.toString()}`
  }

  const handleAdd = (e: MouseEvent) => {
    e.stopPropagation()
    window.open(buildCalUrl(), '_blank')
    setStatus('pending')
  }

  const handleIgnore = async (e: MouseEvent) => {
    e.stopPropagation()
    if (acting) return
    setActing(true)
    try {
      await updateDoc(doc(db, `users/${uid}/signals`, signal.signalId), {
        calendarStatus: 'ignored', updatedAt: Timestamp.now(),
      })
      setStatus('ignored')
    } catch (err) { console.error(err) }
    finally { setActing(false) }
  }

  if (status === 'ignored') return null

  return (
    <div style={{
      padding: '7px 10px',
      borderBottom: '0.5px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      {/* Date */}
      <div style={{
        fontFamily: 'var(--font-dm-mono)',
        fontSize: 'var(--fs-xs)',
        fontWeight: 700,
        letterSpacing: '0.04em',
        color: dotColour,
      }}>
        {formatDate(signal.detectedDate!)}
      </div>

      {/* Title */}
      <div style={{
        fontSize: 'var(--fs-sm)',
        fontWeight: 500,
        color: 'var(--color-text-primary)',
        lineHeight: 1.3,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      } as CSSProperties}>
        {item.aiTitle || signal.description}
      </div>

      {/* Category */}
      <div style={{
        fontSize: 'var(--fs-xs)',
        color: 'var(--color-text-muted)',
      }}>
        {item.categoryName}
      </div>

      {/* Status + action */}
      {isOnCal || isPending ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#3D7A6B', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--fs-xs)', color: '#3D7A6B' }}>
            {isOnCal ? 'In calendar ✓' : 'Adding…'}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
          <button
            onClick={handleAdd}
            style={{
              background: bandColour, color: '#fff', border: 'none',
              borderRadius: 4, padding: '2px 8px',
              fontSize: 'var(--fs-xs)', fontWeight: 600,
              cursor: 'pointer', fontFamily: 'var(--font-dm-sans)',
            }}
          >
            + Add
          </button>
          <button
            onClick={handleIgnore}
            disabled={acting}
            style={{
              background: 'transparent', border: 'none',
              fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)',
              cursor: 'pointer', padding: '2px 4px',
              opacity: acting ? 0.4 : 1,
            }}
          >
            Skip
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Calendar band ────────────────────────────────────────────────────────────

const BAND_LABELS: Record<string, string> = {
  urgent: 'Urgent & high',
  med:    'Needs attention',
  low:    'Everything else',
  triage: 'Unclassified',
}

const BAND_COLOURS: Record<string, string> = {
  urgent: '#9C5E2B',
  med:    '#C4A265',
  low:    '#6B7A82',
  triage: '#B8964E',
}

function CalBand({
  band,
  events,
  uid,
  note,
}: {
  band:   'urgent' | 'med' | 'low' | 'triage'
  events: { signal: KeelSignal; item: KeelItem }[]
  uid:    string
  note?:  string
}) {
  const colour = BAND_COLOURS[band]
  const label  = BAND_LABELS[band]

  return (
    <div style={{
      width: 188,
      flexShrink: 0,
      borderLeft: '0.5px solid var(--color-border)',
      background: 'var(--color-surface-raised)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Band header */}
      <div style={{
        padding: '8px 10px 6px',
        borderBottom: '0.5px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        flexShrink: 0,
      }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: colour, flexShrink: 0 }} />
        <div style={{
          fontFamily: 'var(--font-dm-mono)',
          fontSize: 'var(--fs-xs)',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase' as const,
          color: colour,
        }}>
          {label}
        </div>
      </div>

      {/* Events or placeholder */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {note ? (
          <div style={{
            padding: '10px',
            fontSize: 'var(--fs-sm)',
            color: 'var(--color-text-muted)',
            lineHeight: 1.5,
            flex: 1,
          }}>
            {note}
          </div>
        ) : events.length === 0 ? (
          <div style={{
            padding: '10px',
            fontSize: 'var(--fs-sm)',
            color: 'var(--color-text-muted)',
            fontStyle: 'italic',
            flex: 1,
          }}>
            No upcoming dates
          </div>
        ) : (
          events.map(({ signal, item }) => (
            <CalBandEvent
              key={signal.signalId}
              signal={signal}
              item={item}
              uid={uid}
              bandColour={colour}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ─── Step row ─────────────────────────────────────────────────────────────────

function StepRow({
  children,
  calBand,
  last = false,
}: {
  children: ReactNode
  calBand:  ReactNode
  last?:    boolean
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {children}
        </div>
        {calBand}
      </div>
      {!last && <div style={{ height: '0.5px', background: 'var(--color-border)', flexShrink: 0 }} />}
    </>
  )
}

// ─── Step header ──────────────────────────────────────────────────────────────

const STEP_COLOURS = {
  1: { num: '#FFF3D6', text: '#7A5C1A', border: '#B8964E', badge: '#FFF3D6', badgeText: '#7A5C1A' },
  2: { num: '#FDEADF', text: '#7A3A10', border: '#9C5E2B', badge: '#FDEADF', badgeText: '#7A3A10' },
  3: { num: '#FFF8EC', text: '#7A5C1A', border: '#C4A265', badge: '#f0f0ee', badgeText: '#888' },
  4: { num: '#f0f0ee', text: '#888',    border: '#ccc',    badge: '#f0f0ee', badgeText: '#888' },
}

function StepHeader({
  step,
  title,
  subtitle,
  badge,
}: {
  step:     1 | 2 | 3 | 4
  title:    string
  subtitle: string
  badge:    string
}) {
  const c = STEP_COLOURS[step]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 22, height: 22, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 'var(--fs-sm)', fontWeight: 700, flexShrink: 0,
        background: c.num, color: c.text, border: `1.5px solid ${c.border}`,
      }}>
        {step}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
          {title}
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)' }}>
          {subtitle}
        </div>
      </div>
      <div style={{
        fontSize: 'var(--fs-sm)', fontWeight: 500,
        padding: '2px 9px', borderRadius: 10, flexShrink: 0,
        background: c.badge, color: c.badgeText,
      }}>
        {badge}
      </div>
    </div>
  )
}

// ─── Triage panel (step 1) ────────────────────────────────────────────────────

function TriagePanel({
  count,
  items,
  onSort,
  onDismiss,
}: {
  count:     number
  items:     KeelItem[]
  onSort:    () => void
  onDismiss: () => void
}) {
  const previews = items.slice(0, 3).map(i => i.aiTitle || i.senderName)

  return (
    <div style={{
      background: 'var(--color-accent-sub)',
      border: '1px solid var(--color-accent)',
      borderRadius: 'var(--radius-md)',
      padding: '12px 14px',
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      opacity: 0.95,
    }}>
      <div style={{
        width: 32, height: 32,
        background: 'var(--color-accent)',
        borderRadius: 'var(--radius-md)',
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h16M4 12h16M4 18h7"/>
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-base)', fontWeight: 700, color: 'var(--color-accent-text)', marginBottom: 3 }}>
          Classify {count} item{count !== 1 ? 's' : ''} to sharpen your priority view
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          Quick to do — Keel remembers your choices. Some of these may be urgent.
        </div>
        {previews.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
            {previews.map((p, i) => (
              <span key={i} style={{
                background: 'var(--color-surface)',
                border: '0.5px solid var(--color-border)',
                borderRadius: 3, padding: '2px 7px',
                fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)',
              }}>
                {p}
              </span>
            ))}
            {count > 3 && (
              <span style={{
                fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', padding: '2px 0',
              }}>
                + {count - 3} more
              </span>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            onClick={onSort}
            style={{
              background: 'var(--color-accent)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-md)', padding: '6px 14px',
              fontSize: 'var(--fs-sm)', fontWeight: 600, cursor: 'pointer',
              fontFamily: 'var(--font-dm-sans)',
            }}
          >
            Sort now
          </button>
          <button
            onClick={onDismiss}
            style={{
              background: 'transparent', color: 'var(--color-text-muted)',
              border: '0.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)', padding: '6px 14px',
              fontSize: 'var(--fs-sm)', cursor: 'pointer',
              fontFamily: 'var(--font-dm-sans)',
            }}
          >
            Do later
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── FYI rows (step 4) ────────────────────────────────────────────────────────

function FyiSection({ categoryData }: { categoryData: CategoryWithItems[] }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? categoryData : categoryData.slice(0, 4)
  const hidden  = categoryData.length - 4

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {visible.map(({ category, items }) => (
        <div
          key={category.categoryId}
          style={{
            background: 'var(--color-surface)',
            border: '0.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: '7px 12px',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
          }}
        >
          <div style={{
            fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)',
            width: 110, flexShrink: 0, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {category.name}
          </div>
          <div style={{
            fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)',
            flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {items.slice(0, 3).map(i => i.aiTitle || i.senderName).join(' · ')}
            {items.length > 3 && ` · +${items.length - 3} more`}
          </div>
          <div style={{
            fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)',
            color: 'var(--color-text-muted)', flexShrink: 0,
          }}>
            {items.length}
          </div>
        </div>
      ))}
      {!expanded && hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            background: 'transparent', border: '0.5px dashed var(--color-border)',
            borderRadius: 'var(--radius-md)', padding: '6px 12px',
            fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)',
            cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-dm-sans)',
          }}
        >
          + {hidden} more categories
        </button>
      )}
    </div>
  )
}

// ─── Section note ─────────────────────────────────────────────────────────────

function SectNote({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)',
      background: 'var(--color-surface-recessed)',
      padding: '5px 10px', borderRadius: 'var(--radius-md)',
    }}>
      {children}
    </div>
  )
}

// ─── Main Shell ───────────────────────────────────────────────────────────────

export function DashboardShell2() {
  const { user, lastScanned } = useAuth()
  const { isMobile, isTablet }   = useBreakpoint()
  const scanDaysBack = typeof window !== 'undefined'
    ? parseInt(localStorage.getItem('keel_scan_days_back') ?? '7', 10)
    : 7

  const [settingsOpen,   setSettingsOpen]   = useState(false)
  const [categoriseOpen, setCategoriseOpen] = useState(false)
  const [selectedItem,   setSelectedItem]   = useState<KeelItem | null>(null)
  const [resolvedItems,  setResolvedItems]  = useState<Map<string, KeelItem>>(new Map())
  const [sidebarOpen,    setSidebarOpen]    = useState(false)
  const [triageDismissed, setTriageDismissed] = useState(false)

  const { categoryData, loading } = useDashboardData()
  const { signals }               = useAllSignals()
  const { items: uncatItems }     = useUncategorised()

  const greeting = () => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  }
  const firstName = user?.displayName?.split(' ')[0] ?? 'there'

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

  // ── Priority bands ──────────────────────────────────────────────────────────
  const urgentHighData = filterByBand(categoryData, 3, 4, resolvedItems)
  const medData        = filterByBand(categoryData, 2, 2, resolvedItems)
  const lowData        = filterByBand(categoryData, 1, 1, resolvedItems)

  const urgentCount  = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) >= 3 && !resolvedItems.has(i.itemId)).length
  const medCount     = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) === 2 && !resolvedItems.has(i.itemId)).length
  const lowCount     = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) === 1 && !resolvedItems.has(i.itemId)).length
  const urgentOnly   = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) === 4).length
  const highPlus     = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) >= 3).length

  // ── Calendar signals per band ───────────────────────────────────────────────
  const urgentHighCal = calSignalsForBand(categoryData, signals, 3, 4)
  const medCal        = calSignalsForBand(categoryData, signals, 2, 2)
  const lowCal        = calSignalsForBand(categoryData, signals, 1, 1)

  const uid = user?.uid ?? ''

  const cardProps = {
    onItemClick:  (item: KeelItem) => setSelectedItem(item),
    resolvedItems,
    signals,
    uid,
  }

  const commonPanels = (
    <>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ItemExpandedPanel
        item={selectedItem} signals={signals}
        isResolved={selectedItem ? resolvedItems.has(selectedItem.itemId) : false}
        onClose={() => setSelectedItem(null)}
        onResolved={handleResolved} onUndo={handleUndo}
      />
      {categoriseOpen && <CategoriseModal items={uncatItems} onClose={() => setCategoriseOpen(false)} />}
      <DevTools />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)' }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--color-border)', borderTopColor: 'var(--color-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  // ── Mobile: revert to step list, no cal band ─────────────────────────────────
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--color-bg)', overflow: 'hidden' }}>
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>{greeting()}, {firstName}</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
              {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 80px' }}>
          {/* Mobile: simplified step list without cal bands */}
          {uncatItems.length > 0 && !triageDismissed && (
            <TriagePanel count={uncatItems.length} items={uncatItems}
              onSort={() => setCategoriseOpen(true)}
              onDismiss={() => setTriageDismissed(true)} />
          )}
          {urgentHighData.map(d => (
            <div key={d.category.categoryId} style={{ marginTop: 10 }}>
              <CategoryCard data={d} {...cardProps} />
            </div>
          ))}
          {medData.map(d => (
            <div key={d.category.categoryId} style={{ marginTop: 10 }}>
              <CategoryCard data={d} {...cardProps} />
            </div>
          ))}
        </div>
        <BottomNav onSettingsOpen={() => setSettingsOpen(true)} />
        {commonPanels}
      </div>
    )
  }

  // ── Desktop / Tablet ─────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg)', overflow: 'hidden' }}>
      {/* Sidebar */}
      {isTablet ? (
        <>
          <div
            onClick={() => setSidebarOpen(false)}
            style={{ display: sidebarOpen ? 'block' : 'none', position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 100 }}
          />
          <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 101, transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.22s ease' }}>
            <Sidebar />
          </div>
        </>
      ) : (
        <Sidebar />
      )}

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <Topbar onSidebarOpen={() => setSidebarOpen(true)} onSettingsOpen={() => setSettingsOpen(true)} />

        {/* Single scroll container — each step-row shares height with its cal band */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

          {/* ── Step 1: Sort your inbox ── */}
          {uncatItems.length > 0 && !triageDismissed && (
            <>
              <StepRow
                calBand={
                  <CalBand
                    band="triage"
                    events={[]}
                    uid={uid}
                    note="Some unclassified items may have dates. Classify them first to see events here."
                  />
                }
              >
                <StepHeader
                  step={1}
                  title="Sort your inbox"
                  subtitle={`${uncatItems.length} items need a home — classify to surface what matters`}
                  badge={`${uncatItems.length} to sort`}
                />
                <TriagePanel
                  count={uncatItems.length}
                  items={uncatItems}
                  onSort={() => setCategoriseOpen(true)}
                  onDismiss={() => setTriageDismissed(true)}
                />
              </StepRow>
              <div style={{ height: '0.5px', background: 'var(--color-border)', flexShrink: 0 }} />
            </>
          )}

          {/* ── Step 2: Urgent & high ── */}
          <StepRow
            calBand={
              <CalBand band="urgent" events={urgentHighCal} uid={uid} />
            }
          >
            <StepHeader
              step={2}
              title="Urgent & high priority"
              subtitle="Needs your attention now or soon"
              badge={`${urgentCount} item${urgentCount !== 1 ? 's' : ''}`}
            />
            {urgentHighData.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                Nothing urgent right now.
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
                  {urgentHighData.map(d => (
                    <CategoryCard key={d.category.categoryId} data={d} {...cardProps} />
                  ))}
                </div>
                {categoryData.length - urgentHighData.length > 0 && (
                  <SectNote>
                    Only categories with urgent or high items — {categoryData.length - urgentHighData.length} others have nothing pressing.
                  </SectNote>
                )}
              </>
            )}
          </StepRow>

          <div style={{ height: '0.5px', background: 'var(--color-border)', flexShrink: 0 }} />

          {/* ── Step 3: Needs attention ── */}
          <StepRow
            calBand={
              <CalBand band="med" events={medCal} uid={uid} />
            }
          >
            <StepHeader
              step={3}
              title="Needs attention"
              subtitle="Worth reviewing soon — not time-critical"
              badge={`${medCount} item${medCount !== 1 ? 's' : ''}`}
            />
            {medData.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                Nothing in this tier right now.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
                {medData.map(d => (
                  <CategoryCard key={d.category.categoryId} data={d} {...cardProps} />
                ))}
              </div>
            )}
          </StepRow>

          <div style={{ height: '0.5px', background: 'var(--color-border)', flexShrink: 0 }} />

          {/* ── Step 4: Everything else ── */}
          <StepRow
            last
            calBand={
              <CalBand band="low" events={lowCal} uid={uid} />
            }
          >
            <StepHeader
              step={4}
              title="Everything else"
              subtitle="FYI, receipts, auto-pay bills"
              badge={`${lowCount} item${lowCount !== 1 ? 's' : ''}`}
            />
            {lowData.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                Nothing here either — tidy inbox!
              </div>
            ) : (
              <FyiSection categoryData={lowData} />
            )}
          </StepRow>

        </div>
      </div>

      {commonPanels}
    </div>
  )
}
