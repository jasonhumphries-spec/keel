'use client'

/**
 * BackgroundScanToast
 *
 * Shows a brief toast notification when a background scan processes new emails
 * while the user is active in the dashboard.
 *
 * Listens to users/{uid}/scanRuns for new background scan docs with newItems > 0.
 * Only fires when the document was created in the last 60 seconds (avoids
 * showing stale toasts on page load).
 *
 * Usage: drop inside DashboardShell:
 *   import { BackgroundScanToast } from '@/components/layout/BackgroundScanToast'
 *   <BackgroundScanToast />
 */

import { useEffect, useState, useCallback } from 'react'
import { collection, query, where, onSnapshot, orderBy, limit } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBackgroundScanToast() {
  const { user } = useAuth()
  const [toast, setToast] = useState<{ message: string; id: number } | null>(null)

  const dismiss = useCallback(() => setToast(null), [])

  useEffect(() => {
    if (!user) return

    // Listen for the most recent background scan run
    const q = query(
      collection(db, `users/${user.uid}/scanRuns`),
      where('job', '==', 'background'),
      orderBy('scanAt', 'desc'),
      limit(1),
    )

    let initialLoad = true

    const unsub = onSnapshot(q, snap => {
      // Skip the initial load — only react to genuinely new docs
      if (initialLoad) {
        initialLoad = false
        return
      }

      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue

        const data = change.doc.data()
        const newItems     = data.newItems     as number ?? 0
        const updatedItems = data.updatedItems as number ?? 0

        // Only toast if something actually changed
        if (newItems === 0 && updatedItems === 0) continue

        // Only toast if the scan happened very recently (within 90s)
        // Avoids showing stale toasts if the listener reconnects
        const scanAt = data.scanAt?.toMillis?.() ?? 0
        if (Date.now() - scanAt > 90_000) continue

        let message: string
        if (newItems > 0 && updatedItems > 0) {
          message = `${newItems} new · ${updatedItems} updated`
        } else if (newItems > 0) {
          message = newItems === 1 ? '1 new email organised' : `${newItems} new emails organised`
        } else {
          message = updatedItems === 1 ? '1 item updated' : `${updatedItems} items updated`
        }

        setToast({ message, id: Date.now() })
      }
    })

    return unsub
  }, [user])

  return { toast, dismiss }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BackgroundScanToast() {
  const { toast, dismiss } = useBackgroundScanToast()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!toast) return

    // Animate in
    setVisible(true)

    // Auto-dismiss after 5 seconds
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(dismiss, 300) // wait for fade-out
    }, 5000)

    return () => clearTimeout(timer)
  }, [toast?.id])

  if (!toast) return null

  return (
    <div
      onClick={() => { setVisible(false); setTimeout(dismiss, 300) }}
      style={{
        position:        'fixed',
        bottom:          24,
        right:           24,
        zIndex:          999,
        background:      'var(--color-sidebar, #1e3a4a)',
        color:           '#fff',
        borderRadius:    10,
        padding:         '11px 16px',
        display:         'flex',
        alignItems:      'center',
        gap:             10,
        boxShadow:       '0 4px 20px rgba(0,0,0,0.25)',
        cursor:          'pointer',
        maxWidth:        320,
        opacity:         visible ? 1 : 0,
        transform:       visible ? 'translateY(0)' : 'translateY(12px)',
        transition:      'opacity 0.25s ease, transform 0.25s ease',
        userSelect:      'none',
      }}
    >
      {/* Keel accent dot */}
      <span style={{
        width:           8,
        height:          8,
        borderRadius:    '50%',
        background:      'var(--color-accent, #B8964E)',
        flexShrink:      0,
      }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
          New email arrived
        </div>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
          {toast.message}
        </div>
      </div>
      <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 16, lineHeight: 1 }}>×</span>
    </div>
  )
}
