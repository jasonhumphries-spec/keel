/**
 * POST /api/gmail/backfill-priors
 *
 * Stage 3 of the relevance brain — see docs/relevance-brain-design.md §5.
 *
 * Reads the user's Gmail history and derives per-sender relevance priors from the
 * strongest free signal available: whether they reply, and how fast.
 *
 * Deliberately cheap. Threads are fetched with format=metadata and only the From
 * and Date headers, so no message bodies are read, nothing is sent to a model, and
 * there is no token cost at all. One threads.get per thread (5 quota units) against
 * a 250 units/user/second budget.
 *
 * Cursor-resumable: each call processes up to `maxThreads` and returns a
 * pageToken. State lives in users/{uid}/brain/backfillState, so a long history is
 * walked over several invocations and a timeout loses at most one page.
 *
 * Body: { uid, months?, maxThreads?, reset? }
 * Auth: ADMIN_SECRET via x-admin-secret, matching the other admin routes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getValidAccessToken } from '@/lib/server/tokenUtils'
import {
  aggregateReplyHistory, mergeSenderPriors, parseAddress,
  type ThreadMeta, type SenderPrior,
} from '@/lib/server/replyHistory'

export const maxDuration = 300

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  })
}
const db = getFirestore()

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Pull the metadata we need for one thread. Bodies are never requested. */
async function fetchThreadMeta(threadId: string, token: string): Promise<ThreadMeta | null> {
  const url = `${GMAIL}/threads/${threadId}`
    + `?format=metadata&metadataHeaders=From&metadataHeaders=Date`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return null
  const t = await res.json()
  return {
    threadId,
    messages: (t.messages ?? []).map((m: { payload?: { headers?: Array<{ name: string; value: string }> }; internalDate?: string }) => {
      const from = m.payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value ?? ''
      return { fromEmail: parseAddress(from), internalDate: parseInt(m.internalDate ?? '0', 10) }
    }).filter((m: { fromEmail: string; internalDate: number }) => m.fromEmail && m.internalDate > 0),
  }
}

/** Bounded-concurrency map — keeps us well inside Gmail's per-user rate limit. */
async function pooled<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)))
  }
  return out
}

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-secret') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const { uid, months = 12, maxThreads = 400, reset = false } = await req.json()
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 })

  const stateRef = db.doc(`users/${uid}/brain/backfillState`)
  if (reset) await stateRef.set({}, { merge: false })
  const state = (await stateRef.get()).data() ?? {}
  if (state.done) {
    return NextResponse.json({ done: true, note: 'already complete — pass reset:true to redo', stats: state.stats ?? null })
  }

  const token = await getValidAccessToken(db, uid)
  if (!token) return NextResponse.json({ error: 'no valid Gmail token for user' }, { status: 400 })

  // Every address the owner sends as. Without this, their own replies read as
  // inbound mail and every sender's reply rate collapses to zero.
  const root = (await db.doc(`users/${uid}`).get()).data() ?? {}
  const acct = (await db.doc(`users/${uid}/accounts/account_primary`).get()).data() ?? {}
  const ownerEmails = [...new Set([root.email, acct.emailAddress, acct.email].filter(Boolean).map((e: string) => e.toLowerCase()))]
  if (ownerEmails.length === 0) {
    return NextResponse.json({ error: 'could not determine owner email' }, { status: 400 })
  }

  // List thread ids. `newer_than` keeps the walk bounded; -in:chats drops Hangouts.
  const listUrl = new URL(`${GMAIL}/threads`)
  listUrl.searchParams.set('q', `newer_than:${months}m -in:chats`)
  listUrl.searchParams.set('maxResults', '100')
  if (state.pageToken) listUrl.searchParams.set('pageToken', state.pageToken)

  const ids: string[] = []
  let pageToken: string | undefined = state.pageToken
  let pagesFetched = 0
  while (ids.length < maxThreads) {
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken)
    const res = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      return NextResponse.json({ error: `gmail threads.list ${res.status}`, detail: await res.text() }, { status: 502 })
    }
    const page = await res.json()
    ids.push(...(page.threads ?? []).map((t: { id: string }) => t.id))
    pagesFetched++
    pageToken = page.nextPageToken
    if (!pageToken) break
  }

  const metas = (await pooled(ids.slice(0, maxThreads), 12, id => fetchThreadMeta(id, token)))
    .filter((m): m is ThreadMeta => m !== null)

  const batchResult = aggregateReplyHistory(metas, ownerEmails)

  // Merge into stored priors. Counts accumulate across invocations; derived values
  // are recomputed from totals rather than averaged, which would drift.
  const priorsCol = db.collection(`users/${uid}/priors`)
  let writes = 0
  for (let i = 0; i < batchResult.senders.length; i += 400) {
    const chunk = batchResult.senders.slice(i, i + 400)
    const existing = await Promise.all(chunk.map(s => priorsCol.doc(encodeURIComponent(s.senderEmail)).get()))
    const batch = db.batch()
    chunk.forEach((s, j) => {
      const prev = existing[j].exists ? (existing[j].data() as SenderPrior) : null
      batch.set(priorsCol.doc(encodeURIComponent(s.senderEmail)),
        { ...mergeSenderPriors(prev, s), updatedAt: Timestamp.now() }, { merge: true })
      writes++
    })
    await batch.commit()
  }

  const stats = {
    threadsProcessed: (state.stats?.threadsProcessed ?? 0) + metas.length,
    inboundThreads:   (state.stats?.inboundThreads   ?? 0) + batchResult.stats.inboundThreads,
    repliedThreads:   (state.stats?.repliedThreads   ?? 0) + batchResult.stats.repliedThreads,
    pagesFetched:     (state.stats?.pagesFetched     ?? 0) + pagesFetched,
  }
  const done = !pageToken
  await stateRef.set({
    pageToken: pageToken ?? null, done, months, ownerEmails,
    stats, updatedAt: Timestamp.now(),
    ...(done ? { completedAt: Timestamp.now() } : {}),
  }, { merge: true })

  return NextResponse.json({
    done,
    batch: { threads: metas.length, senders: batchResult.senders.length, priorsWritten: writes },
    stats,
    overallReplyRate: stats.inboundThreads ? stats.repliedThreads / stats.inboundThreads : 0,
    nextPageToken: pageToken ?? null,
  })
}
