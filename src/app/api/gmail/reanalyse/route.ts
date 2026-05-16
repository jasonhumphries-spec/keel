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

async function getValidAccessToken(db: ReturnType<typeof getAdminDb>, uid: string): Promise<string> {
  const accountRef  = db.doc(`users/${uid}/accounts/account_primary`)
  const accountSnap = await accountRef.get()
  if (!accountSnap.exists) throw new Error('Account not found')

  const data        = accountSnap.data()!
  const accessToken = data.accessToken as string | undefined
  const refreshToken = data.refreshToken as string | undefined
  const expiresAt   = data.tokenExpiresAt?.toMillis?.() as number | undefined

  // Still valid with >5 min headroom — use as-is
  const hasHeadroom = expiresAt && expiresAt - Date.now() > 5 * 60 * 1000
  if (accessToken && hasHeadroom) return accessToken

  // Token missing or about to expire — refresh
  if (!refreshToken) throw new Error('No refresh token — please sign out and sign back in')

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    console.error('[reanalyse] Token refresh failed:', err)
    throw new Error(`Token refresh failed — please sign out and sign back in (${tokenRes.status})`)
  }

  const tokenData = await tokenRes.json()
  const newToken  = tokenData.access_token as string
  const expiresIn = tokenData.expires_in as number

  await accountRef.update({
    accessToken:    newToken,
    tokenUpdatedAt: Timestamp.now(),
    tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
  })

  return newToken
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
  const msgs  = thread.messages ?? []
  const total = msgs.length
  return msgs.map((msg: any, i: number) => {
    const headers = msg.payload?.headers ?? []
    const from    = extractHeader(headers, 'from')
    const date    = extractHeader(headers, 'date')
    // Backoff by position from end — mirrors scanUtils.ts
    const pos   = total - i
    const limit = pos === 1 ? 99999 : pos <= 3 ? 1200 : pos <= 6 ? 500 : pos <= 10 ? 250 : 100
    const body  = decodeBody(msg).slice(0, limit)
    const label = pos === 1
      ? `[${date}] FROM: ${from} *** LATEST MESSAGE ***`
      : pos <= 3 ? `[${date}] FROM: ${from} (recent)`
      : `[${date}] FROM: ${from} (earlier context)`
    return `${label}\n${body}`
  }).join('\n\n---\n\n')
}

export async function POST(req: NextRequest) {
  try {
    const { uid, itemId } = await req.json()
    if (!uid || !itemId) return NextResponse.json({ error: 'Missing uid or itemId' }, { status: 400 })

    const db = getAdminDb()

    // Get a valid (auto-refreshed) access token
    let accessToken: string
    try {
      accessToken = await getValidAccessToken(db, uid)
    } catch (e: any) {
      return NextResponse.json({ error: e.message ?? 'Auth expired — please sign out and sign back in', authError: true }, { status: 401 })
    }

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
    const rfcMessageId = extractHeader(headers, 'message-id').replace(/^<|>$/g, '') || null
    const threadBody = buildThreadContext(thread)

    // Compute ownerHasReplied from actual message headers — same logic as scan route
    const accountSnap2 = await db.doc(`users/${uid}/accounts/account_primary`).get()
    const accountEmail = (accountSnap2.data()?.email as string ?? '').toLowerCase()
    const ownerHasReplied = msgs.some((msg: any) => {
      const msgFrom = ((msg.payload?.headers ?? []) as any[]).find((h: any) => h.name.toLowerCase() === 'from')?.value ?? ''
      return msgFrom.toLowerCase().includes(accountEmail)
    })

    // Load categories for context
    const catsSnap = await db.collection(`users/${uid}/categories`).where('archived', '==', false).get()
    const categoryList = catsSnap.docs.map(d =>
      `- ${d.id}: "${d.data().name}"${d.data().description ? ` — ${d.data().description}` : ''}`
    ).join('\n')

    // Full classification prompt (mirrors scan route — preserves category if manually set)
    const preserveCategory = item.manualCategory === true
    const ownerFactNote = ownerHasReplied ? '' : 'HARD FACT — DO NOT OVERRIDE: The account owner has NEVER sent any message in this thread. awaiting_reply is therefore IMPOSSIBLE. Use awaiting_action if a response is needed, or new/quietly_logged if it is noise.\n\n'

    const prompt = `You are Keel, a personal life admin AI. Re-analyse this email thread with fresh eyes.
Write all text in British English.

${ownerFactNote}IMPORTANT: Your analysis must reflect the CURRENT STATE — what is happening now, what action (if any) is still needed. Judge by the most recent messages.

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
  • DATE ACCURACY (critical): Always read the full month from the email context. If the email discusses June events and mentions 'the 16th', that is June 16th not May 16th. Never assume a day number belongs to the current month — use the month explicitly stated or contextually implied. Output all detectedDate values as YYYY-MM-DD with the correct month.
  • event: For confirmed upcoming appointments or events — INCLUDING informational school/activity notices where a date and time are given, even if no action is required. Create event signals for school trips, matches, sports days, concerts, activities, medical appointments — any confirmed event with a known date.
  • awaiting: ONLY for genuinely open questions in the most recent outbound message. Not for already-confirmed matters.
  • deadline/payment/rsvp: Only when genuinely present and unresolved.
- IMPORTANCE: Proximity to today is the primary driver. Events or commitments TODAY or TOMORROW score 0.88-0.92 (Urgent) — includes school events, sports, practice sessions, appointments, social commitments. Events or commitments within 2 days score 0.85-0.87 (Urgent). Non-payment deadlines within 3–7 days (e.g. 'reply by Friday', 'let me know by next week') score 0.75-0.80 (High) — do NOT treat a response deadline as equivalent to a payment deadline. Payment due within 7 days scores 0.82-0.87. Events more than 7 days away score 0.55-0.65 (Medium). Never score today/tomorrow below 0.85.`

    const { text, inputTokens, outputTokens } = await aiComplete(db, prompt, 1024)
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return NextResponse.json({ error: 'AI returned no JSON' }, { status: 500 })

    let parsed = JSON.parse(json)

    // Hard override — same as scan route
    if (!ownerHasReplied && parsed?.status === 'awaiting_reply') {
      console.warn('[reanalyse] awaiting_reply overridden → awaiting_action (owner has never sent a message)')
      parsed.status = 'awaiting_action'
    }

    // Hard proximity override — if any signal is due within 2 days, score must be Urgent (≥0.85).
    // The AI consistently under-scores response deadlines vs payment deadlines regardless of prompting.
    const nowMs       = Date.now()
    const twoDaysMs   = 2 * 24 * 60 * 60 * 1000
    const signals     = Array.isArray(parsed?.signals) ? parsed.signals : []
    const hasImminent = signals.some((s: any) => {
      if (!s?.detectedDate) return false
      const sigMs = new Date(s.detectedDate).getTime()
      return sigMs > nowMs && sigMs - nowMs <= twoDaysMs
    })
    if (hasImminent && (parsed?.aiImportanceScore ?? 0) < 0.85) {
      console.warn(`[reanalyse] Proximity override: signal due within 2 days, score ${parsed.aiImportanceScore} → 0.88`)
      parsed.aiImportanceScore = 0.88
    }

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
      ...(rfcMessageId ? { rfcMessageId } : {}),
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
