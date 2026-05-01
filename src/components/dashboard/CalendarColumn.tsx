'use client'

import { useState } from 'react'
import { doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useCalendarSignals } from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import type { KeelSignal } from '@/lib/types'

function addToCalendarUrl(signal: KeelSignal): string {
  const date    = signal.detectedDate!
  const userTz  = Intl.DateTimeFormat().resolvedOptions().timeZone
  const pad     = (n: number) => String(n).padStart(2, '0')
  const fmt     = (d: Date) => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
  const start   = fmt(date)
  const end     = fmt(new Date(date.getTime() + 60 * 60 * 1000))
  const params  = new URLSearchParams({
    action:  'TEMPLATE',
    text:    signal.description || 'Event',
    dates:   `${start}/${end}`,
    details: 'Added by Keel from email.',
    ctz:     userTz,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

// Three tiers of card treatment
function getSignalTier(signal: KeelSignal): 'on_cal' | 'urgent' | 'normal' {
  if (signal.calendarStatus === 'on_cal') return 'on_cal'
  if (signal.calendarStatus === 'ignored') return 'on_cal' // treated same as done
  // Urgent = payment signal OR high-importance (tied to item importance)
  if (signal.type === 'payment') return 'urgent'
  if (signal.type === 'deadline') return 'urgent'
  if (signal.type === 'rsvp') return 'urgent'
  return 'normal'
}

const TIER_STYLES = {
  on_cal: {
    border:     '1px solid var(--color-border)',
    borderLeft: '3px solid var(--color-status-positive)',
    bg:         'transparent',
    textColour: 'var(--color-text-muted)',
    btnLabel:   '✓ On calendar',
  },
  urgent: {
    border:     '1px solid rgba(138,48,40,0.3)',
    borderLeft: '3px solid var(--color-status-urgent)',
    bg:         'rgba(138,48,40,0.04)',
    textColour: 'var(--color-text-primary)',
    btnLabel:   '+ Add',
  },
  normal: {
    border:     '1px solid var(--color-border)',
    borderLeft: '3px solid var(--color-border-strong)',
    bg:         'transparent',
    textColour: 'var(--color-text-secondary)',
    btnLabel:   '+ Add',
  },
}

function SignalCard({ signal, uid }: { signal: KeelSignal; uid: string }) {
  const [calStatus, setCalStatus] = useState(signal.calendarStatus)
  const [ignoring,  setIgnoring]  = useState(false)

  const effectiveTier = calStatus === 'on_cal' || calStatus === 'pending' || calStatus === 'ignored'
    ? 'on_cal'
    : getSignalTier(signal)
  const styles = TIER_STYLES[effectiveTier]

  const formatAmount = (p: number | null, c: string | null) =>
    p ? `${c === 'GBP' ? '£' : '$'}${(p / 100).toFixed(2)}` : null

  const amount = signal.type === 'payment'
    ? formatAmount(signal.detectedAmount, signal.currency)
    : null

  const handleAdd = () => {
    if (!signal.detectedDate) return
    window.open(addToCalendarUrl(signal), '_blank')
    setCalStatus('pending')
  }

  const handleIgnore = async () => {
    setIgnoring(true)
    try {
      await updateDoc(doc(db, `users/${uid}/signals`, signal.signalId), {
        status: 'ignored', updatedAt: Timestamp.now(),
      })
      setCalStatus('ignored')
    } catch (e) { console.error(e) }
    finally { setIgnoring(false) }
  }

  const isDone    = effectiveTier === 'on_cal'
  const isPending = calStatus === 'pending'

  return (
    <div style={{
      background:  styles.bg,
      border:      styles.border,
      borderLeft:  styles.borderLeft,
      borderRadius: 'var(--radius-md)',
      padding:     '7px 9px',
    }}>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: styles.textColour, lineHeight: 1.3, marginBottom: 3 }}>
        {signal.description}
        {amount && (
          <span style={{ fontFamily: 'var(--font-dm-mono)', fontWeight: 700, color: 'var(--color-status-warning)', marginLeft: 6 }}>
            {amount}
          </span>
        )}
      </div>

      {isDone ? (
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-status-positive)' }}>
          {isPending ? '↗ Opened in calendar' : '✓ On calendar'}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <button
            onClick={handleAdd}
            style={{
              flex: 1, fontSize: 'var(--fs-sm)', fontWeight: 600, fontFamily: 'var(--font-dm-sans)',
              padding: '3px 6px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${effectiveTier === 'urgent' ? 'var(--color-status-urgent)' : 'var(--color-border-strong)'}`,
              background: effectiveTier === 'urgent' ? 'rgba(138,48,40,0.08)' : 'var(--color-surface-recessed)',
              color: effectiveTier === 'urgent' ? 'var(--color-status-urgent)' : 'var(--color-text-secondary)',
            }}
          >
            + Add
          </button>
          <button
            onClick={handleIgnore}
            disabled={ignoring}
            style={{
              flex: 1, fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'var(--font-dm-sans)',
              padding: '3px 6px', borderRadius: 4, cursor: 'pointer',
              border: '1px solid var(--color-border)',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              opacity: ignoring ? 0.5 : 1,
            }}
          >
            Ignore
          </button>
        </div>
      )}
    </div>
  )
}

