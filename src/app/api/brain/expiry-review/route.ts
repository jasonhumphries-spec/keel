/**
 * POST /api/brain/expiry-review
 *
 * See docs/relevance-brain-design.md §10.3.
 *
 * Finds High/Urgent items the stale timer buried and asks the model what it would cost
 * to never see them again, storing the answer so they can be surfaced for review
 * instead of silently deleted.
 *
 * DELIBERATELY SEPARATE FROM THE EXPIRY PATHS. Expiry happens in two places — the
 * nightly Cloud Function and the admin expire-items route — and adding a model call to
 * both would duplicate logic across codebases, which is exactly what left
 * functions/src/scan.ts running a classifier months out of date. This route is
 * idempotent and driven by state (`expiryReviewedAt` unset), so it does not care which
 * path did the burying, can be re-run safely, and back-fills anything missed while it
 * was not running.
 *
 * Body: { uid, limit?, dryRun? }
 * Auth: ADMIN_SECRET via x-admin-secret.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'
import {
  buildExpiryPrompt, parseExpiryReview, needsExpiryReview,
} from '@/lib/server/expiryReview'

export const maxDuration = 300

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  })
}
const db = getFirestore()

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-secret') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const { uid, limit = 50, dryRun = false } = await req.json()
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 })

  // Single-field query, then filter in memory. A composite index on
  // status+quietedBy+score+reviewedAt would need deploying and buys nothing at this
  // volume — the measured rate is ~31 qualifying items a month.
  const snap = await db.collection(`users/${uid}/items`)
    .where('quietedBy', '==', 'expiry:stale')
    .get()

  type ItemDoc = {
    id: string
    status?: string | null
    quietedBy?: string | null
    aiImportanceScore?: number | null
    expiryReviewedAt?: unknown
    aiTitle?: string | null
    senderEmail?: string | null
    subject?: string | null
    aiSummary?: string | null
    aiDetailedSummary?: string | null
  }
  const all: ItemDoc[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ItemDoc, 'id'>) }))
  const pending = all.filter(needsExpiryReview)
  const candidates = [...pending]
    .sort((a, b) => (b.aiImportanceScore ?? 0) - (a.aiImportanceScore ?? 0))
    .slice(0, limit)

  if (dryRun) {
    return NextResponse.json({
      dryRun: true, wrote: 'nothing',
      staleQuieted: snap.size,
      awaitingReview: pending.length,
      wouldReview: candidates.length,
      sample: candidates.slice(0, 10).map(c => ({
        itemId: c.id, score: c.aiImportanceScore, title: c.aiTitle, from: c.senderEmail,
      })),
    })
  }

  let reviewed = 0, open = 0
  const failures: string[] = []

  for (const item of candidates) {
    try {
      const { text } = await aiComplete(db, buildExpiryPrompt(item), 120)
      const r = parseExpiryReview(text)
      await db.doc(`users/${uid}/items/${item.id}`).update({
        expiryReviewOpen:   r.open,
        expiryReviewScore:  r.score,
        expiryReviewReason: r.reason,
        expiryReviewedAt:   Timestamp.now(),
        updatedAt:          Timestamp.now(),
      })
      reviewed++
      if (r.open) open++
    } catch (e) {
      // Never stamp expiryReviewedAt on a failure — an unreviewed item must stay in
      // the queue for the next run rather than silently becoming a permanent NO.
      failures.push(`${item.id}: ${String(e).slice(0, 80)}`)
    }
  }

  return NextResponse.json({
    reviewed, open, buriedButOpen: open,
    failed: failures.length,
    failures: failures.slice(0, 5),
    remaining: Math.max(0, pending.length - reviewed),
  })
}
