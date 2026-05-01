'use client'

import { useState, useEffect } from 'react'
import { doc, updateDoc, addDoc, collection, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useCategories } from '@/lib/hooks'
import type { KeelItem, KeelSignal } from '@/lib/types'

function SignalPill({ signal, itemId }: { signal: KeelSignal; itemId: string }) {
  const [calStatus, setCalStatus] = useState(signal.calendarStatus)

  const showAdd     = (signal.type === 'event' || signal.type === 'rsvp') && calStatus !== 'on_cal' && calStatus !== 'pending'
  const isPending   = calStatus === 'pending'
  const isOnCal     = calStatus === 'on_cal'

  const configs: Record<string, { bg: string; border: string; colour: string; label: string }> = {
    event:    { bg: '#f0f6f2', border: '#2e6848', colour: '#2e6848', label: 'Event' },
    deadline: { bg: '#f8f0f0', border: '#8a3028', colour: '#8a3028', label: 'Deadline' },
    payment:  { bg: '#f8f4ec', border: '#8a6020', colour: '#8a6020', label: 'Payment' },
    rsvp:     { bg: '#f8f0f0', border: '#8a3028', colour: '#8a3028', label: 'RSVP by' },
    awaiting: { bg: 'var(--color-surface-recessed)', border: 'var(--color-border-strong)', colour: 'var(--color-text-secondary)', label: 'Awaiting' },
  }
  const cfg = configs[signal.type] ?? configs.awaiting
  const formatDate   = (d: Date | null) => d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : null
  const formatAmount = (p: number | null, c: string | null) => p ? `${c === 'GBP' ? '£' : '$'}${(p / 100).toFixed(2)}` : null
  const detail = signal.detectedDate ? formatDate(signal.detectedDate) : formatAmount(signal.detectedAmount, signal.currency)

  const addToCalendar = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!signal.detectedDate) return

    const userTz   = Intl.DateTimeFormat().resolvedOptions().timeZone
    const date     = signal.detectedDate

    // Format date for Google Calendar URL: YYYYMMDDTHHmmssZ
    const pad = (n: number) => String(n).padStart(2, '0')
    const fmt = (d: Date) =>
      `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`

    // Use local time format (no Z suffix) so Google Calendar respects the ctz param
    const start = fmt(date)
    const end   = fmt(new Date(date.getTime() + 60 * 60 * 1000)) // 1hr default

    const params = new URLSearchParams({
      action:  'TEMPLATE',
      text:    signal.description || 'Event',
      dates:   `${start}/${end}`,
      details: [
        signal.description,
        '',
        'Added by Keel from email.',
      ].filter(Boolean).join('\n'),
      ctz: userTz,
    })

    window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, '_blank')
    // Optimistically mark as on_cal — user may not actually save it
    // but it's better UX than leaving the button active after they've opened calendar
    setCalStatus('pending')
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'stretch', borderRadius: 6, border: `1px solid ${cfg.border}`, overflow: 'hidden', fontSize: 'var(--fs-sm)', fontWeight: 500, background: cfg.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', color: cfg.colour }}>
        <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{cfg.label}</span>
        <span>{signal.description}</span>
        {detail && <span style={{ opacity: 0.7 }}>· {detail}</span>}
      </div>
      {showAdd && (
        <div onClick={addToCalendar} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '5px 9px', borderLeft: `1px solid ${cfg.border}`, color: cfg.colour, cursor: 'pointer', fontSize: 'var(--fs-xs)', fontWeight: 700, background: 'rgba(255,255,255,0.4)' }}>
          + Add to calendar
        </div>
      )}
      {isPending && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '5px 9px', borderLeft: `1px solid ${cfg.border}`, color: cfg.colour, fontSize: 'var(--fs-xs)', opacity: 0.7 }}>
          ↗ Opened in calendar
        </div>
      )}
      {isOnCal && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '5px 9px', borderLeft: `1px solid ${cfg.border}`, color: cfg.colour, fontSize: 'var(--fs-xs)', opacity: 0.7 }}>
          ✓ On calendar
        </div>
      )}
    </div>
  )
}

