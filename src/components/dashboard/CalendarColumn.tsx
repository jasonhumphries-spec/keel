'use client'

import { useState, useEffect } from 'react'
import { doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useCalendarSignals, useActiveItems } from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import type { KeelSignal, KeelItem } from '@/lib/types'

// ── Colour helpers ────────────────────────────────────────────────────────────

const TEAL  = '#3D7A6B'
const BRASS = '#B8964E'
const RUST  = '#9C5E2B'
const SAND  = '#C4A265'

function signalColour(score: number, calStatus: string | null): string {
  if (calStatus === 'on_cal' || calStatus === 'pending') return TEAL
  if (score >= 0.85) return RUST
  if (score >= 0.70) return BRASS
  return SAND
}

function isHighPriority(score: number): boolean {
  return score >= 0.70
}

// ── Google Calendar URL ───────────────────────────────────────────────────────

function addToCalendarUrl(signal: KeelSignal, item?: KeelItem): string {
  const date   = signal.detectedDate!
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const pad    = (n: number) => String(n).padStart(2, '0')
  const fmt    = (d: Date) => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
  const start  = fmt(date)
  const end    = fmt(new Date(date.getTime() + 60 * 60 * 1000))
  const params = new URLSearchParams({
    action:  'TEMPLATE',
    text:    item?.aiTitle || signal.description || 'Event',
    dates:   `${start}/${end}`,
    details: signal.description || 'Added by Keel from email.',
    ctz:     userTz,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

// ── Signal card ───────────────────────────────────────────────────────────────

function SignalCard({
  signal, item, uid, onItemClick,
}: {
  signal:      KeelSignal
  item:        KeelItem | undefined
  uid:         string
  onItemClick: (item: KeelItem) => void
}) {
  const [calStatus, setCalStatus] = useState(signal.calendarStatus)
  const [ignoring,  setIgnoring]  = useState(false)

  const score     = item?.aiImportanceScore ?? 0.5
  const colour    = signalColour(score, calStatus)
  const isHigh    = isHighPriority(score)
  const isDone    = calStatus === 'on_cal'
  const isPending = calStatus === 'pending'

  const formatAmount = (p: number | null, c: string | null) =>
    p ? `${c === 'GBP' ? '£' : '$'}${(p / 100).toFixed(2)}` : null
  const amount = signal.type === 'payment'
    ? formatAmount(signal.detectedAmount, signal.currency)
    : null

  const handleAdd = () => {
    if (!signal.detectedDate) return
    window.open(addToCalendarUrl(signal, item), '_blank')
    setCalStatus('pending')
  }

  const handleIgnore = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setIgnoring(true)
    try {
      // calendarStatus only — status stays 'active' so card badges still see it
      await updateDoc(doc(db, `users/${uid}/signals`, signal.signalId), {
        calendarStatus: 'ignored', updatedAt: Timestamp.now(),
      })
      setCalStatus('ignored')
    } catch (err) { console.error(err) }
    finally { setIgnoring(false) }
  }

  // Ignored signals are filtered out by the hook — this handles optimistic hide
  if (calStatus === 'ignored') return null

  return (
    <div
      onClick={() => item && onItemClick(item)}
      style={{
        borderRadius: 'var(--radius-md)',
        borderLeft:   `3px solid ${colour}`,
        border:       `1px solid ${colour}22`,
        background:   `${colour}0d`,
        padding:      '7px 9px',
        cursor:       item ? 'pointer' : 'default',
        transition:   'background 0.15s',
      }}
      onMouseOver={e => { if (item) (e.currentTarget as HTMLElement).style.background = `${colour}18` }}
      onMouseOut={e =>  { if (item) (e.currentTarget as HTMLElement).style.background = `${colour}0d` }}
    >
      {/* Title + amount */}
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.3, marginBottom: 2 }}>
        {item?.aiTitle || signal.description}
        {amount && (
          <span style={{ fontFamily: 'var(--font-dm-mono)', fontWeight: 700, color: colour, marginLeft: 6 }}>
            {amount}
          </span>
        )}
      </div>

      {/* Signal description — only if meaningfully different from title and concise */}
      {item?.aiTitle && signal.description &&
        signal.description !== item.aiTitle &&
        signal.description.length < 60 &&
        !item.aiTitle.toLowerCase().includes(signal.description.toLowerCase().slice(0, 15)) && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', marginBottom: 3, lineHeight: 1.4 }}>
          {signal.description}
        </div>
      )}

      {/* State row */}
      {isDone ? (
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: TEAL, marginTop: 2 }}>
          ✓ On calendar
        </div>
      ) : isPending ? (
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: TEAL, marginTop: 2 }}>
          ↗ Opened in calendar
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 4, marginTop: 5 }} onClick={e => e.stopPropagation()}>
          <button
            onClick={handleAdd}
            style={{
              flex: 1, fontSize: 'var(--fs-sm)', fontWeight: 600, fontFamily: 'var(--font-dm-sans)',
              padding: '3px 6px', borderRadius: 4, cursor: 'pointer',
              border:     `1px solid ${colour}`,
              background: isHigh ? colour : 'transparent',
              color:      isHigh ? '#fff' : colour,
            }}
          >
            + Add
          </button>
          <button
            onClick={handleIgnore}
            disabled={ignoring}
            style={{
              fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-dm-sans)',
              padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              border: '1px solid var(--color-border)',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              opacity: ignoring ? 0.4 : 1,
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

// ── Day group ─────────────────────────────────────────────────────────────────

function DayGroup({
  date, signals, itemsMap, uid, onItemClick,
}: {
  date:        string
  signals:     KeelSignal[]
  itemsMap:    Map<string, KeelItem>
  uid:         string
  onItemClick: (item: KeelItem) => void
}) {
  const d          = new Date(date)
  const today      = new Date()
  const isToday    = d.toDateString() === today.toDateString()
  const isTomorrow = d.toDateString() === new Date(today.getTime() + 86400000).toDateString()

  const dayLabel = isToday
    ? 'Today'
    : isTomorrow
    ? 'Tomorrow'
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{
        fontFamily:    'var(--font-dm-mono)', fontSize: 'var(--fs-xs)',
        color:         isToday ? 'var(--color-accent)' : 'var(--color-text-muted)',
        letterSpacing: '0.08em',
        fontWeight:    isToday ? 700 : 400,
        paddingBottom: 3,
        borderBottom:  '1px solid var(--color-border)',
      }}>
        {dayLabel}
      </div>
      {signals.map(sig => (
        <SignalCard
          key={sig.signalId}
          signal={sig}
          item={itemsMap.get(sig.itemId)}
          uid={uid}
          onItemClick={onItemClick}
        />
      ))}
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function CalendarColumn({
  onSettingsOpen,
  onItemClick,
  priorityFilter = '',
}: {
  onSettingsOpen: () => void
  onItemClick:    (item: KeelItem) => void
  priorityFilter?: string
}) {
  const { user }             = useAuth()
  const { signals, loading } = useCalendarSignals()
  const { items }            = useActiveItems()

  // Auto-check calendar status on mount and after user changes
  useEffect(() => {
    if (!user?.uid) return
    fetch('/api/calendar/check', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ uid: user.uid }),
    }).catch(err => console.warn('[CalCheck] Auto-check failed:', err))
  }, [user?.uid])

  const itemsMap = new Map<string, KeelItem>(items.map(i => [i.itemId, i]))

  // Apply priority filter — match what's visible in the main grid
  const minScore = priorityFilter === '4' ? 0.85 : priorityFilter === '3' ? 0.70 : 0
  const visibleSignals = minScore > 0
    ? signals.filter(sig => (itemsMap.get(sig.itemId)?.aiImportanceScore ?? 0) >= minScore)
    : signals

  // Deduplicate: one signal per item per date
  // Priority: event > rsvp > deadline > payment — avoids same item appearing multiple times
  const TYPE_RANK: Record<string, number> = { event: 4, rsvp: 3, deadline: 2, payment: 1 }
  const dedupMap = new Map<string, KeelSignal>() // key: `${itemId}:${dateKey}`
  for (const sig of visibleSignals) {
    if (!sig.detectedDate) continue
    const dateKey = sig.detectedDate.toISOString().split('T')[0]
    const key     = `${sig.itemId}:${dateKey}`
    const existing = dedupMap.get(key)
    if (!existing || (TYPE_RANK[sig.type] ?? 0) > (TYPE_RANK[existing.type] ?? 0)) {
      dedupMap.set(key, sig)
    }
  }
  const dedupedSignals = Array.from(dedupMap.values())

  // Group deduplicated signals by date
  const grouped = new Map<string, KeelSignal[]>()
  for (const sig of dedupedSignals) {
    if (!sig.detectedDate) continue
    const key = sig.detectedDate.toISOString().split('T')[0]
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(sig)
  }
  const sortedDates = Array.from(grouped.keys()).sort()

  // Date range label driven by actual data
  const now      = new Date()
  const lastDate = sortedDates.length > 0
    ? new Date(sortedDates[sortedDates.length - 1])
    : new Date(now.getTime() + 30 * 86400000)
  const fmt       = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const dateRange = `${fmt(now)} – ${fmt(lastDate)}`
  const totalCount = dedupedSignals.length

  const needAdding = dedupedSignals.filter(s =>
    s.calendarStatus !== 'on_cal' && s.calendarStatus !== 'pending' && s.type !== 'payment'
  ).length

  return (
    <div style={{ width: 'var(--cal-width)', flexShrink: 0, borderLeft: '1px solid var(--color-border)', background: 'var(--color-cal-bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '13px 13px 10px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <span style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>Upcoming</span>
          <button onClick={onSettingsOpen} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 1 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
        </div>
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)' }}>
          {loading
            ? 'Loading…'
            : totalCount === 0
            ? (minScore > 0 ? 'No upcoming events at this priority' : 'Nothing upcoming')
            : `${dateRange} · ${needAdding > 0 ? `${needAdding} to add` : 'all on calendar'}${minScore > 0 ? ` · filtered` : ''}`
          }
        </div>
      </div>

      {/* Events */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          [1,2,3].map(i => (
            <div key={i} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ width: '40%', height: 9, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
              <div style={{ width: '80%', height: 11, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
            </div>
          ))
        ) : sortedDates.length === 0 ? (
          <div style={{ padding: '20px 8px', textAlign: 'center', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            No upcoming events<br />in the next 30 days
          </div>
        ) : (
          sortedDates.map(date => (
            <DayGroup
              key={date}
              date={date}
              signals={grouped.get(date)!}
              itemsMap={itemsMap}
              uid={user?.uid ?? ''}
              onItemClick={onItemClick}
            />
          ))
        )}
      </div>

    </div>
  )
}
