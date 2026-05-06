'use client'

import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type MouseEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { doc, getDoc, updateDoc, Timestamp } from 'firebase/firestore'
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
  urgent:   'Urgent',
  awaiting: 'Awaiting reply',
  high:     'High priority',
  fyi:      'Everything else',
  triage:   'Unclassified',
}

const BAND_COLOURS: Record<string, string> = {
  urgent:   '#9C5E2B',
  awaiting: '#4A7FA5',
  high:     '#B8964E',
  fyi:      '#6B7A82',
  triage:   '#B8964E',
}

function CalBand({
  band,
  events,
  uid,
  note,
}: {
  band:   'urgent' | 'awaiting' | 'high' | 'fyi' | 'triage'
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
      background: '#ffffff',
      borderLeft: `1px solid rgba(0,0,0,0.06)`,
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
  accent,
  last = false,
}: {
  children: ReactNode
  calBand:  ReactNode
  accent?:  string
  last?:    boolean
}) {
  return (
    <>
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        background: '#ffffff',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 1px 6px rgba(0,0,0,0.06), 0 0 0 0.5px rgba(0,0,0,0.05)',
        margin: '0 16px',
        borderTop: accent ? `3px solid ${accent}` : '3px solid transparent',
      }}>
        <div style={{ flex: 1, minWidth: 0, padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {children}
        </div>
        {calBand}
      </div>
      {!last && (
        <div style={{ height: 20, background: 'transparent' }} />
      )}
    </>
  )
}

// ─── Step header ──────────────────────────────────────────────────────────────

const STEP_COLOURS = {
  1: { num: '#FFF8EC', text: '#7A5C1A', border: '#B8964E', badge: '#FFF8EC', badgeText: '#7A5C1A' },
  2: { num: '#FEF0E8', text: '#7A3A10', border: '#9C5E2B', badge: '#FEF0E8', badgeText: '#7A3A10' },
  3: { num: '#E8F0F6', text: '#2A5070', border: '#4A7FA5', badge: '#E8F0F6', badgeText: '#2A5070' },
  4: { num: '#FFF8EC', text: '#7A5C1A', border: '#B8964E', badge: '#f2f2f0', badgeText: '#666'    },
  5: { num: '#f2f2f0', text: '#888',    border: '#ccc',    badge: '#f2f2f0', badgeText: '#888'    },
}

