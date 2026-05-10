/**
 * POST /api/gmail/background-scan
 *
 * Processes email threads that changed since the user's stored historyId.
 * Called exclusively by the Cloud Function — not user-initiated.
 *
 * Design philosophy:
 *   The CF stays thin (Firestore + HTTP only). All Gmail API interaction and
 *   AI classification happens here, in Vercel, where the rest of the scan
 *   logic already lives. This avoids duplicating AI code in the functions dir.
 *
 * Body: { uid: string, newHistoryId: string }
 * Auth: x-keel-admin-secret header
 *
 * Resource budget:
 *   Max 10 threads per call. Typical cost: $0.0001–0.0005 per notification.
 *   Comparable to a single manual scan button press on a quiet inbox.
 *
 * TODO: extract shared S1 logic into src/lib/scanUtils.ts once the codebase
 * is stable, so /api/gmail/scan and this route share one implementation.
 */

import { NextRequest, NextResponse } from 'next/server'
import * as admin from 'firebase-admin'
import { google } from 'googleapis'
import { adminDb } from '@/lib/firebaseAdmin'
import { aiComplete } from '@/lib/aiComplete'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_THREADS = 10
const FB_READ_COST = 0.00000036
const FB_WRITE_COST = 0.00000108

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isAuthorised(req: NextRequest): boolean {
  const secret = req.headers.get('x-keel-admin-secret')
  return Boolean(process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET)
}

// ---------------------------------------------------------------------------
// Gmail helpers
// ---------------------------------------------------------------------------

function buildGmailClient(accessToken: string, refreshToken: string) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken })
  return google.gmail({ version: 'v1', auth })
}

function extractText(payload: any, limit = 800): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8').slice(0, limit)
  }
  for (const part of payload.parts ?? []) {
    const t = extractText(part, limit)
    if (t) return t
  }
  return ''
}

function buildThreadBody(messages: any[]): string {
  return messages
    .map((msg, i) => {
      const limit = i >= messages.length - 2 ? 600 : 200
      return extractText(msg.payload, limit)
    })
    .filter(Boolean)
    .join('\n---\n')
}

function parseFrom(from = '') {
  const m = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/)
  return { senderName: m?.[1]?.trim() || from, senderEmail: m?.[2]?.trim() || from }
}

