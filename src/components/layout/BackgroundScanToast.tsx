'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'

export function useBackgroundScanToast() {
  const { user } = useAuth()
  const [toast, setToast] = useState<{ message: string; id: number } | null>(null)
  const seenIds = useRef(new Set<string>())
  const initialised = useRef(false)
  const dismiss = useCallback(() => setToast(null), [])

  useEffect(() => {
    if (!user) return

    const q = query(
      collection(db, `users/${user.uid}/scanRuns`),
      orderBy('scanAt', 'desc'),
      limit(5),
    )

    const unsub = onSnapshot(q, snap => {
      // On first snapshot, just record the existing IDs — don't toast
      if (!initialised.current) {
        snap.docs.forEach(d => seenIds.current.add(d.id))
        initialised.current = true
        return
      }

      // On subsequent snapshots, check for genuinely new docs
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue
        if (seenIds.current.has(change.doc.id)) continue
        seenIds.current.add(change.doc.id)

        const data = change.doc.data()
        if (data.job !== 'background') continue

        const newItems     = (data.newItems     as number) ?? 0
        const updatedItems = (data.updatedItems as number) ?? 0
        if (newItems === 0 && updatedItems === 0) continue

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

    return () => {
      unsub()
      initialised.current = false
      seenIds.current.clear()
    }
  }, [user])

  return { toast, dismiss }
}

export function BackgroundScanToast() {
  const { toast, dismiss } = useBackgroundScanToast()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!toast) return
    setVisible(true)
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(dismiss, 300)
    }, 5000)
    return () => clearTimeout(timer)
  }, [toast?.id])

  if (!toast) return null

  return (
    <div
      onClick={() => { setVisible(false); setTimeout(dismiss, 300) }}
      style={{
        position:   'fixed',
        bottom:     24,
        right:      24,
        zIndex:     999,
        background: 'var(--color-sidebar, #1e3a4a)',
        color:      '#fff',
        borderRadius: 10,
        padding:    '11px 16px',
        display:    'flex',
        alignItems: 'center',
        gap:        10,
        boxShadow:  '0 4px 20px rgba(0,0,0,0.25)',
        cursor:     'pointer',
        maxWidth:   320,
        opacity:    visible ? 1 : 0,
        transform:  visible ? 'translateY(0)' : 'translateY(12px)',
        transition: 'opacity 0.25s ease, transform 0.25s ease',
        userSelect: 'none' as React.CSSProperties['userSelect'],
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent, #B8964E)', flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>New email arrived</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{toast.message}</div>
      </div>
      <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 16, lineHeight: 1 }}>×</span>
    </div>
  )
}
