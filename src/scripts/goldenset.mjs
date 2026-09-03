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

const UID_ARG = (() => {
  const i = process.argv.indexOf('--uid')
  return i !== -1 ? process.argv[i + 1] : null
})()

const MODE = process.argv.includes('--build')      ? 'build'
           : process.argv.includes('--whoami')     ? 'whoami'
           : process.argv.includes('--eval-rule')  ? 'eval-rule'
           : process.argv.includes('--eval-content') ? 'eval-content'
           : process.argv.includes('--eval-llm')  ? 'eval-llm'
           : process.argv.includes('--show-review') ? 'show-review'
           : process.argv.includes('--save-labels') ? 'save-labels'
           : 'recon'

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

  // The labelling target. An item the system itself scored High or Urgent, then
  // silenced on an age threshold rather than any judgement about relevance. 64% of
  // all High items and 37% of Urgent went this way. Whether that was right is
  // exactly what we do not know — hence needs_review, not a verdict.
  const band = (it.aiImportanceScore ?? 0.5) >= 0.85 ? 'urgent'
             : (it.aiImportanceScore ?? 0.5) >= 0.70 ? 'high' : null
  const expired = it.quietedBy?.startsWith('expiry:') || !!it.expiredBy
  if (it.status === 'quietly_logged' && band && expired)
    return { verdict: 'needs_review', source: 'buried_by_expiry', strength: 'unlabelled',
             band, expiredBy: it.expiredBy ?? it.quietedBy ?? null }

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

const allUsers = await db.collection('users').get()
const users = { docs: UID_ARG ? allUsers.docs.filter(d => d.id === UID_ARG) : allUsers.docs }
if (UID_ARG && users.docs.length === 0) {
  console.error(`no such uid: ${UID_ARG}`); process.exit(1)
}
if (UID_ARG) console.log(`scoped to uid ${UID_ARG}`)

/**
 * --eval-llm: at expiry, ASK THE MODEL whether the obligation is still open.
 *
 * Both predicate rules failed for the same reason. Sender engagement measures
 * "do I converse with this person"; learned keywords turned out to memorise
 * "DPC Accountants matter to Jason". Neither asks the question that decides the
 * case, which is a reading-comprehension one: is there an unmet obligation here?
 *
 * The information was never missing — the classifier already read the thread and
 * called it High or Urgent. A timer then overrode that judgement without consulting
 * anything. So this tests putting the question to something that can read.
 *
 * Cost is the reason this is plausible: ~500 input tokens per item at Flash rates,
 * i.e. pennies for the whole corpus, and it runs once per item at expiry rather
 * than on every scan.
 *
 * The prompt deliberately does NOT reveal the score, the band, or that the item was
 * buried — that would leak the label it is being asked to predict.
 */