function getHeader(msg: any, name: string): string {
  return (
    (msg.payload?.headers ?? []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  )
}

/**
 * Query Gmail History API for threads with new messages since lastHistoryId.
 * Returns empty array if the historyId is too old (404) — handled gracefully.
 */
async function getChangedThreadIds(
  gmail: ReturnType<typeof google.gmail>,
  lastHistoryId: string
): Promise<string[]> {
  try {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: lastHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      maxResults: 100,
    })

    const items = res.data.history ?? []
    const seen = new Set<string>()

    for (const item of items) {
      for (const added of item.messagesAdded ?? []) {
        const threadId = added.message?.threadId
        if (threadId) seen.add(threadId)
      }
    }

    return Array.from(seen)
  } catch (err: any) {
    if (err?.code === 404 || err?.status === 404) {
      // historyId too old — Gmail only keeps ~7 days of history
      console.warn(`[background-scan] historyId expired — returning empty. Next manual scan will catch up.`)
      return []
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// S1 Classification
// ---------------------------------------------------------------------------

/**
 * Run Stage 1 AI classification on one thread.
 * Uses aiComplete() which reads the active provider from Firestore (/config/aiProvider).
 * Background scans therefore use the same model as manual scans automatically.
 *
 * NOTE: Align this prompt with the one in /api/gmail/scan/route.ts when you
 * extract shared logic to scanUtils.ts.
 */
async function runS1(params: {
  subject: string
  senderName: string
  senderEmail: string
  body: string
  categoryContext: string
  locale: string
  categoryHints: string
}) {
  const { subject, senderName, senderEmail, body, categoryContext, locale, categoryHints } = params
  const isGB = locale === 'en-GB'

  const prompt = `You are Keel, an AI email organiser. Classify this email thread and extract all signals.

THREAD
From: ${senderName} <${senderEmail}>
Subject: ${subject}

${body}

AVAILABLE CATEGORIES
${categoryContext}

${categoryHints ? `USER CORRECTIONS (follow these)\n${categoryHints}\n` : ''}

Respond ONLY in JSON (no markdown fences):
{
  "categoryId": "<id from list, or \\"other\\">",
  "status": "new|awaiting_action|awaiting_reply|quietly_logged",
  "aiTitle": "<concise title max 8 words${isGB ? ', British English' : ''}>",
  "aiSummary": "<one sentence>",
  "aiDetailedSummary": "<2–4 bullet points starting with •>",
  "aiImportanceScore": <0.0–1.0>,
  "isRecurring": <true|false>,
  "signals": [
    { "type": "event|payment|rsvp|action|info|awaiting_reply", "date": "<ISO date or null>", "amount": <number or null>, "description": "<short>" }
  ]
}`

  const result = await aiComplete({ prompt, maxTokens: 700 })

  let parsed: Record<string, any> = {}
  try {
    const clean = result.text.replace(/^```json\n?|```$/gm, '').trim()
    parsed = JSON.parse(clean)
  } catch {
    console.error('[background-scan] S1 parse error. Raw:', result.text.slice(0, 300))
  }

  return { ...parsed, usage: result.usage }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

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

    let fbReads = 0
    let fbWrites = 0

    // ── Fetch account + hints ──────────────────────────────────────────────
    const [accountDoc, hintsSnap] = await Promise.all([
      adminDb.doc(`users/${uid}`).get(),
      adminDb.collection(`users/${uid}/categoryHints`).limit(50).get(),
    ])
    fbReads += 1 + hintsSnap.size

    if (!accountDoc.exists) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const account = accountDoc.data()!

    // Guard: feature may have been disabled during the debounce window
    if (!account.autoScanEnabled) {
      return NextResponse.json({ skipped: true, reason: 'autoScanEnabled is false' })
    }

    // ── OAuth tokens ───────────────────────────────────────────────────────
    // Adjust field names to match your actual Firestore schema.
    // Common patterns: googleAccessToken / googleRefreshToken on account doc,
    // or accessToken / refreshToken in users/{uid}/tokens/gmail subcollection.
    const accessToken = account.googleAccessToken ?? account.accessToken
    const refreshToken = account.googleRefreshToken ?? account.refreshToken

    if (!accessToken || !refreshToken) {
      return NextResponse.json({ error: 'OAuth tokens not found on account doc' }, { status: 400 })
    }

    const gmail = buildGmailClient(accessToken, refreshToken)

    // ── Advance cursor (always, even on empty results) ─────────────────────
    // We update watchHistoryId to newHistoryId regardless of what we find.
    // If historyId is stale (404 from History API), we still advance so the
    // next notification has a fresh baseline.
    const lastHistoryId = account.watchHistoryId
    await adminDb.doc(`users/${uid}`).update({
      watchHistoryId: newHistoryId,
      lastBackgroundScanAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    fbWrites++

    if (!lastHistoryId) {
      // First notification — no baseline cursor yet. Cursor now seeded.
      return NextResponse.json({ skipped: true, reason: 'Baseline historyId seeded' })
    }

    // ── Get changed threads ────────────────────────────────────────────────
    const allChangedIds = await getChangedThreadIds(gmail, lastHistoryId)
    if (allChangedIds.length === 0) {
      return NextResponse.json({ success: true, newItems: 0, updatedItems: 0, skippedItems: 0 })
    }

    const threadIds = allChangedIds.slice(0, MAX_THREADS)

    // ── Category context ───────────────────────────────────────────────────
    const categoryIds: string[] = account.categoryIds ?? []
    const categoryDescriptions: Record<string, string> = account.categoryDescriptions ?? {}
    const categoryContext = categoryIds
      .map(id => `${id}: ${categoryDescriptions[id] || '(built-in)'}`)
      .join('\n')

    const categoryHints = hintsSnap.docs.map(d => `- ${d.data().hint}`).join('\n')

    // ── Check existing Firestore items for these threads ───────────────────
    const existingSnap = await adminDb
      .collection(`users/${uid}/items`)
      .where('threadId', 'in', threadIds)
      .get()
    fbReads += existingSnap.size

    const existingByThreadId = new Map<string, { docId: string; updatedAt: any }>()
    for (const doc of existingSnap.docs) {
      const d = doc.data()
      existingByThreadId.set(d.threadId, { docId: doc.id, updatedAt: d.updatedAt })
    }

    // ── Process threads ────────────────────────────────────────────────────
    let newItems = 0
    let updatedItems = 0
    let skippedItems = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalAiCost = 0

    for (const threadId of threadIds) {
      try {
        const threadRes = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        })

        const thread = threadRes.data
        const messages = thread.messages ?? []
        if (messages.length === 0) { skippedItems++; continue }

        const latest = messages[messages.length - 1]
        const internalDate = parseInt(latest.internalDate ?? '0', 10)

        // Skip if this thread hasn't changed since we last processed it
        const existing = existingByThreadId.get(threadId)
        if (existing?.updatedAt) {
          const storedMs = existing.updatedAt.toMillis?.() ?? (existing.updatedAt * 1000)
          if (storedMs >= internalDate) { skippedItems++; continue }
        }

        const first = messages[0]
        const subject = getHeader(first, 'subject') || '(no subject)'
        const { senderName, senderEmail } = parseFrom(getHeader(first, 'from'))
        const receivedAt = parseInt(first.internalDate ?? '0', 10)
        const threadBody = buildThreadBody(messages)

        const s1 = await runS1({
          subject,
          senderName,
          senderEmail,
          body: threadBody,
          categoryContext,
          locale: account.locale ?? 'en-GB',
          categoryHints,
        })

        totalInputTokens += s1.usage?.inputTokens ?? 0
        totalOutputTokens += s1.usage?.outputTokens ?? 0
        totalAiCost += s1.usage?.costUsd ?? 0

        const itemData = {
          threadId,
          accountId: uid,
          senderName,
          senderEmail,
          subject,
          receivedAt: admin.firestore.Timestamp.fromMillis(receivedAt),
          categoryId: s1.categoryId ?? 'other',
          status: s1.status ?? 'new',
          aiTitle: s1.aiTitle ?? subject,
          aiSummary: s1.aiSummary ?? '',
          aiDetailedSummary: typeof s1.aiDetailedSummary === 'string' ? s1.aiDetailedSummary : '',
          aiImportanceScore: s1.aiImportanceScore ?? 0.5,
          signals: Array.isArray(s1.signals) ? s1.signals : [],
          isRecurring: s1.isRecurring ?? false,
          updatedAt: admin.firestore.Timestamp.fromMillis(internalDate),
          lastProcessedBy: 'background',
        }

        if (existing) {
          await adminDb.doc(`users/${uid}/items/${existing.docId}`).update(itemData)
          updatedItems++
        } else {
          await adminDb.collection(`users/${uid}/items`).add({
            ...itemData,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
    const fbCost = fbReads * FB_READ_COST + fbWrites * FB_WRITE_COST
    const totalCost = totalAiCost + fbCost

    // ── Write scanRun doc ──────────────────────────────────────────────────
    await adminDb.collection(`users/${uid}/scanRuns`).add({
      scanAt: admin.firestore.FieldValue.serverTimestamp(),
      job: 'background',
      daysBack: 0,
      threadsFound: allChangedIds.length,
      threadsProcessed: newItems + updatedItems,
      newItems,
      updatedItems,
      skipped: skippedItems,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      aiCostUsd: totalAiCost,
      fbReads,
      fbWrites,
      fbCostUsd: fbCost,
      totalCostUsd: totalCost,
      model: account.aiProvider ?? 'gemini-2.5-flash',
      provider: account.aiProvider ?? 'gemini',
      durationMs,
    })

    // ── Update meta/usage ─────────────────────────────────────────────────
    await adminDb.doc('meta/usage').set(
      {
        backgroundScanRuns: admin.firestore.FieldValue.increment(1),
        backgroundScanCostUsd: admin.firestore.FieldValue.increment(totalAiCost),
        backgroundScanInputTokens: admin.firestore.FieldValue.increment(totalInputTokens),
        backgroundScanOutputTokens: admin.firestore.FieldValue.increment(totalOutputTokens),
        backgroundScanNewItems: admin.firestore.FieldValue.increment(newItems),
        backgroundScanUpdatedItems: admin.firestore.FieldValue.increment(updatedItems),
      },
      { merge: true }
    )

    console.log(
      `[background-scan] uid=${uid} new=${newItems} updated=${updatedItems} ` +
      `skipped=${skippedItems} cost=$${totalCost.toFixed(5)} ${durationMs}ms`
    )

    return NextResponse.json({
      success: true,
      newItems,
      updatedItems,
      skippedItems,
      aiCostUsd: totalAiCost,
      totalCostUsd: totalCost,
      durationMs,
    })
  } catch (err: any) {
    console.error('[background-scan] fatal error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
