/**
 * POST /api/admin/restore-cal-quieted
 *
 * One-shot recovery: finds items previously auto-quieted by the calendar-match
 * downgrade (autoQuietedReason='on_calendar', status='quietly_logged') and
 * restores them to status='new' with a Medium score. Use after the calendar-match
 * rule was softened from full-quiet to score-down-only — surfaces school events,
 * appointments etc. that got swept off the dashboard.
 *
 * Body: { uid: string }  — single user
 * Auth: x-keel-admin-secret header
 *
 * Safe to run multiple times — won't touch items the user has since manually
 * resolved (done/archived) or items without the on_calendar tag.
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
      .where('autoQuietedReason', '==', 'on_calendar')
      .where('status',            '==', 'quietly_logged')
      .get()

    let inspected = 0
    const now = Timestamp.now()
    const restoreIds: string[] = []

    for (const d of snap.docs) {
      inspected++
      const data = d.data()
      if (data.manualPriority === true) continue
      restoreIds.push(d.id)
    }

    let restored = 0
    for (let i = 0; i < restoreIds.length; i += 400) {
      const chunk = restoreIds.slice(i, i + 400)
      const batch = db.batch()
      for (const id of chunk) {
        batch.update(db.doc(`users/${uid}/items/${id}`), {
          status:            'new',
          aiImportanceScore: 0.45,
          updatedAt:         now,
        })
      }
      await batch.commit()
      restored += chunk.length
    }

    console.log(`[restore-cal-quieted] uid=${uid.slice(0,8)} inspected=${inspected} restored=${restored}`)
    return NextResponse.json({ success: true, inspected, restored })
  } catch (err: any) {
    console.error('[restore-cal-quieted] error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
