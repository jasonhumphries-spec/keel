/**
 * backfillRunner.ts — the reply-history walk, callable from anywhere.
 *
 * Extracted from /api/gmail/backfill-priors so onboarding and the nightly cron can run
 * it directly instead of an HTTP hop into our own API. Keeping one implementation is
 * deliberate: a second copy is how functions/src/scan.ts ended up months out of date
 * and how the Ignored page silently swallowed four new fields.
 *
 * See docs/relevance-brain-design.md §5.
 */

import type { Firestore } from 'firebase-admin/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import { getValidAccessToken } from '@/lib/server/tokenUtils'
import {
  aggregateReplyHistory, mergeSenderPriors, parseAddress,
  type ThreadMeta, type SenderPrior,
} from '@/lib/server/replyHistory'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Threads dropped because Gmail refused them. Tracked, never silently ignored:
 *  a dropped thread is a missing data point, and a rate-limited run that quietly
 *  discarded a third of its threads would produce confident, wrong priors. */
const failures = { rateLimited: 0, other: 0 }
/** status -> count, plus one sample body per status, so a failing run says WHY. */
const failureDetail: Record<string, { n: number; sample?: string }> = {}

/** Pull the metadata we need for one thread. Bodies are never requested.
 *  Retries on 429/5xx with backoff — Gmail allows 250 quota units per user per
 *  second and a threads.get costs 5, so a burst can legitimately be throttled. */
async function fetchThreadMeta(
  threadId: string,
  tok: { value: string; refresh: () => Promise<string | null> },
  attempt = 0,
): Promise<ThreadMeta | null> {
  const token = tok.value
  const url = `${GMAIL}/threads/${threadId}`
    + `?format=metadata&metadataHeaders=From&metadataHeaders=Date`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    // Gmail signals per-user throttling as 403 userRateLimitExceeded, NOT 429.
    // Treating 403 as fatal silently discarded 38% of threads on the first full run.
    let body = ''
    try { body = (await res.clone().text()).slice(0, 300) } catch { /* ignore */ }
    // A full walk can outlive its own OAuth token: getValidAccessToken only
    // refreshes with under 2 minutes left, so a run starting at minute 58 dies
    // partway through. Refresh once and retry rather than dropping the thread.
    if (res.status === 401 && attempt < 6) {
      const fresh = await tok.refresh()
      if (fresh) return fetchThreadMeta(threadId, tok, attempt + 1)
    }
    const throttled = res.status === 429
      || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body))
    const key = `${res.status}${throttled ? ' (throttled)' : ''}`
    if (!failureDetail[key]) failureDetail[key] = { n: 0, sample: body.slice(0, 160) }
    failureDetail[key].n++
    if ((throttled || res.status >= 500) && attempt < 6) {
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt) + Math.random() * 400))
      return fetchThreadMeta(threadId, tok, attempt + 1)
    }
    if (throttled) failures.rateLimited++; else failures.other++
    return null
  }
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


export interface BackfillOptions {
  months?:     number
  maxThreads?: number
  reset?:      boolean
  dryRun?:     boolean
  query?:      string
}

/**
 * Walk one slice of a user's Gmail history and merge the result into their priors.
 *
 * Cursor-resumable: state lives in users/{uid}/brain/backfillState, so a bounded slice
 * can run during onboarding and the nightly sweep finishes the rest. Returns a plain
 * object; the route wraps it in a response.
 */
