/**
 * goldenset.mjs — build the evaluation golden set from existing user judgement.
 *
 *   npm run eval:recon    # read-only: report what judgement data exists
 *   npm run eval:build    # write candidates to users/{uid}/evals/goldenSet/entries
 *
 * See docs/relevance-brain-design.md §4.1 and §9 (Stage 1).
 *
 * The golden set needs the user's judgement attached to real threads. Rather than
 * asking for 200 fresh labels, this harvests judgement already expressed in the app
 * over months of use: a manually-set priority band is an explicit correction of our
 * score; a manually-ignored item is a hard negative; an item restored out of
 * auto-quiet says a quiet rule mis-fired.
 *
 * Entries are frozen snapshots — eval runs happen weeks later, by which time the
 * item may be re-classified, merged or gone.
 *
 * ACCESS: reads .env.local for Admin SDK credentials (values are never printed) and
 * connects to the live keel-6921a Firestore. Read-only unless --build is passed.
 */

import { readFileSync } from 'node:fs'
import admin from 'firebase-admin'

const MODE = process.argv.includes('--build') ? 'build' : 'recon'

// Load .env.local into process.env without printing any values.
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=([\s\S]*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  }),
})
const db = admin.firestore()

/**
 * Derive a label from judgement the user has already expressed.
 * Ordered strongest-first; the first match wins and records why.
 */
function label(it) {
  if (it.autoQuietedReason && !['quietly_logged', 'archived'].includes(it.status))
    return { verdict: 'should_surface', source: 'restored_from_autoquiet',
             strength: 'strong', note: `auto-quiet rule "${it.autoQuietedReason}" mis-fired` }
  if (it.manuallyIgnored === true)
    return { verdict: 'should_quiet', source: 'manually_ignored', strength: 'strong' }
  if (it.manualPriority === true)
    return { verdict: 'score_is', source: 'manual_priority', strength: 'strong',
             score: it.aiImportanceScore ?? null }
  if (it.userNote)
    return { verdict: 'should_surface', source: 'user_note', strength: 'medium' }
  if (it.status === 'paid')
    return { verdict: 'was_actionable', source: 'marked_paid', strength: 'medium' }
  if (it.status === 'done')
    return { verdict: 'was_actionable', source: 'marked_done', strength: 'weak' }
  return null
}

/**
 * Weak labels are excluded from the golden set by default.
 *
 * marked_done is the big one: everything actionable eventually gets marked done,
 * so it says nothing about whether the priority was right or whether the item
 * should have surfaced. At 90% of harvestable labels it would dominate the set and
 * make any eval score ~95% while measuring nothing. Pass --include-weak to override.
 */
const INCLUDE_WEAK = process.argv.includes('--include-weak')
const usable = (lb) => lb && (INCLUDE_WEAK || lb.strength !== 'weak')

/** Corpus shape — sizes the hand-labelling task that the harvest cannot replace. */
function corpusShape(items) {
  const byStatus = {}, byQuietReason = {}, byBand = {}
  let quietTotal = 0, stamped = 0
  for (const it of items) {
    byStatus[it.status ?? 'undefined'] = (byStatus[it.status ?? 'undefined'] ?? 0) + 1
    if (it.overridesVersion !== undefined) stamped++
    const s = it.aiImportanceScore ?? 0.5
    const band = s >= 0.85 ? '4 urgent' : s >= 0.70 ? '3 high' : s >= 0.40 ? '2 med' : '1 low'
    byBand[band] = (byBand[band] ?? 0) + 1
    if (it.status === 'quietly_logged') {
      quietTotal++
      // quietedBy is the unified cause. Fall back to the two older partial markers
      // so the pre-provenance corpus is still attributable: autoQuietedReason names
      // an override rule, expiredBy names a lifecycle expiry. Anything left really
      // is unattributed — almost certainly the model's own call at scan time.
      const r = it.quietedBy
        ?? (it.autoQuietedReason ? `rule:${it.autoQuietedReason}` : null)
        ?? (it.expiredBy ? `expiry(legacy):${it.expiredBy}` : null)
        ?? '(unattributed)'
      byQuietReason[r] = (byQuietReason[r] ?? 0) + 1
    }
  }
  return { byStatus, byQuietReason, byBand, quietTotal, stamped }
}

/**
 * Score distribution WITHIN each quiet cause.
 *
 * The question this answers: is a quiet mechanism burying items the system itself
 * judged important? A time-based expiry has no relevance input at all — it fires on
 * age alone — so if band 3/4 items are being aged out, the rule is silencing exactly
 * the mail Keel exists to surface. aiImportanceScore survives the transition, so this
 * is measurable from the existing corpus with no labelling.
 */
function bandsByCause(items) {
  const out = {}
  for (const it of items) {
    if (it.status !== 'quietly_logged') continue
    const cause = it.quietedBy
      ?? (it.autoQuietedReason ? `rule:${it.autoQuietedReason}` : null)
      ?? (it.expiredBy ? `expiry(legacy):${it.expiredBy}` : null)
      ?? '(unattributed)'
    const sc = it.aiImportanceScore ?? 0.5
    const band = sc >= 0.85 ? 'urgent' : sc >= 0.70 ? 'high' : sc >= 0.40 ? 'med' : 'low'
    ;(out[cause] ??= { low: 0, med: 0, high: 0, urgent: 0, n: 0 })
    out[cause][band]++
    out[cause].n++
  }
  return out
}

const users = await db.collection('users').get()
const totals = { items: 0, labelled: 0 }
const bySource = {}