if (MODE === 'eval-llm') {
  const { readdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { GoogleGenerativeAI } = await import('@google/generative-ai')
  const dir   = process.argv[process.argv.indexOf('--labels') + 1]
  const snapF = process.argv[process.argv.indexOf('--snapshot') + 1]
  const outF  = process.argv[process.argv.indexOf('--out') + 1]

  const labels = readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')))
    .filter(l => l.verdict === 'keep' || l.verdict === 'bury')
  const snap = JSON.parse(readFileSync(snapF, 'utf8'))
  const frozen = new Map(snap.entries.map(e => [e.itemId, e.frozen ?? {}]))

  const j = (v) => Array.isArray(v) ? v.join(' ') : (v ?? '')
  const model = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY)
    .getGenerativeModel({ model: 'gemini-2.5-flash' })

  const ask = async (l, attempt = 0) => {
    const f = frozen.get(l.itemId) ?? {}
    // v2. v1 asked "is a task open?" and scored 85% recall but 29% precision: it
    // was technically right — "respond to the Vinted offer" IS an open task — and
    // still wrong, because the user does not care. The dividing line in the labels
    // is CONSEQUENCE, not openness. So ask what it costs to never do it.
    const prompt = `An email thread arrived and the account owner never acted on it. Weeks have passed. It is about to be hidden permanently.

SUBJECT: ${j(f.subject)}
FROM: ${j(f.senderEmail)}
SUMMARY: ${j(f.aiSummary)}
DETAIL: ${j(f.aiDetailedSummary).slice(0, 900)}

Question: if this thread is hidden and the account owner NEVER sees it again, is there a real cost?

Answer YES only if never dealing with it means: money stays owed or unclaimed; a legal, tax or regulatory filing stays incomplete; a document stays unsigned; medical or school administration stays unresolved; or a specific person is left waiting on a reply the owner promised.

Answer NO if it is discretionary or low-stakes, even when a task technically remains: an optional purchase, offer, renewal or upgrade; an invitation the owner can simply decline or ignore; a marketing or loyalty prompt; a survey or feedback request; an app update or account nudge; a delivery, parcel or booking that resolves itself; social plans; anything already handled, superseded, or now in the past.

The test is not "is there something to do" — almost every email has something. The test is whether a real obligation would be silently dropped.

Reply with exactly one line: YES|<six words why> or NO|<six words why>`
    try {
      const r = await model.generateContent(prompt)
      const t = (r.response.text() ?? '').trim()
      return { open: /^yes/i.test(t), why: t.split('|')[1]?.trim().slice(0, 48) ?? '' }
    } catch (e) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)))
        return ask(l, attempt + 1)
      }
      return { error: String(e).slice(0, 80) }
    }
  }

  console.log(`asking the model about ${labels.length} items…`)
  const out = []
  let failed = 0
  for (let i = 0; i < labels.length; i += 8) {
    const chunk = labels.slice(i, i + 8)
    const res = await Promise.all(chunk.map(ask))
    res.forEach((r, k) => {
      if (r.error) { failed++; return }
      out.push({ itemId: chunk[k].itemId, verdict: chunk[k].verdict, band: chunk[k].band,
                 from: chunk[k].from, title: chunk[k].title, open: r.open, why: r.why })
    })
    if (i % 80 === 0) process.stdout.write(`  ${i + chunk.length}/${labels.length}\r`)
  }
  console.log(`\nanswered ${out.length}, failed ${failed}`)
  if (outF) writeFileSync(outF, JSON.stringify(out, null, 2))

  const hash = (str) => { let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h }
  const ev = (set) => {
    let tp = 0, fp = 0, fn = 0, tn = 0
    for (const o of set) {
      if (o.verdict === 'keep') { if (o.open) tp++; else fn++ } else { if (o.open) fp++; else tn++ }
    }
    const r = tp + fn ? tp / (tp + fn) : 0, p = tp + fp ? tp / (tp + fp) : 0
    return { tp, fp, fn, tn, r, p, f1: p + r ? 2 * p * r / (p + r) : 0 }
  }
  const show = (n, m) => console.log(`${n.padEnd(24)}${String(m.tp).padStart(5)}/${String(m.tp + m.fn).padEnd(4)}`
    + `${(m.r * 100).toFixed(0).padStart(7)}%${String(m.fp).padStart(8)}/${String(m.fp + m.tn).padEnd(4)}`
    + `${(m.p * 100).toFixed(0).padStart(8)}%${m.f1.toFixed(2).padStart(7)}`)
  console.log(`\n${'set'.padEnd(24)}${'rescued'.padStart(10)}${'recall'.padStart(7)}${'wrongly kept'.padStart(13)}${'prec'.padStart(8)}${'F1'.padStart(7)}`)
  // The model was given no labels, so nothing is fitted — but the same split is
  // reported anyway, so this number is comparable with the predicate rules.
  show('held-out test', ev(out.filter(o => hash(String(o.itemId)) % 3 === 0)))
  show('train (reference)', ev(out.filter(o => hash(String(o.itemId)) % 3 !== 0)))
  show('ALL 371', ev(out))
  process.exit(0)
}

/**
 * --eval-content: test whether obligation LANGUAGE separates the wrongly-buried
 * items better than sender engagement does.
 *
 * The sender-prior rule scored 36% recall / 50% precision on held-out data. Its
 * failure mode is structural: it cannot see `noreply@` senders, and that is exactly
 * where machine-generated obligations live — e-signature requests, filing
 * rejections, statutory notices. You cannot reply to Companies House.
 *
 * The hypothesis here is that the obligation is stated in the TEXT, and is stated
 * as plainly by a robot as by a person.
 *
 * DISCRIMINATIVE TERMS ARE LEARNED FROM THE TRAIN HALF ONLY. Hand-writing a pattern
 * list would be contaminated: by this point in the session the whole labelled set
 * has been read, so "obvious" keywords are partly memorised test answers. Deriving
 * them mechanically from train, then scoring on test, is the only honest version.
 */