export async function runBackfillSlice(
  db: Firestore,
  uid: string,
  opts: BackfillOptions = {},
): Promise<Record<string, unknown>> {
  const { months = 12, maxThreads = 400, reset = false, dryRun = false, query } = opts
  failures.rateLimited = 0; failures.other = 0
  for (const k of Object.keys(failureDetail)) delete failureDetail[k]
  const stateRef = db.doc(`users/${uid}/brain/backfillState`)
  if (reset && !dryRun) await stateRef.set({}, { merge: false })
  const state = dryRun ? {} : ((await stateRef.get()).data() ?? {})
  if (state.done) {
    return ({ done: true, note: 'already complete — pass reset:true to redo', stats: state.stats ?? null })
  }

  const token = await getValidAccessToken(db, uid)
  if (!token) return ({ error: 'no valid Gmail token for user' })

  // Shared, refreshable token. A single in-flight refresh is reused so a burst of
  // concurrent 401s does not stampede the token endpoint.
  let refreshing: Promise<string | null> | null = null
  const tok = {
    value: token,
    refresh: async () => {
      if (!refreshing) {
        refreshing = getValidAccessToken(db, uid, true).then(t => {
          if (t) tok.value = t
          refreshing = null
          return t
        }).catch(() => { refreshing = null; return null })
      }
      return refreshing
    },
  }

  // Every address the owner sends as. Without this, their own replies read as
  // inbound mail and every sender's reply rate collapses to zero.
  const root = (await db.doc(`users/${uid}`).get()).data() ?? {}
  const acct = (await db.doc(`users/${uid}/accounts/account_primary`).get()).data() ?? {}
  const ownerEmails = [...new Set([root.email, acct.emailAddress, acct.email].filter(Boolean).map((e: string) => e.toLowerCase()))]
  if (ownerEmails.length === 0) {
    return ({ error: 'could not determine owner email' })
  }

  // List thread ids. `newer_than` keeps the walk bounded; -in:chats drops Hangouts.
  const listUrl = new URL(`${GMAIL}/threads`)
  // `query` overrides the default window — used to sanity-check reply detection
  // against threads known to contain a reply (e.g. `in:sent`), and to scope a run.
  listUrl.searchParams.set('q', query ?? `newer_than:${months}m -in:chats`)
  listUrl.searchParams.set('maxResults', '100')
  if (state.pageToken) listUrl.searchParams.set('pageToken', state.pageToken)

  const ids: string[] = []
  let pageToken: string | undefined = state.pageToken
  let pagesFetched = 0
  while (ids.length < maxThreads) {
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken)
    const res = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      return ({ error: `gmail threads.list ${res.status}`, detail: await res.text() })
    }
    const page = await res.json()
    ids.push(...(page.threads ?? []).map((t: { id: string }) => t.id))
    pagesFetched++
    pageToken = page.nextPageToken
    if (!pageToken) break
  }

  const metas = (await pooled(ids.slice(0, maxThreads), 6, id => fetchThreadMeta(id, tok)))
    .filter((m): m is ThreadMeta => m !== null)

  const batchResult = aggregateReplyHistory(metas, ownerEmails)

  // Merge into stored priors. Counts accumulate across invocations; derived values
  // are recomputed from totals rather than averaged, which would drift.
  const priorsCol = db.collection(`users/${uid}/priors`)
  let writes = 0
  for (let i = 0; !dryRun && i < batchResult.senders.length; i += 400) {
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
  if (dryRun) {
    // Report enough to judge whether the reply rates look like real behaviour
    // before a single prior is written.
    const top = (xs: SenderPrior[]) => xs.slice(0, 25).map(x => ({
      sender: x.senderEmail, in: x.inboundThreads, replied: x.repliedThreads,
      rate: +x.replyRate.toFixed(2), smoothed: +x.smoothedReplyRate.toFixed(2),
      medianH: x.medianLatencyHours === null ? null : +x.medianLatencyHours.toFixed(1),
      fast: x.fastReplies,
    }))
    const answered = batchResult.senders.filter(s => s.repliedThreads > 0)
    return ({
      dryRun: true, wrote: 'nothing',
      ownerEmails,
      batch: { threadsListed: ids.length, threadsFetched: metas.length,
               dropped: failures.rateLimited + failures.other, failures: { ...failures },
               failureDetail: { ...failureDetail },
               distinctSenders: batchResult.senders.length, answeredSenders: answered.length },
      stats: batchResult.stats,
      byVolume: top(batchResult.senders),
      byEngagement: top([...answered].sort((a, b) =>
        b.smoothedReplyRate - a.smoothedReplyRate || b.inboundThreads - a.inboundThreads)),
      neverAnswered: batchResult.senders.filter(s => s.repliedThreads === 0 && s.inboundThreads >= 3)
        .slice(0, 15).map(s => ({ sender: s.senderEmail, in: s.inboundThreads })),
      topDomains: batchResult.domains.slice(0, 12).map(d => ({
        domain: d.domain, in: d.inboundThreads, replied: d.repliedThreads,
        smoothed: +d.smoothedReplyRate.toFixed(2) })),
      hasMorePages: !!pageToken,
    })
  }

  await stateRef.set({
    pageToken: pageToken ?? null, done, months, ownerEmails,
    stats, updatedAt: Timestamp.now(),
    ...(done ? { completedAt: Timestamp.now() } : {}),
  }, { merge: true })

  return ({
    done,
    batch: { threads: metas.length, dropped: failures.rateLimited + failures.other,
             failures: { ...failures }, senders: batchResult.senders.length, priorsWritten: writes },
    stats,
    overallReplyRate: stats.inboundThreads ? stats.repliedThreads / stats.inboundThreads : 0,
    nextPageToken: pageToken ?? null,
  })
}
