'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  collection, query, orderBy, limit, onSnapshot,
  where, getDocs, Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import Link from 'next/link'

// ── Priority helpers ───────────────────────────────────────────────────────────

function scoreToLevel(score: number): 1 | 2 | 3 | 4 {
  if (score >= 0.85) return 4
  if (score >= 0.70) return 3
  if (score >= 0.40) return 2
  return 1
}

const LEVEL_LABEL  = { 1: 'Low', 2: 'Med', 3: 'High', 4: 'Urgent' } as const
const LEVEL_COLOUR = { 1: '#6B7A82', 2: '#C4A265', 3: '#B8964E', 4: '#9C5E2B' } as const

const STATUS_LABEL: Record<string, string> = {
  new:             'New',
  awaiting_action: 'Action needed',
  awaiting_reply:  'Awaiting reply',
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface ToastItem {
  itemId:       string
  senderName:   string
  aiTitle:      string
  categoryName: string
  status:       string
  score:        number
}

interface ToastData {
  id:           number
  newCount:     number
  updatedCount: number
  items:        ToastItem[]
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useBackgroundScanToast() {
  const { user }              = useAuth()
  const [toast, setToast]     = useState<ToastData | null>(null)
  const seenIds               = useRef(new Set<string>())
  const initialised           = useRef(false)
  const dismiss               = useCallback(() => setToast(null), [])

  useEffect(() => {
    if (!user) return

    const q = query(
      collection(db, `users/${user.uid}/scanRuns`),
      orderBy('scanAt', 'desc'),
      limit(5),
    )

    const unsub = onSnapshot(q, async snap => {
      if (!initialised.current) {
        snap.docs.forEach(d => seenIds.current.add(d.id))
        initialised.current = true
        return
      }

      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue
        if (seenIds.current.has(change.doc.id)) continue
        seenIds.current.add(change.doc.id)

        const data         = change.doc.data()
        if (data.job !== 'background') continue

        const newCount     = (data.newItems     as number) ?? 0
        const updatedCount = (data.updatedItems as number) ?? 0
        if (newCount === 0 && updatedCount === 0) continue

        // Fetch items updated in this scan window (scanAt ± 5s buffer)
        const scanAt      = data.scanAt as Timestamp
        const windowStart = Timestamp.fromMillis(scanAt.toMillis() - 5000)

        let items: ToastItem[] = []
        try {
          const itemsSnap = await getDocs(
            query(
              collection(db, `users/${user.uid}/items`),
              where('updatedAt', '>=', windowStart),
              orderBy('updatedAt', 'desc'),
              limit(6),
            )
          )
          items = itemsSnap.docs
            .map(d => {
              const item = d.data()
              return {
                itemId:       d.id,
                senderName:   (item.senderName   as string) ?? '',
                aiTitle:      (item.aiTitle       as string) ?? (item.subject as string) ?? '',
                categoryName: (item.categoryName  as string) ?? '',
                status:       (item.status        as string) ?? 'new',
                score:        (item.aiImportanceScore as number) ?? 0.5,
              }
            })
            .filter(i => i.status !== 'quietly_logged')
            .slice(0, 3)
        } catch (e) {
          console.warn('[BackgroundScanToast] Failed to fetch items:', e)
        }

        setToast({ id: Date.now(), newCount, updatedCount, items })
      }
    })

    return () => {
      unsub()
      initialised.current = false
      seenIds.current.clear()
    }
  }, [user])

  return { toast, dismiss }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function BackgroundScanToast() {
  const { toast, dismiss }    = useBackgroundScanToast()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!toast) return
    setVisible(true)
    const duration = toast.items.length > 0 ? 8000 : 5000
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(dismiss, 300)
    }, duration)
    return () => clearTimeout(timer)
  }, [toast?.id])

  if (!toast) return null

  const { newCount, updatedCount, items } = toast

  const headline = newCount > 0 && updatedCount > 0
    ? `${newCount} new · ${updatedCount} updated`
    : newCount > 0
    ? (newCount === 1 ? '1 new email' : `${newCount} new emails`)
    : (updatedCount === 1 ? '1 item updated' : `${updatedCount} items updated`)

  return (
    <div style={{
      position:     'fixed',
      bottom:       24,
      right:        24,
      zIndex:       999,
      background:   'var(--color-sidebar, #1e3a4a)',
      color:        '#fff',
      borderRadius: 12,
      padding:      '12px 14px',
      boxShadow:    '0 4px 24px rgba(0,0,0,0.30)',
      maxWidth:     320,
      minWidth:     260,
      opacity:      visible ? 1 : 0,
      transform:    visible ? 'translateY(0)' : 'translateY(14px)',
      transition:   'opacity 0.25s ease, transform 0.25s ease',
      userSelect:   'none' as React.CSSProperties['userSelect'],
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: items.length ? 10 : 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-accent, #B8964E)', flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>New email arrived</div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 1, fontFamily: 'monospace' }}>{headline}</div>
        </div>
        <button
          onClick={() => { setVisible(false); setTimeout(dismiss, 300) }}
          style={{ background: 'none', border: 'none', color: '#fff', opacity: 0.35, cursor: 'pointer', fontSize: 17, lineHeight: 1, padding: 2, flexShrink: 0 }}
        >×</button>
      </div>

      {/* Item rows */}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {items.map((item, i) => {
            const level   = scoreToLevel(item.score)
            const colour  = LEVEL_COLOUR[level]
            const isActionable = item.status in STATUS_LABEL

            return (
              <div key={item.itemId}>
                {i > 0 && <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '3px 0' }} />}
                <Link
                  href={`/dashboard?highlight=${item.itemId}`}
                  onClick={() => { setVisible(false); setTimeout(dismiss, 300) }}
                  style={{
                    display: 'block', textDecoration: 'none', color: 'inherit',
                    borderRadius: 7, padding: '6px 7px',
                    background: 'rgba(255,255,255,0.05)',
                  }}
                >
                  {/* Sender · Title */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.45)',
                      flexShrink: 0, maxWidth: 85,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {item.senderName}
                    </span>
                    <span style={{
                      fontSize: 12, fontWeight: 500, color: '#fff',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}>
                      {item.aiTitle}
                    </span>
                  </div>

                  {/* Category · Priority · Status · Arrow */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: 9, fontFamily: 'monospace',
                      color: 'rgba(255,255,255,0.40)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 3, padding: '1px 5px',
                      maxWidth: 105, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {item.categoryName}
                    </span>

                    <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, fontFamily: 'monospace', color: colour }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: colour }} />
                      {LEVEL_LABEL[level]}
                    </span>

                    {isActionable && (
                      <span style={{
                        fontSize: 9, fontFamily: 'monospace',
                        color: colour, border: `1px solid ${colour}`,
                        borderRadius: 3, padding: '1px 4px', opacity: 0.85,
                      }}>
                        {STATUS_LABEL[item.status]}
                      </span>
                    )}

                    <span style={{ marginLeft: 'auto', opacity: 0.3 }}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                      </svg>
                    </span>
                  </div>
                </Link>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