if (MODE === 'eval-content') {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir  = process.argv[process.argv.indexOf('--labels') + 1]
  const snapF = process.argv[process.argv.indexOf('--snapshot') + 1]
  const labels = readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')))
    .filter(l => l.verdict === 'keep' || l.verdict === 'bury')

  // Full frozen text per item — title alone is thin.
  const snap = JSON.parse(readFileSync(snapF, 'utf8'))
  const text = new Map()
  for (const e of snap.entries) {
    const f = e.frozen ?? {}
    const j = (v) => Array.isArray(v) ? v.join(' ') : (v ?? '')
    text.set(e.itemId, `${j(f.aiTitle)} ${j(f.subject)} ${j(f.aiSummary)} ${j(f.aiDetailedSummary)}`.toLowerCase())
  }

  const hash = (str) => {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h
  }
  const isTest = (l) => hash(String(l.itemId)) % 3 === 0
  const train = labels.filter(l => !isTest(l))
  const test  = labels.filter(isTest)
  console.log(`labels ${labels.length}   train ${train.length} (${train.filter(l=>l.verdict==='keep').length} keep)   test ${test.length} (${test.filter(l=>l.verdict==='keep').length} keep)`)

  // ── learn terms on TRAIN only ────────────────────────────────────────────
  const toks = (id) => [...new Set((text.get(id) ?? '').match(/[a-z][a-z-]{3,}/g) ?? [])]
  const inKeep = new Map(), inBury = new Map()
  let nKeep = 0, nBury = 0
  for (const l of train) {
    const bag = toks(l.itemId)
    if (l.verdict === 'keep') { nKeep++; for (const t of bag) inKeep.set(t, (inKeep.get(t) ?? 0) + 1) }
    else                      { nBury++; for (const t of bag) inBury.set(t, (inBury.get(t) ?? 0) + 1) }
  }
  // Smoothed log-odds; require the term to appear in at least 4 train keeps so a
  // single memorable email cannot mint a rule.
  const scored = []
  for (const [t, k] of inKeep) {
    if (k < 4) continue
    const b = inBury.get(t) ?? 0
    const pk = (k + 0.5) / (nKeep + 1), pb = (b + 0.5) / (nBury + 1)
    scored.push({ t, k, b, lo: Math.log(pk / pb) })
  }
  scored.sort((a, b) => b.lo - a.lo)
  const TOP = scored.slice(0, 25)
  console.log(`\nterms learned from TRAIN (${nKeep} keep / ${nBury} bury), top 25 by log-odds:`)
  for (const x of TOP) console.log(`   ${x.lo.toFixed(2).padStart(6)}  ${x.t.padEnd(18)} keep ${String(x.k).padStart(3)}  bury ${String(x.b).padStart(3)}`)

  const terms = new Set(TOP.map(x => x.t))
  const hits = (id) => toks(id).filter(t => terms.has(t)).length

  // sender prior, for the union test
  const snapPri = await db.collection(`users/${UID_ARG}/priors`).get()
  const priors = new Map()
  for (const d of snapPri.docs) { const v = d.data(); if (v?.senderEmail) priors.set(v.senderEmail.toLowerCase(), v) }
  const senderScore = (from) => priors.get(String(from ?? '').toLowerCase())?.smoothedReplyRate ?? 0

  const evaluate = (set, pred) => {
    let tp = 0, fp = 0, fn = 0, tn = 0
    for (const l of set) {
      const keep = pred(l)
      if (l.verdict === 'keep') { if (keep) tp++; else fn++ } else { if (keep) fp++; else tn++ }
    }
    const r = tp + fn ? tp / (tp + fn) : 0, p = tp + fp ? tp / (tp + fp) : 0
    return { tp, fp, fn, tn, r, p, f1: p + r ? 2 * p * r / (p + r) : 0 }
  }
  const row = (name, m, total) => console.log(
    `${name.padEnd(30)}${String(m.tp).padStart(6)}/${String(m.tp + m.fn).padEnd(4)}`
    + `${(m.r * 100).toFixed(0).padStart(7)}%${String(m.fp).padStart(9)}/${String(m.fp + m.tn).padEnd(4)}`
    + `${(m.p * 100).toFixed(0).padStart(8)}%${m.f1.toFixed(2).padStart(7)}`)

  const header = (t) => {
    console.log(`\n${t}`)
    console.log(`${'rule'.padEnd(30)}${'rescued'.padStart(11)}${'recall'.padStart(7)}${'wrongly kept'.padStart(14)}${'prec'.padStart(8)}${'F1'.padStart(7)}`)
  }
  // choose the hit-count cutoff on train
  header('TRAIN — choosing the cutoff')
  let bestN = 1, bestF = -1
  for (const n of [1, 2, 3, 4]) {
    const m = evaluate(train, l => hits(l.itemId) >= n)
    row(`content: >=${n} term(s)`, m)
    if (m.f1 > bestF) { bestF = m.f1; bestN = n }
  }
  console.log(`\nchosen on train: >=${bestN} term(s)`)

  header('TEST — held out')
  const c = evaluate(test, l => hits(l.itemId) >= bestN)
  row(`content: >=${bestN} term(s)`, c)
  const sOnly = evaluate(test, l => senderScore(l.from) >= 0.15)
  row('sender prior >= 0.15', sOnly)
  const union = evaluate(test, l => hits(l.itemId) >= bestN || senderScore(l.from) >= 0.15)
  row('content OR sender', union)
  const inter = evaluate(test, l => hits(l.itemId) >= bestN && senderScore(l.from) >= 0.15)
  row('content AND sender', inter)
  process.exit(0)
}

