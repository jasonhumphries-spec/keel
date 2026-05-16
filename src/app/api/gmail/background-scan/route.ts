/**
 * POST /api/gmail/background-scan
 *
 * Processes email threads that changed since the user's stored historyId.
 * Called exclusively by the Cloud Function (handleGmailNotification).
 *
 * Uses classifyThread() from scanUtils.ts — identical prompt and scoring
 * to the manual scan route. Improvements to the prompt in scanUtils.ts
 * automatically apply here.
 *
 * Body: { uid: string, newHistoryId: string }
 * Auth: x-keel-admin-secret header
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { classifyThread, decodeBody, buildThreadContext } from '@/lib/scanUtils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Firebase Admin ─────────────────────────────────────────────────────────

function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    })
  }
  return getFirestore()
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_THREADS   = 10
const FB_READ_COST  = 0.06 / 100_000
const FB_WRITE_COST = 0.18 / 100_000

// ── Auth ───────────────────────────────────────────────────────────────────

function isAuthorised(req: NextRequest): boolean {
  return req.headers.get('x-keel-admin-secret') === process.env.ADMIN_SECRET
}

// ── Token helper ───────────────────────────────────────────────────────────

async function getValidAccessToken(
  db: ReturnType<typeof getFirestore>,
  uid: string
): Promise<string> {
  const accountRef = db.doc(`users/${uid}/accounts/account_primary`)
  const accountDoc = await accountRef.get()
  if (!accountDoc.exists) throw new Error(`account_primary not found for uid: ${uid}`)

  const data         = accountDoc.data()!
  const accessToken  = data.accessToken  as string | undefined
  const refreshToken = data.refreshToken as string | undefined
  const expiresAt    = (data.tokenExpiresAt as Timestamp | undefined)?.toMillis() ?? 0

  if (accessToken && Date.now() < expiresAt - 60_000) return accessToken

  if (!refreshToken) {
    // No way to get a fresh token — throw so the caller gets a clean error
    // rather than silently using an expired/empty token that will 401 on Gmail
    throw new Error('No refresh token — user must sign in again to re-grant Gmail access')
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })

  if (!tokenRes.ok) throw new Error(`Token refresh failed: ${await tokenRes.text()}`)

  const tokenData = await tokenRes.json()
  const newToken  = tokenData.access_token as string
  const expiresIn = (tokenData.expires_in  as number) ?? 3600

  await accountRef.update({
    accessToken:    newToken,
    tokenUpdatedAt: Timestamp.now(),
    tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
  })

  return newToken
}

// ── Gmail helpers ──────────────────────────────────────────────────────────

async function getChangedThreadIds(accessToken: string, lastHistoryId: string): Promise<string[]> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history')
  url.searchParams.set('startHistoryId', lastHistoryId)
  url.searchParams.set('historyTypes',   'messageAdded')
  url.searchParams.set('labelId',        'INBOX')
  url.searchParams.set('maxResults',     '100')

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
  if (res.status === 404) {
    // historyId too old — Gmail only keeps ~7 days. Treat as empty (next scan will catch up).
    console.warn('[background-scan] historyId expired (404) — no history to process')
    return []
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    throw new Error(`Gmail history.list failed: ${res.status} ${body}`)
  }

  const data = await res.json()
  const seen = new Set<string>()
  for (const item of data.history ?? []) {
    for (const added of item.messagesAdded ?? []) {
      if (added.message?.threadId) seen.add(added.message.threadId)
    }
  }
  return Array.from(seen)
}

async function fetchThread(accessToken: string, threadId: string): Promise<any | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return res.ok ? res.json() : null
}

function extractHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// decodeBody and buildThreadContext imported from @/lib/scanUtils

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const startTime = Date.now()

  try {
    const body = await req.json()
    const { uid, newHistoryId } = body as { uid: string; newHistoryId: string }
    if (!uid || !newHistoryId) {
      return NextResponse.json({ error: 'Missing uid or newHistoryId' }, { status: 400 })
    }

    const db = getAdminDb()
    let fbReads  = 0
    let fbWrites = 0

    // ── Load user data ─────────────────────────────────────────────────────
    const [rootDoc, catsSnap, hintsSnap] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.collection(`users/${uid}/categories`).where('archived', '==', false).get(),
      db.collection(`users/${uid}/categoryHints`).limit(50).get(),
    ])
    fbReads += 1 + catsSnap.size + hintsSnap.size

    if (!rootDoc.exists) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const rootData = rootDoc.data()!
    if (!rootData.autoScanEnabled) {
      return NextResponse.json({ skipped: true, reason: 'autoScanEnabled is false' })
    }

    // ── Advance cursor ─────────────────────────────────────────────────────
    const lastHistoryId = rootData.watchHistoryId as string | undefined
    await db.doc(`users/${uid}`).update({
      watchHistoryId:       newHistoryId,
      lastBackgroundScanAt: FieldValue.serverTimestamp(),
    })
    fbWrites++

    if (!lastHistoryId) {
      return NextResponse.json({ skipped: true, reason: 'Baseline historyId seeded' })
    }

    // ── Access token ───────────────────────────────────────────────────────
    let accessToken: string
    try {
      accessToken = await getValidAccessToken(db, uid)
      fbReads++
    } catch (err: any) {
      return NextResponse.json({ error: `Token error: ${err.message}` }, { status: 400 })
    }

    // ── Changed threads ────────────────────────────────────────────────────
    const allChangedIds = await getChangedThreadIds(accessToken, lastHistoryId)
    if (allChangedIds.length === 0) {
      return NextResponse.json({ success: true, newItems: 0, updatedItems: 0, skippedItems: 0 })
    }

    const threadIds = allChangedIds.slice(0, MAX_THREADS)

    // ── Classification context ─────────────────────────────────────────────
    const categories = catsSnap.docs.map(d => ({
      id:          d.id,
      name:        d.data().name        as string,
      description: (d.data().description as string) || '',
    }))
    const hints = hintsSnap.docs.map(d => d.data() as {
      categoryId: string; categoryName: string;
      senderEmail: string; senderName: string; subjectClue: string;
    })
    const locale       = rootData.locale ?? 'en-GB'
    const accountEmail  = ((await db.doc(`users/${uid}/accounts/account_primary`).get()).data()?.email as string ?? '').toLowerCase()
    const isUK   = locale.startsWith('en-GB') || locale.startsWith('en-AU') || locale.startsWith('en-NZ')

    // ── Existing items ─────────────────────────────────────────────────────
    const existingSnap = await db
      .collection(`users/${uid}/items`)
      .where('threadId', 'in', threadIds)
      .select('threadId', 'updatedAt', 'lastMessageInternalDate', 'manualPriority', 'manualCategory')
      .get()
    fbReads += existingSnap.size

    const threadToItemId       = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.id]))
    const threadToUpdatedAt    = new Map(existingSnap.docs.map(d => {
      const gmailTs = d.data().lastMessageInternalDate as number | undefined
      const keelTs  = d.data().updatedAt as Timestamp | undefined
      return [d.data().threadId as string, gmailTs ?? keelTs?.toMillis?.() ?? 0]
    }))
    const threadManualPrio     = new Map(existingSnap.docs.map(d => [d.data().threadId as string, !!d.data().manualPriority]))
    const threadManualCategory = new Map(existingSnap.docs.map(d => [d.data().threadId as string, !!d.data().manualCategory]))

    // ── Process threads ────────────────────────────────────────────────────
    let newItems = 0, updatedItems = 0, skippedItems = 0
    let totalInputTokens = 0, totalOutputTokens = 0, totalAiCost = 0

    for (const threadId of threadIds) {
      try {
        const thread   = await fetchThread(accessToken, threadId)
        if (!thread) { skippedItems++; continue }

        const messages = thread.messages ?? []
        if (!messages.length) { skippedItems++; continue }

        const latest       = messages[messages.length - 1]
        const internalDate = parseInt(latest.internalDate ?? '0', 10)
        const existingId   = threadToItemId.get(threadId)

        if (existingId && (threadToUpdatedAt.get(threadId) ?? 0) >= internalDate) {
          skippedItems++; continue
        }

        const first       = messages[0]
        const headers     = first.payload?.headers ?? []
        const subject     = extractHeader(headers, 'subject') || '(no subject)'
        const from        = extractHeader(headers, 'from')
        const fromMatch   = from.match(/^(.*?)\s*<(.+?)>$/)
        const senderName  = fromMatch?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? from.split('@')[0]
        const senderEmail = fromMatch?.[2] ?? from
        const receivedAt  = parseInt(first.internalDate ?? '0', 10)
        const threadBody  = buildThreadContext(thread)

        // ── S1: classifyThread — same function as manual scan ──────────────
        const isOutbound    = senderEmail.toLowerCase() === accountEmail
        // isSelfEmail: user emailed themselves — treat as a note/reminder, always process
        const isSelfEmail   = isOutbound && messages.length === 1 &&
          (messages[0].payload?.headers ?? []).some((h: any) =>
            h.name.toLowerCase() === 'to' && (h.value as string).toLowerCase().includes(accountEmail)
          )
        // ownerHasReplied: computed from message headers — blocks awaiting_reply on inbound-only threads
        const ownerHasReplied = messages.some((msg: any) => {
          const msgFrom = ((msg.payload?.headers ?? []) as any[]).find((h: any) => h.name.toLowerCase() === 'from')?.value ?? ''
          return msgFrom.toLowerCase().includes(accountEmail)
        })
        const classification = await classifyThread(db, subject, from, threadBody, categories, hints, isUK, isOutbound, ownerHasReplied)
        // Self-emails and outbound threads are always worth storing — never skip them
        // even if the AI returns shouldProcess=false
        if (!classification || (!classification.shouldProcess && !isOutbound)) { skippedItems++; continue }

        totalInputTokens  += classification._usage?.inputTokens  ?? 0
        totalOutputTokens += classification._usage?.outputTokens ?? 0
        // Cost derived from tokens at Gemini Flash rates (active provider)
        totalAiCost += ((classification._usage?.inputTokens  ?? 0) / 1_000_000 * 0.15)
                     + ((classification._usage?.outputTokens ?? 0) / 1_000_000 * 0.60)

        const itemData: Record<string, any> = {
          threadId,
          accountId:               'account_primary',
          senderName,
          senderEmail,
          subject,
          receivedAt:              Timestamp.fromMillis(receivedAt),
          status:                  classification.status            ?? 'new',
          aiTitle:                 classification.aiTitle           ?? subject,
          aiSummary:               classification.aiSummary         ?? '',
          aiDetailedSummary:       classification.aiDetailedSummary ?? '',
          aiImportanceScore:       classification.aiImportanceScore ?? 0.5,
          signals:                 Array.isArray(classification.signals) ? classification.signals : [],
          isRecurring:             classification.isRecurring        ?? false,
          updatedAt:               Timestamp.fromMillis(internalDate),
          lastMessageInternalDate: internalDate,
          lastProcessedBy:         'background',
        }

        if (!threadManualCategory.get(threadId)) {
          itemData.categoryId   = classification.categoryId   ?? 'cat_other'
          itemData.categoryName = classification.categoryName ?? 'Other'
        }
        if (threadManualPrio.get(threadId)) {
          delete itemData.aiImportanceScore
        }

        if (existingId) {
          await db.doc(`users/${uid}/items/${existingId}`).update(itemData)
          updatedItems++
        } else {
          const itemId = `${threadId}_${uid}`
          await db.doc(`users/${uid}/items/${itemId}`).set({
            ...itemData,
            itemId,
            messageId: latest.id ?? '',
            createdAt: FieldValue.serverTimestamp(),
          })
          newItems++
        }
        fbWrites++

      } catch (threadErr) {
        console.error(`[background-scan] thread ${threadId} failed:`, threadErr)
        skippedItems++
      }
    }

    const durationMs = Date.now() - startTime
    const fbCost     = fbReads * FB_READ_COST + fbWrites * FB_WRITE_COST
    const totalCost  = totalAiCost + fbCost

    // ── Write scanRun + update meta/usage ──────────────────────────────────
    await Promise.all([
      db.collection(`users/${uid}/scanRuns`).add({
        scanAt: FieldValue.serverTimestamp(), job: 'background', daysBack: 0,
        threadsFound: allChangedIds.length, threadsProcessed: newItems + updatedItems,
        newItems, updatedItems, skipped: skippedItems,
        inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        aiCostUsd: totalAiCost, fbReads, fbWrites, fbCostUsd: fbCost,
        totalCostUsd: totalCost, model: 'gemini-2.5-flash', provider: 'gemini-flash', durationMs,
      }),
      db.doc('meta/usage').set({
        backgroundScanRuns:         FieldValue.increment(1),
        backgroundScanCostUsd:      FieldValue.increment(totalAiCost),
        backgroundScanInputTokens:  FieldValue.increment(totalInputTokens),
        backgroundScanOutputTokens: FieldValue.increment(totalOutputTokens),
        backgroundScanNewItems:     FieldValue.increment(newItems),
        backgroundScanUpdatedItems: FieldValue.increment(updatedItems),
      }, { merge: true }),
    ])

    console.log(`[background-scan] uid=${uid} new=${newItems} updated=${updatedItems} skipped=${skippedItems} cost=$${totalCost.toFixed(5)} ${durationMs}ms`)

    return NextResponse.json({ success: true, newItems, updatedItems, skippedItems, aiCostUsd: totalAiCost, totalCostUsd: totalCost, durationMs })

  } catch (err: any) {
    console.error('[background-scan] fatal error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
