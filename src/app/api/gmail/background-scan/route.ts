/**
 * POST /api/gmail/background-scan
 *
 * Processes email threads that changed since the user's stored watchHistoryId.
 * Called exclusively by the Cloud Function — not user-initiated.
 *
 * Design:
 *   The CF stays thin (Firestore + Pub/Sub only). All Gmail API interaction and
 *   AI classification happens here in Vercel, where the rest of the scan logic
 *   already lives. This avoids duplicating code in the functions directory.
 *
 *   Uses the same shared utilities as /api/gmail/scan:
 *     - getValidAccessToken  → consistent OAuth token handling + auto-refresh
 *     - classifyThread       → identical AI prompt and classification logic
 *     - buildThreadContext   → identical thread body construction
 *     - decodeBody           → identical HTML structured data extraction
 *
 * Body: { uid: string, newHistoryId: string }
 * Auth: x-keel-admin-secret header
 *
 * Resource budget:
 *   Max 10 threads per call. Typical cost: $0.0001–0.0005 per notification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { getValidAccessToken } from '@/lib/server/tokenUtils'
import { classifyThread, buildThreadContext, runInBatches } from '@/lib/scanUtils'
import { runCalendarCheck } from '@/lib/server/calendarCheck'
import { calcCost, PROVIDER_MODEL, getActiveProvider } from '@/lib/aiComplete'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_THREADS    = 10
const FB_READ_COST   = 0.06  / 100_000
const FB_WRITE_COST  = 0.18  / 100_000

// ── Firebase Admin ────────────────────────────────────────────────────────────

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

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorised(req: NextRequest): boolean {
  const secret = req.headers.get('x-keel-admin-secret')
  return Boolean(process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET)
}

// ── Gmail helpers ─────────────────────────────────────────────────────────────

function getHeader(msg: any, name: string): string {
  return (
    (msg.payload?.headers ?? []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  )
}

function parseFrom(from = ''): { senderName: string; senderEmail: string } {
  const m = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/)
  return {
    senderName:  m?.[1]?.trim() || from,
    senderEmail: m?.[2]?.trim() || from,
  }
}

function getThreadParticipants(thread: any): string[] {
  const messages = thread?.messages ?? []
  const seen     = new Set<string>()
  const names: string[] = []
  for (const msg of messages) {
    const from  = getHeader(msg, 'from')
    const match = from.match(/^(.*?)\s*<(.+?)>$/)
    const name  = match?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? from.split('@')[0]
    const email = match?.[2] ?? from
    if (email.includes('noreply') || email.includes('no-reply') || email.includes('notifications')) continue
    if (!seen.has(email)) { seen.add(email); names.push(name) }
  }
  return names.slice(0, 4)
}

async function fetchThread(accessToken: string, threadId: string): Promise<any | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) return null
  return res.json()
}

/**
 * Query Gmail History API for threads with new messages since lastHistoryId.
 * Returns empty array if the historyId is too old (404) — handled gracefully.
 */
