'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { PageShell } from '@/components/layout/PageShell'
import { collection, query, orderBy, onSnapshot, DocumentData, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'

interface Payment {
  paymentId:    string
  itemId:       string
  payee:        string
  payeeEmail:   string
  description:  string
  amountPence:  number | null
  currency:     string
  paidAt:       Date
  categoryName: string
  source:       string
}

function toDate(v: unknown): Date {
  if (!v) return new Date()
  if ((v as any)?.toDate) return (v as any).toDate()
  if (v instanceof Date) return v
  return new Date(v as string)
}

function docToPayment(id: string, d: DocumentData): Payment {
  return {
    paymentId:    id,
    itemId:       d.itemId ?? '',
    payee:        d.payee ?? d.payeeName ?? 'Unknown',
    payeeEmail:   d.payeeEmail ?? '',
    description:  d.description ?? '',
    amountPence:  d.amountPence ?? d.amount ?? null,
    currency:     d.currency ?? 'GBP',
    paidAt:       toDate(d.paidAt),
    categoryName: d.categoryName ?? 'Uncategorised',
    source:       d.source ?? 'manual',
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
  const groups = new Map<string, Payment[]>()
  for (const p of payments) {
    const key = p.paidAt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }
  return Array.from(groups.entries()).map(([label, payments]) => ({
    label,
    payments,
    total: payments.reduce((sum, p) => sum + (p.amountPence ?? 0), 0),
  }))
}

function exportCSV(payments: Payment[]) {
  const headers = ['Date', 'Payee', 'Description', 'Amount', 'Currency', 'Category', 'Source']
  const rows = payments.map(p => [
    formatDate(p.paidAt),
    p.payee,
    p.description,
    p.amountPence !== null ? (p.amountPence / 100).toFixed(2) : '',
    p.currency,
    p.categoryName,
    p.source,
  ])
  const csv = [headers, ...rows].map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `keel-payments-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function PaymentHistoryPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')

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

  const filtered = search.trim()
    ? payments.filter(p =>
        p.payee.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase()) ||
        p.categoryName.toLowerCase().includes(search.toLowerCase())
      )
    : payments

  const groups     = groupByMonth(filtered)
  const grandTotal = filtered.reduce((sum, p) => sum + (p.amountPence ?? 0), 0)

  return (
    <PageShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Topbar */}
        <div style={{ background: 'var(--color-topbar-bg)', borderBottom: '1px solid var(--color-border)', padding: '0 20px', height: 'var(--topbar-height)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Payment History</div>
            <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 1 }}>
              {loading ? 'Loading…' : `${filtered.length} payments · total ${formatAmount(grandTotal, 'GBP')}`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Search */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', width: 200 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search payments…"
                style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 'var(--fs-base)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', width: '100%' }}
              />
            </div>
            {/* Export CSV */}
            <button
              onClick={() => exportCSV(filtered)}
              disabled={filtered.length === 0}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '6px 12px', fontSize: 'var(--fs-base)', fontWeight: 500, color: 'var(--color-text-secondary)', cursor: filtered.length === 0 ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-dm-sans)', opacity: filtered.length === 0 ? 0.5 : 1 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              Export CSV
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {loading ? (
            <div style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 12, textAlign: 'center' }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }}>
                <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 10h8M8 14h8"/>
              </svg>
              <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>No payments yet</div>
              <div style={{ fontSize: 'var(--fs-base)', color: 'var(--color-text-muted)', maxWidth: 280, lineHeight: 1.6 }}>
                Payment records are created automatically when Keel detects receipts in your emails.
              </div>
            </div>
          ) : (
            groups.map(group => (
              <div key={group.label}>
                {/* Month header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {group.label}
                  </div>
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                    {formatAmount(group.total, 'GBP')}
                  </div>
                </div>

                {/* Payment rows */}
                <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                  {group.payments.map((payment, i) => (
                    <div
                      key={payment.paymentId}
                      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px', borderBottom: i < group.payments.length - 1 ? '1px solid var(--color-border)' : 'none' }}
                    >
                      {/* Date */}
                      <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', flexShrink: 0, minWidth: 90 }}>
                        {formatDate(payment.paidAt)}
                      </div>

                      {/* Payee + description */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 'var(--fs-base)', fontWeight: 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {payment.description || payment.payee}
                        </div>
                        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', marginTop: 1 }}>
                          {payment.payee} · {payment.categoryName}
                        </div>
                      </div>

                      {/* Amount */}
                      <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--color-status-warning)', flexShrink: 0 }}>
                        {formatAmount(payment.amountPence, payment.currency)}
                      </div>
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
