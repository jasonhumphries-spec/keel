'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { PageShell } from '@/components/layout/PageShell'
import { doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAllItems } from '@/lib/hooks'
import type { KeelItem, ItemStatus } from '@/lib/types'

// ── Status display ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ItemStatus, string> = {
  new:              'New',
  awaiting_action:  'Action needed',
  awaiting_reply:   'Awaiting reply',
  quietly_logged:   'Ignored',
  done:             'Done',
  paid:             'Paid',
  archived:         'Archived',
  snoozed:          'Snoozed',
}

const STATUS_COLOUR: Record<ItemStatus, string> = {
  new:              'var(--color-text-muted)',
  awaiting_action:  '#B8964E',
  awaiting_reply:   '#4A7FA5',
  quietly_logged:   'var(--color-text-muted)',
  done:             '#3D7A6B',
  paid:             '#3D7A6B',
  archived:         'var(--color-text-muted)',
  snoozed:          'var(--color-text-muted)',
}

// ── Grouping ───────────────────────────────────────────────────────────────────

function groupByWeek(items: KeelItem[]): { label: string; items: KeelItem[] }[] {
  const groups = new Map<string, KeelItem[]>()
  const now = new Date()
  for (const item of items) {
    const diff  = Math.floor((now.getTime() - item.receivedAt.getTime()) / 86400000)
    const label = diff < 7 ? 'This week' : diff < 14 ? 'Last week' : diff < 30 ? 'Earlier this month' : 'Older'
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(item)
  }
  const order = ['This week', 'Last week', 'Earlier this month', 'Older']
  return order.filter(l => groups.has(l)).map(l => ({ label: l, items: groups.get(l)! }))
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Components ─────────────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
      {label}
      <span style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '1px 7px', fontSize: 'var(--fs-xs)' }}>{count}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
    </div>
  )
}