function StepHeader({
  step,
  title,
  subtitle,
  badge,
}: {
  step:     1 | 2 | 3 | 4 | 5
  title:    string
  subtitle: string
  badge:    string
}) {
  const c = STEP_COLOURS[step]
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, paddingBottom: 4 }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 3,
        background: c.num, color: c.text, border: `1.5px solid ${c.border}`,
      }}>
        {step}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.2, color: 'var(--color-text-primary)' }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.4 }}>
          {subtitle}
        </div>
      </div>
      <div style={{
        fontFamily: 'var(--font-dm-mono)',
        fontSize: 11, fontWeight: 500,
        padding: '2px 9px', borderRadius: 10, flexShrink: 0, marginTop: 4,
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

function FyiSection({
  categoryData,
  onItemClick,
  resolvedItems,
  signals,
  uid,
  expandedId,
  onExpandChange,
}: {
  categoryData:    CategoryWithItems[]
  onItemClick:     (item: KeelItem) => void
  resolvedItems:   Map<string, KeelItem>
  signals:         KeelSignal[]
  uid:             string
  expandedId:      string | null
  onExpandChange:  (id: string | null) => void
}) {
  const [showAll, setShowAll] = useState(false)

  const visible = showAll ? categoryData : categoryData.slice(0, 5)
  const hidden  = categoryData.length - 5

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {visible.map(({ category, items }) => {
        const isExpanded = expandedId === category.categoryId
        return (
          <div key={category.categoryId} style={{
            background: 'var(--color-surface)',
            border: '0.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}>
            {/* Collapsed row — always visible */}
            <div
              onClick={() => onExpandChange(expandedId === category.categoryId ? null : category.categoryId)}
              style={{
                padding: '7px 12px',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                cursor: 'pointer',
                background: isExpanded ? 'var(--color-surface-recessed)' : 'transparent',
                transition: 'background 0.1s',
              }}
            >
              <div style={{
                fontSize: 'var(--fs-sm)', fontWeight: isExpanded ? 600 : 400,
                color: isExpanded ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                width: 110, flexShrink: 0,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {category.name}
              </div>
              <div style={{
                fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)',
                flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {items.slice(0, 3).map(i => i.aiTitle || i.senderName).join(' · ')}
                {items.length > 3 && ` · +${items.length - 3} more`}
              </div>
              <div style={{
                fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)',
                color: 'var(--color-text-muted)', flexShrink: 0, marginRight: 4,
              }}>
                {items.length}
              </div>
              {/* Chevron */}
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                style={{
                  flexShrink: 0, color: 'var(--color-text-muted)',
                  transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s',
                }}
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>

            {/* Expanded: full CategoryCard */}
            {isExpanded && (
              <div style={{ borderTop: '0.5px solid var(--color-border)' }}>
                <CategoryCard
                  data={{ category, items }}
                  onItemClick={onItemClick}
                  resolvedItems={resolvedItems}
                  signals={signals}
                  uid={uid}
                />
              </div>
            )}
          </div>
        )
      })}

      {!showAll && hidden > 0 && (
        <button
          onClick={() => setShowAll(true)}
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
  const { user, lastScanned, triggerScan } = useAuth()
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
  const [fyiExpandedId,   setFyiExpandedId]   = useState<string | null>(null)
  const [initialScanDone, setInitialScanDone] = useState(false)

  const scrollRef   = useRef<HTMLDivElement>(null)

  // On mount: read lastScanCompletedAt from Firestore (survives page refresh unlike React state)
  // Only scan if > 10 minutes since last scan
  useEffect(() => {
    if (!user) return
    const check = async () => {
      try {
        const accountSnap = await getDoc(doc(db, `users/${user.uid}/accounts/account_primary`))
        const lastScanTs  = accountSnap.data()?.lastScanCompletedAt
        const lastScanMs  = lastScanTs ? lastScanTs.toMillis() : 0
        const minsAgo     = (Date.now() - lastScanMs) / 60000
        if (minsAgo < 10) {
          setInitialScanDone(true)
          return
        }
      } catch { /* proceed with scan if read fails */ }
      triggerScan('auto').finally(() => setInitialScanDone(true))
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // When triage is dismissed: scroll to top so section 2 comes into view
  const handleTriageDone = useCallback(() => {
    setTriageDismissed(true)
    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }, 50)
  }, [])

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
    setResolvedItems((prev: Map<string, KeelItem>) => new Map([...prev, [item.itemId, item]]))
    setSelectedItem(null)
  }, [])

  const handleUndo = useCallback(async (item: KeelItem) => {
    if (!user) return
    setResolvedItems((prev: Map<string, KeelItem>) => { const n = new Map(prev); n.delete(item.itemId); return n })
    await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
      status: 'awaiting_action', resolvedAt: null, updatedAt: Timestamp.now(),
    })
    setSelectedItem(null)
  }, [user])

  // ── Priority bands ──────────────────────────────────────────────────────────
  const urgentData  = filterByBand(categoryData, 4, 4, resolvedItems)
  const highData    = filterByBand(categoryData, 3, 3, resolvedItems)
  const fyiData     = filterByBand(categoryData, 1, 2, resolvedItems)

  // Awaiting replies — items where user sent last message with open question
  const awaitingData: CategoryWithItems[] = categoryData
    .map(d => ({
      ...d,
      items: d.items.filter(i =>
        i.status === 'awaiting_reply' && !resolvedItems.has(i.itemId)
      ),
    }))
    .filter(d => d.items.length > 0)

  const urgentCount  = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) === 4 && !resolvedItems.has(i.itemId)).length
  const awaitingCount = awaitingData.flatMap(d => d.items).length
  const highCount    = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) === 3 && !resolvedItems.has(i.itemId) && i.status !== 'awaiting_reply').length
  const fyiCount     = categoryData.flatMap(d => d.items).filter(i => scoreToLevel(i.aiImportanceScore ?? 0.5) <= 2 && !resolvedItems.has(i.itemId)).length

  // ── Calendar signals per band ───────────────────────────────────────────────
  const urgentCal   = calSignalsForBand(categoryData, signals, 4, 4)
  const allItems    = categoryData.flatMap(d => d.items)
  const awaitingCal = signals
    .filter(s => {
      const item = allItems.find(i => i.itemId === s.itemId)
      return item?.status === 'awaiting_reply' && ['event','deadline'].includes(s.type) && s.detectedDate != null && s.calendarStatus !== 'ignored'
    })
    .sort((a, b) => a.detectedDate!.getTime() - b.detectedDate!.getTime())
    .map(s => ({ signal: s, item: allItems.find(i => i.itemId === s.itemId)! }))
    .filter(x => x.item)
  const highCal   = calSignalsForBand(categoryData, signals, 3, 3)
  // FYI cal: only show events from the currently expanded category
  const fyiCalAll = calSignalsForBand(categoryData, signals, 1, 2)
  const fyiCal    = fyiExpandedId
    ? fyiCalAll.filter(({ item }) => item.categoryId === fyiExpandedId)
    : []

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
      {categoriseOpen && <CategoriseModal items={uncatItems} onClose={() => { setCategoriseOpen(false); handleTriageDone() }} />}
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
          {urgentData.map(d => (
            <div key={d.category.categoryId} style={{ marginTop: 10 }}>
              <CategoryCard data={d} {...cardProps} />
            </div>
          ))}
          {highData.map(d => (
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
        <Topbar
          greeting={`${greeting()}, ${firstName}`}
          onSettingsOpen={() => setSettingsOpen(true)}
          onCategoriseOpen={() => setCategoriseOpen(true)}
        />

        {/* Single scroll container — padding-top centres section 1 on load */}
        <div ref={scrollRef} style={{
          flex: 1, overflowY: 'auto', background: '#eeeef0',
          paddingTop: uncatItems.length > 0 && !triageDismissed ? 'calc(25vh)' : 20,
          paddingBottom: uncatItems.length > 0 && !triageDismissed ? 'calc(25vh)' : 40,
          transition: 'padding-top 0.4s ease',
        }}>

          {/* ── Step 1: Sort your inbox (only shown once initial scan is complete) ── */}
          {uncatItems.length > 0 && !triageDismissed && (
            <div>
              <StepRow
                accent="#B8964E"
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
                  title="A few items need sorting first"
                  subtitle="Keel remembers your choices. Classifying now means nothing urgent gets missed."
                  badge={`${uncatItems.length} to sort`}
                />
                <TriagePanel
                  count={uncatItems.length}
                  items={uncatItems}
                  onSort={() => setCategoriseOpen(true)}
                  onDismiss={handleTriageDone}
                />
              </StepRow>
              <div style={{ height: 20, background: 'transparent' }} />
            </div>
          )}

          {/* ── Step 2: Urgent ── */}
          <div>
          <StepRow
            accent="#9C5E2B"
            calBand={
              <CalBand band="urgent" events={urgentCal} uid={uid}/>
            }
          >
            <StepHeader
              step={1}
              title="These look urgent — worth a look first"
              subtitle="Time-sensitive items that may need action today or very soon."
              badge={`${urgentCount} item${urgentCount !== 1 ? 's' : ''}`}
            />
            {urgentData.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                Nothing urgent right now.
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
                  {urgentData.map(d => (
                    <CategoryCard key={d.category.categoryId} data={d} {...cardProps} />
                  ))}
                </div>
                {categoryData.length - urgentData.length > 0 && (
                  <SectNote>
                    Only categories with urgent items — {categoryData.length - urgentData.length} others have nothing at this level.
                  </SectNote>
                )}
              </>
            )}
          </StepRow>
          </div>

          <div style={{ height: 20, background: 'transparent' }} />

          {/* ── Step 3: Awaiting responses ── */}
          <div>
          <StepRow
            accent="#4A7FA5"
            calBand={
              <CalBand band="awaiting" events={awaitingCal} uid={uid} />
            }
          >
            <StepHeader
              step={2}
              title="Waiting for a reply — worth a nudge?"
              subtitle="You sent the last message. These may benefit from a follow-up."
              badge={`${awaitingCount} item${awaitingCount !== 1 ? 's' : ''}`}
            />
            {awaitingData.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                Nothing waiting on a reply right now.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
                {awaitingData.map(d => (
                  <CategoryCard key={d.category.categoryId} data={d} {...cardProps} />
                ))}
              </div>
            )}
          </StepRow>
          </div>

          <div style={{ height: 20, background: 'transparent' }} />

          {/* ── Step 4: High priority ── */}
          <StepRow
            accent="#B8964E"
            calBand={
              <CalBand band="high" events={highCal} uid={uid}/>
            }
          >
            <StepHeader
              step={3}
              title="On your radar — when you're ready"
              subtitle="These can wait a little, but are worth getting to today or tomorrow."
              badge={`${highCount} item${highCount !== 1 ? 's' : ''}`}
            />
            {highData.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                Nothing in this tier right now.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
                {highData.map(d => (
                  <CategoryCard key={d.category.categoryId} data={d} {...cardProps} />
                ))}
              </div>
            )}
          </StepRow>

          <div style={{ height: 20, background: 'transparent' }} />

          {/* ── Step 4: Everything else ── */}
          <StepRow
            last
            accent="#6B7A82"
            calBand={
              <CalBand
                band="fyi"
                events={fyiCal}
                uid={uid}
                note={fyiExpandedId ? undefined : 'Expand a category below to see its dates here.'}
              />
            }
          >
            <StepHeader
              step={4}
              title="The rest — just so you know"
              subtitle="Receipts, confirmations, auto-pay bills. No action needed."
              badge={`${fyiCount} item${fyiCount !== 1 ? 's' : ''}`}
            />
            {fyiData.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                Nothing here — tidy inbox!
              </div>
            ) : (
              <FyiSection
                categoryData={fyiData}
                onItemClick={cardProps.onItemClick}
                resolvedItems={resolvedItems}
                signals={signals}
                uid={uid}
                expandedId={fyiExpandedId}
                onExpandChange={setFyiExpandedId}
              />
            )}
          </StepRow>

        </div>
      </div>

      {/* Scan-in-progress overlay — fixed, covers everything */}
      {!initialScanDone && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 500,
          backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)',
          background: 'rgba(255,255,255,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#fff', borderRadius: 16, padding: '32px 40px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.06)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
            maxWidth: 360, textAlign: 'center',
          }}>
            <div style={{ width: 28, height: 28, border: '2.5px solid var(--color-border)', borderTopColor: 'var(--color-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Checking for new emails…</div>
              <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.5 }}>Scanning your inbox so nothing gets missed. Your dashboard will be ready in a moment.</div>
            </div>
          </div>
        </div>
      )}

      {commonPanels}
    </div>
  )
}
