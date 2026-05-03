'use client'

import { useState } from 'react'
import { doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import Link from 'next/link'
import { useDashboardData } from '@/lib/hooks'
import type { KeelItem, KeelSignal, CategoryWithItems } from '@/lib/types'

// Priority bands — used by PriorityButtons
const PRIORITY_BANDS = [0.10, 0.25, 0.50, 0.70, 0.85, 0.95]

// Signal strength priority indicator
function scoreToLevel(score: number): 1 | 2 | 3 | 4 {
  if (score >= 0.85) return 4
  if (score >= 0.70) return 3
  if (score >= 0.40) return 2
  return 1
}

// Priority temperature ramp — Session 5 design doc
const PRIORITY_COLOURS = {
  low:    '#6B7A82',
  med:    '#C4A265',
  high:   '#B8964E',
  urgent: '#9C5E2B',
}

const LEVEL_BANDS = [
  { level: 1 as const, band: 0.25, label: 'Low',    colour: PRIORITY_COLOURS.low    },
  { level: 2 as const, band: 0.50, label: 'Medium', colour: PRIORITY_COLOURS.med    },
  { level: 3 as const, band: 0.70, label: 'High',   colour: PRIORITY_COLOURS.high   },
  { level: 4 as const, band: 0.90, label: 'Urgent', colour: PRIORITY_COLOURS.urgent },
]

function getPriorityColour(item: KeelItem): string {
  if (item.snoozedUntil) return '#9CA3AF' // grey for snoozed
  const level = scoreToLevel(item.aiImportanceScore ?? 0.5)
  return LEVEL_BANDS[level - 1].colour
}

function PriorityDot({ item }: { item: KeelItem }) {
  const { user } = useAuth()
  const [open,   setOpen]   = useState(false)
  const [saving, setSaving] = useState(false)

  const currentLevel = scoreToLevel(item.aiImportanceScore ?? 0.5)
  const currentCfg   = LEVEL_BANDS[currentLevel - 1]
  const dotColour    = getPriorityColour(item)

  const setLevel = async (e: React.MouseEvent, band: number) => {
    e.stopPropagation()
    if (!user || saving) return
    setSaving(true)
    setOpen(false)
    try {
      await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
        aiImportanceScore: band, manualPriority: true, updatedAt: Timestamp.now(),
      })
    } catch (err) { console.error(err) }
    finally { setSaving(false) }
  }

  const resetPriority = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!user) return
    setOpen(false)
    await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
      manualPriority: false, updatedAt: Timestamp.now(),
    })
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
      {/* Filled circle dot */}
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        title={`Priority: ${currentCfg.label}${item.manualPriority ? ' (manual)' : ''}`}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: saving ? 0.4 : 1, transition: 'opacity 0.15s' }}
      >
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: dotColour,
          boxShadow: item.manualPriority ? `0 0 0 2px ${dotColour}33` : 'none',
          transition: 'background 0.2s',
        }} />
      </button>

      {/* Dropdown picker */}
      {open && (
        <div
          style={{ position: 'absolute', top: '100%', right: 0, zIndex: 50, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', padding: 6, minWidth: 130, marginTop: 4 }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 6px 6px' }}>
            Priority
          </div>
          {LEVEL_BANDS.map(({ level, band, label, colour }) => {
            const isActive = currentLevel === level
            return (
              <button
                key={level}
                onClick={e => setLevel(e, band)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 8px', borderRadius: 5, border: 'none', background: isActive ? 'var(--color-surface-raised)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-dm-sans)', fontSize: 'var(--fs-sm)', color: isActive ? colour : 'var(--color-text-secondary)', fontWeight: isActive ? 600 : 400 }}
              >
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: colour, flexShrink: 0 }} />
                {label}
                {isActive && <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)' }}>✓</span>}
              </button>
            )
          })}
          {item.manualPriority && (
            <>
              <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />
              <button onClick={resetPriority} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '5px 8px', borderRadius: 5, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>
                ↺ Reset to AI
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
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

function getItemDisplay(item: KeelItem) {
  const isOverdue = item.status === 'awaiting_action' && item.aiImportanceScore >= 0.85
  const isNew     = item.status === 'new'
  const isWaiting = item.status === 'awaiting_reply'

  if (isOverdue) return { dotColour: 'var(--color-status-urgent)',  tag: 'Act now',    tagStyle: { borderColor: 'var(--color-status-urgent)',  color: 'var(--color-status-urgent)'  } as React.CSSProperties }
  if (isNew)     return { dotColour: 'var(--color-status-new)',     tag: 'New',        tagStyle: { borderColor: 'var(--color-status-new)',     color: 'var(--color-status-new)'     } as React.CSSProperties }
  if (isWaiting) return { dotColour: 'var(--color-status-warning)', tag: '⚑ Flagged', tagStyle: { background: 'var(--flag-bg)', color: 'var(--flag-text)', borderColor: 'var(--flag-bg)' } as React.CSSProperties }
  return           { dotColour: 'var(--color-status-warning)', tag: 'Review',     tagStyle: { borderColor: 'var(--color-status-warning)', color: 'var(--color-status-warning)' } as React.CSSProperties }
}

function formatRelativeTime(date: Date): string {
  const diff  = Date.now() - date.getTime()
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (hours < 1)  return 'Just now'
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

function Tag({ label, style }: { label: string; style: React.CSSProperties }) {
  return (
    <span style={{
      fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', padding: '2px 7px', borderRadius: 4,
      border: '1px solid var(--color-border)', color: 'var(--color-text-muted)',
      whiteSpace: 'nowrap', flexShrink: 0, alignSelf: 'flex-start', marginTop: 2,
      ...style,
    }}>
      {label}
    </span>
  )
}

// Mini signal pills shown on the card
function MiniPill({ signal }: { signal: KeelSignal }) {
  const configs: Record<string, { colour: string; label: string }> = {
    event:    { colour: '#2e6848', label: 'Event' },
    deadline: { colour: '#8a3028', label: 'Deadline' },
    payment:  { colour: '#8a6020', label: 'Payment' },
    rsvp:     { colour: '#8a3028', label: 'RSVP' },
    awaiting: { colour: '#9aa2a6', label: 'Awaiting' },
  }
  const cfg = configs[signal.type] ?? configs.awaiting

  const formatDate = (d: Date | null) => d
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null
  const formatAmount = (p: number | null, c: string | null) =>
    p ? `${c === 'GBP' ? '£' : '$'}${(p / 100).toFixed(2)}` : null

  const detail = signal.detectedAmount
    ? formatAmount(signal.detectedAmount, signal.currency)
    : formatDate(signal.detectedDate)

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)',
      lineHeight: 1,
      padding: '3px 7px', borderRadius: 3,
      background: 'var(--color-surface-recessed)',
      border: `1px solid ${cfg.colour}`,
      color: cfg.colour,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.04em', lineHeight: 1 }}>{cfg.label}</span>
      {detail && <span style={{ lineHeight: 1 }}>{detail}</span>}
    </span>
  )
}

function CategoryCard({
  data,
  onItemClick,
  resolvedItems,
  signals,
}: {
  data:          CategoryWithItems
  onItemClick:   (item: KeelItem) => void
  resolvedItems: Map<string, KeelItem>
  signals:       KeelSignal[]
}) {
  const { category, items: liveItems } = data
  const [hovered, setHovered] = useState<string | null>(null)
  const iconPath = ICON_PATHS[category.icon] ?? ICON_PATHS.tag

  const resolvedForCategory = Array.from(resolvedItems.values())
    .filter(i => i.categoryId === category.categoryId)
  const liveIds      = new Set(liveItems.map(i => i.itemId))
  const resolvedOnly = resolvedForCategory.filter(i => !liveIds.has(i.itemId))

  // Sort: urgent first, then by detected deadline date, then by recency
  const sortedItems = [...liveItems].sort((a, b) => {
    const scoreA = a.aiImportanceScore ?? 0
    const scoreB = b.aiImportanceScore ?? 0
    const urgencyA = scoreA >= 0.80 ? 0 : a.status === 'awaiting_action' ? 1 : 2
    const urgencyB = scoreB >= 0.80 ? 0 : b.status === 'awaiting_action' ? 1 : 2
    if (urgencyA !== urgencyB) return urgencyA - urgencyB
    if (scoreA !== scoreB) return scoreB - scoreA
    return b.receivedAt.getTime() - a.receivedAt.getTime()
  })
  const allItems    = [...sortedItems, ...resolvedOnly]
  const activeCount = liveItems.length
  const isQuiet     = allItems.length === 0

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)', height: '100%' }}>

      {/* Header */}
      <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: isQuiet ? 0.5 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d={iconPath} />
            </svg>
          </span>
          <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {category.name}
          </span>
        </div>
        <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', flexShrink: 0, marginLeft: 8 }}>
          {activeCount} active
        </span>
      </div>

      {/* Items */}
      {isQuiet ? (
        <div style={{ padding: '20px 14px', fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontStyle: 'italic', textAlign: 'center' }}>
          Nothing needs attention
        </div>
      ) : (
        <div style={{ padding: 6, overflowY: 'auto', maxHeight: 420 }}>
          {allItems.map(item => {
            const isResolved   = resolvedItems.has(item.itemId)
            const display      = getItemDisplay(item)
            const itemSignals  = signals.filter(s => s.itemId === item.itemId && s.status === 'active')
            const isUrgent     = !isResolved && item.aiImportanceScore >= 0.80
            const paymentSig   = itemSignals.find(s => s.type === 'payment')
            const formatAmount = (p: number | null, c: string | null) =>
              p ? `${c === 'GBP' ? '£' : '$'}${(p / 100).toFixed(2)}` : null
            const paymentAmount = paymentSig
              ? formatAmount(paymentSig.detectedAmount, paymentSig.currency)
              : null
            const paymentDue = paymentSig?.detectedDate
              ? paymentSig.detectedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
              : null
            const isReceipt   = (item.aiTitle || '').toLowerCase().startsWith('receipt:') ||
              (item.aiSummary || '').toLowerCase().includes('no action needed') ||
              (item.aiSummary || '').toLowerCase().includes('receipt for') ||
              (item.aiSummary || '').toLowerCase().includes('paid to') && item.aiImportanceScore <= 0.35
            const hasPayment  = !!paymentSig && (!!paymentAmount || !!paymentDue)

            return (
              <div
                key={item.itemId}
                onClick={() => onItemClick(item)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9,
                  padding: '8px 8px 8px 10px', borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  background: isResolved
                    ? '#f0f6f2'
                    : isUrgent
                    ? 'rgba(138, 48, 40, 0.04)'
                    : hovered === item.itemId ? 'var(--color-surface-raised)' : 'transparent',
                  borderTop: '1px solid transparent',
                  borderRight: '1px solid transparent',
                  borderBottom: '1px solid transparent',
                  borderLeft: isResolved ? '3px solid #2e6848' : `3px solid ${getPriorityColour(item)}`,
                  opacity: isResolved ? 0.65 : 1,
                  transition: 'background 0.1s, opacity 0.2s',
                }}
                onMouseOver={() => setHovered(item.itemId)}
                onMouseOut={() => setHovered(null)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Title row — with payment amount if applicable */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: isResolved ? '#2e6848' : 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                      {item.aiTitle || item.senderName}
                    </div>
                    {paymentAmount && (
                      <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-base)', fontWeight: 700, color: 'var(--color-status-warning)', flexShrink: 0 }}>
                        {paymentAmount}
                      </span>
                    )}
                  </div>

                  {/* Due date — shown when we have a payment signal */}
                  {hasPayment && paymentDue && (
                    <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-status-warning)', marginTop: 1 }}>
                      {paymentAmount ? `Due ${paymentDue}` : `Payment · ${paymentDue}`}
                    </div>
                  )}

                  {/* Contributors */}
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.4, marginTop: 1 }}>
                    {(item.participants?.length > 0 ? item.participants : [item.senderName]).join(' · ')}
                  </div>

                  {/* Signal pills */}
                  {itemSignals.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {itemSignals.slice(0, 3).map(sig => (
                        <MiniPill key={sig.signalId} signal={sig} />
                      ))}
                      {itemSignals.length > 3 && (
                        <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>
                          +{itemSignals.length - 3}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Summary */}
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginTop: 4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
                    {item.aiSummary}
                  </div>

                  {/* Timestamp */}
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 3 }}>
                    {formatRelativeTime(item.receivedAt)}
                    {item.isRecurring && ' · ↻ recurring'}
                  </div>
                </div>

                {/* Right side — signal strength + tag */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                  {isResolved ? (
                    <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', padding: '2px 7px', borderRadius: 4, background: '#f0f6f2', border: '1px solid #2e6848', color: '#2e6848', whiteSpace: 'nowrap' }}>
                      ✓ Done
                    </span>
                  ) : isReceipt ? (
                    <Tag label="Receipt" style={{ borderColor: 'var(--color-border-strong)', color: 'var(--color-text-muted)' }} />
                  ) : hasPayment ? (
                    <Tag label="Pay" style={{ borderColor: 'var(--color-status-warning)', color: 'var(--color-status-warning)' }} />
                  ) : (
                    <Tag label={display.tag} style={display.tagStyle} />
                  )}
                  {!isResolved && <PriorityDot item={item} />}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* No footer — cards scroll, no view all needed */}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ width: '60%', height: 14, background: 'var(--color-surface-recessed)', borderRadius: 4 }} />
      </div>
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[1, 2].map(i => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ width: '40%', height: 12, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
              <div style={{ width: '80%', height: 11, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CategoryGrid({
  onItemClick,
  resolvedItems,
  signals,
  lastScanned,
  scanDaysBack = 7,
  priorityFilter = '',
  singleColumn = false,
}: {
  onItemClick:     (item: KeelItem) => void
  resolvedItems:   Map<string, KeelItem>
  signals:         KeelSignal[]
  lastScanned:     Date | null
  scanDaysBack?:   number
  priorityFilter?: string
  singleColumn?:   boolean
}) {
  const { categoryData, loading } = useDashboardData()

  // Apply priority filter
  const minLevel = priorityFilter === '4' ? 4 : priorityFilter === '3' ? 3 : 0
  const filteredData = minLevel > 0
    ? categoryData.map(d => ({
        ...d,
        items: d.items.filter(item => scoreToLevel(item.aiImportanceScore ?? 0.5) >= minLevel),
      })).filter(d => d.items.length > 0)
    : categoryData

  const activeCount = filteredData.reduce((acc, d) => acc + d.items.length, 0)

  const now      = new Date()
  const fromDate = new Date(now.getTime() - scanDaysBack * 86400000)
  const fmtDate  = (d: Date) => {
    const sameYear = d.getFullYear() === now.getFullYear()
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
  }
  const fmtEnd   = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const dateRange = `${fmtDate(fromDate)} – ${fmtEnd}`
  const lastChecked = lastScanned
    ? lastScanned.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null

  if (loading) {
    return (
      <div>
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 14 }}>Loading…</div>
        <div style={{ display: 'grid', gridTemplateColumns: singleColumn ? '1fr' : 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
        </div>
      </div>
    )
  }

  if (categoryData.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
        <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>No categories yet</div>
        <div style={{ fontSize: 'var(--fs-base)', maxWidth: 280, lineHeight: 1.6 }}>Run the seed script or connect Gmail to populate your dashboard.</div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
          {activeCount} active items · sorted by urgency
          {minLevel > 0 && (
            <Link href="/dashboard" scroll={false} style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-accent)', border: '1px solid var(--color-accent)', borderRadius: 3, padding: '1px 6px', textDecoration: 'none', letterSpacing: '0.06em' }}>
              {minLevel === 4 ? 'Urgent only' : 'High & above'} · clear ×
            </Link>
          )}
        </div>
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', marginTop: 2, opacity: 0.7 }}>
          {dateRange}{lastChecked ? ` · Last checked ${lastChecked}` : ''}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: singleColumn ? '1fr' : 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
        {filteredData.map((data, i) => (
          <div key={data.category.categoryId} className="cascade-item" style={{ animationDelay: `${i * 0.08}s` }}>
            <CategoryCard
              data={data}
              onItemClick={onItemClick}
              resolvedItems={resolvedItems}
              signals={signals}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