function MarkAsPaidPanel({ item, onClose, onPaid }: { item: KeelItem; onClose: () => void; onPaid: () => void }) {
  const { user } = useAuth()
  const [method, setMethod] = useState('')
  const [saving, setSaving] = useState(false)

  const handleConfirm = async () => {
    if (!user) return
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
        status: 'paid', resolvedAt: Timestamp.now(), updatedAt: Timestamp.now(),
      })
      await addDoc(collection(db, `users/${user.uid}/payments`), {
        itemId: item.itemId, payeeName: item.senderName,
        amount: null, currency: 'GBP', dueDate: null,
        paidAt: Timestamp.now(), method: method || null,
        notes: null, createdAt: Timestamp.now(),
      })
      onPaid()
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)', background: 'var(--color-surface-raised)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Log payment</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', marginBottom: 4 }}>Payee</div>
          <div style={{ background: '#f0f6f2', border: '1px solid #2e6848', borderRadius: 6, padding: '6px 10px', fontSize: 'var(--fs-sm)', color: '#2e6848' }}>{item.senderName}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', marginBottom: 4 }}>Date paid</div>
          <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', borderRadius: 6, padding: '6px 10px', fontSize: 'var(--fs-sm)', color: 'var(--color-text-primary)' }}>Today</div>
        </div>
      </div>
      <div>
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', marginBottom: 4 }}>Method (optional)</div>
        <input value={method} onChange={e => setMethod(e.target.value)} placeholder="e.g. HSBC, Direct Debit…" style={{ width: '100%', background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', borderRadius: 6, padding: '6px 10px', fontSize: 'var(--fs-sm)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none' }} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleConfirm} disabled={saving} style={{ flex: 1, padding: '8px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: '#2e6848', border: '1px solid #2e6848', color: 'white', fontSize: 'var(--fs-base)', fontWeight: 600, fontFamily: 'var(--font-dm-sans)', opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : '✓ Confirm payment'}
        </button>
        <button onClick={onClose} style={{ padding: '8px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontSize: 'var(--fs-base)', fontFamily: 'var(--font-dm-sans)' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function ActBtn({ label, onClick, variant = 'ghost' }: { label: string; onClick: () => void; variant?: 'primary' | 'accent' | 'ghost' }) {
  const styles: Record<string, React.CSSProperties> = {
    primary: { background: 'var(--color-action-primary)', color: 'var(--color-action-text)', border: '1px solid var(--color-action-primary)', fontWeight: 600 },
    accent:  { background: 'var(--color-accent-sub)', color: 'var(--color-accent)', border: '1px solid var(--color-accent)' },
    ghost:   { background: 'transparent', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' },
  }
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '7px 13px', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-base)', fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-dm-sans)', whiteSpace: 'nowrap', ...styles[variant] }}>
      {label}
    </button>
  )
}

