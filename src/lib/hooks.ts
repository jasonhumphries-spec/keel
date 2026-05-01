'use client'

import { useEffect, useState } from 'react'
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
  DocumentData,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import type {
  KeelCategory,
  KeelItem,
  KeelSignal,
  KeelOutbound,
  CategoryWithItems,
} from '@/lib/types'

// ---- Converters ----
function toDate(v: unknown): Date {
  if (!v) return new Date()
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  return new Date(v as string)
}

function docToCategory(id: string, d: DocumentData): KeelCategory {
  return {
    categoryId: id, name: d.name ?? '', description: d.description ?? '', icon: d.icon ?? 'tag',
    parentId: d.parentId ?? null, order: d.order ?? 0,
    archived: d.archived ?? false, archivedAt: d.archivedAt ? toDate(d.archivedAt) : null,
    createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt), itemCount: d.itemCount ?? 0,
  }
}

function docToItem(id: string, d: DocumentData): KeelItem {
  return {
    itemId: id, messageId: d.messageId ?? '', threadId: d.threadId ?? '',
    accountId: d.accountId ?? '', senderEmail: d.senderEmail ?? '',
    senderName: d.senderName ?? '', subject: d.subject ?? '',
    receivedAt: toDate(d.receivedAt), categoryId: d.categoryId ?? '',
    categoryName: d.categoryName ?? '', subcategoryId: d.subcategoryId ?? null,
    subcategoryName: d.subcategoryName ?? null, status: d.status ?? 'new',
    importanceFlag: d.importanceFlag ?? false, aiImportanceScore: d.aiImportanceScore ?? 0.5,
    manualPriority: d.manualPriority ?? false,
    snoozedUntil: d.snoozedUntil ? toDate(d.snoozedUntil) : null,
    linkedOutboundId: d.linkedOutboundId ?? null, linkedItemId: d.linkedItemId ?? null,
    isRecurring: d.isRecurring ?? false, fromTrackedReply: d.fromTrackedReply ?? false,
    trackedReplyId: d.trackedReplyId ?? null, mergedThreadIds: d.mergedThreadIds ?? [], createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt), resolvedAt: d.resolvedAt ? toDate(d.resolvedAt) : null,
    participants: d.participants ?? [],
    aiTitle:           d.aiTitle ?? d.subject ?? '',
    aiSummary:         d.aiSummary ?? '',
    aiDetailedSummary: d.aiDetailedSummary ?? '',
  }
}

function docToSignal(id: string, d: DocumentData): KeelSignal {
  return {
    signalId: id, itemId: d.itemId ?? '', accountId: d.accountId ?? '',
    type: d.type ?? 'event', detectedDate: d.detectedDate ? toDate(d.detectedDate) : null,
    detectedAmount: d.detectedAmountPence ?? null, currency: d.currency ?? null,
    description: d.description ?? '', calendarStatus: d.calendarStatus ?? null,
    calendarEventId: d.calendarEventId ?? null, targetCalendarId: d.targetCalendarId ?? null,
    status: d.status ?? 'active', createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt),
  }
}

function docToOutbound(id: string, d: DocumentData): KeelOutbound {
  return {
    outboundId: id, messageId: d.messageId ?? '', threadId: d.threadId ?? '',
    accountId: d.accountId ?? '', recipientEmail: d.recipientEmail ?? '',
    recipientName: d.recipientName ?? '', subject: d.subject ?? '',
    aiSummary: d.aiSummary ?? '', categoryId: d.categoryId ?? null,
    categoryName: d.categoryName ?? null, status: d.status ?? 'open',
    sentAt: toDate(d.sentAt), ageDays: d.ageDays ?? 0,
    snoozedUntil: d.snoozedUntil ? toDate(d.snoozedUntil) : null,
    repliedAt: d.repliedAt ? toDate(d.repliedAt) : null,
    replyMessageId: d.replyMessageId ?? null, linkedItemId: d.linkedItemId ?? null,
    graceExpiresAt: d.graceExpiresAt ? toDate(d.graceExpiresAt) : null,
    followUpCount: d.followUpCount ?? 0,
    lastFollowUpAt: d.lastFollowUpAt ? toDate(d.lastFollowUpAt) : null,
    createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt),
  }
}

// ---- Hooks ----

export function useCounts() {
  const { user } = useAuth()
  const [counts, setCounts] = useState({
    dashboard: 0, awaitingReply: 0, quietlyLogged: 0, highPlus: 0, urgentOnly: 0, uncategorised: 0,
  })

  useEffect(() => {
    if (!user) return

    // All active items
    const qItems = query(
      collection(db, `users/${user.uid}/items`),
      where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply', 'snoozed']),
    )
    const unsubItems = onSnapshot(qItems, snap => {
      const items = snap.docs.map(d => d.data())
      const highPlus   = items.filter(d => (d.aiImportanceScore ?? 0) >= 0.70).length
      const urgentOnly = items.filter(d => (d.aiImportanceScore ?? 0) >= 0.85).length
      setCounts(prev => ({ ...prev, dashboard: snap.size, highPlus, urgentOnly }))
    })

    // Awaiting reply
    const qReply = query(
      collection(db, `users/${user.uid}/items`),
      where('status', '==', 'awaiting_reply'),
    )
    const unsubReply = onSnapshot(qReply, snap => {
      setCounts(prev => ({ ...prev, awaitingReply: snap.size }))
    })

    // Quietly logged
    const qQuiet = query(
      collection(db, `users/${user.uid}/items`),
      where('status', '==', 'quietly_logged'),
    )
    const unsubQuiet = onSnapshot(qQuiet, snap => {
      setCounts(prev => ({ ...prev, quietlyLogged: snap.size }))
    })

    // Uncategorised (cat_other / empty)
    const qUncat = query(
      collection(db, `users/${user.uid}/items`),
      where('categoryId', 'in', ['cat_other', '', 'uncategorised']),
      where('status', 'in', ['new', 'awaiting_action']),
    )
    const unsubUncat = onSnapshot(qUncat, snap => {
      setCounts(prev => ({ ...prev, uncategorised: snap.size }))
    })

    return () => { unsubItems(); unsubReply(); unsubQuiet(); unsubUncat() }
  }, [user])

  return counts
}

