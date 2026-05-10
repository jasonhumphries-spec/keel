/**
 * POST /api/gmail/background-scan
 *
 * Processes email threads that changed since the user's stored historyId.
 * Called exclusively by the Cloud Function (handleGmailNotification) — not user-initiated.
 *
 * Body: { uid: string, newHistoryId: string }
 * Auth: x-keel-admin-secret header
 *
 * Resource budget: max 10 threads per call, ~$0.0001–0.0005 per notification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'

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

const MAX_THREADS    = 10
const FB_READ_COST   = 0.06  / 100_000
const FB_WRITE_COST  = 0.18  / 100_000

// ── Auth ───────────────────────────────────────────────────────────────────

function isAuthorised(req: NextRequest): boolean {
  return req.headers.get('x-keel-admin-secret') === process.env.ADMIN_SECRET
}

// ── Token helpers ──────────────────────────────────────────────────────────

/**
 * Gets a valid access token for the user — refreshes if needed.
 * Tokens are stored at users/{uid}/accounts/account_primary.
 */
async function getValidAccessToken(
  db: ReturnType<typeof getFirestore>,
  uid: string
): Promise<string> {
  const accountRef = db.doc(`users/${uid}/accounts/account_primary`)
  const accountDoc = await accountRef.get()

  if (!accountDoc.exists) throw new Error(`account_primary not found for uid: ${uid}`)

  const data = accountDoc.data()!
  const accessToken   = data.accessToken  as string | undefined
  const refreshToken  = data.refreshToken as string | undefined
  const tokenExpiresAt = data.tokenExpiresAt as Timestamp | undefined

  if (!accessToken) throw new Error('No accessToken on account_primary')

  // Check if token is still valid (with 60s buffer)
  const expiresMs = tokenExpiresAt?.toMillis() ?? 0
  if (Date.now() < expiresMs - 60_000) return accessToken

  // Token expired or expiry unknown — attempt refresh
  if (!refreshToken) {
    // No refresh token — return current token and hope for the best;
    // the Gmail call will 401 and be caught by the caller
    console.warn(`[background-scan] No refreshToken for uid=${uid}, using potentially stale accessToken`)
    return accessToken
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

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    throw new Error(`Token refresh failed: ${err}`)
  }

  const tokenData    = await tokenRes.json()
  const newToken     = tokenData.access_token as string
  const expiresIn    = (tokenData.expires_in as number) ?? 3600

  // Persist the refreshed token
  await accountRef.update({
    accessToken:    newToken,
    tokenUpdatedAt: Timestamp.now(),
    tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
  })

  console.log(`[background-scan] Refreshed access token for uid=${uid}`)
  return newToken
}

// ── Gmail helpers (using fetch — no googleapis package in keel) ────────────

