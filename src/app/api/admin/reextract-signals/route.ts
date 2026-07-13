/**
 * POST /api/admin/reextract-signals
 *
 * Re-runs a slim signal-extraction pass over EXISTING items that have no
 * event/deadline/rsvp signals. Uses the item's already-classified summary
 * as input — no Gmail refetch needed. Fixes the historical gap where the
 * scanner classified something as awaiting_action but forgot to emit a
 * structured signal with the date it referenced in prose.
 *
 * Body: { uid: string, dryRun?: boolean, maxItems?: number }
 * Auth: x-keel-admin-secret header
 *
 * Behaviour:
 *   - Query users/{uid}/items with status in [new, awaiting_action, awaiting_reply]
 *   - For each item, check if it has any event/deadline/rsvp signal — skip if so
 *   - Otherwise, prompt the AI (using aiComplete + active provider) to extract
 *     signals from the summary text. If AI returns any, write them.
 *   - Return counts + sample of created signals.
 *
 * Cost: ~$0.001–0.003 per item depending on provider. Cap via maxItems.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

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

const EXPIRY_SIGNAL_TYPES = new Set(['event', 'deadline', 'rsvp'])

type ExtractedSignal = {
  type:         'event' | 'deadline' | 'rsvp'
  description:  string
  detectedDate: string   // YYYY-MM-DD
}

async function extractSignalsFromSummary(
  db:       ReturnType<typeof getFirestore>,
  item:     FirebaseFirestore.DocumentData,
  todayStr: string,
): Promise<{ signals: ExtractedSignal[]; costUsd: number }> {
  const title    = (item.aiTitle           as string | undefined) ?? ''
  const summary  = (item.aiSummary         as string | undefined) ?? ''
  const detailed = (item.aiDetailedSummary as string | undefined) ?? ''

  if (!summary && !detailed) return { signals: [], costUsd: 0 }

  const prompt = `You are extracting structured signals from an already-summarised email item in an inbox manager.

Today's date: ${todayStr}
Item title: ${title}
Summary: ${summary}
Detailed summary:
${detailed}

Task: extract any concrete dates or deadlines that are referenced in the summary or detailed summary. Return signals in one of these types:
- "event": a scheduled time slot the person attends or that happens at a specific moment (meeting, appointment, school event, pickup time, etc.)
- "deadline": a point by which the person must DO something ("ship by X", "reply by X", "complete by X")
- "rsvp": a genuine RSVP request that hasn't been responded to

Rules:
- Only emit signals for SPECIFIC dates or day-of-week + context that resolves to a single date. Skip vague "sometime next week" references.
- Ignore past dates (before ${todayStr}). Only emit signals for today or future dates.
- Never emit a signal for a date the summary explicitly says was declined, cancelled, or resolved.
- If the summary references NO specific future date, return { "signals": [] }.
- detectedDate MUST be YYYY-MM-DD format.
- description should be a short human-readable string (max 80 chars).

Output raw JSON only:
{ "signals": [ { "type": "...", "description": "...", "detectedDate": "YYYY-MM-DD" } ] }`

  try {
    const { text, costUsd } = await aiComplete(db, prompt, 512)
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return { signals: [], costUsd }
    const parsed = JSON.parse(json) as { signals?: any[] }
    const signals = (parsed.signals ?? [])
      .filter(s => s && EXPIRY_SIGNAL_TYPES.has(s.type) && typeof s.detectedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.detectedDate))
      .map(s => ({
        type:         s.type as 'event' | 'deadline' | 'rsvp',
        description:  String(s.description ?? '').slice(0, 200),
        detectedDate: s.detectedDate as string,
      }))
    return { signals, costUsd }
  } catch (e) {
    console.warn('[reextract-signals] AI extraction failed for item:', e)
    return { signals: [], costUsd: 0 }
  }
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-keel-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const db   = getAdminDb()
  const body = await req.json().catch(() => ({}))
  const uid      = body.uid as string | undefined
  const dryRun   = !!body.dryRun
  const maxItems = typeof body.maxItems === 'number' ? body.maxItems : 500
  if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

  const itemsSnap = await db.collection(`users/${uid}/items`)
    .where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply']).get()

  const itemIds = itemsSnap.docs.map(d => d.id)

  // Which items already have any expiry-type signal? Skip those.
  const hasExpirySignal = new Set<string>()
  for (let i = 0; i < itemIds.length; i += 10) {
    const chunk    = itemIds.slice(i, i + 10)
    const sigsSnap = await db.collection(`users/${uid}/signals`)
      .where('itemId', 'in', chunk).get()
    for (const sd of sigsSnap.docs) {
      const s = sd.data()
      if (EXPIRY_SIGNAL_TYPES.has(s.type as string)) hasExpirySignal.add(s.itemId as string)
    }
  }

  const candidates = itemsSnap.docs.filter(d => !hasExpirySignal.has(d.id)).slice(0, maxItems)
  const todayStr   = new Date().toISOString().slice(0, 10)

  let examined     = 0
  let itemsUpdated = 0
  let signalsCreated = 0
  let totalCostUsd = 0
  const samples: Array<{ itemId: string; title: string; signals: ExtractedSignal[] }> = []

  for (const doc of candidates) {
    examined++
    const item = doc.data()
    const { signals, costUsd } = await extractSignalsFromSummary(db, item, todayStr)
    totalCostUsd += costUsd
    if (signals.length === 0) continue

    if (!dryRun) {
      const now      = Timestamp.now()
      const sigBatch = db.batch()
      const threadId = (item.threadId as string) ?? doc.id
      for (const sig of signals) {
        // Uniqueness key: threadId + type + date — prevents dup writes on repeated runs
        const sigId = `sig_${threadId.slice(0, 12)}_${sig.type}_${sig.detectedDate}`
        sigBatch.set(db.doc(`users/${uid}/signals/${sigId}`), {
          signalId:            sigId,
          itemId:              doc.id,
          accountId:           'account_primary',
          type:                sig.type,
          detectedDate:        Timestamp.fromDate(new Date(sig.detectedDate)),
          detectedAmountPence: null,
          currency:            null,
          description:         sig.description,
          calendarStatus:      null,
          calendarEventId:     null,
          targetCalendarId:    null,
          status:              'active',
          createdAt:           now,
          updatedAt:           now,
          createdBy:           'reextract',
        }, { merge: true })
      }
      await sigBatch.commit()
    }

    itemsUpdated++
    signalsCreated += signals.length
    if (samples.length < 10) {
      samples.push({ itemId: doc.id, title: (item.aiTitle as string ?? '').slice(0, 80), signals })
    }
  }

  console.log(`[reextract-signals] uid=${uid.slice(0,8)} examined=${examined} updated=${itemsUpdated} signals=${signalsCreated} cost=$${totalCostUsd.toFixed(4)} dryRun=${dryRun}`)

  return NextResponse.json({
    success:        true,
    dryRun,
    activeItems:    itemsSnap.size,
    alreadyHadSignals: hasExpirySignal.size,
    candidates:     candidates.length,
    examined,
    itemsUpdated,
    signalsCreated,
    costUsd:        Number(totalCostUsd.toFixed(4)),
    samples,
  })
}