function DayGroup({ date, signals, uid }: { date: string; signals: KeelSignal[]; uid: string }) {
  const d       = new Date(date)
  const today   = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const isTomorrow = d.toDateString() === new Date(today.getTime() + 86400000).toDateString()

  const dayLabel = isToday
    ? 'Today'
    : isTomorrow
    ? 'Tomorrow'
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{
        fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)',
        color: isToday ? 'var(--color-accent)' : 'var(--color-text-muted)',
        letterSpacing: '0.08em',
        fontWeight: isToday ? 700 : 400,
        paddingBottom: 3,
        borderBottom: '1px solid var(--color-border)',
      }}>
        {dayLabel}
      </div>
      {signals.map(sig => (
        <SignalCard key={sig.signalId} signal={sig} uid={uid} />
      ))}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '40%', height: 9, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
      <div style={{ width: '80%', height: 11, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
    </div>
  )
}

export function CalendarColumn({ onSettingsOpen }: { onSettingsOpen: () => void }) {
  const { user } = useAuth()
  const { signals, loading } = useCalendarSignals(10)

  // Group signals by date
  const grouped = new Map<string, KeelSignal[]>()
  for (const sig of signals) {
    if (!sig.detectedDate) continue
    const dateKey = sig.detectedDate.toISOString().split('T')[0]
    if (!grouped.has(dateKey)) grouped.set(dateKey, [])
    grouped.get(dateKey)!.push(sig)
  }
  const sortedDates = Array.from(grouped.keys()).sort()

  const needAdding  = signals.filter(s =>
    s.calendarStatus !== 'on_cal' &&
    s.calendarStatus !== 'pending' &&
    s.calendarStatus !== 'ignored' &&
    s.type !== 'payment'
  ).length

  const now       = new Date()
  const endDate   = new Date(now.getTime() + 10 * 86400000)
  const dateRange = `${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${endDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`

  return (
    <div style={{ width: 'var(--cal-width)', flexShrink: 0, borderLeft: '1px solid var(--color-border)', background: 'var(--color-cal-bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '13px 13px 10px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <span style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>Next 10 days</span>
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
            : `${dateRange} · ${needAdding > 0 ? `${needAdding} to add` : 'all on calendar'}`
          }
        </div>
      </div>

      {/* Events grouped by day */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          [1,2,3].map(i => <SkeletonCard key={i} />)
        ) : sortedDates.length === 0 ? (
          <div style={{ padding: '20px 8px', textAlign: 'center', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            No events or payments<br />in the next 10 days
          </div>
        ) : (
          sortedDates.map(date => (
            <DayGroup
              key={date}
              date={date}
              signals={grouped.get(date)!}
              uid={user?.uid ?? ''}
            />
          ))
        )}
      </div>

      {/* Legend */}
      <div style={{ padding: '8px 10px', borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {[
          { colour: 'var(--color-status-positive)', label: 'On calendar' },
          { colour: 'var(--color-status-urgent)',   label: 'Needs adding — important' },
          { colour: 'var(--color-border-strong)',   label: 'Needs adding' },
        ].map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 3, height: 12, borderRadius: 2, background: item.colour, flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.04em' }}>{item.label}</span>
          </div>
        ))}
      </div>

    </div>
  )
}
