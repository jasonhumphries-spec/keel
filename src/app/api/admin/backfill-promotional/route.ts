/**
 * POST /api/admin/backfill-promotional
 *
 * Backfill: tag existing quietly_logged items as autoQuietedReason='promotional'
 * when their aiTitle/aiSummary or sender suggests marketing content. Run once
 * after deploying the promotional override + Section 6 to retroactively populate
 * the new "Recent offers" section with items received before the override was live.
 *
 * Body: { uid: string }  — single user
 * Auth: x-keel-admin-secret header
 *
 * Detection is conservative: requires either an explicit AI self-flag in summary,
 * or a marketing sender pattern combined with offer-like wording. Won't touch items
 * that already have an autoQuietedReason set.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

// Marketing sender patterns. Substring match, lowercase.
// NOTE: 'noreply'/'no-reply'/'updates'/'news' removed — too generic; schools,
// banks, doctors all use them for legit transactional mail.
const MARKETING_SENDER_HINTS = [
  'newsletter', 'marketing', 'promo', 'promos',
  'offers', 'deals', 'insideapple', 'campaigns',
  'announce', 'announcement',
]

// Strong AI-summary hints that indicate promotional content. Substring match, lowercase.
// NOTE: 'sign up for', 'subscribe for', 'free trial' removed — schools use
// 'sign up for the trip', 'register your child' which would false-trigger.
const PROMO_SUMMARY_HINTS = [
  'promotional', 'offer valid', "don't miss", 'special offer', 'limited time',
  'discount', '% off',
]

function looksPromotional(item: any): boolean {
  const summary = `${item.aiSummary ?? ''} ${item.aiDetailedSummary ?? ''} ${item.aiTitle ?? ''}`.toLowerCase()
  const sender  = (item.senderEmail ?? '').toLowerCase()

  // Strong signal: AI summary explicitly says promotional / offer-y language.
  if (PROMO_SUMMARY_HINTS.some(h => summary.includes(h))) return true

  // Weaker signal: marketing sender + offer-ish word in summary.
  const senderLooksMarketing = MARKETING_SENDER_HINTS.some(h => sender.includes(h))
  if (senderLooksMarketing && (summary.includes('offer') || summary.includes('sale'))) return true

  return false
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-keel-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const db = getAdminDb()
  const body = await req.json().catch(() => ({}))
  const uid  = body.uid as string | undefined

  if (!uid) {
    return NextResponse.json({ error: 'Missing uid' }, { status: 400 })
  }

  try {
    const snap = await db.collection(`users/${uid}/items`)
      .where('status', '==', 'quietly_logged')
      .get()

    let inspected = 0
    const now = Timestamp.now()

    const updates: Array<{ id: string; reason: string }> = []
    for (const d of snap.docs) {
      inspected++
      const data = d.data()
      if (data.autoQuietedReason) continue
      if (!looksPromotional(data)) continue
      updates.push({ id: d.id, reason: 'promotional' })
    }

    let tagged = 0
    for (let i = 0; i < updates.length; i += 400) {
      const chunk = updates.slice(i, i + 400)
      const batch = db.batch()
      for (const u of chunk) {
        batch.update(db.doc(`users/${uid}/items/${u.id}`), {
          autoQuietedReason: u.reason,
          updatedAt:         now,
        })
      }
      await batch.commit()
      tagged += chunk.length
    }

    console.log(`[backfill-promotional] uid=${uid.slice(0,8)} inspected=${inspected} tagged=${tagged}`)
    return NextResponse.json({ success: true, inspected, tagged })
  } catch (err: any) {
    console.error('[backfill-promotional] error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