for (const u of users.docs) {
  const snap = await db.collection(`users/${u.id}/items`).get()
  if (snap.size === 0) continue

  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  const labelled = items.map(it => ({ it, lb: label(it) })).filter(x => usable(x.lb))
  const shape = corpusShape(items)
  totals.items += items.length
  totals.labelled += labelled.length
  for (const { lb } of labelled) bySource[lb.source] = (bySource[lb.source] ?? 0) + 1

  console.log(`\nuid ${u.id.slice(0, 8)}…  items=${items.length}  labelled=${labelled.length}`)
  const counts = {}
  for (const { lb } of labelled) counts[lb.source] = (counts[lb.source] ?? 0) + 1
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(v).padStart(4)}  ${k}`)

  // Which auto-quiet rules were overturned — the highest-value signal we hold.
  const overturned = {}
  for (const { it, lb } of labelled)
    if (lb.source === 'restored_from_autoquiet')
      overturned[it.autoQuietedReason] = (overturned[it.autoQuietedReason] ?? 0) + 1
  if (Object.keys(overturned).length)
    console.log(`    overturned auto-quiets: ${JSON.stringify(overturned)}`)

  console.log(`    coverage: aiDetailedSummary=${labelled.filter(x => x.it.aiDetailedSummary).length}`
            + `  overridesVersion stamped (whole corpus)=${shape.stamped}/${items.length}`)

  console.log(`    status     : ${Object.entries(shape.byStatus).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join('  ')}`)
  console.log(`    score band : ${Object.entries(shape.byBand).sort().map(([k,v])=>`${k}=${v}`).join('  ')}`)
  // What was silenced, for the expiry paths — burying a stale `new` is housekeeping;
  // burying a stale `awaiting_action` is the failure Keel exists to prevent.
  const fromStatus = {}
  for (const it of items) {
    if (it.status !== 'quietly_logged') continue
    const cause = it.quietedBy
      ?? (it.autoQuietedReason ? `rule:${it.autoQuietedReason}` : null)
      ?? (it.expiredBy ? `expiry(legacy):${it.expiredBy}` : null)
      ?? '(unattributed)'
    const from = it.quietedFromStatus ?? '(not recorded)'
    ;(fromStatus[cause] ??= {})[from] = ((fromStatus[cause] ??= {})[from] ?? 0) + 1
  }

  const bands = bandsByCause(items)
  console.log(`    quietly_logged=${shape.quietTotal}, by reason (score bands of what was silenced):`)
  for (const [k, v] of Object.entries(shape.byQuietReason).sort((a,b)=>b[1]-a[1])) {
    const b = bands[k] ?? { low:0, med:0, high:0, urgent:0, n:0 }
    const notable = b.high + b.urgent
    const pct = b.n ? Math.round((notable / b.n) * 100) : 0
    console.log(`        ${String(v).padStart(5)}  ${k.padEnd(40)}`
              + `low=${String(b.low).padStart(4)} med=${String(b.med).padStart(4)}`
              + ` high=${String(b.high).padStart(4)} urgent=${String(b.urgent).padStart(4)}`
              + `   high+urgent=${pct}%`)
    const fs = fromStatus[k]
    if (fs && !(Object.keys(fs).length === 1 && fs['(not recorded)']))
      console.log(`               from: ${Object.entries(fs).sort((a,b)=>b[1]-a[1]).map(([s,c])=>`${s}=${c}`).join('  ')}`)
  }

  if (MODE === 'build') {
    const sigSnap = await db.collection(`users/${u.id}/signals`).get()
    const sigsByItem = {}
    for (const s of sigSnap.docs) {
      const d = s.data()
      ;(sigsByItem[d.itemId] ??= []).push({
        type: d.type, description: d.description,
        detectedDate: d.detectedDate?.toDate?.()?.toISOString?.() ?? null,
        detectedAmount: d.detectedAmount ?? null, calendarStatus: d.calendarStatus ?? null,
      })
    }
    let written = 0
    for (const { it, lb } of labelled) {
      await db.doc(`users/${u.id}/evals/goldenSet/entries/${it.itemId}`).set({
        itemId: it.itemId, threadId: it.threadId ?? null,
        capturedAt: admin.firestore.Timestamp.now(),
        label: lb,
        frozen: {
          senderEmail: it.senderEmail ?? null, senderName: it.senderName ?? null,
          subject: it.subject ?? null,
          receivedAt: it.receivedAt?.toDate?.()?.toISOString?.() ?? null,
          aiTitle: it.aiTitle ?? null, aiSummary: it.aiSummary ?? null,
          aiDetailedSummary: it.aiDetailedSummary ?? null,
          status: it.status ?? null, aiImportanceScore: it.aiImportanceScore ?? null,
          categoryId: it.categoryId ?? null, categoryName: it.categoryName ?? null,
          autoQuietedReason: it.autoQuietedReason ?? null,
          manualPriority: it.manualPriority ?? false,
          manuallyIgnored: it.manuallyIgnored ?? false,
          isOutbound: it.isOutbound ?? false,
          overridesVersion: it.overridesVersion ?? null,
          signals: sigsByItem[it.itemId] ?? [],
        },
      }, { merge: true })
      written++
    }
    console.log(`    WROTE ${written} entries to users/${u.id}/evals/goldenSet/entries`)
  }
}

console.log(`\n── totals ──`)
console.log(`items scanned : ${totals.items}`)
console.log(`labelled      : ${totals.labelled}`)
for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(v).padStart(4)}  ${k}`)
if (MODE === 'recon') console.log('\n(recon only — nothing written. Pass --build to write.)')
process.exit(0)
