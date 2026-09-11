/**
 * /api/brain/learned — backs the "What keel has learned" view. See docs §15.
 *
 * GET   the user's draft and active profile, learned weightings, and what they change.
 * POST  { action: 'generate' }                               a fresh draft profile
 *       { action: 'promote', candidateId, markdown? }        approve, optionally edited
 *       { action: 'reject',  candidateId }                   discard a draft
 *
 * AUTH. uid comes from a verified Firebase ID token, never from the body.
 *
 * WHY THE SERVER. The client may read its own brain (firestore.rules), but never write
 * it: an approved profile is destined for a prompt, so approval runs the same budget and
 * instruction-like checks as generation, and that cannot be left to the browser.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { aiComplete } from '@/lib/aiComplete'
import {
  summariseEvidence, bulletBudget, hasEnoughEvidence, MIN_EVENTS_FOR_PROFILE,
  generateProfileCandidate, candidateStatus,
} from '@/lib/server/reflection'
import {
  summariseWeightings, summariseEffects, checkReview, describeCandidate, nextGenerationAt,
  LIFTED_QUERY_LIMIT, PROFILE_USED_IN_SCORING, type ReviewAction,
} from '@/lib/server/learned'

export const maxDuration = 60

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

async function verifiedUid(req: NextRequest): Promise<string | null> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  try { return (await getAuth().verifyIdToken(token)).uid } catch { return null }
}

type Stamp = { toDate?: () => Date } | null | undefined
const dateOf = (t: unknown): Date | null => (t as Stamp)?.toDate?.() ?? null
const isoOf  = (t: unknown): string | null => dateOf(t)?.toISOString() ?? null

export async function GET(req: NextRequest) {
  const uid = await verifiedUid(req)
  if (!uid) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  const items = db.collection(`users/${uid}/items`)
  const [priorsSnap, candSnap, profileSnap, liftedSnap, consultedAgg, newestSnap, evidence] = await Promise.all([
    db.collection(`users/${uid}/priors`).get(),
    db.collection(`users/${uid}/brain/profile/candidates`).orderBy('generatedAt', 'desc').limit(20).get(),
    db.doc(`users/${uid}/brain/profile`).get(),
    items.where('senderPriorLift', '>', 0).orderBy('senderPriorLift', 'desc').limit(LIFTED_QUERY_LIMIT).get(),
    items.where('senderPriorSource', 'in', ['sender', 'domain']).count().get(),
    items.orderBy('createdAt', 'desc').limit(1).get(),
    summariseEvidence(db, uid),
  ])

  const now = new Date()
  const candidates = candSnap.docs.map(d => ({ id: d.id, data: d.data() }))
  const pending = candidates.find(c => candidateStatus(c.data) === 'pending')
  const active  = profileSnap.exists ? profileSnap.data()?.active ?? null : null

  const gateOpen = hasEnoughEvidence(evidence)
  const cooldownUntil = nextGenerationAt(dateOf(candidates[0]?.data.generatedAt), now)

  return NextResponse.json({
    evidence: {
      events:    evidence.events,
      budget:    bulletBudget(evidence.events),
      minEvents: MIN_EVENTS_FOR_PROFILE,
      gateOpen,
    },
    profile: {
      active: active ? {
        markdown:    String(active.markdown ?? ''),
        candidateId: active.candidateId ?? null,
        promotedAt:  isoOf(active.promotedAt),
        edited:      active.edited === true,
      } : null,
      pending: pending ? {
        id: pending.id,
        generatedAt: isoOf(pending.data.generatedAt),
        ...describeCandidate(pending.data),
      } : null,
      history: candidates
        .filter(c => candidateStatus(c.data) !== 'pending')
        .slice(0, 6)
        .map(c => ({
          id: c.id, status: candidateStatus(c.data),
          generatedAt: isoOf(c.data.generatedAt), reviewedAt: isoOf(c.data.reviewedAt),
        })),
      usedInScoring: PROFILE_USED_IN_SCORING,
    },
    generation: {
      allowed: gateOpen && !cooldownUntil,
      reason:  !gateOpen
        ? `Needs ${MIN_EVENTS_FOR_PROFILE} actions to learn from — ${evidence.events} so far`
        : cooldownUntil ? 'A draft was generated in the last few minutes' : null,
      nextAt:  cooldownUntil?.toISOString() ?? null,
    },
    weightings: summariseWeightings(priorsSnap.docs.map(d => d.data())),
    effects: summariseEffects(
      liftedSnap.docs.map(d => {
        const v = d.data()
        return {
          title:  String(v.aiTitle ?? v.subject ?? ''),
          sender: String(v.senderEmail ?? ''),
          lift:   Number(v.senderPriorLift ?? 0),
          at:     dateOf(v.updatedAt) ?? dateOf(v.createdAt),
        }
      }),
      {
        consulted:       consultedAgg.data().count,
        lastProcessedAt: newestSnap.empty ? null : dateOf(newestSnap.docs[0].data().createdAt),
        now,
      },
    ),
  })
}

class ReviewError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function POST(req: NextRequest) {
  const uid = await verifiedUid(req)
  if (!uid) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { action?: string; candidateId?: string; markdown?: unknown }
  const candidatesCol = db.collection(`users/${uid}/brain/profile/candidates`)

  if (body.action === 'generate') {
    const latest = await candidatesCol.orderBy('generatedAt', 'desc').limit(1).get()
    const cooldownUntil = nextGenerationAt(latest.empty ? null : dateOf(latest.docs[0].data().generatedAt), new Date())
    if (cooldownUntil) {
      return NextResponse.json({ error: 'cooldown', nextAt: cooldownUntil.toISOString() }, { status: 429 })
    }
    // A deliberate re-roll: the user is asking for a fresh draft even if one exists.
    return NextResponse.json(await generateProfileCandidate(db, uid, aiComplete, { skipIfUnchanged: false }))
  }

  if (body.action !== 'promote' && body.action !== 'reject') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }
  const action: ReviewAction = body.action
  const candidateId = String(body.candidateId ?? '')
  if (!candidateId || candidateId.includes('/')) {
    return NextResponse.json({ error: 'candidateId required' }, { status: 400 })
  }
  const edited = typeof body.markdown === 'string' ? body.markdown : undefined

  const candRef    = candidatesCol.doc(candidateId)
  const profileRef = db.doc(`users/${uid}/brain/profile`)

  try {
    const result = await db.runTransaction(async tx => {
      const [candSnap, profSnap] = await Promise.all([tx.get(candRef), tx.get(profileRef)])
      if (!candSnap.exists) throw new ReviewError('no such draft', 404)
      const c = candSnap.data()!

      const check = checkReview(c, action, edited)
      if (!check.ok) throw new ReviewError(check.reason, check.code === 'not_pending' ? 409 : 422)

      const now = Timestamp.now()
      if (action === 'reject') {
        tx.update(candRef, { status: 'rejected', reviewedAt: now })
        return { status: 'rejected' as const }
      }

      const previousId = profSnap.exists ? profSnap.data()?.active?.candidateId : null
      if (previousId && previousId !== candidateId) {
        tx.set(candidatesCol.doc(String(previousId)),
          { status: 'superseded', supersededAt: now, supersededBy: candidateId }, { merge: true })
      }
      tx.set(profileRef, {
        active: {
          markdown: check.markdown, candidateId, promotedAt: now,
          edited: check.edited, basedOn: c.basedOn ?? null,
        },
        updatedAt: now,
      }, { merge: true })
      tx.update(candRef, {
        status: 'promoted', promoted: true, reviewedAt: now,
        ...(check.edited ? { editedMarkdown: check.markdown } : {}),
      })
      return { status: 'promoted' as const, edited: check.edited }
    })
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof ReviewError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
