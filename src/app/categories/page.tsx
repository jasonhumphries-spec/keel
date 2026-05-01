'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useCategories } from '@/lib/hooks'
import { doc, updateDoc, deleteDoc, setDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { PageShell } from '@/components/layout/PageShell'
import { DEFAULT_CATEGORY_DESCRIPTIONS, CATEGORY_DESCRIPTION_HINTS } from '@/lib/categoryDefaults'
import type { KeelCategory } from '@/lib/types'
import Link from 'next/link'

interface EditableCategory extends KeelCategory {
  nameEdited: string
  descEdited: string
  dirty: boolean
}

// Spin keyframes injected once
if (typeof document !== 'undefined' && !document.getElementById('keel-spin')) {
  const s = document.createElement('style')
  s.id = 'keel-spin'
  s.textContent = '@keyframes spin { to { transform: rotate(360deg) } }'
  document.head.appendChild(s)
}

export default function CategoriesPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const { categories, loading } = useCategories()
  const [items, setItems]       = useState<EditableCategory[]>([])
  const [saving, setSaving]     = useState<Set<string>>(new Set())
  const [saved,  setSaved]      = useState<Set<string>>(new Set())
  const [newName, setNewName]   = useState('')
  const [adding,  setAdding]    = useState(false)
  const [reclassifying, setReclassifying] = useState(false)
  const [reclassifyResult, setReclassifyResult] = useState<{ examined: number; reclassified: number; message: string } | null>(null)

  useEffect(() => {
    if (!authLoading && !user) router.push('/')
  }, [user, authLoading, router])

  // Sync categories into editable items (preserve edits on re-render)
  useEffect(() => {
    setItems(prev => categories.map(cat => {
      const existing = prev.find(p => p.categoryId === cat.categoryId)
      return {
        ...cat,
        nameEdited: existing?.nameEdited ?? cat.name,
        descEdited: existing?.descEdited ?? (cat.description ?? ''),
        dirty:      existing?.dirty ?? false,
      }
    }))
  }, [categories])

  const reclassifyAll = async () => {
    if (!user || reclassifying) return
    setReclassifying(true)
    setReclassifyResult(null)
    try {
      const daysBack = parseInt(localStorage.getItem('keel_scan_days_back') ?? '7', 10)
      const res  = await fetch('/api/gmail/reclassify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid: user.uid, daysBack }),
      })
      const data = await res.json()
      setReclassifyResult({ examined: data.examined ?? 0, reclassified: data.reclassified ?? 0, message: data.message ?? '' })
      // Auto-clear after 8 seconds
      setTimeout(() => setReclassifyResult(null), 8000)
    } catch (e) {
      console.error('Reclassify failed:', e)
      setReclassifyResult({ examined: 0, reclassified: 0, message: 'Reclassification failed — please try again' })
    } finally {
      setReclassifying(false)
    }
  }

  const update = (categoryId: string, field: 'nameEdited' | 'descEdited', value: string) => {
    setItems(prev => prev.map(item =>
      item.categoryId === categoryId
        ? { ...item, [field]: value, dirty: true }
        : item
    ))
  }

  const save = async (cat: EditableCategory) => {
    if (!user) return
    setSaving(prev => new Set([...prev, cat.categoryId]))
    try {
      await updateDoc(doc(db, `users/${user.uid}/categories`, cat.categoryId), {
        name:        cat.nameEdited.trim() || cat.name,
        description: cat.descEdited.trim(),
        updatedAt:   Timestamp.now(),
      })
      setItems(prev => prev.map(i => i.categoryId === cat.categoryId ? { ...i, dirty: false } : i))
      setSaved(prev => { const n = new Set(prev); n.add(cat.categoryId); return n })
      setTimeout(() => setSaved(prev => { const n = new Set(prev); n.delete(cat.categoryId); return n }), 2000)
    } catch (e) { console.error(e) }
    setSaving(prev => { const n = new Set(prev); n.delete(cat.categoryId); return n })
  }

  const saveAll = async () => {
    const dirty = items.filter(i => i.dirty)
    await Promise.all(dirty.map(save))
  }

  const deleteCategory = async (cat: EditableCategory) => {
    if (!user || cat.itemCount > 0) return
    if (!confirm(`Delete "${cat.name}"? This cannot be undone.`)) return
    await deleteDoc(doc(db, `users/${user.uid}/categories`, cat.categoryId))
  }

  const addCategory = async () => {
    if (!user || !newName.trim()) return
    const catId = `cat_${Date.now()}`
    const now   = Timestamp.now()
    await setDoc(doc(db, `users/${user.uid}/categories`, catId), {
      categoryId: catId, name: newName.trim(), description: '',
      icon: 'tag', order: categories.length + 1,
      archived: false, archivedAt: null, itemCount: 0,
      parentId: null, createdAt: now, updatedAt: now,
    })
    setNewName('')
    setAdding(false)
  }

  const dirtyCount = items.filter(i => i.dirty).length

  if (authLoading || !user) return null

  return (
    <PageShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>

        {/* Topbar */}
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 24px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Life categories</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>
              {loading ? 'Loading...' : `${categories.length} categories`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {dirtyCount > 0 && (
              <button
                onClick={saveAll}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-dm-sans)' }}
              >
                Save {dirtyCount} change{dirtyCount !== 1 ? 's' : ''}
              </button>
            )}
            <button
              onClick={reclassifyAll}
              disabled={reclassifying}
              title="Re-run AI classification on all active items and recent quietly-logged emails using your current categories"
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: reclassifying ? 'var(--color-surface-recessed)' : 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 13, fontWeight: 500, color: reclassifying ? 'var(--color-text-muted)' : 'var(--color-text-secondary)', cursor: reclassifying ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-dm-sans)', opacity: reclassifying ? 0.7 : 1 }}
            >
              {reclassifying ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  Reclassifying…
                </>
              ) : '↺ Reclassify all'}
            </button>
            <Link href="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
              ← Dashboard
            </Link>
          </div>
        </div>

        {/* Explainer */}
        <div style={{ background: 'var(--color-accent-sub)', borderBottom: '1px solid var(--color-border)', padding: '10px 24px', flexShrink: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--color-accent)', lineHeight: 1.6, maxWidth: 720 }}>
            <strong>AI descriptions guide automatic classification.</strong> The more specific you are, the better Keel gets at placing new emails without asking. Include: who sends these emails, what topics they cover, and any key names, companies, or terms. You don't need to fill these in — but they make a real difference.
          </div>
        </div>

        {/* Reclassify result banner */}
        {reclassifyResult && (
          <div style={{ padding: '10px 24px', background: reclassifyResult.reclassified > 0 ? 'var(--color-accent-sub)' : 'var(--color-surface-recessed)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, color: reclassifyResult.reclassified > 0 ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
              <strong>{reclassifyResult.reclassified > 0 ? '✓' : '—'}</strong> {reclassifyResult.message}
              <span style={{ marginLeft: 8, opacity: 0.6 }}>{reclassifyResult.examined} items examined</span>
            </div>
            <button onClick={() => setReclassifyResult(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 16, lineHeight: 1, padding: 4 }}>×</button>
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* Column headers */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 12, padding: '0 0 8px', borderBottom: '1px solid var(--color-border)', marginBottom: 4 }}>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Category name</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              AI description
              <span style={{ marginLeft: 8, fontSize: 9, color: 'var(--color-accent)', background: 'var(--color-accent-sub)', border: '1px solid var(--color-accent)', borderRadius: 3, padding: '1px 5px' }}>guides classification</span>
            </div>
            <div style={{ width: 80 }} />
          </div>

          {/* Example row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-border)', marginBottom: 4, opacity: 0.5 }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic', fontFamily: 'var(--font-dm-mono)', paddingTop: 4 }}>e.g. Bath Rental Property</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic', lineHeight: 1.5, paddingTop: 4 }}>
              "Emails from letting agents (Savills, Fox &amp; Sons), tenants, and tradespeople about our Bath flat. Includes rent, repairs, gas safety certs, and council tax."
            </div>
            <div style={{ width: 80 }} />
          </div>

          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)', fontSize: 12 }}>Loading...</div>
          ) : (
            items.map(cat => (
              <div
                key={cat.categoryId}
                style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--color-border)', alignItems: 'start' }}
              >
                {/* Name */}
                <div>
                  <input
                    value={cat.nameEdited}
                    onChange={e => update(cat.categoryId, 'nameEdited', e.target.value)}
                    style={{ width: '100%', background: 'var(--color-surface-recessed)', border: `1px solid ${cat.dirty ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', padding: '7px 10px', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none', boxSizing: 'border-box' }}
                  />
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
                    {cat.itemCount} active item{cat.itemCount !== 1 ? 's' : ''}
                  </div>
                </div>

                {/* Description */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {/* Show what Keel already knows for built-in categories */}
                  {DEFAULT_CATEGORY_DESCRIPTIONS[cat.categoryId] && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', padding: '6px 10px', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderLeft: '3px solid var(--color-accent)', borderRadius: 'var(--radius-md)', lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-accent)', display: 'block', marginBottom: 2 }}>Keel already knows:</span>
                      {DEFAULT_CATEGORY_DESCRIPTIONS[cat.categoryId]}
                    </div>
                  )}
                  <textarea
                    value={cat.descEdited}
                    onChange={e => update(cat.categoryId, 'descEdited', e.target.value)}
                    placeholder={
                      CATEGORY_DESCRIPTION_HINTS[cat.categoryId]
                        ?? 'Describe what emails belong here — who sends them, what they\'re about, any key names...'
                    }
                    rows={2}
                    style={{ width: '100%', background: 'var(--color-surface-recessed)', border: `1px solid ${cat.dirty ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', padding: '7px 10px', fontSize: 12, color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none', resize: 'vertical', lineHeight: 1.5, boxSizing: 'border-box' as const }}
                  />
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 80 }}>
                  {cat.dirty && (
                    <button
                      onClick={() => save(cat)}
                      disabled={saving.has(cat.categoryId)}
                      style={{ padding: '6px 8px', background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-dm-sans)', textAlign: 'center' }}
                    >
                      {saving.has(cat.categoryId) ? '...' : saved.has(cat.categoryId) ? '✓ Saved' : 'Save'}
                    </button>
                  )}
                  {saved.has(cat.categoryId) && !cat.dirty && (
                    <div style={{ padding: '6px 8px', color: 'var(--color-status-positive)', fontSize: 11, fontWeight: 600, textAlign: 'center', fontFamily: 'var(--font-dm-mono)' }}>✓ Saved</div>
                  )}
                  {cat.itemCount === 0 && (
                    <button
                      onClick={() => deleteCategory(cat)}
                      style={{ padding: '5px 8px', background: 'transparent', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-dm-sans)', textAlign: 'center' }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Add new category */}
          <div style={{ paddingTop: 16 }}>
            {adding ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addCategory(); if (e.key === 'Escape') { setAdding(false); setNewName('') } }}
                  placeholder="New category name..."
                  style={{ flex: 1, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: '8px 12px', fontSize: 13, color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none' }}
                />
                <button onClick={addCategory} disabled={!newName.trim()} style={{ padding: '8px 14px', background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 600, cursor: !newName.trim() ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-dm-sans)', opacity: !newName.trim() ? 0.5 : 1 }}>
                  Add
                </button>
                <button onClick={() => { setAdding(false); setNewName('') }} style={{ padding: '8px 12px', background: 'transparent', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-dm-sans)' }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'transparent', border: '1.5px dashed var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 13, color: 'var(--color-text-muted)', cursor: 'pointer', fontFamily: 'var(--font-dm-sans)' }}
              >
                + Add category
              </button>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  )
}