export function useCategories() {
  const { user } = useAuth()
  const [categories, setCategories] = useState<KeelCategory[]>([])
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/categories`),
      where('archived', '==', false),
      orderBy('order', 'asc'),
    )
    const unsub = onSnapshot(q, snap => {
      setCategories(snap.docs.map(d => docToCategory(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  return { categories, loading }
}

export function useActiveItems() {
  const { user } = useAuth()
  const [items, setItems]     = useState<KeelItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/items`),
      where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply', 'snoozed']),
    )
    const unsub = onSnapshot(q, snap => {
      setItems(snap.docs.map(d => docToItem(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  return { items, loading }
}

export function useDashboardData(): { categoryData: CategoryWithItems[]; loading: boolean } {
  const { categories, loading: catLoading } = useCategories()
  const { items, loading: itemLoading }     = useActiveItems()
  const loading = catLoading || itemLoading

  const categoryData: CategoryWithItems[] = categories.map(cat => ({
    category: cat,
    items: items
      .filter(item => item.categoryId === cat.categoryId)
      .sort((a, b) => b.aiImportanceScore - a.aiImportanceScore),
  }))

  return { categoryData, loading }
}

// All active signals — used for the item expanded panel
export function useAllSignals() {
  const { user } = useAuth()
  const [signals, setSignals] = useState<KeelSignal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/signals`),
      where('status', '==', 'active'),
    )
    const unsub = onSnapshot(q, snap => {
      setSignals(snap.docs.map(d => docToSignal(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  return { signals, loading }
}

// Calendar strip — date-filtered signals
export function useCalendarSignals(daysAhead = 10) {
  const { user } = useAuth()
  const [signals, setSignals] = useState<KeelSignal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    const now  = new Date()
    const then = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)
    const q = query(
      collection(db, `users/${user.uid}/signals`),
      where('type', 'in', ['event', 'payment']),
      where('status', '==', 'active'),
      where('detectedDate', '>=', Timestamp.fromDate(now)),
      where('detectedDate', '<=', Timestamp.fromDate(then)),
      orderBy('detectedDate', 'asc'),
    )
    const unsub = onSnapshot(q, snap => {
      setSignals(snap.docs.map(d => docToSignal(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user, daysAhead])

  return { signals, loading }
}

export function useOpenOutbound() {
  const { user } = useAuth()
  const [outbound, setOutbound] = useState<KeelOutbound[]>([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/outbound`),
      where('status', '==', 'open'),
      orderBy('sentAt', 'asc'),
    )
    const unsub = onSnapshot(q, snap => {
      setOutbound(snap.docs.map(d => docToOutbound(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  return { outbound, loading }
}

export function useOutboundAll() {
  const { user } = useAuth()
  const [outbound, setOutbound] = useState<KeelOutbound[]>([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/outbound`),
      where('status', 'in', ['open', 'replied']),
      orderBy('sentAt', 'asc'),
    )
    const unsub = onSnapshot(q, snap => {
      setOutbound(snap.docs.map(d => docToOutbound(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  return { outbound, loading }
}


export function useUncategorised() {
  const { user } = useAuth()
  const [items, setItems]     = useState<KeelItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/items`),
      where('categoryId', 'in', ['cat_other', '', 'uncategorised']),
      where('status', 'in', ['new', 'awaiting_action']),
    )
    const unsub = onSnapshot(q, snap => {
      setItems(snap.docs.map(d => docToItem(d.id, d.data())))
      setLoading(false)
    })
    return unsub
  }, [user])

  return { items, loading }
}

export function useCategoryCounts(): Map<string, number> {
  const { user } = useAuth()
  const [counts, setCounts] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    if (!user) return
    const q = query(
      collection(db, `users/${user.uid}/items`),
      where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply', 'snoozed']),
    )
    const unsub = onSnapshot(q, snap => {
      const map = new Map<string, number>()
      for (const d of snap.docs) {
        const catId = d.data().categoryId as string
        if (catId) map.set(catId, (map.get(catId) ?? 0) + 1)
      }
      setCounts(map)
    })
    return unsub
  }, [user])

  return counts
}

export function useBreakpoint() {
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200)

  useEffect(() => {
    const handler = () => setWidth(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  return {
    isMobile:  width < 768,
    isTablet:  width >= 768 && width < 1024,
    isDesktop: width >= 1024,
    width,
  }
}
