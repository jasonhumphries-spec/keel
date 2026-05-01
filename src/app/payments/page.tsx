'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { collection, query, orderBy, onSnapshot, DocumentData, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'

interface Payment {
  paymentId: string
  itemId:    string
  payeeName: string
  amount:    number | null
  currency:  string
  dueDate:   Date | null
  paidAt:    Date
  method:    string | null
  notes:     string | null
}

function toDate(v: unknown): Date {
  if (!v) return new Date()
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  return new Date(v as string)
}

function docToPayment(id: string, d: DocumentData): Payment {
  return {
    paymentId: id,
    itemId:    d.itemId ?? '',
    payeeName: d.payeeName ?? 'Unknown',
    amount:    d.amount ?? null,
    currency:  d.currency ?? 'GBP',
    dueDate:   d.dueDate ? toDate(d.dueDate) : null,
    paidAt:    toDate(d.paidAt),
    method:    d.method ?? null,
    notes:     d.notes ?? null,
  }
}

function formatAmount(pence: number | null, currency: string): string {
  if (pence === null) return '—'
  const symbol = currency === 'GBP' ? '£' : '$'
  return `${symbol}${(pence / 100).toFixed(2)}`
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function groupByMonth(payments: Payment[]): { label: string; payments: Payment[]; total: number }[] {
  const groups: Map<string, Payment[]> = new Map()

  for (const p of payments) {
    const label = p.paidAt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(p)
  }

  return Array.from(groups.entries()).map(([label, payments]) => ({
    label,
    payments,
    total: payments.reduce((sum, p) => sum + (p.amount ?? 0), 0),
  }))
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '14px 18px', flex: 1 }}>
      <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function PaymentRow({ payment }: { payment: Payment }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: hovered ? 'var(--color-surface-raised)' : 'transparent', transition: 'background 0.1s', cursor: 'pointer' }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      {/* Paid indicator */}
      <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#f0f6f2', border: '1px solid #2e6848', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2e6848" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>

      {/* Payee */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {payment.payeeName}
        </div>
        <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>
          {formatDate(payment.paidAt)}
          {payment.method && ` · ${payment.method}`}
        </div>
      </div>

      {/* Amount */}
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', flexShrink: 0, fontFamily: 'var(--font-dm-mono)' }}>
        {formatAmount(payment.amount, payment.currency)}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', gap: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.25 }}>
        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 10h8M8 14h8"/>
      </svg>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-secondary)' }}>No payments logged yet</div>
      <div style={{ fontSize: 13, maxWidth: 300, lineHeight: 1.6 }}>
        When you mark a bill or invoice as paid from the dashboard, it gets recorded here with the date, payee, and method.
      </div>
    </div>
  )
}

export default function PaymentHistoryPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (!authLoading && !user) router.push('/')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/payments`),
      orderBy('paidAt', 'desc'),
    )
    const unsub = onSnapshot(q, snap => {
      setPayments(snap.docs.map(d => docToPayment(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  if (authLoading || !user) return null

  const groups       = groupByMonth(payments)
  const totalThisMonth = groups[0]?.total ?? 0
  const totalAllTime   = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0)
  const thisMonthLabel = groups[0]?.label ?? new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--color-bg)' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Topbar */}
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 20px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Payment History</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>
              {loading ? 'Loading…' : `${payments.length} payment${payments.length !== 1 ? 's' : ''} logged`}
            </div>
          </div>
          <button style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-dm-sans)' }}>
            Export CSV
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Summary cards */}
          {!loading && payments.length > 0 && (
            <div style={{ display: 'flex', gap: 12 }}>
              <SummaryCard
                label={thisMonthLabel}
                value={formatAmount(totalThisMonth, 'GBP')}
                sub={`${groups[0]?.payments.length ?? 0} payments`}
              />
              <SummaryCard
                label="All time"
                value={formatAmount(totalAllTime, 'GBP')}
                sub={`${payments.length} payments total`}
              />
              <SummaryCard
                label="Most recent"
                value={payments[0]?.payeeName ?? '—'}
                sub={payments[0] ? formatDate(payments[0].paidAt) : ''}
              />
            </div>
          )}

          {/* Payment groups */}
          {loading ? (
            <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
              {[1,2,3].map(i => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--color-surface-recessed)', flexShrink: 0 }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ width: '30%', height: 12, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
                    <div style={{ width: '20%', height: 10, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
                  </div>
                  <div style={{ width: 50, height: 14, background: 'var(--color-surface-recessed)', borderRadius: 3 }} />
                </div>
              ))}
            </div>
          ) : payments.length === 0 ? (
            <EmptyState />
          ) : (
            groups.map(group => (
              <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* Month header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                    {group.label}
                  </div>
                  <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                    {formatAmount(group.total, 'GBP')}
                  </div>
                </div>

                {/* Payment list */}
                <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                  {group.payments.map((payment, i) => (
                    <div key={payment.paymentId}>
                      {i > 0 && <div style={{ height: 1, background: 'var(--color-border)', margin: '0 14px' }} />}
                      <PaymentRow payment={payment} />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}

        </div>
      </div>
    </div>
  )
}
