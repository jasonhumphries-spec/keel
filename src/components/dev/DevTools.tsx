'use client'

import { useState } from 'react'
import { collection, getDocs, deleteDoc, doc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'

export function DevTools() {
  const { user, signOut } = useAuth()
  const [open,    setOpen]    = useState(false)
  const [status,  setStatus]  = useState('')
  const [loading, setLoading] = useState(false)

  if (process.env.NODE_ENV !== 'development') return null
  if (!user) return null

  const flush = async (collections: string[]) => {
    setLoading(true)
    setStatus('…')
    try {
      let total = 0
      for (const col of collections) {
        const snap = await getDocs(collection(db, `users/${user.uid}/${col}`))
        for (const d of snap.docs) await deleteDoc(d.ref)
        total += snap.size
      }
      setStatus(`✓ ${total} docs removed`)
      setTimeout(() => { setStatus(''); setOpen(false) }, 2500)
    } catch (e) {
      setStatus('Error')
    } finally {
      setLoading(false)
    }
  }

  const resetToNewUser = async () => {
    setLoading(true)
    setStatus('Resetting…')
    try {
      // Archive usage stats before wiping — preserved under meta/usage_archive_{timestamp}
      const { doc: fDoc, getDoc: fGetDoc, setDoc: fSetDoc, collection, getDocs, deleteDoc } = await import('firebase/firestore')
      const { db: fDb } = await import('@/lib/firebase')

      const usageSnap = await fGetDoc(fDoc(fDb, `users/${user.uid}/meta/usage`))
      if (usageSnap.exists()) {
        const archiveId = `usage_archive_${Date.now()}`
        await fSetDoc(fDoc(fDb, `users/${user.uid}/meta/${archiveId}`), {
          ...usageSnap.data(),
          archivedAt: new Date().toISOString(),
          reason: 'dev_reset',
        })
      }

      // Delete all data collections — but preserve usage archives in meta
      const cols = ['items', 'signals', 'outbound', 'payments', 'categories', 'categoryHints']
      for (const col of cols) {
        const snap = await getDocs(collection(fDb, `users/${user.uid}/${col}`))
        for (const d of snap.docs) await deleteDoc(d.ref)
      }
      // Delete meta docs except usage archives
      const metaSnap = await getDocs(collection(fDb, `users/${user.uid}/meta`))
      for (const d of metaSnap.docs) {
        if (!d.id.startsWith('usage_archive_')) await deleteDoc(d.ref)
      }
      await deleteDoc(fDoc(fDb, `users/${user.uid}/accounts`, 'account_primary'))
      setStatus('✓ Done — signing out')
      setTimeout(async () => { await signOut() }, 1000)
    } catch (e) {
      console.error(e)
      setStatus('Error')
      setLoading(false)
    }
  }

  const runMerge = async () => {
    setLoading(true)
    setStatus('Finding duplicates…')
    try {
      const res  = await fetch('/api/gmail/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid }),
      })
      const data = await res.json()
      setStatus(`✓ Merged ${data.merged} duplicate${data.merged !== 1 ? 's' : ''}`)
      setTimeout(() => { setStatus(''); setOpen(false) }, 2500)
    } catch (e) {
      setStatus('Merge failed')
    } finally {
      setLoading(false)
    }
  }

  const actions = [
    { label: 'Items + signals',       cols: ['items', 'signals'],                                        colour: '#c49040' },
    { label: 'All data',              cols: ['items', 'signals', 'outbound', 'payments'],                colour: '#c45048' },
    { label: 'Everything incl. cats', cols: ['items', 'signals', 'outbound', 'payments', 'categories'], colour: '#c45048' },
  ]

  const btn = (label: string, onClick: () => void, colour: string, bg = 'transparent', key?: string) => (
    <button
      key={key ?? label}
      onClick={onClick}
      disabled={loading}
      style={{ background: bg, border: `1px solid ${colour}`, color: colour, borderRadius: 5, padding: '5px 10px', fontSize: 11, fontFamily: 'var(--font-dm-mono)', cursor: loading ? 'not-allowed' : 'pointer', textAlign: 'left' as const, opacity: loading ? 0.5 : 1, letterSpacing: '0.02em', width: '100%' }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ position: 'fixed', left: 0, top: '50%', transform: 'translateY(-50%)', zIndex: 900, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>

      {open && (
        <div style={{ background: '#111', border: '1px solid #333', borderLeft: 'none', borderRadius: '0 8px 8px 0', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 210, boxShadow: '4px 0 16px rgba(0,0,0,0.4)' }}>

          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const }}>
            Firestore flush
          </div>
          {actions.map(a => btn(a.label, () => flush(a.cols), a.colour, undefined, a.label))}

          <div style={{ height: 1, background: '#222', margin: '2px 0' }} />
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const }}>
            Clean start
          </div>
          {btn('Reset to new user + sign out', resetToNewUser, '#ff6b6b', 'rgba(180,50,50,0.15)')}

          <div style={{ height: 1, background: '#222', margin: '2px 0' }} />
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const }}>
            AI passes
          </div>
          {btn('Find & merge duplicates', runMerge, '#5555cc')}

          {status && (
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: '#4ade80', marginTop: 2 }}>{status}</div>
          )}
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 9, color: '#333', marginTop: 2 }}>
            {user.uid.slice(0, 14)}...
          </div>
        </div>
      )}

      <div
        onClick={() => setOpen(o => !o)}
        style={{ background: '#1a1a1a', border: '1px solid #333', borderLeft: open ? 'none' : '1px solid #333', borderRadius: '0 4px 4px 0', padding: '10px 5px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, boxShadow: '2px 0 8px rgba(0,0,0,0.3)' }}
      >
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80' }} />
        <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 9, color: '#555', letterSpacing: '0.08em', writingMode: 'vertical-rl' as const, textTransform: 'uppercase' as const, marginTop: 2 }}>
          DEV
        </span>
      </div>

    </div>
  )
}
