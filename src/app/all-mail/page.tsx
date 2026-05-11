'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { PageShell } from '@/components/layout/PageShell'
import { doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAllItems } from '@/lib/hooks'
import type { KeelItem, ItemStatus } from '@/lib/types'

const STATUS_LABEL: Record<ItemStatus, string> = {
  new:             'New',
  awaiting_action: 'Action needed',
  awaiting_reply:  'Awaiting reply',
  quietly_logged:  'Ignored',
  done:            'Done',
  paid:            'Paid',
  archived:        'Archived',
  snoozed:         'Snoozed',
}

const STATUS_COLOUR: Record<ItemStatus, string> = {
  new:             'var(--color-text-muted)',
  awaiting_action: '#B8964E',
  awaiting_reply:  '#4A7FA5',
  quietly_logged:  'var(--color-text-muted)',
  done:            '#3D7A6B',
  paid:            '#3D7A6B',
  archived:        'var(--color-text-muted)',
  snoozed:         'var(--color-text-muted)',
}

const SENT_BLUE = '#4A7FA5'

function isSentByUser(item: KeelItem, userEmail: string): boolean {
  // Use isOutbound if set (items scanned after the field was added)
  // Fall back to senderEmail comparison for older items not yet rescanned
  if ((item as any).isOutbound !== undefined) return (item as any).isOutbound === true
  return item.senderEmail.toLowerCase() === userEmail.toLowerCase()
}