async function getChangedThreadIds(
  accessToken:   string,
  lastHistoryId: string
): Promise<string[]> {
  try {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history')
    url.searchParams.set('startHistoryId', lastHistoryId)
    url.searchParams.set('historyTypes',   'messageAdded')
    url.searchParams.set('labelId',        'INBOX')
    url.searchParams.set('maxResults',     '100')

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!res.ok) {
      if (res.status === 404) {
        // historyId too old — Gmail only retains ~7 days of history
        console.warn('[background-scan] historyId expired — returning empty. Next manual scan will catch up.')
        return []
      }
      throw new Error(`Gmail History API returned ${res.status}`)
    }

    const data  = await res.json()
    const items = data.history ?? []
    const seen  = new Set<string>()

    for (const item of items) {
      for (const added of item.messagesAdded ?? []) {
        const threadId = added.message?.threadId
        if (threadId) seen.add(threadId)
      }
    }

    return Array.from(seen)
  } catch (err: any) {
    if (err?.message?.includes('404')) return []
    throw err
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

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

    // ── Read root doc (watch state) + account_primary (OAuth tokens) in parallel ──
    // Watch fields (autoScanEnabled, watchHistoryId) are on the root users/{uid} doc,
    // written by /api/inbox-watch. OAuth tokens are on account_primary.
    const [rootSnap, catsSnap, hintsSnap] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.collection(`users/${uid}/categories`).where('archived', '==', false).get(),
      db.collection(`users/${uid}/categoryHints`).limit(50).get(),
    ])
    fbReads += 1 + catsSnap.size + hintsSnap.size

    if (!rootSnap.exists) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const rootData = rootSnap.data()!

    // Guard: feature may have been disabled during the notification debounce window
    if (!rootData.autoScanEnabled) {
      return NextResponse.json({ skipped: true, reason: 'autoScanEnabled is false' })
    }

    // ── OAuth token — from account_primary via shared utility ──────────────────
    const accessToken = await getValidAccessToken(db, uid)
    if (!accessToken) {
      return NextResponse.json({ error: 'OAuth tokens unavailable — user must sign in again' }, { status: 401 })
    }

    // ── Advance cursor (always, even if history returns nothing) ───────────────
    // Write newHistoryId before calling the History API so concurrent CF invocations
    // can't both process the same batch. The cursor is always advanced regardless
    // of whether threads were found — prevents reprocessing on retry.
    const lastHistoryId = rootData.watchHistoryId as string | undefined

    await db.doc(`users/${uid}`).update({
      watchHistoryId:       newHistoryId,
      lastBackgroundScanAt: FieldValue.serverTimestamp(),
    })
    fbWrites++

    if (!lastHistoryId) {
      // First notification — cursor now seeded, nothing to process yet
      return NextResponse.json({ skipped: true, reason: 'Baseline historyId seeded' })
    }

    // ── Get changed thread IDs from Gmail History API ─────────────────────────
    const allChangedIds = await getChangedThreadIds(accessToken, lastHistoryId)
    if (allChangedIds.length === 0) {
      return NextResponse.json({ success: true, newItems: 0, updatedItems: 0, skippedItems: 0 })
    }

    const threadIds = allChangedIds.slice(0, MAX_THREADS)
    console.log(`[background-scan] uid=${uid} ${threadIds.length} threads to process (${allChangedIds.length} changed total)`)

    // ── Build category list for classifyThread ─────────────────────────────────
    const categories = catsSnap.docs.map(d => ({
      id:          d.id,
      name:        d.data().name as string,
      description: (d.data().description as string) || '',
    }))

    const hints = hintsSnap.docs.map(d => d.data() as {
      categoryId: string; categoryName: string
      senderEmail: string; senderName: string; subjectClue: string
    })

    const locale = rootData.locale ?? 'en-GB'
    const isUK   = locale.startsWith('en-GB') || locale.startsWith('en-AU') || locale.startsWith('en-NZ')

    // ── Check which threads already have Firestore items ──────────────────────
    const existingSnap = await db.collection(`users/${uid}/items`)
      .where('threadId', 'in', threadIds)
      .get()
    fbReads += existingSnap.size

    const existingByThreadId = new Map<string, { docId: string; internalDate: number; status: string; manualCategory: boolean }>()
    for (const doc of existingSnap.docs) {
      const d = doc.data()
      existingByThreadId.set(d.threadId, {
        docId:          doc.id,
        internalDate:   d.lastMessageInternalDate ?? 0,
        status:         d.status ?? '',
        manualCategory: d.manualCategory ?? false,
      })
    }

    // ── Fetch and classify threads ─────────────────────────────────────────────
    let newItems     = 0
    let updatedItems = 0
    let skippedItems = 0
    let totalInputTokens  = 0
    let totalOutputTokens = 0
    let totalAiCost       = 0

    const TERMINAL_STATUSES = new Set(['done', 'paid', 'archived'])

    // Process in batches of 5 — matches main scan concurrency
    await runInBatches(threadIds, 5, async (threadId: string) => {
      try {
        const thread = await fetchThread(accessToken, threadId)
        if (!thread) { skippedItems++; return }

        const messages = thread.messages ?? []
        if (messages.length === 0) { skippedItems++; return }

        const latest       = messages[messages.length - 1]
        const internalDate = parseInt(latest.internalDate ?? '0', 10)

        // Skip if this thread hasn't changed since we last processed it
        const existing = existingByThreadId.get(threadId)
        if (existing && existing.internalDate > 0 && internalDate <= existing.internalDate) {
          skippedItems++
          return
        }

        // Never re-process items the user has explicitly resolved
        if (existing && TERMINAL_STATUSES.has(existing.status)) {
          skippedItems++
          return
        }

        const first       = messages[0]
        const subject     = getHeader(first, 'subject') || '(no subject)'
        const from        = getHeader(first, 'from')
        const { senderName, senderEmail } = parseFrom(from)
        const receivedAt  = parseInt(first.internalDate ?? '0', 10)
        const participants = getThreadParticipants(thread)
        const threadBody  = buildThreadContext(thread)

        // Classify using the same shared function as the manual scan
        // If the item has a manually assigned category, pass a single-entry
        // categories list to preserve it (classifyThread still runs the full prompt)
        const classifyCategories = (existing?.manualCategory && existing.docId)
          ? categories  // classifyThread will see all categories; we guard the write below
          : categories

        const result = await classifyThread(
          db, subject, from, threadBody,
          classifyCategories, hints, isUK
        )

        if (!result) { skippedItems++; return }

        totalInputTokens  += result._usage?.inputTokens  ?? 0
        totalOutputTokens += result._usage?.outputTokens ?? 0
        totalAiCost       += 0 // calculated after loop using provider model

        const now     = Timestamp.now()
        const itemId  = existing?.docId ?? `item_${threadId.slice(0, 16)}`
        const effStatus = result.status === 'quietly_logged' ? 'quietly_logged' : result.status

        if (existing) {
          // Update existing item — never overwrite terminal status or manual category
          await db.doc(`users/${uid}/items/${itemId}`).update({
            aiTitle:           result.aiTitle,
            aiSummary:         result.aiSummary,
            aiDetailedSummary: result.aiDetailedSummary ?? '',
            aiImportanceScore: result.aiImportanceScore,
            participants,
            ...(!TERMINAL_STATUSES.has(existing.status) ? { status: effStatus } : {}),
            // Never overwrite a manually-assigned category
            ...(!existing.manualCategory ? {
              categoryId:   result.categoryId,
              categoryName: result.categoryName,
            } : {}),
            lastMessageInternalDate: internalDate,
            updatedAt:  now,
          })
          fbWrites++
          updatedItems++
        } else {
          // New item — full write
          await db.doc(`users/${uid}/items/${itemId}`).set({
            itemId,
            threadId,
            messageId:             latest.id ?? '',
            accountId:             'account_primary',
            senderEmail,
            senderName,
            subject,
            receivedAt:            Timestamp.fromMillis(receivedAt),
            categoryId:            result.categoryId,
            categoryName:          result.categoryName,
            subcategoryId:         null,
            subcategoryName:       null,
            status:                result.shouldProcess ? effStatus : 'quietly_logged',
            importanceFlag:        false,
            aiImportanceScore:     result.aiImportanceScore,
            manualPriority:        false,
            manuallyIgnored:       false,
            manualCategory:        false,
            userNote:              null,
            snoozedUntil:          null,
            linkedOutboundId:      null,
            linkedItemId:          null,
            isRecurring:           result.isRecurring,
            fromTrackedReply:      false,
            trackedReplyId:        null,
            mergedThreadIds:       [],
            lastMessageInternalDate: internalDate,
            participants,
            aiTitle:               result.aiTitle,
            aiSummary:             result.aiSummary,
            aiDetailedSummary:     result.aiDetailedSummary ?? '',
            createdAt:             now,
            updatedAt:             now,
            resolvedAt:            null,
          })
          fbWrites++

          // Write signals to subcollection — same as manual scan, so calendar check works
          if ((result.signals ?? []).length > 0) {
            const sigBatch = db.batch()
            for (const sig of result.signals) {
              const sigId = `sig_${threadId.slice(0, 12)}_${sig.type}`
              sigBatch.set(db.doc(`users/${uid}/signals/${sigId}`), {
                signalId:            sigId,
                itemId,
                accountId:           'account_primary',
                type:                sig.type,
                detectedDate:        sig.detectedDate ? Timestamp.fromDate(new Date(sig.detectedDate)) : null,
                detectedAmountPence: sig.detectedAmountPence ?? null,
                currency:            sig.currency ?? null,
                description:         sig.description,
                calendarStatus:      null,
                calendarEventId:     null,
                targetCalendarId:    null,
                matchedCalendarName: null,
                status:              'active',
                createdAt:           now,
                updatedAt:           now,
              }, { merge: true })
            }
            await sigBatch.commit()
            fbWrites += result.signals.length
          }

          newItems++
        }
      } catch (threadErr) {
        console.error(`[background-scan] thread ${threadId} failed:`, threadErr)
        skippedItems++
      }
    })

    // ── Cost tracking ──────────────────────────────────────────────────────────
    const activeProvider = await getActiveProvider(db)
    const activeModel    = PROVIDER_MODEL[activeProvider]
    totalAiCost          = calcCost(activeModel, totalInputTokens, totalOutputTokens)

    const fbCost    = fbReads * FB_READ_COST + fbWrites * FB_WRITE_COST
    const totalCost = totalAiCost + fbCost

    // ── Write scanRun doc ──────────────────────────────────────────────────────
    const durationMs = Date.now() - startTime
    await db.collection(`users/${uid}/scanRuns`).add({
      scanAt:           FieldValue.serverTimestamp(),
      job:              'background',
      daysBack:         0,
      threadsFound:     allChangedIds.length,
      threadsProcessed: newItems + updatedItems,
      newItems,
      updatedItems,
      skipped:          skippedItems,
      inputTokens:      totalInputTokens,
      outputTokens:     totalOutputTokens,
      aiCostUsd:        totalAiCost,
      fbReads,
      fbWrites,
      fbCostUsd:        fbCost,
      totalCostUsd:     totalCost,
      model:            activeModel,
      provider:         activeProvider,
      durationMs,
    })

    // ── Update meta/usage ──────────────────────────────────────────────────────
    await db.doc(`users/${uid}/meta/usage`).set(
      {
        backgroundScanRuns:          FieldValue.increment(1),
        backgroundScanCostUsd:       FieldValue.increment(totalAiCost),
        backgroundScanInputTokens:   FieldValue.increment(totalInputTokens),
        backgroundScanOutputTokens:  FieldValue.increment(totalOutputTokens),
        backgroundScanNewItems:      FieldValue.increment(newItems),
        backgroundScanUpdatedItems:  FieldValue.increment(updatedItems),
      },
      { merge: true }
    )

    // ── Calendar check — fire and forget ───────────────────────────────────────
    // Only worth running if we wrote new items with signals
    if (newItems > 0) {
      runCalendarCheck(db, uid, accessToken).catch(e =>
        console.warn('[background-scan] Cal check non-fatal:', e)
      )
    }

    console.log(
      `[background-scan] uid=${uid} new=${newItems} updated=${updatedItems} ` +
      `skipped=${skippedItems} cost=$${totalCost.toFixed(5)} ${durationMs}ms`
    )

    return NextResponse.json({
      success: true,
      newItems,
      updatedItems,
      skippedItems,
      aiCostUsd:    totalAiCost,
      totalCostUsd: totalCost,
      durationMs,
    })

  } catch (err: any) {
    console.error('[background-scan] fatal error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