async function getChangedThreadIds(
  accessToken: string,
  lastHistoryId: string
): Promise<string[]> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history')
  url.searchParams.set('startHistoryId', lastHistoryId)
  url.searchParams.set('historyTypes',   'messageAdded')
  url.searchParams.set('labelId',        'INBOX')
  url.searchParams.set('maxResults',     '100')

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (res.status === 404) {
    // historyId too old — Gmail keeps ~7 days of history
    console.warn('[background-scan] historyId expired — no threads returned')
    return []
  }
  if (!res.ok) {
    throw new Error(`Gmail history.list failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json()
  const seen = new Set<string>()

  for (const item of data.history ?? []) {
    for (const added of item.messagesAdded ?? []) {
      const threadId = added.message?.threadId
      if (threadId) seen.add(threadId)
    }
  }

  return Array.from(seen)
}

async function fetchThread(accessToken: string, threadId: string): Promise<any | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) return null
  return res.json()
}

function extractHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBody(message: any): string {
  const parts = message.payload?.parts ?? [message.payload]
  for (const part of parts) {
    if (part?.mimeType === 'text/plain' && part?.body?.data) {
      const text = Buffer.from(part.body.data, 'base64').toString('utf-8').slice(0, 2000)
      if (text.trim().length > 20) return text
    }
  }
  for (const part of parts) {
    if (part?.mimeType === 'text/html' && part?.body?.data) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf-8')
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
    }
  }
  return ''
}

function buildThreadContext(thread: any): string {
  const messages = thread?.messages ?? []
  return messages.map((msg: any, i: number) => {
    const headers = msg.payload?.headers ?? []
    const from    = extractHeader(headers, 'from')
    const date    = extractHeader(headers, 'date')
    const isRecent = i >= messages.length - 3
    const body    = decodeBody(msg).slice(0, isRecent ? 800 : 200)
    return `[${date}] From: ${from}\n${body}`
  }).filter(Boolean).join('\n---\n')
}

function parseFrom(from = '') {
  const m = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/)
  return { senderName: m?.[1]?.trim() || from, senderEmail: m?.[2]?.trim() || from }
}

// ── S1 Classification ──────────────────────────────────────────────────────

async function runS1(
  db: ReturnType<typeof getFirestore>,
  params: {
    subject: string
    senderName: string
    senderEmail: string
    body: string
    categories: { id: string; name: string; description: string }[]
    hints: { categoryId: string; categoryName: string; senderEmail: string; aiTitle: string }[]
    locale: string
  }
): Promise<Record<string, any>> {
  const { subject, senderName, senderEmail, body, categories, hints, locale } = params
  const isGB = locale.startsWith('en-GB') || locale.startsWith('en-AU')

  const categoryList = categories
    .map(c => `- ${c.id} (${c.name})${c.description ? ': ' + c.description : ''}`)
    .join('\n')

  const hintLines = hints.length > 0
    ? hints.slice(0, 20).map(h =>
        `  Sender "${h.senderEmail}" → category "${h.categoryName}" (example: "${h.aiTitle}")`
      ).join('\n')
    : ''

  const prompt = `You are Keel, an AI email organiser. Classify this Gmail thread.

FROM: ${senderName} <${senderEmail}>
SUBJECT: ${subject}

THREAD CONTENT:
${body}

CATEGORIES:
${categoryList}

${hintLines ? `USER CORRECTIONS — follow these:\n${hintLines}\n` : ''}

Reply ONLY with valid JSON (no markdown fences):
{
  "categoryId": "<exact id from list above, or \\"cat_other\\">",
  "status": "new|awaiting_action|awaiting_reply|quietly_logged",
  "aiTitle": "<concise title, max 8 words${isGB ? ', British English' : ''}>",
  "aiSummary": "<one sentence summary>",
  "aiDetailedSummary": "<2-4 bullet points starting with •>",
  "aiImportanceScore": <0.0 to 1.0>,
  "isRecurring": <true|false>,
  "signals": [
    { "type": "event|payment|rsvp|action|info|awaiting_reply", "date": "<ISO or null>", "amount": <number or null>, "description": "<short label>" }
  ]
}`

  // aiComplete signature: (db, prompt, maxTokens) → { text, inputTokens, outputTokens, model, costUsd }
  const result = await aiComplete(db, prompt, 700)

  let parsed: Record<string, any> = {}
  try {
    const clean = result.text.replace(/^```json\n?|```$/gm, '').trim()
    parsed = JSON.parse(clean)
  } catch {
    console.error('[background-scan] S1 JSON parse error. Raw:', result.text.slice(0, 200))
  }

  return {
    ...parsed,
    inputTokens:  result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd:      result.costUsd,
    model:        result.model,
  }
}

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

    if (!rootDoc.exists) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const rootData = rootDoc.data()!

    // Guard: user may have disabled the feature during debounce window
    if (!rootData.autoScanEnabled) {
      return NextResponse.json({ skipped: true, reason: 'autoScanEnabled is false' })
    }

    // ── Always advance historyId cursor ────────────────────────────────────
    // Do this before any Gmail calls so the next notification has a fresh baseline
    // even if this call errors or returns empty.
    const lastHistoryId = rootData.watchHistoryId as string | undefined
    await db.doc(`users/${uid}`).update({
      watchHistoryId:        newHistoryId,
      lastBackgroundScanAt:  FieldValue.serverTimestamp(),
    })
    fbWrites++

    if (!lastHistoryId) {
      // First notification — cursor now seeded for next time
      return NextResponse.json({ skipped: true, reason: 'Baseline historyId seeded' })
    }

    // ── Get valid access token (refreshes if expired) ──────────────────────
    let accessToken: string
    try {
      accessToken = await getValidAccessToken(db, uid)
      fbReads++   // getValidAccessToken reads account_primary
    } catch (err: any) {
      console.error(`[background-scan] Token error for uid=${uid}:`, err.message)
      return NextResponse.json({ error: 'OAuth token unavailable' }, { status: 400 })
    }

    // ── Discover changed threads ───────────────────────────────────────────
    const allChangedIds = await getChangedThreadIds(accessToken, lastHistoryId)
    if (allChangedIds.length === 0) {
      return NextResponse.json({ success: true, newItems: 0, updatedItems: 0, skippedItems: 0 })
    }

    const threadIds = allChangedIds.slice(0, MAX_THREADS)

    // ── Build category + hints context ─────────────────────────────────────
    const categories = catsSnap.docs.map(d => ({
      id:          d.id,
      name:        d.data().name        as string,
      description: d.data().description as string || '',
    }))

    const hints = hintsSnap.docs.map(d => d.data() as {
      categoryId: string; categoryName: string;
      senderEmail: string; senderName: string; subjectClue: string; aiTitle: string;
    })

    const locale = rootData.locale ?? 'en-GB'

    // ── Check for existing items with these threadIds ──────────────────────
    const existingSnap = await db
      .collection(`users/${uid}/items`)
      .where('threadId', 'in', threadIds)
      .select('threadId', 'updatedAt', 'lastMessageInternalDate', 'manualPriority', 'manualCategory')
      .get()
    fbReads += existingSnap.size

    const threadToItemId   = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.id]))
    const threadToUpdatedAt = new Map(existingSnap.docs.map(d => {
      const gmailTs = d.data().lastMessageInternalDate
      const keelTs  = d.data().updatedAt
      return [d.data().threadId as string, gmailTs ?? keelTs?.toMillis?.() ?? 0]
    }))
    const threadManualPrio     = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.data().manualPriority as boolean]))
    const threadManualCategory = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.data().manualCategory as boolean]))

    // ── Process threads ────────────────────────────────────────────────────
    let newItems          = 0
    let updatedItems      = 0
    let skippedItems      = 0
    let totalInputTokens  = 0
    let totalOutputTokens = 0
    let totalAiCost       = 0

    for (const threadId of threadIds) {
      try {
        const thread = await fetchThread(accessToken, threadId)
        if (!thread) { skippedItems++; continue }

        const messages = thread.messages ?? []
        if (messages.length === 0) { skippedItems++; continue }

        const latest         = messages[messages.length - 1]
        const internalDate   = parseInt(latest.internalDate ?? '0', 10)
        const storedDate     = threadToUpdatedAt.get(threadId) ?? 0
        const existingItemId = threadToItemId.get(threadId)

        // Skip if unchanged since we last processed it
        if (existingItemId && storedDate >= internalDate) { skippedItems++; continue }

        const first = messages[0]
        const headers    = first.payload?.headers ?? []
        const subject    = extractHeader(headers, 'subject') || '(no subject)'
        const from       = extractHeader(headers, 'from')
        const { senderName, senderEmail } = parseFrom(from)
        const receivedAt = parseInt(first.internalDate ?? '0', 10)
        const threadBody = buildThreadContext(thread)

        // Skip re-classification if user manually assigned a category
        const hasManualCategory = threadManualCategory.get(threadId) ?? false

        const s1 = await runS1(db, {
          subject, senderName, senderEmail,
          body: threadBody,
          categories,
          hints,
          locale,
        })

        totalInputTokens  += s1.inputTokens  ?? 0
        totalOutputTokens += s1.outputTokens ?? 0
        totalAiCost       += s1.costUsd      ?? 0

        const itemData: Record<string, any> = {
          threadId,
          accountId:    'account_primary',
          senderName,
          senderEmail,
          subject,
          receivedAt:              Timestamp.fromMillis(receivedAt),
          status:                  s1.status            ?? 'new',
          aiTitle:                 s1.aiTitle           ?? subject,
          aiSummary:               s1.aiSummary         ?? '',
          aiDetailedSummary:       typeof s1.aiDetailedSummary === 'string' ? s1.aiDetailedSummary : '',
          aiImportanceScore:       s1.aiImportanceScore ?? 0.5,
          signals:                 Array.isArray(s1.signals) ? s1.signals : [],
          isRecurring:             s1.isRecurring        ?? false,
          updatedAt:               Timestamp.fromMillis(internalDate),
          lastMessageInternalDate: internalDate,
          lastProcessedBy:         'background',
        }

        // Only update categoryId if the user hasn't manually set one
        if (!hasManualCategory) {
          itemData.categoryId = s1.categoryId ?? 'cat_other'
        }

        // Preserve manual priority override
        if (threadManualPrio.get(threadId)) {
          delete itemData.aiImportanceScore
        }

        if (existingItemId) {
          await db.doc(`users/${uid}/items/${existingItemId}`).update(itemData)
          updatedItems++
        } else {
          const itemId = `${threadId}_${uid}`
          await db.doc(`users/${uid}/items/${itemId}`).set({
            ...itemData,
            itemId,
            messageId:  latest.id ?? '',
            createdAt:  FieldValue.serverTimestamp(),
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

    // ── Write scanRun doc ──────────────────────────────────────────────────
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
      model:            'gemini-2.5-flash',
      provider:         'gemini-flash',
      durationMs,
    })
    fbWrites++

    // ── Update meta/usage ─────────────────────────────────────────────────
    await db.doc('meta/usage').set({
      backgroundScanRuns:          FieldValue.increment(1),
      backgroundScanCostUsd:       FieldValue.increment(totalAiCost),
      backgroundScanInputTokens:   FieldValue.increment(totalInputTokens),
      backgroundScanOutputTokens:  FieldValue.increment(totalOutputTokens),
      backgroundScanNewItems:      FieldValue.increment(newItems),
      backgroundScanUpdatedItems:  FieldValue.increment(updatedItems),
    }, { merge: true })

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
