'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { PageShell } from '@/components/layout/PageShell'
import { collection, query, where, orderBy, onSnapshot, doc, updateDoc, DocumentData, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { KeelItem } from '@/lib/types'

function toDate(v: unknown): Date {
  if (!v) return new Date()
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  return new Date(v as string)
}

function docToItem(id: string, d: DocumentData): KeelItem {
  return {
    itemId: id, messageId: d.messageId ?? '', threadId: d.threadId ?? '',
    accountId: d.accountId ?? '', senderEmail: d.senderEmail ?? '',
    senderName: d.senderName ?? '', subject: d.subject ?? '',
    receivedAt: toDate(d.receivedAt), categoryId: d.categoryId ?? '',
    categoryName: d.categoryName ?? '', subcategoryId: d.subcategoryId ?? null,
    subcategoryName: d.subcategoryName ?? null, status: d.status ?? 'quietly_logged',
    importanceFlag: d.importanceFlag ?? false, aiImportanceScore: d.aiImportanceScore ?? 0,
    snoozedUntil: null, linkedOutboundId: null, linkedItemId: null,
    isRecurring: d.isRecurring ?? false, fromTrackedReply: false, trackedReplyId: null,
    createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt), resolvedAt: null,
    participants: d.participants ?? [],
    aiTitle:   d.aiTitle ?? d.subject ?? '',
    aiSummary: d.aiSummary ?? '',
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function groupByWeek(items: KeelItem[]): { label: string; items: KeelItem[] }[] {
  const groups: Map<string, KeelItem[]> = new Map()
  const now = new Date()
  for (const item of items) {
    const diff = Math.floor((now.getTime() - item.receivedAt.getTime()) / 86400000)
    const label = diff < 7 ? 'This week' : diff < 14 ? 'Last week' : diff < 30 ? 'Earlier this month' : 'Older'
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(item)
  }
  const order = ['This week', 'Last week', 'Earlier this month', 'Older']
  return order.filter(l => groups.has(l)).map(l => ({ label: l, items: groups.get(l)! }))
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
      {label}
      <span style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '1px 7px', fontSize: 'var(--fs-xs)' }}>{count}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
    </div>
  )
}

function LoggedItem({ item, uid, onMoved }: { item: KeelItem; uid: string; onMoved: () => void }) {
  const [hovered,  setHovered]  = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [saving,   setSaving]   = useState(false)

  const moveToDashboard = async () => {
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${uid}/items`, item.itemId), {
        status:    'new',
        updatedAt: Timestamp.now(),
      })
      onMoved()
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  const openInGmail = () => {
    window.open(`https://mail.google.com/mail/u/0/#all/${item.threadId}`, '_blank')
  }

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '9px 12px', borderRadius: 'var(--radius-md)',
          background: hovered ? 'var(--color-surface-raised)' : 'transparent',
          transition: 'background 0.1s', cursor: 'pointer',
        }}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-border-strong)', flexShrink: 0, marginTop: 5 }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 1 }}>
            <span style={{ fontSize: 'var(--fs-base)', fontWeight: 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '55%' }}>
              {item.aiTitle || item.senderName}
            </span>
            <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {item.senderName}
            </span>
            <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {item.categoryName}
            </span>
          </div>
          {expanded && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginTop: 4, marginBottom: 6 }}>
              {item.aiSummary}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {hovered && (
            <>
              <button
                onClick={e => { e.stopPropagation(); openInGmail() }}
                style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
              >
                Gmail
              </button>
              <button
                onClick={e => { e.stopPropagation(); moveToDashboard() }}
                disabled={saving}
                style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-accent)', background: 'var(--color-accent-sub)', color: 'var(--color-accent)', cursor: 'pointer', fontWeight: 600, opacity: saving ? 0.6 : 1 }}
              >
                {saving ? '…' : '→ Dashboard'}
              </button>
            </>
          )}
          <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
            {formatDate(item.receivedAt)}
          </span>
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', gap: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.25 }}>
        <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>
      </svg>
      <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Nothing ignored yet</div>
      <div style={{ fontSize: 'var(--fs-base)', maxWidth: 300, lineHeight: 1.6 }}>
        Newsletters, automated notifications and other low-priority emails get filed here automatically — they never clutter your dashboard.
      </div>
    </div>
  )
}

function SkeletonRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-surface-recessed)', flexShrink: 0, marginTop: 5 }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ width: '35%', height: 12, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
        <div style={{ width: '65%', height: 11, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
      </div>
      <div style={{ width: 60, height: 10, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
    </div>
  )
}

export default function QuietlyLoggedPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [items, setItems]     = useState<KeelItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [movedIds, setMovedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!authLoading && !user) router.push('/')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/items`),
      where('status', '==', 'quietly_logged'),
      orderBy('receivedAt', 'desc'),
    )
    const unsub = onSnapshot(q, snap => {
      setItems(snap.docs.map(d => docToItem(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  if (authLoading || !user) return null

  const visible  = items.filter(i => !movedIds.has(i.itemId))
  const filtered = search.trim()
    ? visible.filter(i =>
        i.senderName.toLowerCase().includes(search.toLowerCase()) ||
        i.subject.toLowerCase().includes(search.toLowerCase()) ||
        i.aiSummary.toLowerCase().includes(search.toLowerCase()) ||
        i.aiTitle.toLowerCase().includes(search.toLowerCase())
      )
    : visible

  const groups = groupByWeek(filtered)

  return (
    <PageShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Topbar */}
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 20px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Ignored</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 1 }}>
              {loading ? 'Loading…' : `${visible.length} items filed automatically`}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', width: 220 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 'var(--fs-base)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', width: '100%' }}
              />
            </div>
          </div>
        </div>

        {/* Explainer */}
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            Hover any item to open it in Gmail or move it to your dashboard. Click to expand the summary.
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loading ? (
            <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', padding: '4px 0' }}>
              {[1,2,3,4,5].map(i => <SkeletonRow key={i} />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState />
          ) : (
            groups.map(group => (
              <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <SectionHeader label={group.label} count={group.items.length} />
                <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', padding: '4px 0' }}>
                  {group.items.map((item, i) => (
                    <div key={item.itemId}>
                      {i > 0 && <div style={{ height: 1, background: 'var(--color-border)', margin: '0 12px' }} />}
                      <LoggedItem
                        item={item}
                        uid={user.uid}
                        onMoved={() => setMovedIds(prev => new Set([...prev, item.itemId]))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </PageShell>
  )
}
