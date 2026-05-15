import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'
import { runCalendarCheck } from '@/lib/server/calendarCheck'

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

async function fetchThread(accessToken: string, threadId: string) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) return { data: null, status: res.status }
  return { data: await res.json(), status: res.status }
}

async function getValidAccessToken(db: ReturnType<typeof getAdminDb>, uid: string): Promise<string | null> {
  const accountSnap = await db.doc(`users/${uid}/accounts/account_primary`).get()
  const data        = accountSnap.data()
  if (!data?.accessToken) return null

  const existingToken = data.accessToken as string

  // If tokenExpiresAt is missing or unknown, try using the existing token directly
  // (the scan route keeps this refreshed so it's likely still valid)
  const expiresAt = data.tokenExpiresAt?.toMillis?.() ?? 0
  const hasHeadroom = expiresAt > Date.now() + 2 * 60 * 1000
  if (hasHeadroom || !data.refreshToken) return existingToken

  // Token is near expiry and we have a refresh token — try refreshing
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: data.refreshToken as string,
        grant_type:    'refresh_token',
      }),
    })
    if (!tokenRes.ok) {
      // Refresh failed — fall back to existing token (may still work if not truly expired)
      console.warn('[reanalyse] Token refresh failed, falling back to existing token')
      return existingToken
    }
    const td = await tokenRes.json()
    await db.doc(`users/${uid}/accounts/account_primary`).update({
      accessToken:    td.access_token,
      tokenExpiresAt: Timestamp.fromMillis(Date.now() + td.expires_in * 1000),
      tokenUpdatedAt: Timestamp.now(),
    })
    return td.access_token as string
  } catch (e) {
    console.warn('[reanalyse] Token refresh threw:', e)
    return null
  }
}

function extractHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBody(message: any): string {
  const parts = message.payload?.parts ?? [message.payload]
  const decode = (p: any): string => {
    if (!p) return ''
    if (p.parts) return p.parts.map(decode).join('\n')
    const data = p.body?.data ?? ''
    try { return atob(data.replace(/-/g, '+').replace(/_/g, '/')) } catch { return '' }
  }
  const raw = parts.map(decode).join('\n').replace(/\r\n/g, '\n').trim()
  // Strip HTML tags so char limit is spent on actual content, not markup
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function buildThreadContext(thread: any): string {
  const msgs = thread.messages ?? []
  return msgs.map((msg: any, i: number) => {
    const headers  = msg.payload?.headers ?? []
    const from     = extractHeader(headers, 'from')
    const date     = extractHeader(headers, 'date')
    // Recent messages (last 3): 2000 chars — enough to capture full invitation body
    // Older messages: 300 chars for context
    const maxLen   = i < msgs.length - 3 ? 300 : 2000
    const body     = decodeBody(msg).slice(0, maxLen)
    return `[${date}] FROM: ${from}\n${body}`
  }).join('\n\n---\n\n')
}

export async function POST(req: NextRequest) {
  try {
    const { uid, itemId } = await req.json()
    if (!uid || !itemId) return NextResponse.json({ error: 'Missing uid or itemId' }, { status: 400 })

    const db = getAdminDb()

    // Get a valid (auto-refreshed) access token
    const accessToken = await getValidAccessToken(db, uid)
    if (!accessToken) return NextResponse.json({ error: 'Auth expired — user must sign in again', authError: true }, { status: 401 })

    // Read existing item
    const itemSnap = await db.doc(`users/${uid}/items/${itemId}`).get()
    if (!itemSnap.exists) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    const item = itemSnap.data()!

    // Fetch thread from Gmail — skip gracefully if thread deleted/not accessible
    const { data: thread, status: threadStatus } = await fetchThread(accessToken, item.threadId)
    if (!thread) {
      if (threadStatus === 404) return NextResponse.json({ skipped: true, reason: 'Thread not found in Gmail' })
      return NextResponse.json({ error: `Gmail returned ${threadStatus}` }, { status: 502 })
    }

    const msgs     = thread.messages ?? []
    const latest   = msgs[msgs.length - 1]
    const headers  = latest?.payload?.headers ?? []
    const subject  = extractHeader(headers, 'subject') || item.subject
    const from     = extractHeader(headers, 'from')
    const threadBody = buildThreadContext(thread)

    // Load categories for context
    const catsSnap = await db.collection(`users/${uid}/categories`).where('archived', '==', false).get()
    const categoryList = catsSnap.docs.map(d =>
      `- ${d.id}: "${d.data().name}"${d.data().description ? ` — ${d.data().description}` : ''}`
    ).join('\n')

    // Full classification prompt (mirrors scan route — preserves category if manually set)
    const preserveCategory = item.manualCategory === true
    const prompt = `You are Keel, a personal life admin AI. Re-analyse this email thread with fresh eyes.
Write all text in British English.

IMPORTANT: Your analysis must reflect the CURRENT STATE — what is happening now, what action (if any) is still needed. Judge by the most recent messages.

${preserveCategory ? `CATEGORY (DO NOT CHANGE): ${item.categoryName} (${item.categoryId}) — user has manually assigned this.` : `CATEGORIES:\n${categoryList}`}

THREAD SUBJECT: ${subject}
ORIGINAL SENDER: ${from}

THREAD (most recent messages last):
${threadBody.slice(0, 3000)}

Respond with ONLY valid JSON:
{
  "aiTitle": string,
  "aiSummary": string,
  "aiDetailedSummary": string,
  "aiImportanceScore": number,
  "signals": [
    {
      "type": "event" | "deadline" | "payment" | "rsvp" | "awaiting",
      "description": string,
      "detectedDate": "YYYY-MM-DD" | null,
      "detectedAmountPence": number | null,
      "currency": "GBP" | "USD" | null
    }
  ],
  "status": "new" | "awaiting_action" | "awaiting_reply" | "quietly_logged"${preserveCategory ? '' : ',\n  "categoryId": string,\n  "categoryName": string'}
}

Rules:
- aiTitle: 4-7 words, use real names from thread, never "user" or "the user"
- aiSummary: one sentence, current state, max 120 chars, use real names
- aiDetailedSummary: 2-5 bullets "• " prefix:
  • PURPOSE: What is this about and why does it matter? Use real names.
  • EVOLUTION (only if meaningful): How did the thread develop?
  • CURRENT STATE: Final agreed outcome with concrete details — dates, times, names.
  • NEXT STEP: Who specifically needs to do what next? Identify by name. If the last outbound message asks a question, the next step is waiting for the other party's reply. Omit if nothing needed.
- NAMES: Never use "the user", "you", or "the account owner". Use real first names.
- STATUS: Use "quietly_logged" ONLY if the matter is 100% resolved with zero further relevance. If there is a date, an event, a payment, or any information worth knowing — use "new" not "quietly_logged". When in doubt, use "new".
- RSVP / REGISTRATION: If the email contains "please complete the registration form", "please register", "please confirm attendance", "RSVP required", or similar — status must be "awaiting_action" regardless of anything else. Do not be misled by the event being far away.
- CRITICAL — CALENDAR \u2260 RSVP: The fact that an event is in the user's Google Calendar does NOT mean they have RSVPd or registered. Keel adds calendar entries automatically. Only treat an RSVP as complete if the email thread itself contains a confirmation reply or "thank you for registering" message.
- UNANSWERED INVITATIONS: If the email is an invitation and the thread contains no evidence the user has responded/registered — status must be "awaiting_action", aiImportanceScore 0.70-0.85, even if the event is weeks away.
- SIGNALS — strict quality rules:
  • event: For confirmed upcoming appointments or events — INCLUDING informational school/activity notices where a date and time are given, even if no action is required. Create event signals for school trips, matches, sports days, concerts, activities, medical appointments — any confirmed event with a known date.
  • awaiting: ONLY for genuinely open questions in the most recent outbound message. Not for already-confirmed matters.
  • deadline/payment/rsvp: Only when genuinely present and unresolved.
- IMPORTANCE: Upcoming events within 7 days score 0.72-0.78 (High priority) even if no action required — proximity alone justifies surfacing them. Events today/tomorrow score 0.78, later this week 0.72. Events more than 7 days away score 0.55-0.65 (Medium). Never score an imminent informational school/activity notice below 0.70.`

    const { text, inputTokens, outputTokens } = await aiComplete(db, prompt, 1024)
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return NextResponse.json({ error: 'AI returned no JSON' }, { status: 500 })

    const parsed = JSON.parse(json)

    const now = Timestamp.now()

    // Build update — always update content fields, preserve category if manually set
    const wasActive = item.status !== 'quietly_logged'

    // Guard: never let reanalyse silently move an active item to quietly_logged.
    // Only the user can explicitly ignore an item. The AI may classify something as
    // "no action needed" (quietly_logged) but if the user has been seeing this item
    // as active, preserve its current status rather than hiding it.
    // Exception: if the item was already quietly_logged, allow the AI to keep it there.
    const resolvedStatus = (parsed.status === 'quietly_logged' && wasActive)
      ? item.status   // keep the existing active status
      : (parsed.status ?? item.status)

    const update: Record<string, any> = {
      aiTitle:           parsed.aiTitle ?? item.aiTitle,
      aiSummary:         parsed.aiSummary ?? item.aiSummary,
      aiDetailedSummary: parsed.aiDetailedSummary ?? item.aiDetailedSummary,
      aiImportanceScore: parsed.aiImportanceScore ?? item.aiImportanceScore,
      status:            resolvedStatus,
      updatedAt:         now,
    }

    if (!preserveCategory && parsed.categoryId) {
      update.categoryId   = parsed.categoryId
      update.categoryName = parsed.categoryName
    }

    await db.doc(`users/${uid}/items/${itemId}`).update(update)

    // Rewrite signals
    if (Array.isArray(parsed.signals)) {
      const signalsSnap = await db.collection(`users/${uid}/signals`)
        .where('itemId', '==', itemId).get()
      const batch = db.batch()
      signalsSnap.docs.forEach(d => batch.delete(d.ref))
      for (const sig of parsed.signals) {
        const sigId  = `sig_${itemId}_${sig.type}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`
        const sigRef = db.doc(`users/${uid}/signals/${sigId}`)
        batch.set(sigRef, {
          signalId:            sigId,
          itemId,
          type:                sig.type,
          description:         sig.description ?? '',
          detectedDate:        sig.detectedDate ? Timestamp.fromDate(new Date(sig.detectedDate)) : null,
          detectedAmountPence: sig.detectedAmountPence ?? null,
          currency:            sig.currency ?? 'GBP',
          importanceFlag:      (parsed.aiImportanceScore ?? 0) >= 0.7,
          calendarStatus:      null,
          status:              'active',
          createdAt:           now,
          updatedAt:           now,
        })
      }
      await batch.commit()
    }

    // Run calendar check so newly-written signals get their on_cal status immediately
    // Fire-and-forget with error suppression — don't block the response
    runCalendarCheck(db, uid, accessToken).catch(e =>
      console.warn('[reanalyse] Cal check non-fatal:', e)
    )

    return NextResponse.json({
      success:      true,
      inputTokens,
      outputTokens,
      costUsd:      (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000,
    })

  } catch (err) {
    console.error('[reanalyse]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
