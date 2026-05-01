'use client'

import { useAuth } from '@/contexts/AuthContext'
import { useUncategorised } from '@/lib/hooks'
import { useState, useEffect, useRef } from 'react'
import { collection, query, where, onSnapshot, DocumentData } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { KeelItem } from '@/lib/types'

interface TopbarProps {
  greeting:         string
  onSettingsOpen:   () => void
  onCategoriseOpen: () => void
}

function useRelativeTime(date: Date | null): string {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!date) return
    const interval = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(interval)
  }, [date])
  if (!date) return ''
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function toDate(v: unknown): Date {
  if (!v) return new Date()
  if ((v as any)?.toDate) return (v as any).toDate()
  return new Date(v as string)
}

function docToItem(id: string, d: DocumentData): KeelItem {
  return {
    itemId: id, messageId: d.messageId ?? '', threadId: d.threadId ?? '',
    accountId: d.accountId ?? '', senderEmail: d.senderEmail ?? '',
    senderName: d.senderName ?? '', subject: d.subject ?? '',
    receivedAt: toDate(d.receivedAt), categoryId: d.categoryId ?? '',
    categoryName: d.categoryName ?? '', subcategoryId: null, subcategoryName: null,
    status: d.status ?? 'new', importanceFlag: false,
    aiImportanceScore: d.aiImportanceScore ?? 0.5,
    manualPriority: d.manualPriority ?? false,
    snoozedUntil: null, linkedOutboundId: null, linkedItemId: null,
    isRecurring: d.isRecurring ?? false, fromTrackedReply: false, trackedReplyId: null,
    createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt), resolvedAt: null,
    participants: d.participants ?? [],
    aiTitle: d.aiTitle ?? d.subject ?? '',
    aiSummary: d.aiSummary ?? '',
    aiDetailedSummary: d.aiDetailedSummary ?? '',
    mergedThreadIds: d.mergedThreadIds ?? [],
  }
}

function SearchOverlay({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  const [q, setQ]           = useState('')
  const [allItems, setAll]  = useState<KeelItem[]>([])
  const inputRef            = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (!user) return
    const q_ = query(
      collection(db, `users/${user.uid}/items`),
      where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply', 'snoozed', 'quietly_logged']),
    )
    const unsub = onSnapshot(q_, snap => setAll(snap.docs.map(d => docToItem(d.id, d.data()))))
    return unsub
  }, [user])

  const results = q.trim()
    ? allItems.filter(item => {
        const hay = `${item.aiTitle} ${item.aiSummary} ${item.senderName} ${item.categoryName} ${item.subject}`.toLowerCase()
        return hay.includes(q.toLowerCase())
      }).slice(0, 8)
    : []

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'var(--color-overlay)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80 }}
      onClick={onClose}
    >
      <div
        style={{ width: 560, background: 'var(--color-surface)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden', border: '1px solid var(--color-border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Input row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && onClose()}
            placeholder="Search items, senders, categories..."
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 'var(--fs-lg)', color: 'var(--color-text-primary)', background: 'transparent', fontFamily: 'var(--font-dm-sans)' }}
          />
          {q && <button onClick={() => setQ('')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 'var(--fs-xl)', lineHeight: 1 }}>x</button>}
        </div>

        {/* Results */}
        {results.length > 0 ? (
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {results.map((item, i) => (
              <div
                key={item.itemId}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '11px 16px', borderBottom: i < results.length - 1 ? '1px solid var(--color-border)' : 'none', cursor: 'pointer', transition: 'background 0.1s' }}
                onClick={() => { window.open(`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`, '_blank'); onClose() }}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--color-surface-raised)')}
                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 2 }}>{item.aiTitle || item.subject}</div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)' }}>{item.senderName} · {item.categoryName}</div>
                  {item.aiSummary && (
                    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>{item.aiSummary}</div>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0, marginTop: 2 }}>Gmail</div>
              </div>
            ))}
          </div>
        ) : q.trim() ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)' }}>No results for "{q}"</div>
        ) : (
          <div style={{ padding: '16px', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)' }}>Search across all items, senders, and categories</div>
        )}
      </div>
    </div>
  )
}

export function Topbar({ greeting, onSettingsOpen, onCategoriseOpen }: TopbarProps) {
  const { scanProgress, triggerScan, lastScanned } = useAuth()
  const { items: uncategorised } = useUncategorised()
  const [showSearch, setShowSearch] = useState(false)
  const uncatCount   = uncategorised.length
  const lastScanText = useRelativeTime(lastScanned)
  const isScanning   = scanProgress.status === 'scanning'
  const isDone       = scanProgress.status === 'done'
  const isError      = scanProgress.status === 'error'
  const showStatus   = isScanning || isDone || isError

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setShowSearch(true) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <>
      <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 20px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>

        <div>
          <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>{greeting}</div>
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 1 }}>{date}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>

          {/* Search button */}
          <button
            onClick={() => setShowSearch(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', width: 180, fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)', cursor: 'pointer' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
            <span style={{ flex: 1 }}>Search...</span>
            <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.5 }}>K</span>
          </button>

          {/* Scan status */}
          {showStatus && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: isError ? '#fef2f2' : isDone ? '#f0f6f2' : 'var(--color-accent-sub)', border: `1px solid ${isError ? '#fca5a5' : isDone ? '#2e6848' : 'var(--color-accent)'}`, borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 'var(--fs-sm)', fontWeight: 500, color: isError ? '#dc2626' : isDone ? '#2e6848' : 'var(--color-accent)', fontFamily: 'var(--font-dm-sans)', transition: 'all 0.2s' }}>
              {isScanning && <div style={{ width: 12, height: 12, border: '2px solid var(--color-accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />}
              {isDone && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2e6848" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
              {isError && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
              {scanProgress.message}
            </div>
          )}

          {/* Categorise button */}
          {!isScanning && uncatCount > 0 && (
            <button onClick={onCategoriseOpen} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-accent-sub)', border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 'var(--fs-base)', fontWeight: 600, color: 'var(--color-accent)', cursor: 'pointer', fontFamily: 'var(--font-dm-sans)', whiteSpace: 'nowrap' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
              </svg>
              {uncatCount} to categorise
            </button>
          )}

          {/* Re-scan */}
          <button onClick={() => triggerScan('manual')} disabled={isScanning} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 'var(--fs-base)', fontWeight: 500, color: isScanning ? 'var(--color-text-muted)' : 'var(--color-text-secondary)', cursor: isScanning ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-dm-sans)', opacity: isScanning ? 0.6 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ animation: isScanning ? 'spin 1s linear infinite' : 'none' }}>
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
              </svg>
              {isScanning ? 'Checking...' : 'Check for updates'}
            </div>
            {lastScanText && !isScanning && (
              <div style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-dm-mono)', color: 'var(--color-text-muted)', letterSpacing: '0.04em' }}>{lastScanText}</div>
            )}
          </button>

          {/* Settings */}
          <button onClick={onSettingsOpen} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 9px', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>

        </div>
      </div>

      {showSearch && <SearchOverlay onClose={() => setShowSearch(false)} />}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )
}
