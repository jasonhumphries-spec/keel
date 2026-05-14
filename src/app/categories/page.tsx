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
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  if (authLoading || !user) return null

  return (
    <PageShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>

        {/* Topbar */}
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 24px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Categories</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}>
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

        {/* Content — responsive card grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 10,
          }}>
            {loading ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-dm-mono)', fontSize: 12, gridColumn: '1/-1' }}>Loading…</div>
            ) : (
              items.map(cat => {
                const isExpanded = hoveredId === cat.categoryId || cat.dirty
                return (
                  <div
                    key={cat.categoryId}
                    onMouseEnter={() => setHoveredId(cat.categoryId)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      background: isExpanded ? 'var(--color-topbar-bg, #fff)' : 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderLeft: `3px solid ${isExpanded ? 'var(--color-accent)' : 'transparent'}`,
                      borderRadius: 'var(--radius-lg)',
                      padding: '12px 14px',
                      transition: 'background 0.13s ease, border-left-color 0.13s ease',
                      overflow: 'hidden',
                    }}
                  >
                    {/* Header row — always visible */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        value={cat.nameEdited}
                        onChange={e => update(cat.categoryId, 'nameEdited', e.target.value)}
                        onFocus={() => setHoveredId(cat.categoryId)}
                        style={{
                          flex: 1, minWidth: 0,
                          background: 'transparent',
                          border: 'none',
                          borderBottom: `1px solid ${cat.dirty ? 'var(--color-accent)' : isExpanded ? 'var(--color-border)' : 'transparent'}`,
                          fontSize: 14, fontWeight: 600,
                          color: 'var(--color-text-primary)',
                          fontFamily: 'var(--font-dm-sans)',
                          padding: '2px 2px 5px',
                          outline: 'none',
                          transition: 'border-color 0.13s',
                        }}
                      />
                      <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                        {cat.itemCount} item{cat.itemCount !== 1 ? 's' : ''}
                      </span>
                      {cat.dirty && (
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent)', flexShrink: 0 }} title="Unsaved changes" />
                      )}
                    </div>

                    {/* Expanded content — slides in on hover or when dirty */}
                    <div style={{
                      maxHeight: isExpanded ? 320 : 0,
                      opacity: isExpanded ? 1 : 0,
                      overflow: 'hidden',
                      marginTop: isExpanded ? 10 : 0,
                      transition: 'max-height 0.18s ease, opacity 0.15s, margin-top 0.12s',
                    }}>
                      {/* Keel already knows panel */}
                      {DEFAULT_CATEGORY_DESCRIPTIONS[cat.categoryId] && (
                        <div style={{
                          fontSize: 11, color: 'var(--color-text-secondary)',
                          padding: '6px 10px', marginBottom: 8,
                          background: 'var(--color-surface-recessed)',
                          border: '1px solid var(--color-border)',
                          borderLeft: '3px solid var(--color-accent)',
                          borderRadius: 'var(--radius-md)',
                          lineHeight: 1.5,
                        }}>
                          <span style={{ fontWeight: 600, color: 'var(--color-accent)', display: 'block', marginBottom: 2 }}>Keel already knows:</span>
                          {DEFAULT_CATEGORY_DESCRIPTIONS[cat.categoryId]}
                        </div>
                      )}

                      {/* User description */}
                      <textarea
                        value={cat.descEdited}
                        onChange={e => update(cat.categoryId, 'descEdited', e.target.value)}
                        onFocus={e => { setHoveredId(cat.categoryId); e.target.style.borderColor = 'var(--color-accent)' }}
                        onBlurCapture={e => { e.target.style.borderColor = cat.dirty ? 'var(--color-accent)' : 'var(--color-border)' }}
                        placeholder={
                          CATEGORY_DESCRIPTION_HINTS[cat.categoryId]
                            ?? "Describe what emails belong here — who sends them, what they're about, any key names…"
                        }
                        rows={3}
                        style={{
                          width: '100%', boxSizing: 'border-box' as const,
                          background: 'var(--color-surface-recessed)',
                          border: `1px solid ${cat.dirty ? 'var(--color-accent)' : 'var(--color-border)'}`,
                          borderRadius: 'var(--radius-md)',
                          padding: '7px 10px',
                          fontSize: 12, fontFamily: 'var(--font-dm-sans)',
                          color: 'var(--color-text-primary)',
                          resize: 'vertical' as const, lineHeight: 1.5, outline: 'none',
                          transition: 'border-color 0.15s',
                        }}
                      />

                      {/* Actions */}
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                        {saved.has(cat.categoryId) && !cat.dirty && (
                          <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: '#3D7A6B' }}>✓ Saved</span>
                        )}
                        {cat.dirty && (
                          <button
                            onClick={() => save(cat)}
                            disabled={saving.has(cat.categoryId)}
                            style={{
                              padding: '5px 14px', background: 'var(--color-accent)', color: 'white',
                              border: 'none', borderRadius: 'var(--radius-md)',
                              fontSize: 12, fontWeight: 600, cursor: 'pointer',
                              fontFamily: 'var(--font-dm-sans)',
                              opacity: saving.has(cat.categoryId) ? 0.6 : 1,
                            }}
                          >
                            {saving.has(cat.categoryId) ? '…' : 'Save'}
                          </button>
                        )}
                        {cat.itemCount === 0 && (
                          <button
                            onClick={() => deleteCategory(cat)}
                            style={{
                              padding: '5px 10px', background: 'transparent',
                              color: 'var(--color-text-secondary)',
                              border: '1px solid var(--color-border)',
                              borderRadius: 'var(--radius-md)',
                              fontSize: 11, cursor: 'pointer',
                              fontFamily: 'var(--font-dm-sans)',
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

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