/**
 * --eval-rule: score a proposed fix against real human labels.
 *
 * The rule under test: exempt an item from stale expiry when its sender's reply
 * prior clears a threshold. The claim is that obligations without dates — an
 * outstanding invoice, an e-signature request — come from people the user
 * demonstrably answers, so sender engagement separates the items that should have
 * stayed from the ones correctly buried.
 *
 * Labels come from the review artifact (keep = should have stayed, bury = fine to
 * bury). Priors come from users/{uid}/priors, written by the backfill.
 *
 * This is the first eval in the project that scores a proposed behaviour change
 * against ground truth rather than against one email someone happened to look at.
 *
 * TRAIN/TEST SPLIT. The threshold is chosen on the train half and reported on the
 * held-out half. Sweeping thresholds on all the labels and quoting the best one
 * would fit the knob to the same data used to score it, and the number would be
 * optimistic by an unknown margin — the precise self-deception this project exists
 * to avoid. The split is a hash of itemId, so it is deterministic, stable as more
 * labels arrive, and independent of label order or verdict.
 */
if (MODE === 'eval-rule') {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = process.argv[process.argv.indexOf('--labels') + 1]
  const labels = readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')))
    .filter(l => l.verdict === 'keep' || l.verdict === 'bury')

  const uid = UID_ARG
  if (!uid) { console.error('--eval-rule needs --uid'); process.exit(1) }

  // FNV-1a over the itemId: deterministic, and adding labels never reassigns an
  // existing one. ~1/3 held out.
  const hash = (str) => {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h
  }
  const isTest = (l) => hash(String(l.itemId)) % 3 === 0
  const train = labels.filter(l => !isTest(l))
  const test  = labels.filter(isTest)

  const snap = await db.collection(`users/${uid}/priors`).get()
  const priors = new Map()
  for (const d of snap.docs) {
    const v = d.data()
    if (v?.senderEmail) priors.set(v.senderEmail.toLowerCase(), v)
  }
  console.log(`labels: ${labels.length}   priors loaded: ${priors.size}`)
  const kept = (xs) => xs.filter(l => l.verdict === 'keep').length
  console.log(`train: ${train.length} (${kept(train)} should-have-stayed)   `
            + `test: ${test.length} (${kept(test)} should-have-stayed)`)

  const domainOf = (e) => { const i = (e ?? '').lastIndexOf('@'); return i > 0 ? e.slice(i + 1).toLowerCase() : '' }
  // Domain-level fallback for a sender with no prior of their own.
  const byDomain = new Map()
  for (const p of priors.values()) {
    const d = domainOf(p.senderEmail)
    const a = byDomain.get(d) ?? { inbound: 0, replied: 0 }
    a.inbound += p.inboundThreads ?? 0; a.replied += p.repliedThreads ?? 0
    byDomain.set(d, a)
  }

  const scoreOf = (from) => {
    const e = (from ?? '').toLowerCase()
    const p = priors.get(e)
    if (p) return { v: p.smoothedReplyRate ?? 0, why: `sender ${p.repliedThreads}/${p.inboundThreads}` }
    const d = byDomain.get(domainOf(e))
    if (d && d.inbound > 0) return { v: (d.replied + 0.024 * 10) / (d.inbound + 10), why: `domain ${d.replied}/${d.inbound}` }
    return { v: 0, why: 'unseen' }
  }

  const sweep = (set) => {
    const out = []
    for (const t of [0.02, 0.05, 0.08, 0.10, 0.15, 0.20, 0.30, 0.50]) {
      let tp = 0, fp = 0, fn = 0, tn = 0
      for (const l of set) {
        const exempt = scoreOf(l.from).v >= t
        if (l.verdict === 'keep') { if (exempt) tp++; else fn++ }
        else { if (exempt) fp++; else tn++ }
      }
      const recall = tp + fn ? tp / (tp + fn) : 0
      const prec   = tp + fp ? tp / (tp + fp) : 0
      // F1 picks the threshold: recall alone would exempt everything, precision
      // alone would exempt nothing.
      const f1 = prec + recall ? 2 * prec * recall / (prec + recall) : 0
      out.push({ t, tp, fp, fn, tn, recall, prec, f1 })
    }
    return out
  }
  const show = (rows, title) => {
    console.log(`\n${title}`)
    console.log(`${'thresh'.padEnd(8)}${'kept'.padStart(6)}${'caught'.padStart(8)}${'recall'.padStart(8)}${'wrongly kept'.padStart(14)}${'precision'.padStart(11)}${'F1'.padStart(7)}`)
    for (const r of rows)
      console.log(`${r.t.toFixed(2).padEnd(8)}${String(r.tp + r.fp).padStart(6)}${String(r.tp).padStart(8)}`
        + `${(r.recall * 100).toFixed(0).padStart(7)}%${String(r.fp).padStart(14)}${(r.prec * 100).toFixed(0).padStart(10)}%${r.f1.toFixed(2).padStart(7)}`)
  }

  const trainRows = sweep(train)
  show(trainRows, 'TRAIN — choosing the threshold')
  const chosen = trainRows.slice().sort((a, b) => b.f1 - a.f1)[0]
  console.log(`\nchosen on train: threshold ${chosen.t} (F1 ${chosen.f1.toFixed(2)})`)

  const testRows = sweep(test)
  show(testRows, 'TEST — held out, not used to choose anything')
  const held = testRows.find(r => r.t === chosen.t)
  console.log(`\n=== HONEST RESULT at threshold ${chosen.t}, on the held-out set ===`)
  console.log(`  should have stayed, rescued : ${held.tp} of ${held.tp + held.fn}  (recall ${(held.recall * 100).toFixed(0)}%)`)
  console.log(`  fine to bury, wrongly kept  : ${held.fp} of ${held.fp + held.tn}  (precision ${(held.prec * 100).toFixed(0)}%)`)

  const best = chosen
  console.log(`\n--- at threshold ${best.t}: what the rule does to each labelled item ---`)
  console.log('CAUGHT (should have stayed, rule keeps it):')
  for (const l of labels.filter(l => l.verdict === 'keep' && scoreOf(l.from).v >= best.t))
    console.log(`   ${String(l.from).slice(0, 34).padEnd(34)} ${scoreOf(l.from).why.padEnd(18)} ${String(l.title).slice(0, 44)}`)
  console.log('MISSED (should have stayed, rule still buries):')
  for (const l of labels.filter(l => l.verdict === 'keep' && scoreOf(l.from).v < best.t))
    console.log(`   ${String(l.from).slice(0, 34).padEnd(34)} ${scoreOf(l.from).why.padEnd(18)} ${String(l.title).slice(0, 44)}`)
  console.log(`WRONGLY KEPT (fine to bury, rule keeps it) — ${best.fp} of ${labels.filter(l => l.verdict === 'bury').length} buriable:`)
  for (const l of labels.filter(l => l.verdict === 'bury' && scoreOf(l.from).v >= best.t).slice(0, 12))
    console.log(`   ${String(l.from).slice(0, 34).padEnd(34)} ${scoreOf(l.from).why.padEnd(18)} ${String(l.title).slice(0, 44)}`)
  process.exit(0)
}

