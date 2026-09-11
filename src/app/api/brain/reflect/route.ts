/**
 * POST /api/brain/reflect
 *
 * Stage 4 — see docs/relevance-brain-design.md §3 (L5) and §14.
 *
 * Reads the evidence log, summarises what the user has actually DONE, and generates a
 * draft narrative profile for review. Generation lives in
 * src/lib/server/reflection.ts (`generateProfileCandidate`) so the nightly sweep and
 * the user's own "generate a new draft" button share one implementation.
 *
 * WHY GENERATION AND PROMOTION ARE SEPARATE. This is the one layer that can regress
 * silently. A wrong score is visible on screen; a buried item is countable; a profile
 * that has drifted into a false belief about someone produces fluent, plausible output
 * that is quietly worse, and there is no obvious signal. So a draft is written,
 * versioned and shown — and a human decides, in "What keel has learned".
 *
 * WHAT REACHES THE MODEL. Action counts, sender addresses and rule-override tallies.
 * Never email bodies, subjects or summaries. The profile is destined for a prompt, so
 * anything in it is effectively an instruction; keeping mail content out closes the
 * path from a stranger's email to the classifier's behaviour.
 *
 * Body: { uid, force? }   force bypasses the evidence threshold, for inspection only.
 * Auth: ADMIN_SECRET via x-admin-secret, or CRON_SECRET bearer on GET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'
import { generateProfileCandidate } from '@/lib/server/reflection'

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
  const { uid, force = false } = await req.json()
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 })
  return NextResponse.json(await generateProfileCandidate(db, uid, aiComplete, { force }))
}

/** Scheduled sweep. Same auth shape as the expiry review. */
export async function GET(req: NextRequest) {
  const bearer = req.headers.get('authorization')
  const cronOk = !!process.env.CRON_SECRET && bearer === `Bearer ${process.env.CRON_SECRET}`
  const adminOk = req.headers.get('x-admin-secret') === process.env.ADMIN_SECRET
  if (!cronOk && !adminOk) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  const users = await db.collection('users').get()
  const results = []
  for (const u of users.docs) {
    try { results.push(await generateProfileCandidate(db, u.id, aiComplete)) }
    catch (e) { results.push({ uid: u.id, generated: false, reason: String(e).slice(0, 120) }) }
  }
  return NextResponse.json({ users: users.size, generated: results.filter(r => r.generated).length, results })
}