function MoveToPicker({
  categories,
  onSelect,
  uid,
}: {
  categories: { categoryId: string; name: string; order: number }[]
  onSelect:   (categoryId: string, categoryName: string) => void
  uid:        string
}) {
  const [creating,    setCreating]    = useState(false)
  const [newName,     setNewName]     = useState('')
  const [newDesc,     setNewDesc]     = useState('')
  const [saving,      setSaving]      = useState(false)

  const createAndMove = async () => {
    if (!newName.trim() || !uid) return
    setSaving(true)
    try {
      const categoryId = `cat_${newName.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}_${Date.now()}`
      const { doc: firestoreDoc, setDoc, Timestamp: TS } = await import('firebase/firestore')
      const { db: firestoreDb } = await import('@/lib/firebase')
      await setDoc(firestoreDoc(firestoreDb, `users/${uid}/categories`, categoryId), {
        categoryId,
        name:        newName.trim(),
        description: newDesc.trim(),
        icon:        'tag',
        parentId:    null,
        order:       categories.length + 1,
        archived:    false,
        archivedAt:  null,
        itemCount:   0,
        createdAt:   TS.now(),
        updatedAt:   TS.now(),
      })
      onSelect(categoryId, newName.trim())
    } catch (e) {
      console.error('Create category error:', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-surface)', flexShrink: 0 }}>
      <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '10px 14px 6px' }}>
        Move to category
      </div>
      <div style={{ padding: '0 6px' }}>
        {categories.map(cat => (
          <button
            key={cat.categoryId}
            onClick={() => onSelect(cat.categoryId, cat.name)}
            style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 8, padding: '8px 10px', borderRadius: 6, fontSize: 'var(--fs-base)', color: 'var(--color-text-primary)', cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--font-dm-sans)', textAlign: 'left' }}
            onMouseOver={e => (e.currentTarget.style.background = 'var(--color-surface-raised)')}
            onMouseOut={e  => (e.currentTarget.style.background = 'transparent')}
          >
            {cat.name}
          </button>
        ))}
      </div>
      <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 14px' }} />
      {!creating ? (
        <button
          onClick={() => setCreating(true)}
          style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 8, padding: '8px 16px 12px', fontSize: 'var(--fs-base)', color: 'var(--color-accent)', cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--font-dm-sans)', fontWeight: 500 }}
        >
          + New category
        </button>
      ) : (
        <div style={{ padding: '6px 10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setCreating(false) }}
            placeholder="Category name…"
            style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border-strong)', borderRadius: 6, padding: '6px 10px', fontSize: 'var(--fs-base)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none' }}
          />
          <input
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createAndMove(); if (e.key === 'Escape') setCreating(false) }}
            placeholder="Description — helps AI route emails here (optional)"
            style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '6px 10px', fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-dm-sans)', outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={createAndMove}
              disabled={!newName.trim() || saving}
              style={{ flex: 1, padding: '6px 12px', borderRadius: 6, background: 'var(--color-accent)', border: 'none', color: 'white', fontSize: 'var(--fs-base)', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-dm-sans)', opacity: !newName.trim() || saving ? 0.5 : 1 }}
            >
              {saving ? '…' : 'Create & move'}
            </button>
            <button
              onClick={() => setCreating(false)}
              style={{ padding: '6px 10px', borderRadius: 6, background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)', fontSize: 'var(--fs-base)', cursor: 'pointer', fontFamily: 'var(--font-dm-sans)' }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface ItemExpandedPanelProps {
  item:       KeelItem | null
  signals:    KeelSignal[]
  isResolved: boolean
  onClose:    () => void
  onResolved: (item: KeelItem) => void   // passes full item snapshot
  onUndo:     (item: KeelItem) => Promise<void>
}

export function ItemExpandedPanel({ item, signals, isResolved, onClose, onResolved, onUndo }: ItemExpandedPanelProps) {
  const { user, accessToken } = useAuth()
  const { categories } = useCategories()
  const [showPaidPanel, setShowPaidPanel] = useState(false)
  const [showMoreMenu,  setShowMoreMenu]  = useState(false)
  const [showMoveTo,    setShowMoveTo]    = useState(false)
  const [saving, setSaving]               = useState(false)
  const [localScore,   setLocalScore]     = useState<number | null>(null)
  const [localManual,  setLocalManual]    = useState<boolean | null>(null)

  useEffect(() => {
    setShowPaidPanel(false)
    setShowMoreMenu(false)
    setShowMoveTo(false)
    setLocalScore(null)
    setLocalManual(null)
  }, [item?.itemId])

  const isOpen = !!item

  const reclassify = async (categoryId: string, categoryName: string) => {
    if (!user || !item) return
    await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
      categoryId,
      categoryName,
      updatedAt: Timestamp.now(),
    })
    // Write a learning hint so future similar emails get classified correctly
    try {
      const hintId = `hint_${item.itemId}`
      await import('firebase/firestore').then(({ doc: fDoc, setDoc }) =>
        setDoc(fDoc(db, `users/${user.uid}/categoryHints`, hintId), {
          hintId,
          categoryId,
          categoryName,
          senderEmail:  item.senderEmail,
          senderName:   item.senderName,
          subjectClue:  item.subject.slice(0, 80),
          aiTitle:      item.aiTitle,
          createdAt:    Timestamp.now(),
        })
      )
    } catch (e) { console.error('Hint write failed:', e) }
    setShowMoveTo(false)
    onClose()
  }

  const markDone = async () => {
    if (!user || !item) return
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
        status: 'done', resolvedAt: Timestamp.now(), updatedAt: Timestamp.now(),
      })
      onResolved(item)   // pass full item snapshot
    } finally { setSaving(false) }
  }

  const snooze = async (days = 3) => {
    if (!user || !item) return
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
      status: 'snoozed', snoozedUntil: Timestamp.fromDate(until), updatedAt: Timestamp.now(),
    })
    onResolved(item)
  }

  const archive = async () => {
    if (!user || !item) return
    await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
      status: 'archived', updatedAt: Timestamp.now(),
    })
    onResolved(item)
  }

  const ignoreItem = async () => {
    if (!user || !item) return
    await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
      status: 'quietly_logged', manuallyIgnored: true, updatedAt: Timestamp.now(),
    })
    setShowMoreMenu(false)
    onResolved(item)
  }

  const itemSignals      = signals.filter(s => s.itemId === item?.itemId)
  const hasPaymentSignal = itemSignals.some(s => s.type === 'payment')

  const formatDate   = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const relativeTime = (d: Date) => {
    const days = Math.floor((Date.now() - d.getTime()) / 86400000)
    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    return `${days} days ago`
  }

  return (
    <>
      <div onClick={onClose} style={{ display: isOpen ? 'block' : 'none', position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 300 }} />

      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 480, background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', zIndex: 301, display: 'flex', flexDirection: 'column', transform: isOpen ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease', boxShadow: '-8px 0 32px rgba(0,0,0,0.12)', overflow: 'hidden' }}>

        {item && (
          <>
            {/* Header */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexShrink: 0 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>{item.categoryName}</div>
                <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 2 }}>{item.aiTitle || item.senderName}</div>
                <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.senderName} · {item.subject}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)' }}>{formatDate(item.receivedAt)}</div>
                <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 2 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>

            {/* Status row */}
            <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              {isResolved ? (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', fontWeight: 500, padding: '3px 8px', borderRadius: 4, background: '#f0f6f2', border: '1px solid #2e6848', color: '#2e6848' }}>
                  ✓ Done this session
                </div>
              ) : (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', fontWeight: 500, padding: '3px 8px', borderRadius: 4, background: item.status === 'new' ? '#f0f3f8' : '#f8f4ec', border: `1px solid ${item.status === 'new' ? '#284e78' : '#8a6020'}`, color: item.status === 'new' ? '#284e78' : '#8a6020' }}>
                  {item.status === 'new' ? '● New' : item.status === 'awaiting_reply' ? '→ Awaiting reply' : '● Needs action'}
                </div>
              )}
              <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginLeft: 'auto' }}>{relativeTime(item.receivedAt)}</div>
            </div>

            {/* Scrollable body */}
            <div style={{ flex: 1, overflowY: 'auto' }}>

              {/* Payment details — shown prominently if item has a payment signal */}
              {itemSignals.filter(s => s.type === 'payment').map(sig => {
                const amount = sig.detectedAmount
                  ? `${sig.currency === 'GBP' ? '£' : '$'}${(sig.detectedAmount / 100).toFixed(2)}`
                  : null
                const due = sig.detectedDate
                  ? sig.detectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
                  : null
                const daysUntil = sig.detectedDate
                  ? Math.ceil((sig.detectedDate.getTime() - Date.now()) / 86400000)
                  : null

                return (
                  <div key={sig.signalId} style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', background: '#fdf8f2' }}>
                    <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: '#8a6020', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#8a6020" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 10h8M8 14h8"/>
                      </svg>
                      Payment due
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                      {amount && (
                        <div style={{ fontSize: 28, fontWeight: 700, color: '#8a6020', fontFamily: 'var(--font-dm-mono)', letterSpacing: '-0.02em' }}>
                          {amount}
                        </div>
                      )}
                      <div>
                        {due && (
                          <div style={{ fontSize: 'var(--fs-base)', color: '#8a6020', fontWeight: 500 }}>{due}</div>
                        )}
                        {daysUntil !== null && (
                          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: daysUntil <= 3 ? '#8a3028' : '#8a6020', marginTop: 2 }}>
                            {daysUntil < 0
                              ? `${Math.abs(daysUntil)} days overdue`
                              : daysUntil === 0
                              ? 'Due today'
                              : daysUntil === 1
                              ? 'Due tomorrow'
                              : `${daysUntil} days to go`}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 'var(--fs-sm)', color: '#8a6020', marginTop: 6, opacity: 0.8 }}>{sig.description}</div>
                  </div>
                )
              })}

              {/* AI Summary */}
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-raised)' }}>
                <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M5 3l.75 2.25L8 6l-2.25.75L5 9l-.75-2.25L2 6l2.25-.75z"/></svg>
                  AI summary
                </div>
                {/* Short summary always shown */}
                <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: item.aiDetailedSummary ? 8 : 0 }}>
                  {item.aiSummary}
                </div>
                {/* Detailed bullets — only if present and adds value */}
                {item.aiDetailedSummary && typeof item.aiDetailedSummary === 'string' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    {item.aiDetailedSummary
                      .split('\n')
                      .filter(line => line.trim().startsWith('•'))
                      .map((line, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <span style={{ color: 'var(--color-accent)', flexShrink: 0, marginTop: 1, fontSize: 'var(--fs-sm)' }}>•</span>
                          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                            {line.replace(/^•\s*/, '')}
                          </span>
                        </div>
                      ))
                    }
                  </div>
                )}
              </div>

              {/* Signal pills */}
              {itemSignals.length > 0 && (
                <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {itemSignals.map(sig => <SignalPill key={sig.signalId} signal={sig} itemId={item.itemId} />)}
                </div>
              )}

              {/* Metadata */}
              <div style={{ padding: '12px 18px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                  {[
                    { label: 'From',     value: `${item.senderName} <${item.senderEmail}>` },
                    { label: 'Received', value: formatDate(item.receivedAt) },
                    { label: 'Category', value: item.categoryName },
                    { label: 'Account',  value: 'Personal Gmail' },
                  ].map(row => (
                    <div key={row.label}>
                      <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', marginBottom: 2 }}>{row.label}</div>
                      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.value}</div>
                    </div>
                  ))}
                </div>

                {/* Priority control — signal bars, consistent with card view */}
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--color-border)' }}>
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    Priority
                    {(localManual ?? item.manualPriority) && (
                      <span style={{ color: 'var(--color-accent)', fontSize: 'var(--fs-xs)' }}>· manually set</span>
                    )}
                    {(localManual ?? item.manualPriority) && (
                      <button
                        onClick={async () => {
                          if (!user) return
                          setLocalScore(null)
                          setLocalManual(false)
                          await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
                            manualPriority: false, updatedAt: Timestamp.now(),
                          })
                        }}
                        style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-dm-mono)', color: 'var(--color-text-muted)', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 3, cursor: 'pointer', padding: '1px 5px' }}
                      >
                        reset to AI
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {[
                      { band: 0.25, label: 'Low',    level: 1, colour: 'var(--color-text-muted)' },
                      { band: 0.50, label: 'Med',    level: 2, colour: 'var(--color-status-new)' },
                      { band: 0.70, label: 'High',   level: 3, colour: 'var(--color-status-warning)' },
                      { band: 0.90, label: 'Urgent', level: 4, colour: 'var(--color-status-urgent)' },
                    ].map(({ band, label, level, colour }) => {
                      const score        = localScore ?? item.aiImportanceScore ?? 0.5
                      const manual       = localManual ?? item.manualPriority ?? false
                      const currentLevel = score >= 0.85 ? 4 : score >= 0.70 ? 3 : score >= 0.40 ? 2 : 1
                      const isActive     = currentLevel === level
                      const barColour    = manual ? 'var(--color-accent)' : colour
                      return (
                        <button
                          key={band}
                          onClick={async () => {
                            if (!user) return
                            setLocalScore(band)
                            setLocalManual(true)
                            await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
                              aiImportanceScore: band,
                              manualPriority:    true,
                              updatedAt:         Timestamp.now(),
                            })
                          }}
                          title={label}
                          style={{
                            flex: 1,
                            padding: '7px 4px',
                            borderRadius: 'var(--radius-md)',
                            border: `1.5px solid ${isActive ? (item.manualPriority ? 'var(--color-accent)' : colour) : 'var(--color-border)'}`,
                            background: isActive ? 'var(--color-surface-raised)' : 'transparent',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 5,
                            transition: 'all 0.1s',
                          }}
                        >
                          {/* Signal bars */}
                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}>
                            {[1,2,3,4].map(bar => (
                              <div key={bar} style={{
                                width: 4,
                                height: bar * 4,
                                borderRadius: 1,
                                background: isActive
                                  ? (bar <= level ? barColour : 'var(--color-border)')
                                  : 'var(--color-border)',
                                transition: 'background 0.15s',
                              }} />
                            ))}
                          </div>
                          {/* Label */}
                          <span style={{
                            fontFamily: 'var(--font-dm-mono)',
                            fontSize: 'var(--fs-xs)',
                            color: isActive ? (item.manualPriority ? 'var(--color-accent)' : colour) : 'var(--color-text-muted)',
                            fontWeight: isActive ? 600 : 400,
                          }}>
                            {label}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Mark as paid panel */}
            {showPaidPanel && (
              <MarkAsPaidPanel
                item={item}
                onClose={() => setShowPaidPanel(false)}
                onPaid={() => { setShowPaidPanel(false); onResolved(item) }}
              />
            )}

            {/* Move to category picker */}
            {showMoveTo && (
              <MoveToPicker
                categories={categories.filter(c => c.categoryId !== item?.categoryId)}
                onSelect={reclassify}
                uid={user?.uid ?? ''}
              />
            )}

            {/* More menu */}
            

            {showMoreMenu && (
              <div style={{ borderTop: '1px solid var(--color-border)', padding: 6, background: 'var(--color-surface)', flexShrink: 0 }}>
                {[
                  { label: 'Snooze 3 days', action: () => snooze(3) },
                  { label: 'Snooze 1 week', action: () => snooze(7) },
                  { label: 'Archive',        action: archive },
                  { label: 'Ignore',         action: ignoreItem },
                ].map(m => (
                  <button key={m.label} onClick={m.action} style={{ display: 'flex', width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 'var(--fs-base)', color: 'var(--color-text-secondary)', cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--font-dm-sans)' }}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}

            {/* Action bar */}
            {isResolved ? (
              <div style={{ padding: '12px 16px', borderTop: '1px solid #d0e8d8', background: '#f0f6f2', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2e6848" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <div style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: '#2e6848', flex: 1 }}>Done this session</div>
                <button onClick={() => onUndo(item)} style={{ padding: '6px 14px', borderRadius: 'var(--radius-md)', border: '1px solid #2e6848', background: 'white', color: '#2e6848', fontSize: 'var(--fs-base)', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-dm-sans)' }}>
                  Undo
                </button>
              </div>
            ) : (
              <div style={{ padding: '10px 14px', borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', flexShrink: 0, background: 'var(--color-surface)' }}>
                <ActBtn label="Open in Gmail" onClick={() => window.open(`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`, '_blank')} variant="primary" />
                {(item.mergedThreadIds ?? []).map((tid, i) => (
                  <ActBtn key={tid} label={`Open thread ${i + 2} in Gmail`} onClick={() => window.open(`https://mail.google.com/mail/u/0/#inbox/${tid}`, '_blank')} variant="ghost" />
                ))}
                {hasPaymentSignal && !showPaidPanel && (
                  <ActBtn label="Mark as Paid" onClick={() => { setShowPaidPanel(true); setShowMoreMenu(false) }} variant="accent" />
                )}
                <ActBtn label="Mark done" onClick={markDone} variant="ghost" />
                <ActBtn label="Move to…" onClick={() => { setShowMoveTo(m => !m); setShowPaidPanel(false); setShowMoreMenu(false) }} variant="ghost" />
                <button
                  onClick={() => { setShowMoreMenu(m => !m); setShowPaidPanel(false) }}
                  style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '7px 9px', borderRadius: 'var(--radius-md)', background: showMoreMenu ? 'var(--color-surface-raised)' : 'transparent', border: '1px solid var(--color-border)', cursor: 'pointer', color: 'var(--color-text-muted)' }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
                  </svg>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
