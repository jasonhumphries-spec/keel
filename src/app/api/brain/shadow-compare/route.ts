/**
 * POST /api/brain/shadow-compare
 *
 * The decisive Stage 2 comparison — see docs/relevance-brain-design.md §9.4.
 *
 * The first shadow run had two caveats that mattered: extraction read the OLD
 * prompt's summaries rather than raw threads (a lossy paraphrase), and every item was
 * High/Urgent by construction, so it measured ranking inside a compressed band. This
 * run removes both: it pulls the real thread from Gmail and samples across all four
 * bands.
 *
 * Runs BOTH classifiers over the SAME thread text so the difference is the scoring
 * approach and nothing else. Imports the shipped `extraction.ts` and `scoring.ts`
 * rather than restating them — a reimplementation would stop describing the code that
 * actually runs, which is the failure mode this codebase has hit three times.
 *
 * Writes nothing. Switching is a separate decision.
 *
 * Body: { uid, perBand?, months? }
 * Auth: ADMIN_SECRET via x-admin-secret.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getValidAccessToken } from '@/lib/server/tokenUtils'
import { aiComplete } from '@/lib/aiComplete'
import { classifyThread, buildThreadContext } from '@/lib/scanUtils'
import { buildExtractionPrompt, parseExtraction } from '@/lib/extraction'
import { scoreFromFacts, bandOf } from '@/lib/scoring'

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

type Band = 'low' | 'med' | 'high' | 'urgent'

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-secret') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }
  const { uid, perBand = 25, repeats = 1 } = await req.json()
  // repeats > 1 runs extraction N times over the SAME thread to measure how much of
  // any agreement change is scoring difference and how much is model variance. Without
  // this number, a 5-point move between runs cannot be told from noise.
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 })

  const token = await getValidAccessToken(db, uid)
  if (!token) return NextResponse.json({ error: 'no valid Gmail token' }, { status: 400 })

  const [itemsSnap, catsSnap, acctDoc, labelSnap] = await Promise.all([
    db.collection(`users/${uid}/items`).get(),
    db.collection(`users/${uid}/categories`).where('archived', '==', false).get(),
    db.doc(`users/${uid}/accounts/account_primary`).get(),
    db.collection(`users/${uid}/evals/goldenSet/entries`).get(),
  ])
  const accountEmail = String(acctDoc.data()?.email ?? '').toLowerCase()
  const categories = catsSnap.docs.map(d => ({
    id: d.id, name: d.data().name ?? '', description: d.data().description ?? '',
  }))
  // Human verdicts, where they exist — the only ground truth available.
  const truth = new Map<string, string>()
  for (const d of labelSnap.docs) {
    const v = d.data()?.humanLabel?.verdict
    if (v) truth.set(d.id, v)
  }

  // Stratified sample: equal numbers per band, so Low and Medium are represented
  // rather than drowned by the 90% of the corpus that is quiet.
  const byBand: Record<Band, Array<{ id: string; d: FirebaseFirestore.DocumentData }>> =
    { low: [], med: [], high: [], urgent: [] }
  for (const doc of itemsSnap.docs) {
    const d = doc.data()
    if (!d.threadId) continue
    byBand[bandOf(Number(d.aiImportanceScore ?? 0))].push({ id: doc.id, d })
  }
  const sample: Array<{ id: string; d: FirebaseFirestore.DocumentData; band: Band }> = []
  for (const b of ['low', 'med', 'high', 'urgent'] as Band[]) {
    const pool = byBand[b]
    // Deterministic stride sample rather than random, so a re-run is comparable.
    const stride = Math.max(1, Math.floor(pool.length / perBand))
    for (let i = 0; i < pool.length && sample.filter(s => s.band === b).length < perBand; i += stride) {
      sample.push({ ...pool[i], band: b })
    }
  }

  const rows: Array<Record<string, unknown>> = []
  const failures: string[] = []
  const today = new Date().toISOString().slice(0, 10)

  for (let i = 0; i < sample.length; i += 4) {
    const chunk = sample.slice(i, i + 4)
    await Promise.all(chunk.map(async ({ id, d, band }) => {
      try {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${d.threadId}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) { failures.push(`${id}: gmail ${res.status}`); return }
        const thread = await res.json()
        const body = buildThreadContext(thread)
        if (!body) { failures.push(`${id}: empty thread`); return }

        const from = String(d.senderEmail ?? '')
        const subject = String(d.subject ?? '')

        // Both scorers, same text, same moment.
        const extractionPrompt = buildExtractionPrompt({ subject, from, threadBody: body, todayISO: today })
        const [oldRes, ...newRuns] = await Promise.all([
          classifyThread(db, subject, from, body, categories, [], true,
                         d.isOutbound ?? false, true, accountEmail),
          ...Array.from({ length: Math.max(1, repeats) },
                        () => aiComplete(db, extractionPrompt, 700)),
        ])
        const allFacts = newRuns.map(r => parseExtraction(r.text, today)).filter(f => f !== null)
        const facts = allFacts[0]
        if (!oldRes || !facts) { failures.push(`${id}: ${!oldRes ? 'old' : 'new'} classifier returned nothing`); return }
        const scored = scoreFromFacts(facts)
        const repeatBands = allFacts.map(f => bandOf(scoreFromFacts(f).score))

        rows.push({
          itemId: id, storedBand: band,
          oldScore: oldRes.aiImportanceScore, oldBand: bandOf(oldRes.aiImportanceScore),
          newScore: scored.score, newBand: bandOf(scored.score),
          obligation: facts.obligation, consequence: facts.consequence,
          daysToDue: facts.daysToDue, isNoise: facts.isNoise,
          reason: scored.reason,
          truth: truth.get(id) ?? null,
          title: d.aiTitle ?? subject, from,
          ...(repeats > 1 ? {
            repeatBands,
            repeatStable: repeatBands.every(b => b === repeatBands[0]),
            repeatObligations: allFacts.map(f => f.obligation),
          } : {}),
        })
      } catch (e) {
        failures.push(`${id}: ${String(e).slice(0, 60)}`)
      }
    }))
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const agree = rows.filter(r => r.oldBand === r.newBand).length
  const byStored: Record<string, { n: number; agree: number }> = {}
  for (const r of rows) {
    const k = String(r.storedBand)
    byStored[k] ??= { n: 0, agree: 0 }
    byStored[k].n++
    if (r.oldBand === r.newBand) byStored[k].agree++
  }

  const labelled = rows.filter(r => r.truth)
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
  const keep = labelled.filter(r => r.truth === 'keep')
  const bury = labelled.filter(r => r.truth === 'bury')
  const separation = keep.length && bury.length ? {
    old: +(mean(keep.map(r => Number(r.oldScore))) - mean(bury.map(r => Number(r.oldScore)))).toFixed(3),
    new: +(mean(keep.map(r => Number(r.newScore))) - mean(bury.map(r => Number(r.newScore)))).toFixed(3),
    n: { keep: keep.length, bury: bury.length },
  } : null

  return NextResponse.json({
    compared: rows.length,
    failed: failures.length,
    failures: failures.slice(0, 8),
    bandAgreement: rows.length ? +(agree / rows.length).toFixed(3) : 0,
    ...(repeats > 1 ? {
      // The floor on any agreement figure: if the same input lands in different bands
      // across repeats, that share of disagreement is variance, not signal.
      repeatStability: +(rows.filter(r => r.repeatStable).length / Math.max(1, rows.length)).toFixed(3),
    } : {}),
    agreementByStoredBand: byStored,
    /** Truth-anchored, on whatever slice of the sample carries a human verdict. */
    separationOnLabelled: separation,
    rows,
  })
}
