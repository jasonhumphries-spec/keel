'use client'

import { useState, useCallback } from 'react'
import { doc, updateDoc, setDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useCategories } from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import type { KeelItem } from '@/lib/types'

interface CategoriseModalProps {
  items:   KeelItem[]
  onClose: () => void
}

export function CategoriseModal({ items, onClose }: CategoriseModalProps) {
  const { user }       = useAuth()
  const { categories } = useCategories()

  const [currentIndex, setCurrentIndex] = useState(0)
  const [assigned,     setAssigned]     = useState<Map<string, { categoryId: string; categoryName: string }>>(new Map())
  const [saving,       setSaving]       = useState(false)
  const [ignored,      setIgnored]      = useState<Set<string>>(new Set())
  const [creating,     setCreating]     = useState(false)
  const [newName,      setNewName]      = useState('')
  const [newDesc,      setNewDesc]      = useState('')
  const [creatingError,setCreatingError]= useState('')

  const item        = items[currentIndex] ?? null
  const isAssigned  = item ? assigned.has(item.itemId) : false
  const assignedCat = item ? assigned.get(item.itemId) : null
  const doneCount   = assigned.size
  const remaining   = items.length - doneCount
  const progress    = Math.round((doneCount / items.length) * 100)
  const canGoBack   = currentIndex > 0
  const canGoNext   = currentIndex < items.length - 1
  const isIgnored   = item ? ignored.has(item.itemId) : false
  const allDone     = (doneCount + ignored.size) === items.length

  const assign = useCallback(async (categoryId: string, categoryName: string) => {
    if (!user || !item || saving) return
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
        categoryId, categoryName, updatedAt: Timestamp.now(),
      })
      setAssigned(prev => new Map(prev).set(item.itemId, { categoryId, categoryName }))
      // Auto-advance to next unassigned item
      const next = items.findIndex((it, i) => i > currentIndex && !assigned.has(it.itemId) && it.itemId !== item.itemId)
      if (next !== -1) setCurrentIndex(next)
      else if (canGoNext) setCurrentIndex(i => i + 1)
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }, [user, item, saving, currentIndex, items, assigned, canGoNext])

  const ignoreItem = async () => {
    if (!user || !item || saving) return
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${user.uid}/items`, item.itemId), {
        status: 'quietly_logged', updatedAt: Timestamp.now(),
      })
      setIgnored(prev => new Set([...prev, item.itemId]))
      const next = items.findIndex((it, i) => i > currentIndex && !assigned.has(it.itemId) && !ignored.has(it.itemId) && it.itemId !== item.itemId)
      if (next !== -1) setCurrentIndex(next)
      else if (canGoNext) setCurrentIndex(i => i + 1)
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  const createAndAssign = async () => {
    if (!user || !item || !newName.trim() || saving) return
    setSaving(true)
    setCreatingError('')
    try {
      const catId = `cat_${Date.now()}`
      const now   = Timestamp.now()
      await setDoc(doc(db, `users/${user.uid}/categories`, catId), {
        categoryId: catId, name: newName.trim(), description: newDesc.trim(),
        icon: 'tag', order: categories.length + 1, archived: false,
        archivedAt: null, itemCount: 0, parentId: null, createdAt: now, updatedAt: now,
      })
      await assign(catId, newName.trim())
      setCreating(false); setNewName(''); setNewDesc('')
    } catch (e) {
      console.error(e)
      setCreatingError('Failed to create category — please try again')
    } finally { setSaving(false) }
  }

  const skipForNow = () => {
    if (canGoNext) setCurrentIndex(i => i + 1)
    else onClose()
  }

  const S = {
    btn: (accent?: boolean, disabled?: boolean) => ({
      padding: '9px 12px', borderRadius: 'var(--radius-md)', border: accent ? 'none' : '1px solid var(--color-border)',
      background: accent ? 'var(--color-accent)' : 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: 13, fontWeight: accent ? 600 : 400, color: accent ? 'white' : 'var(--color-text-muted)',
      fontFamily: 'var(--font-dm-sans)', opacity: disabled ? 0.5 : 1,
    } as React.CSSProperties),
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'var(--color-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
      onClick={onClose}
    >
      <div
        style={{ width: '100%', maxWidth: 520, background: 'var(--color-surface)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden', border: '1px solid var(--color-border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {creating ? 'Create new category' : 'Categorise items'}
            </div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {creating ? 'Name your category and optionally describe it' : `${doneCount} categorised · ${ignored.size} ignored · ${items.length - doneCount - ignored.size} remaining`}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!creating && !allDone && remaining > 0 && (
              <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 12, padding: '4px 10px', fontFamily: 'var(--font-dm-sans)', whiteSpace: 'nowrap' as const }}>
                Do the rest later
              </button>
            )}
            <button onClick={creating ? () => setCreating(false) : onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 20, lineHeight: 1, padding: 4 }}>
              {creating ? '←' : '×'}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {!creating && (
          <div style={{ height: 3, background: 'var(--color-border)' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: 'var(--color-accent)', transition: 'width 0.3s ease' }} />
          </div>
        )}

        {/* Create form */}
        {creating ? (
          <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', display: 'block', marginBottom: 6 }}>Category name</label>
              <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createAndAssign()}
                placeholder="e.g. Drama & Social, Job Search, Side Projects"
                style={{ width: '100%', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '9px 12px', fontSize: 13, color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none', boxSizing: 'border-box' as const }} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', display: 'block', marginBottom: 4 }}>
                Description <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional but recommended)</span>
              </label>
              <div style={{ background: 'var(--color-accent-sub)', border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: '10px 12px', marginBottom: 8, fontSize: 11, color: 'var(--color-accent)', lineHeight: 1.6 }}>
                <strong>Tip:</strong> A good description helps Keel automatically place future emails here — no manual categorising needed.
              </div>
              <textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Describe what kinds of emails belong here..." rows={3}
                style={{ width: '100%', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '9px 12px', fontSize: 12, color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none', resize: 'vertical' as const, lineHeight: 1.5, boxSizing: 'border-box' as const }} />
            </div>
            {creatingError && <div style={{ fontSize: 12, color: 'var(--color-status-urgent)' }}>{creatingError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setCreating(false)} style={S.btn(false)}>Cancel</button>
              <button onClick={createAndAssign} disabled={!newName.trim() || saving} style={{ ...S.btn(true, !newName.trim() || saving), flex: 2 }}>
                {saving ? 'Creating...' : 'Create & assign →'}
              </button>
            </div>
          </div>

        ) : allDone ? (
          <div style={{ padding: '40px 20px', textAlign: 'center' as const, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 12 }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-status-positive)', opacity: 0.7 }}>
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>All categorised!</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{items.length} item{items.length !== 1 ? 's' : ''} assigned.</div>
            <button onClick={onClose} style={{ ...S.btn(true), marginTop: 8, padding: '8px 20px' }}>Done</button>
          </div>

        ) : item ? (
          <>
            {/* Prev / position / next */}
            <div style={{ padding: '7px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--color-surface-recessed)' }}>
              <button onClick={() => setCurrentIndex(i => i - 1)} disabled={!canGoBack}
                style={{ background: 'transparent', border: 'none', cursor: canGoBack ? 'pointer' : 'not-allowed', color: canGoBack ? 'var(--color-text-secondary)' : 'var(--color-border)', fontSize: 13, padding: '4px 2px', fontFamily: 'var(--font-dm-sans)' }}>
                ← Prev
              </button>
              <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{currentIndex + 1} of {items.length}</span>
                {isAssigned && <span style={{ color: 'var(--color-status-positive)' }}>✓ {assignedCat?.categoryName}</span>}
                {isIgnored && <span style={{ color: 'var(--color-text-muted)' }}>— Ignored</span>}
              </div>
              <button onClick={() => setCurrentIndex(i => i + 1)} disabled={!canGoNext}
                style={{ background: 'transparent', border: 'none', cursor: canGoNext ? 'pointer' : 'not-allowed', color: canGoNext ? 'var(--color-text-secondary)' : 'var(--color-border)', fontSize: 13, padding: '4px 2px', fontFamily: 'var(--font-dm-sans)' }}>
                Next →
              </button>
            </div>

            {/* Item preview */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>{item.aiTitle || item.subject}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                {item.senderName} · {item.receivedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </div>
              {item.aiSummary && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{item.aiSummary}</div>}
            </div>

            {/* Category picker */}
            <div style={{ padding: '12px 20px 16px' }}>
              <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' as const, marginBottom: 10 }}>
                {isAssigned ? 'Reassign to a different category' : 'Assign to category'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 220, overflowY: 'auto' as const }}>
                {categories.map(cat => {
                  const isActive = assignedCat?.categoryId === cat.categoryId
                  return (
                    <button key={cat.categoryId} onClick={() => assign(cat.categoryId, cat.name)} disabled={saving}
                      style={{ padding: '9px 12px', borderRadius: 'var(--radius-md)', border: `1px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border)'}`, background: isActive ? 'var(--color-accent-sub)' : 'var(--color-surface)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: isActive ? 600 : 400, color: isActive ? 'var(--color-accent)' : 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', textAlign: 'left' as const, opacity: saving ? 0.6 : 1 }}
                      onMouseOver={e => { if (!isActive) { e.currentTarget.style.borderColor = 'var(--color-accent)'; e.currentTarget.style.color = 'var(--color-accent)' }}}
                      onMouseOut={e => { if (!isActive) { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-primary)' }}}>
                      {cat.name}
                    </button>
                  )
                })}
                <button onClick={() => setCreating(true)} disabled={saving}
                  style={{ padding: '9px 12px', borderRadius: 'var(--radius-md)', border: '1.5px dashed var(--color-accent)', background: 'var(--color-accent-sub)', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--color-accent)', fontFamily: 'var(--font-dm-sans)', textAlign: 'left' as const }}>
                  + New category
                </button>
              </div>

              {!isAssigned && !isIgnored && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={skipForNow} style={{ padding: '7px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-sans)', whiteSpace: 'nowrap' as const }}>
                      Leave for now
                    </button>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                      Stays in Other until you assign it.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={ignoreItem} disabled={saving} style={{ padding: '7px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'transparent', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 12, color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-sans)', whiteSpace: 'nowrap' as const, opacity: saving ? 0.5 : 1 }}>
                      Ignore
                    </button>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                      Moves to Ignored — won't appear in the dashboard.
                    </div>
                  </div>
                </div>
              )}
              {isIgnored && (
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--color-text-muted)', padding: '7px 0' }}>
                  — Moved to Ignored. Use ← Prev to go back and assign a category instead.
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
