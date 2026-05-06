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
  if (!res.ok) return null
  return res.json()
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
  return parts.map(decode).join('\n').replace(/\r\n/g, '\n').trim()
}

function buildThreadContext(thread: any): string {
  const msgs = thread.messages ?? []
  return msgs.map((msg: any, i: number) => {
    const headers  = msg.payload?.headers ?? []
    const from     = extractHeader(headers, 'from')
    const date     = extractHeader(headers, 'date')
    const maxLen   = i < msgs.length - 3 ? 200 : 600
    const body     = decodeBody(msg).slice(0, maxLen)
    return `[${date}] FROM: ${from}\n${body}`
  }).join('\n\n---\n\n')
}

export async function POST(req: NextRequest) {
  try {
    const { uid, itemId } = await req.json()
    if (!uid || !itemId) return NextResponse.json({ error: 'Missing uid or itemId' }, { status: 400 })

    const db = getAdminDb()

    // Read OAuth token
    const accountSnap = await db.doc(`users/${uid}/accounts/account_primary`).get()
    const accessToken = accountSnap.data()?.accessToken as string
    if (!accessToken) return NextResponse.json({ error: 'No access token' }, { status: 401 })

    // Read existing item
    const itemSnap = await db.doc(`users/${uid}/items/${itemId}`).get()
    if (!itemSnap.exists) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    const item = itemSnap.data()!

    // Fetch thread from Gmail
    const thread = await fetchThread(accessToken, item.threadId)
    if (!thread) return NextResponse.json({ error: 'Thread not found in Gmail' }, { status: 404 })

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
- SIGNALS — strict quality rules:
  • event: ONLY for confirmed, agreed, upcoming appointments. NOT for declined dates, obstacle dates, or scheduling context.
  • awaiting: ONLY for genuinely open questions in the most recent outbound message. Not for already-confirmed matters.
  • deadline/payment/rsvp: Only when genuinely present and unresolved.`

    const { text, inputTokens, outputTokens } = await aiComplete(db, prompt, 1024)
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return NextResponse.json({ error: 'AI returned no JSON' }, { status: 500 })

    const parsed = JSON.parse(json)

    const now = Timestamp.now()

    // Build update — always update content fields, preserve category if manually set
    const update: Record<string, any> = {
      aiTitle:           parsed.aiTitle ?? item.aiTitle,
      aiSummary:         parsed.aiSummary ?? item.aiSummary,
      aiDetailedSummary: parsed.aiDetailedSummary ?? item.aiDetailedSummary,
      aiImportanceScore: parsed.aiImportanceScore ?? item.aiImportanceScore,
      status:            parsed.status ?? item.status,
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
