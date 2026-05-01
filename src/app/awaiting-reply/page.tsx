'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { PageShell } from '@/components/layout/PageShell'
import { collection, query, where, onSnapshot, doc, updateDoc, Timestamp, DocumentData } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { KeelItem } from '@/lib/types'

function toDate(v: unknown): Date {
  if (!v) return new Date()
  if ((v as any).toDate) return (v as any).toDate()
  return new Date(v as string)
}

function docToItem(id: string, d: DocumentData): KeelItem {
  return {
    itemId: id, messageId: d.messageId ?? '', threadId: d.threadId ?? '',
    accountId: d.accountId ?? '', senderEmail: d.senderEmail ?? '',
    senderName: d.senderName ?? '', subject: d.subject ?? '',
    receivedAt: toDate(d.receivedAt), categoryId: d.categoryId ?? '',
    categoryName: d.categoryName ?? '', subcategoryId: null, subcategoryName: null,
    status: d.status ?? 'awaiting_reply',
    importanceFlag: d.importanceFlag ?? false,
    aiImportanceScore: d.aiImportanceScore ?? 0.5,
    manualPriority: d.manualPriority ?? false,
    snoozedUntil: null, linkedOutboundId: null, linkedItemId: null,
    isRecurring: d.isRecurring ?? false, fromTrackedReply: false, trackedReplyId: null,
    createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt), resolvedAt: null,
    participants: d.participants ?? [],
    aiTitle:           d.aiTitle ?? d.subject ?? '',
    aiSummary:         d.aiSummary ?? '',
    aiDetailedSummary: d.aiDetailedSummary ?? '',
  }
}

function formatRelative(date: Date): string {
  const diff  = Math.floor((Date.now() - date.getTime()) / 86400000)
  const hours = Math.floor((Date.now() - date.getTime()) / 3600000)
  if (hours < 1)  return 'Less than an hour ago'
  if (hours < 24) return `${hours}h ago`
  if (diff === 1) return 'Yesterday'
  return `${diff} days ago`
}

function AgeDays({ date }: { date: Date }) {
  const days  = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000))
  const colour = days >= 6 ? '#8a3028' : days >= 3 ? '#8a6020' : '#9aa2a6'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0, minWidth: 48, paddingTop: 2 }}>
      <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: colour, lineHeight: 1, fontFamily: 'var(--font-dm-mono)' }}>{days}</div>
      <div style={{ fontSize: 'var(--fs-xs)', color: colour, opacity: 0.7, fontFamily: 'var(--font-dm-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>days</div>
      <div style={{ width: 30, height: 3, borderRadius: 2, background: colour }} />
    </div>
  )
}

function AgeLegend() {
  return (
    <div style={{ display: 'flex', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      {[
        { colour: '#9aa2a6', label: 'Day 1–2 · Fresh' },
        { colour: '#8a6020', label: 'Day 3–5 · Waiting' },
        { colour: '#8a3028', label: 'Day 6+ · Follow up?' },
      ].map((item, i) => (
        <div key={i} style={{ flex: 1, padding: '7px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: item.colour, borderRight: i < 2 ? '1px solid var(--color-border)' : 'none' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: item.colour }} />
          {item.label}
        </div>
      ))}
    </div>
  )
}

function AwaitingItem({ item, uid }: { item: KeelItem; uid: string }) {
  const [saving, setSaving] = useState(false)
  const days = Math.floor((Date.now() - item.receivedAt.getTime()) / 86400000)
  const borderColour = days >= 6 ? '#8a3028' : days >= 3 ? '#8a6020' : 'var(--color-border)'

  const markDone = async () => {
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${uid}/items`, item.itemId), {
        status: 'done', resolvedAt: Timestamp.now(), updatedAt: Timestamp.now(),
      })
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  const snooze = async () => {
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${uid}/items`, item.itemId), {
        status: 'snoozed',
        snoozedUntil: Timestamp.fromMillis(Date.now() + 7 * 86400000),
        updatedAt: Timestamp.now(),
      })
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  const openInGmail = () =>
    window.open(`https://mail.google.com/mail/u/0/#sent/${item.threadId}`, '_blank')

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderLeft: `3px solid ${borderColour}`, borderRadius: 'var(--radius-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '13px 15px' }}>

        <AgeDays date={item.receivedAt} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 3 }}>
            {item.categoryName ?? 'Uncategorised'}
          </div>
          <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 2 }}>
            {item.aiTitle || item.subject}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginBottom: 4 }}>
            {(item.participants?.length > 0 ? item.participants : [item.senderName]).join(' · ')}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {item.aiSummary}
          </div>
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 5 }}>
            Sent {formatRelative(item.receivedAt)}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          <button onClick={openInGmail} style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'var(--font-dm-sans)', padding: '6px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-secondary)' }}>
            Open in Gmail
          </button>
          <button onClick={markDone} disabled={saving} style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'var(--font-dm-sans)', padding: '6px 12px', borderRadius: 'var(--radius-md)', cursor: saving ? 'not-allowed' : 'pointer', background: '#f0f6f2', border: '1px solid #2e6848', color: '#2e6848', opacity: saving ? 0.6 : 1 }}>
            {saving ? '…' : 'Mark resolved'}
          </button>
          <button onClick={snooze} disabled={saving} style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'var(--font-dm-sans)', padding: '6px 12px', borderRadius: 'var(--radius-md)', cursor: saving ? 'not-allowed' : 'pointer', background: '#f8f4ec', border: '1px solid #8a6020', color: '#8a6020', opacity: saving ? 0.6 : 1 }}>
            Snooze 1 week
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AwaitingReplyPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [items, setItems]   = useState<KeelItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!authLoading && !user) router.push('/')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/items`),
      where('status', '==', 'awaiting_reply'),
    )
    const unsub = onSnapshot(q, snap => {
      const sorted = snap.docs
        .map(d => docToItem(d.id, d.data()))
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()) // oldest first
      setItems(sorted)
      setLoading(false)
    })
    return unsub
  }, [user])

  if (authLoading || !user) return null

  return (
    <PageShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>

        {/* Topbar */}
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 20px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Awaiting Reply</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 1 }}>
              {loading ? 'Loading…' : `${items.length} open · sorted oldest first`}
            </div>
          </div>
          <a href="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 'var(--fs-base)', fontWeight: 500, color: 'var(--color-text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-dm-sans)', textDecoration: 'none' }}>
            ← Dashboard
          </a>
        </div>

        {/* Explainer */}
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '8px 20px', flexShrink: 0 }}>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            These are email threads where your most recent message contains an open question or request. Mark resolved when you get a reply, or snooze to hide for a week.
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading ? (
            <AgeLegend />
          ) : items.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                <path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Nothing awaiting a reply</div>
              <div style={{ fontSize: 'var(--fs-base)', maxWidth: 280, lineHeight: 1.6 }}>
                When Keel detects you sent an email with an open question, it'll appear here until you get a reply.
              </div>
            </div>
          ) : (
            <>
              <AgeLegend />
              {items.map(item => (
                <AwaitingItem key={item.itemId} item={item} uid={user.uid} />
              ))}
            </>
          )}
        </div>
      </div>
    </PageShell>
  )
}