function MailItem({ item, uid, onRestored }: { item: KeelItem; uid: string; onRestored: (id: string) => void }) {
  const [hovered, setHovered]   = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving]     = useState(false)

  const isRestorable = item.status === 'quietly_logged' || item.status === 'archived'

  const restore = async () => {
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${uid}/items`, item.itemId), {
        status:    'new',
        updatedAt: Timestamp.now(),
      })
      onRestored(item.itemId)
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  const openInGmail = () => {
    window.open(`https://mail.google.com/mail/u/0/#all/${item.threadId}`, '_blank')
  }

  const status = item.status as ItemStatus

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
        {/* Status dot */}
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOUR[status] ?? 'var(--color-border-strong)', flexShrink: 0, marginTop: 5 }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 1, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-base)', fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>
              {item.aiTitle || item.subject || item.senderName}
            </span>
            <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {item.senderName}
            </span>
            <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {item.categoryName}
            </span>
            {/* Status badge */}
            <span style={{
              fontFamily: 'var(--font-dm-mono)', fontSize: 10,
              color: STATUS_COLOUR[status] ?? 'var(--color-text-muted)',
              border: `1px solid ${STATUS_COLOUR[status] ?? 'var(--color-border)'}`,
              borderRadius: 4, padding: '0px 5px', letterSpacing: '0.03em', flexShrink: 0,
              opacity: (status === 'quietly_logged' || status === 'archived' || status === 'done' || status === 'paid') ? 0.6 : 1,
            }}>
              {STATUS_LABEL[status] ?? status}
            </span>
          </div>

          {expanded && item.aiSummary && (
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
              {isRestorable && (
                <button
                  onClick={e => { e.stopPropagation(); restore() }}
                  disabled={saving}
                  style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-accent)', background: 'var(--color-accent-sub)', color: 'var(--color-accent)', cursor: 'pointer', fontWeight: 600, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? '…' : '→ Dashboard'}
                </button>
              )}
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

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AllMailPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const { items, loading } = useAllItems(300)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [restoredIds, setRestoredIds]   = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!authLoading && !user) router.push('/')
  }, [user, authLoading, router])

  if (authLoading || !user) return null

  const STATUS_OPTIONS = [
    { value: 'all',             label: 'All' },
    { value: 'active',          label: 'Active' },
    { value: 'awaiting_action', label: 'Action needed' },
    { value: 'awaiting_reply',  label: 'Awaiting reply' },
    { value: 'quietly_logged',  label: 'Ignored' },
    { value: 'done',            label: 'Done' },
    { value: 'archived',        label: 'Archived' },
  ]

  const ACTIVE_STATUSES = new Set(['new', 'awaiting_action', 'awaiting_reply', 'snoozed'])

  let visible = items.filter(i => !restoredIds.has(i.itemId) || ACTIVE_STATUSES.has(i.status))

  if (statusFilter === 'active') {
    visible = visible.filter(i => ACTIVE_STATUSES.has(i.status))
  } else if (statusFilter !== 'all') {
    visible = visible.filter(i => i.status === statusFilter)
  }

  if (search.trim()) {
    const q = search.trim().toLowerCase()
    visible = visible.filter(i =>
      i.senderName.toLowerCase().includes(q) ||
      i.subject.toLowerCase().includes(q) ||
      i.aiTitle.toLowerCase().includes(q) ||
      i.aiSummary.toLowerCase().includes(q) ||
      i.categoryName.toLowerCase().includes(q)
    )
  }

  const groups = groupByWeek(visible)

  return (
    <PageShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Topbar */}
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 20px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>All Mail</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 1 }}>
              {loading ? 'Loading…' : `${items.length} emails scanned`}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', width: 200 }}>
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

        {/* Status filter pills */}
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, overflowX: 'auto' }}>
          {STATUS_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setStatusFilter(opt.value)}
              style={{
                fontFamily:  'var(--font-dm-mono)',
                fontSize:    'var(--fs-xs)',
                padding:     '4px 10px',
                borderRadius: 6,
                border:      statusFilter === opt.value
                  ? '1px solid var(--color-accent)'
                  : '1px solid var(--color-border)',
                background:  statusFilter === opt.value
                  ? 'var(--color-accent-sub)'
                  : 'transparent',
                color:       statusFilter === opt.value
                  ? 'var(--color-accent)'
                  : 'var(--color-text-muted)',
                cursor:      'pointer',
                whiteSpace:  'nowrap',
                fontWeight:  statusFilter === opt.value ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
            {visible.length} shown
          </span>
        </div>

        {/* Note about scan scope */}
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '6px 20px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            Shows all emails Keel has scanned from your inbox. Emails in Promotions, Social, or Spam tabs are not scanned — open Gmail to see those.
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loading ? (
            <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', padding: '4px 0' }}>
              {[1,2,3,4,5,6,7,8].map(i => <SkeletonRow key={i} />)}
            </div>
          ) : visible.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', gap: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.25 }}>
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
              </svg>
              <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                {search ? 'No results' : 'Nothing here yet'}
              </div>
              <div style={{ fontSize: 'var(--fs-base)', maxWidth: 280, lineHeight: 1.6 }}>
                {search ? 'Try a different search term.' : 'Emails will appear here once Keel has scanned your inbox.'}
              </div>
            </div>
          ) : (
            groups.map(group => (
              <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <SectionHeader label={group.label} count={group.items.length} />
                <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', padding: '4px 0' }}>
                  {group.items.map((item, i) => (
                    <div key={item.itemId}>
                      {i > 0 && <div style={{ height: 1, background: 'var(--color-border)', margin: '0 12px' }} />}
                      <MailItem
                        item={item}
                        uid={user.uid}
                        onRestored={id => setRestoredIds(prev => new Set([...prev, id]))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}

          {/* Limit note */}
          {!loading && items.length >= 300 && (
            <div style={{ textAlign: 'center', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', padding: '8px 0 16px' }}>
              Showing most recent 300 emails — run a scan to refresh
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}
