/**
 * POST /api/admin/expire-items
 *
 * Runs the same per-user expiry + proximity rescore logic as the nightly
 * Cloud Function (nightlyItemExpiry), but on demand for a specific user.
 *
 * Called:
 *   - Fire-and-forget at the end of every scan (scan/route.ts)
 *   - By the admin console "Run expiry" button
 *
 * Body: { uid: string }  — or omit uid to run for ALL users (admin only)
 * Auth: x-keel-admin-secret header
 *
 * This ensures items whose event dates have passed are archived/marked
 * overdue immediately after a scan, not at 1am.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

// ── Types ─────────────────────────────────────────────────────────────────────

type Db = FirebaseFirestore.Firestore

// ── Proximity rescore ─────────────────────────────────────────────────────────

function proximityScore(daysUntil: number): number | null {
  if (daysUntil <= 1) return 0.90  // today/tomorrow → Urgent
  if (daysUntil <= 2) return 0.85  // within 2 days → Urgent
  if (daysUntil <= 7) return 0.77  // within 7 days → High
  return null
}

async function rescoreByProximity(db: Db, uid: string): Promise<number> {
  const nowMs       = Date.now()
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  const nowTs       = Timestamp.fromMillis(nowMs)
  const cutoffTs    = Timestamp.fromMillis(nowMs + sevenDaysMs)

  const itemsSnap = await db.collection(`users/${uid}/items`)
    .where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply'])
    .get()

  if (itemsSnap.empty) return 0

  const itemIds        = itemsSnap.docs.map(d => d.id)
  const itemDataById   = new Map(itemsSnap.docs.map(d => [d.id, d.data()]))
  const earliestSigMs  = new Map<string, number>()

  for (let i = 0; i < itemIds.length; i += 10) {
    const chunk    = itemIds.slice(i, i + 10)
    const sigsSnap = await db.collection(`users/${uid}/signals`)
      .where('itemId', 'in', chunk)
      .where('detectedDate', '>', nowTs)
      .where('detectedDate', '<=', cutoffTs)
      .get()

    for (const sigDoc of sigsSnap.docs) {
      const sig = sigDoc.data()
      if (!['event', 'deadline', 'rsvp'].includes(sig.type as string)) continue
      const sigMs  = (sig.detectedDate as Timestamp).toMillis()
      const itemId = sig.itemId as string
      const prev   = earliestSigMs.get(itemId)
      if (prev === undefined || sigMs < prev) earliestSigMs.set(itemId, sigMs)
    }
  }

  if (earliestSigMs.size === 0) return 0

  let batch      = db.batch()
  let batchCount = 0
  let rescored   = 0

  for (const [itemId, nearestMs] of earliestSigMs) {
    const item = itemDataById.get(itemId)
    if (!item || item.manualPriority) continue

    const daysUntil    = (nearestMs - nowMs) / (24 * 60 * 60 * 1000)
    const newScore     = proximityScore(daysUntil)
    const currentScore = (item.aiImportanceScore as number) ?? 0

    if (newScore !== null && newScore > currentScore) {
      batch.update(db.doc(`users/${uid}/items/${itemId}`), {
        aiImportanceScore: newScore,
        updatedAt:         FieldValue.serverTimestamp(),
        rescoredBy:        'proximity_on_scan',
      })
      rescored++
      batchCount++
      if (batchCount % 400 === 0) {
        await batch.commit()
        batch = db.batch()
        batchCount = 0
      }
    }
  }

  if (batchCount > 0) await batch.commit()
  return rescored
}

// ── Per-user expiry ───────────────────────────────────────────────────────────

async function expireItemsForUser(
  db:  Db,
  uid: string,
): Promise<{ archived: number; overdue: number; skipped: number }> {
  // 1-day grace period — items expire the day AFTER their event date
  const threshold = new Date()
  threshold.setDate(threshold.getDate() - 1)
  threshold.setHours(0, 0, 0, 0)
  const thresholdTs = Timestamp.fromDate(threshold)

  const itemsSnap = await db.collection(`users/${uid}/items`)
    .where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply'])
    .get()

  if (itemsSnap.empty) return { archived: 0, overdue: 0, skipped: 0 }

  const itemIds = itemsSnap.docs.map(d => d.id)

  // Fetch signals for all active items in chunks of 10
  const signalsByItem = new Map<string, { type: string; detectedDate: Timestamp | null }[]>()

  for (let i = 0; i < itemIds.length; i += 10) {
    const chunk    = itemIds.slice(i, i + 10)
    const sigsSnap = await db.collection(`users/${uid}/signals`)
      .where('itemId', 'in', chunk)
      .get()

    for (const sigDoc of sigsSnap.docs) {
      const sig = sigDoc.data()
      if (!['event', 'deadline', 'rsvp', 'payment'].includes(sig.type as string)) continue
      const existing = signalsByItem.get(sig.itemId as string) ?? []
      existing.push({ type: sig.type as string, detectedDate: sig.detectedDate ?? null })
      signalsByItem.set(sig.itemId as string, existing)
    }
  }

  let batch      = db.batch()
  let batchCount = 0
  let archived   = 0
  let overdue    = 0
  let skipped    = 0

  for (const itemDoc of itemsSnap.docs) {
    const item    = itemDoc.data()
    const signals = signalsByItem.get(itemDoc.id) ?? []

    if (signals.length === 0) {
      // No event signals — quietly archive stale 'new' items older than 30 days
      const receivedMs      = (item.receivedAt as Timestamp)?.toMillis?.() ?? 0
      const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000
      if (item.status === 'new' && receivedMs < thirtyDaysAgoMs) {
        batch.update(itemDoc.ref, {
          status:     'quietly_logged',
          resolvedAt: FieldValue.serverTimestamp(),
          updatedAt:  FieldValue.serverTimestamp(),
          expiredBy:  'expire_on_scan_stale',
        })
        archived++
        batchCount++
      } else {
        skipped++
      }
      continue
    }

    // Does this item have any future event/deadline dates?
    const hasFutureDate = signals.some(sig =>
      sig.detectedDate && sig.detectedDate.toMillis() > thresholdTs.toMillis(),
    )

    if (hasFutureDate) { skipped++; continue }

    // All event dates are in the past — expire
    if (item.status === 'new' || item.status === 'awaiting_reply') {
      batch.update(itemDoc.ref, {
        status:     'quietly_logged',
        resolvedAt: FieldValue.serverTimestamp(),
        updatedAt:  FieldValue.serverTimestamp(),
        expiredBy:  'expire_on_scan',
      })
      archived++
    } else if (item.status === 'awaiting_action') {
      batch.update(itemDoc.ref, {
        status:    'overdue',
        updatedAt: FieldValue.serverTimestamp(),
        expiredBy: 'expire_on_scan',
      })
      overdue++
    }

    batchCount++
    if (batchCount % 400 === 0) {
      await batch.commit()
      batch = db.batch()
      batchCount = 0
    }
  }

  if (batchCount > 0) await batch.commit()
  return { archived, overdue, skipped }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-keel-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const db = getAdminDb()

  try {
    const body = await req.json().catch(() => ({}))
    const uid  = body.uid as string | undefined

    const uids: string[] = []

    if (uid) {
      uids.push(uid)
    } else {
      // No uid — run for all users (admin console "run all" button)
      const usersSnap = await db.collection('users').select().get()
      usersSnap.docs.forEach(d => uids.push(d.id))
    }

    let totalArchived = 0
    let totalOverdue  = 0
    let totalRescored = 0

    for (const u of uids) {
      try {
        const [expiry, rescored] = await Promise.all([
          expireItemsForUser(db, u),
          rescoreByProximity(db, u),
        ])
        totalArchived += expiry.archived
        totalOverdue  += expiry.overdue
        totalRescored += rescored

        if (expiry.archived > 0 || expiry.overdue > 0 || rescored > 0) {
          console.log(
            `[expire-items] uid=${u.slice(0, 8)} ` +
            `archived=${expiry.archived} overdue=${expiry.overdue} rescored=${rescored}`,
          )
        }
      } catch (e) {
        console.error(`[expire-items] uid=${u.slice(0, 8)} failed:`, e)
      }
    }

    return NextResponse.json({
      success:  true,
      users:    uids.length,
      archived: totalArchived,
      overdue:  totalOverdue,
      rescored: totalRescored,
    })

  } catch (err) {
    console.error('[expire-items]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
