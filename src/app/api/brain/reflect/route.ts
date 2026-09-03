/**
 * POST /api/brain/reflect
 *
 * Stage 4 — see docs/relevance-brain-design.md §3 (L5).
 *
 * Reads the evidence log, summarises what the user has actually DONE, and generates a
 * candidate narrative profile. Stores it as a candidate. Does not promote it, and
 * nothing reads a candidate.
 *
 * WHY GENERATION AND PROMOTION ARE SEPARATE. This is the one layer that can regress
 * silently. A wrong score is visible on screen; a buried item is countable; a profile
 * that has drifted into a false belief about someone produces fluent, plausible output
 * that is quietly worse, and there is no obvious signal. So a candidate is written,
 * versioned and shown — and a human decides.
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
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'
import {
  summariseEvidence, hasEnoughEvidence, buildProfilePrompt, validateCandidate,
  MIN_EVENTS_FOR_PROFILE,
} from '@/lib/server/reflection'

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

async function reflectUser(uid: string, force: boolean) {
  const summary = await summariseEvidence(db, uid)

  if (!force && !hasEnoughEvidence(summary)) {
    return {
      uid, generated: false,
      reason: `only ${summary.events} events; need ${MIN_EVENTS_FOR_PROFILE}`,
      summary: { events: summary.events, engaged: summary.engaged.length, dismissed: summary.dismissed.length },
    }
  }

  const { text } = await aiComplete(db, buildProfilePrompt(summary), 500)
  const check = validateCandidate(text)
  if (!check.ok) {
    return { uid, generated: false, reason: `candidate rejected: ${check.reason}` }
  }

  // Versioned, never overwritten: a profile's history is how drift becomes visible.
  const candidateRef = db.collection(`users/${uid}/brain/profile/candidates`).doc()
  await candidateRef.set({
    markdown: text.trim(),
    generatedAt: Timestamp.now(),
    basedOn: {
      events: summary.events,
      engaged: summary.engaged.length,
      dismissed: summary.dismissed.length,
      overturnedRules: summary.overturnedRules,
    },
    promoted: false,
  })

  return {
    uid, generated: true, candidateId: candidateRef.id,
    markdown: text.trim(),
    basedOn: { events: summary.events, engaged: summary.engaged.length, dismissed: summary.dismissed.length },
    note: 'candidate only — not promoted, and nothing reads a candidate',
  }
}

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-secret') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }
  const { uid, force = false } = await req.json()
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 })
  return NextResponse.json(await reflectUser(uid, force))
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
    try { results.push(await reflectUser(u.id, false)) }
    catch (e) { results.push({ uid: u.id, generated: false, reason: String(e).slice(0, 120) }) }
  }
  return NextResponse.json({ users: users.size, generated: results.filter(r => r.generated).length, results })
}