/**
 * --save-labels: give the hand-labelled verdicts a durable home.
 *
 * The 371 labels are the most expensive artefact this project has — hours of the
 * user's judgement, and the eval every future change is scored against. They were
 * living in the review artifact's database and a session-temporary scratchpad
 * directory, one of which evaporates when the session ends.
 *
 * Writes two independent copies, because one is not a backup:
 *   1. Firestore, merged into users/{uid}/evals/goldenSet/entries — the entries
 *      already hold the frozen thread text, so the verdict completes them.
 *   2. snapshots/goldenset-labels-<date>.json — survives the database, and survives
 *      the artifact being deleted. Gitignored: it is real mail metadata.
 */
if (MODE === 'save-labels') {
  const { readdirSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const dir = process.argv[process.argv.indexOf('--labels') + 1]
  const uid = UID_ARG
  if (!uid || !dir) { console.error('--save-labels needs --uid and --labels <dir>'); process.exit(1) }

  const labels = readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')))
  console.log(`read ${labels.length} labels from ${dir}`)

  const col = db.collection(`users/${uid}/evals/goldenSet/entries`)
  let merged = 0, created = 0
  for (let i = 0; i < labels.length; i += 400) {
    const chunk = labels.slice(i, i + 400)
    const existing = await Promise.all(chunk.map(l => col.doc(l.itemId).get()))
    const batch = db.batch()
    chunk.forEach((l, k) => {
      if (existing[k].exists) merged++; else created++
      batch.set(col.doc(l.itemId), {
        itemId: l.itemId,
        humanLabel: {
          verdict: l.verdict, band: l.band, at: l.at ?? null,
          source: 'buried-mail-review artifact, hand-labelled 2026-09-02',
        },
      }, { merge: true })
    })
    await batch.commit()
  }
  console.log(`Firestore: ${merged} merged into existing entries, ${created} new`)

  mkdirSync('snapshots', { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const file = `snapshots/goldenset-labels-${stamp}.json`
  const counts = labels.reduce((a, l) => ({ ...a, [l.verdict]: (a[l.verdict] ?? 0) + 1 }), {})
  writeFileSync(file, JSON.stringify({
    uid, savedAt: new Date().toISOString(), n: labels.length, counts,
    provenance: 'Hand-labelled in the buried-mail-review artifact. Question asked: '
      + '"It sat unactioned, so Keel hid it. Would you have wanted to see this?"',
    labels,
  }, null, 2))
  console.log(`local:     ${file}  (${labels.length} labels, ${JSON.stringify(counts)})`)
  process.exit(0)
}

/** --show-review: what the expiry review has decided, for eyeballing the UI. */
if (MODE === 'show-review') {
  for (const u of users.docs) {
    const snap = await db.collection(`users/${u.id}/items`)
      .where('quietedBy', '==', 'expiry:stale').get()
    const done = snap.docs.map(d => d.data()).filter(d => d.expiryReviewedAt)
    if (done.length === 0) continue
    console.log(`\nuid ${u.id.slice(0, 10)}…  reviewed ${done.length} of ${snap.size} stale-quieted`)
    for (const d of done.sort((a, b) => (b.expiryReviewScore ?? 0) - (a.expiryReviewScore ?? 0))) {
      console.log(`  ${d.expiryReviewOpen ? 'SHOWN ' : 'hidden'} score=${(d.expiryReviewScore ?? 0).toFixed(2)}  status=${String(d.status).padEnd(15)} ${String(d.aiTitle).slice(0, 40)}`)
      console.log(`          reason: ${d.expiryReviewReason}`)
    }
  }
  // Did Stage 0's evidence log capture the restores? This is the loop closing:
  // a rule surfaces an item, the user acts, and the action is recorded as a label.
  for (const u of users.docs) {
    const fb = await db.collection(`users/${u.id}/feedback`).get()
    if (fb.empty) continue
    const byAction = {}
    for (const d of fb.docs) { const a = d.data().action; byAction[a] = (byAction[a] ?? 0) + 1 }
    console.log(`\nfeedback events for ${u.id.slice(0, 10)}…  (${fb.size} total)`)
    for (const [a, n] of Object.entries(byAction).sort((x, y) => y[1] - x[1]))
      console.log(`   ${String(n).padStart(4)}  ${a}`)
    for (const d of fb.docs) {
      const v = d.data()
      if (v.action === 'restored_from_quiet')
        console.log(`      restored: score=${v.prior?.score} quietedBy=${v.facts?.senderDomain ?? '?'} ${String(v.facts?.aiTitle).slice(0, 42)}`)
    }
  }
  process.exit(0)
}

/** --whoami: map each uid to the account behind it. Identity only, no mail content. */
if (MODE === 'whoami') {
  for (const u of allUsers.docs) {
    const root = u.data() ?? {}
    let auth = {}
    try {
      const rec = await admin.auth().getUser(u.id)
      auth = { email: rec.email, name: rec.displayName, created: rec.metadata?.creationTime,
               lastSignIn: rec.metadata?.lastSignInTime, providers: rec.providerData?.map(p => p.providerId) }
    } catch (e) { auth = { error: e.code ?? String(e) } }

    let acct = {}
    try {
      const a = await db.doc(`users/${u.id}/accounts/account_primary`).get()
      if (a.exists) acct = { accountEmail: a.data()?.emailAddress ?? a.data()?.email ?? null }
    } catch { /* ignore */ }

    const items = await db.collection(`users/${u.id}/items`).count().get()
    console.log(`\n${u.id}`)
    console.log(`  auth email   : ${auth.email ?? '(none)'}${auth.error ? `  [auth lookup failed: ${auth.error}]` : ''}`)
    console.log(`  display name : ${auth.name ?? '(none)'}`)
    console.log(`  root doc     : email=${root.email ?? '(none)'}  scanDaysBack=${root.scanDaysBack ?? '-'}`)
    console.log(`  gmail account: ${acct.accountEmail ?? '(none)'}`)
    console.log(`  created      : ${auth.created ?? '?'}`)
    console.log(`  last sign-in : ${auth.lastSignIn ?? '?'}`)
    console.log(`  providers    : ${(auth.providers ?? []).join(', ') || '-'}`)
    console.log(`  items        : ${items.data().count}`)
  }
  process.exit(0)
}

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

    // The Firestore copy lives under users/{uid} and would be destroyed by an
    // account rebuild — the exact event this snapshot exists to survive. Write a
    // durable local copy too. snapshots/ is gitignored: this is real mail content.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('snapshots', { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const file  = `snapshots/goldenset-${u.id.slice(0, 8)}-${stamp}.json`
    writeFileSync(file, JSON.stringify({
      uid: u.id, capturedAt: new Date().toISOString(),
      corpusStats: { items: items.length, ...shape },
      entries: labelled.map(({ it, lb }) => ({ itemId: it.itemId, label: lb, frozen: {
        senderEmail: it.senderEmail ?? null, subject: it.subject ?? null,
        receivedAt: it.receivedAt?.toDate?.()?.toISOString?.() ?? null,
        aiTitle: it.aiTitle ?? null, aiSummary: it.aiSummary ?? null,
        aiDetailedSummary: it.aiDetailedSummary ?? null,
        status: it.status ?? null, aiImportanceScore: it.aiImportanceScore ?? null,
        categoryName: it.categoryName ?? null,
        autoQuietedReason: it.autoQuietedReason ?? null, expiredBy: it.expiredBy ?? null,
        quietedBy: it.quietedBy ?? null, quietedFromStatus: it.quietedFromStatus ?? null,
        overridesVersion: it.overridesVersion ?? null,
        signals: sigsByItem[it.itemId] ?? [],
      } })),
    }, null, 2))
    console.log(`    WROTE ${file}`)
  }
}

console.log(`\n── totals ──`)
console.log(`items scanned : ${totals.items}`)
console.log(`labelled      : ${totals.labelled}`)
for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(v).padStart(4)}  ${k}`)
if (MODE === 'recon') console.log('\n(recon only — nothing written. Pass --build to write.)')
process.exit(0)