function groupByWeek(items: KeelItem[]): { label: string; items: KeelItem[] }[] {
  const groups = new Map<string, KeelItem[]>()
  const now = new Date()
  for (const item of items) {
    const diff  = Math.floor((now.getTime() - item.receivedAt.getTime()) / 86400000)
    const label = diff < 7 ? 'This week' : diff < 14 ? 'Last week' : diff < 30 ? 'Earlier this month' : 'Older'
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(item)
  }
  return ['This week', 'Last week', 'Earlier this month', 'Older']
    .filter(l => groups.has(l))
    .map(l => ({ label: l, items: groups.get(l)! }))
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
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

function MailItem({ item, uid, userEmail, onRestored }: {
  item: KeelItem; uid: string; userEmail: string; onRestored: (id: string) => void
}) {
  const [hovered,  setHovered]  = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [saving,   setSaving]   = useState(false)

  const sent          = isSentByUser(item, userEmail)
  const status        = item.status as ItemStatus
  const isRestorable  = status === 'quietly_logged' || status === 'archived'
  // Sent + awaiting_reply = needs chasing — most important signal in this view
  const isChase       = sent && status === 'awaiting_reply'

  const restore = async () => {
    setSaving(true)
    try {
      await updateDoc(doc(db, `users/${uid}/items`, item.itemId), { status: 'new', updatedAt: Timestamp.now() })
      onRestored(item.itemId)
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '9px 12px 9px 10px',
          borderLeft: isChase ? `3px solid ${SENT_BLUE}` : '3px solid transparent',
          background: hovered ? 'var(--color-surface-raised)' : 'transparent',
          transition: 'background 0.1s', cursor: 'pointer',
        }}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 5,
          background: isChase ? SENT_BLUE : (STATUS_COLOUR[status] ?? 'var(--color-border-strong)'),
        }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-base)', fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }}>
              {item.aiTitle || item.subject || item.senderName}
            </span>

            {/* Origin: filled Sent badge or plain sender name */}
            {sent ? (
              <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, background: SENT_BLUE, color: '#fff', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>
                Sent
              </span>
            ) : (
              <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
                {item.senderName}
              </span>
            )}

            <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {item.categoryName}
            </span>

            {/* Status badge — filled+bold for chase items */}
            <span style={{
              fontFamily: 'var(--font-dm-mono)', fontSize: 10,
              color:      isChase ? '#fff' : (STATUS_COLOUR[status] ?? 'var(--color-text-muted)'),
              background: isChase ? SENT_BLUE : 'transparent',
              border:     `1px solid ${STATUS_COLOUR[status] ?? 'var(--color-border)'}`,
              borderRadius: 4, padding: '0px 5px', flexShrink: 0,
              fontWeight: isChase ? 600 : 400,
              opacity: (!isChase && ['quietly_logged','archived','done','paid'].includes(status)) ? 0.5 : 1,
            }}>
              {isChase ? '↑ Chase?' : (STATUS_LABEL[status] ?? status)}
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
              <button onClick={e => { e.stopPropagation(); window.open(`https://mail.google.com/mail/u/0/#all/${item.threadId}`, '_blank') }}
                style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
                Gmail
              </button>
              {isRestorable && (
                <button onClick={e => { e.stopPropagation(); restore() }} disabled={saving}
                  style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-accent)', background: 'var(--color-accent-sub)', color: 'var(--color-accent)', cursor: 'pointer', fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
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

export default function AllMailPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const { items, loading }             = useAllItems(300)
  const [search, setSearch]            = useState('')
  const [statusFilter, setStatusFilter]  = useState<string>('all')
  const [restoredIds, setRestoredIds]    = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!authLoading && !user) router.push('/')
  }, [user, authLoading, router])

  if (authLoading || !user) return null

  const userEmail    = user.email ?? ''
  const ACTIVE       = new Set(['new', 'awaiting_action', 'awaiting_reply', 'snoozed'])
  const chaseCount   = items.filter(i => isSentByUser(i, userEmail) && i.status === 'awaiting_reply').length

  let visible = items.filter(i => !restoredIds.has(i.itemId) || ACTIVE.has(i.status))
  if      (statusFilter === 'active')          visible = visible.filter(i => ACTIVE.has(i.status))
  else if (statusFilter === 'sent')            visible = visible.filter(i => isSentByUser(i, userEmail))
  else if (statusFilter !== 'all')             visible = visible.filter(i => i.status === statusFilter)

  if (search.trim()) {
    const q = search.toLowerCase()
    visible = visible.filter(i =>
      i.senderName.toLowerCase().includes(q) || i.subject.toLowerCase().includes(q) ||
      i.aiTitle.toLowerCase().includes(q)    || i.aiSummary.toLowerCase().includes(q) ||
      i.categoryName.toLowerCase().includes(q)
    )
  }

  const groups = groupByWeek(visible)

  const FILTERS = [
    { value: 'all',             label: 'All' },
    { value: 'active',          label: 'Active' },
    { value: 'sent',            label: 'Sent',           badge: chaseCount },
    { value: 'awaiting_reply',  label: 'Awaiting reply' },
    { value: 'awaiting_action', label: 'Action needed' },
    { value: 'quietly_logged',  label: 'Ignored' },
    { value: 'done',            label: 'Done' },
    { value: 'archived',        label: 'Archived' },
  ]

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', width: 200 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
              style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 'var(--fs-base)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', width: '100%' }} />
          </div>
        </div>

        {/* Filter pills */}
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, overflowX: 'auto' }}>
          {FILTERS.map(opt => {
            const on      = statusFilter === opt.value
            const isSent  = opt.value === 'sent'
            const accent  = isSent ? SENT_BLUE : 'var(--color-accent)'
            const accentBg = isSent ? 'rgba(74,127,165,0.12)' : 'var(--color-accent-sub)'
            return (
              <button key={opt.value} onClick={() => setStatusFilter(opt.value)}
                style={{
                  fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', padding: '4px 10px',
                  borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
                  border:      on ? `1px solid ${accent}` : '1px solid var(--color-border)',
                  background:  on ? accentBg : 'transparent',
                  color:       on ? accent   : 'var(--color-text-muted)',
                  fontWeight:  on ? 600 : 400,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                {opt.label}
                {opt.badge && opt.badge > 0 && (
                  <span style={{ background: SENT_BLUE, color: '#fff', borderRadius: 8, padding: '0 5px', fontSize: 9, fontWeight: 700, lineHeight: '14px' }}>
                    {opt.badge}
                  </span>
                )}
              </button>
            )
          })}
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>{visible.length} shown</span>
        </div>

        {/* Context note */}
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '6px 20px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            {statusFilter === 'sent'
              ? `Emails you sent — ${chaseCount > 0 ? `${chaseCount} flagged as needing a chase. ` : ''}Click any row to expand the summary.`
              : 'Shows all emails Keel has scanned from your inbox and sent folder. Promotions, Social, and Spam are not scanned — open Gmail to see those.'}
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
                {statusFilter === 'sent' ? 'No sent emails found' : search ? 'No results' : 'Nothing here yet'}
              </div>
              <div style={{ fontSize: 'var(--fs-base)', maxWidth: 300, lineHeight: 1.6 }}>
                {statusFilter === 'sent'
                  ? 'Run a scan to pick up emails you have sent recently.'
                  : search ? 'Try a different search term.' : 'Emails will appear here once Keel has scanned your inbox.'}
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
                      <MailItem item={item} uid={user.uid} userEmail={userEmail}
                        onRestored={id => setRestoredIds(prev => new Set([...prev, id]))} />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
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
