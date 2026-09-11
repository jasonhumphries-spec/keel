/**
 * reflection.ts — Stage 4, layer L5. See docs/relevance-brain-design.md §3.
 *
 * Turns the evidence log into a narrative profile: a short markdown document about
 * what this user actually treats as important, generated from what they have DONE
 * rather than from what a prompt assumes.
 *
 * THE INPUT IS THE LOG, NOT THE MAIL. Reflection reads structured actions, sender
 * addresses and counts — never email bodies. That is a security decision as much as a
 * design one: the profile is destined for a prompt, so anything that reaches it is
 * effectively an instruction. Feeding it mail content would open a path from a stranger's
 * email to the classifier's behaviour. Feeding it aggregates does not.
 *
 * NOTHING HERE IS APPLIED AUTOMATICALLY. Generation produces a CANDIDATE. Promotion is
 * a separate, gated step — see `promoteProfile`. This is the one layer that can regress
 * silently: a wrong score is visible on screen and a buried item is countable, but a
 * profile that has drifted into a false belief produces plausible output that is
 * quietly worse.
 */

import type { Firestore } from 'firebase-admin/firestore'
import { Timestamp } from 'firebase-admin/firestore'

export interface EvidenceSummary {
  /** Total judgement actions available. */
  events: number
  /** Action counts, e.g. { marked_done: 41, snoozed: 12 }. */
  byAction: Record<string, number>
  /** Senders the user acted on positively, with what they did. */
  engaged: Array<{ sender: string; domain: string; actions: string[]; n: number }>
  /** Senders the user consistently dismissed. */
  dismissed: Array<{ sender: string; domain: string; n: number }>
  /** Auto-quiet rules the user overturned — the sharpest correction available. */
  overturnedRules: Record<string, number>
  /** Bands the user manually raised or lowered, as a correction signal. */
  priorityCorrections: { raised: number; lowered: number }
}

/**
 * Aggregate the evidence log.
 *
 * Deliberately returns counts and addresses only. If this ever starts returning
 * free text from mail, the injection guarantee above is gone.
 */
export async function summariseEvidence(db: Firestore, uid: string): Promise<EvidenceSummary> {
  const snap = await db.collection(`users/${uid}/feedback`).get()

  const byAction: Record<string, number> = {}
  const overturnedRules: Record<string, number> = {}
  const perSender = new Map<string, { pos: Set<string>; neg: number; n: number; domain: string }>()
  let raised = 0, lowered = 0

  const POSITIVE = new Set(['marked_done', 'marked_paid', 'restored_from_quiet', 'note_added',
                            'calendar_added', 'priority_raised', 'undone'])
  const NEGATIVE = new Set(['ignored_item', 'ignored_sender', 'categorise_skipped',
                            'priority_lowered', 'calendar_ignored'])

  for (const doc of snap.docs) {
    const v = doc.data() as Record<string, unknown>
    const action = String(v.action ?? '')
    byAction[action] = (byAction[action] ?? 0) + 1

    if (action === 'priority_raised') raised++
    if (action === 'priority_lowered') lowered++

    const facts = (v.facts ?? {}) as Record<string, unknown>
    const prior = (v.prior ?? {}) as Record<string, unknown>
    if (action === 'restored_from_quiet' && prior.autoQuietedReason) {
      const r = String(prior.autoQuietedReason)
      overturnedRules[r] = (overturnedRules[r] ?? 0) + 1
    }

    const sender = String(facts.senderEmail ?? '').toLowerCase()
    if (!sender) continue
    let e = perSender.get(sender)
    if (!e) { e = { pos: new Set(), neg: 0, n: 0, domain: String(facts.senderDomain ?? '') }; perSender.set(sender, e) }
    e.n++
    if (POSITIVE.has(action)) e.pos.add(action)
    if (NEGATIVE.has(action)) e.neg++
  }

  const engaged = [...perSender.entries()]
    .filter(([, e]) => e.pos.size > 0 && e.n >= MIN_SENDER_ACTIONS)
    .map(([sender, e]) => ({ sender, domain: e.domain, actions: [...e.pos], n: e.n }))
    .sort((a, b) => b.n - a.n).slice(0, 25)

  const dismissed = [...perSender.entries()]
    .filter(([, e]) => e.neg >= MIN_SENDER_ACTIONS && e.pos.size === 0)
    .map(([sender, e]) => ({ sender, domain: e.domain, n: e.neg }))
    .sort((a, b) => b.n - a.n).slice(0, 25)

  return {
    events: snap.size, byAction, engaged, dismissed, overturnedRules,
    priorityCorrections: { raised, lowered },
  }
}

/**
 * How much evidence before a profile is worth generating at all.
 *
 * This was 150, which was wrong — not because the reasoning behind it was wrong, but
 * because it answered the wrong question. Measured on real accounts, the log grows at
 * roughly 20-25 events in three days, so 150 is about three weeks of use before anything
 * is learned at all. That is far too slow to iterate on.
 *
 * The number was conflating two questions that deserve separate answers:
 *
 *   1. Should a profile be GENERATED? Cheap, versioned, and never applied without a
 *      human promoting it — so the cost of generating early is low.
 *   2. How much may the profile CLAIM? That is not about total volume at all. It is
 *      about how much evidence stands behind each individual statement.
 *
 * Answering them separately is what makes an early profile honest rather than
 * confabulated: it is allowed to exist, and allowed to say very little.
 */
export const MIN_EVENTS_FOR_PROFILE = 20

/**
 * A sender must have been acted on more than once to be named.
 *
 * One action is an anecdote. On the real logs, 17 distinct senders had been touched but
 * only 5 more than once — so without this a profile would confidently describe a
 * "pattern" that happened a single time.
 */
export const MIN_SENDER_ACTIONS = 2

/**
 * How many claims the evidence can support.
 *
 * A ladder rather than a formula, so the steps are arguable. The point is that a profile
 * built on 20 events must not be allowed to make six confident assertions — the number
 * of bullets IS the confidence, and the model will fill whatever budget it is given.
 */
export function bulletBudget(events: number): number {
  if (events < 40)  return 2
  if (events < 80)  return 3
  if (events < 140) return 4
  if (events < 200) return 5
  return 6
}

export function hasEnoughEvidence(summary: EvidenceSummary): boolean {
  return summary.events >= MIN_EVENTS_FOR_PROFILE
}

/**
 * Prompt for generating the candidate profile.
 *
 * Constrained hard: short, specific, and grounded only in the counts supplied. The
 * instruction against inference matters — the failure mode is a fluent paragraph of
 * invented preferences that reads well and is wrong.
 */
export function buildProfilePrompt(s: EvidenceSummary): string {
  const budget = bulletBudget(s.events)
  return `Below is a summary of what one person has DONE in their email triage app. Write a short profile of what they treat as important.

Ground every sentence in the counts below. Do not infer personality, profession, family or circumstances. If the evidence is thin on something, say nothing about it rather than guessing.

ACTIONS TAKEN (${s.events} total):
${Object.entries(s.byAction).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v} x ${k}`).join('\n')}

PRIORITY CORRECTIONS: raised ${s.priorityCorrections.raised}, lowered ${s.priorityCorrections.lowered}

SENDERS THEY ACTED ON:
${s.engaged.map(e => `  ${e.sender} (${e.n} actions: ${e.actions.join(', ')})`).join('\n') || '  none yet'}

SENDERS THEY DISMISSED:
${s.dismissed.map(e => `  ${e.sender} (${e.n})`).join('\n') || '  none yet'}

AUTO-QUIET RULES THEY OVERTURNED:
${Object.entries(s.overturnedRules).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  none'}

Write AT MOST ${budget} bullet point${budget === 1 ? '' : 's'}, each one sentence, each traceable to a count above. This budget reflects how much evidence there is — do not pad to reach it. Two well-grounded bullets are a better answer than ${budget} that stretch.

Prefer concrete senders and domains over adjectives. Write nothing you cannot point at.

Output only the bullets, each starting with "- ".`
}

/** A generated profile awaiting promotion. */
export interface ProfileCandidate {
  markdown:    string
  generatedAt: string
  basedOn:     { events: number; engaged: number; dismissed: number }
  /** Set by the promotion gate; a candidate is never live until this passes. */
  promoted?:   boolean
}

/**
 * Reject a candidate that fails basic sanity before a human or an eval ever sees it.
 *
 * Cheap guards against the two ways this goes wrong quietly: a profile that has
 * invented detail (too long, too confident) and one that says nothing (all hedging).
 */
export function validateCandidate(markdown: string, maxBullets = 8): { ok: boolean; reason?: string } {
  const text = (markdown ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }

  const bullets = text.split('\n').filter(l => l.trim().startsWith('- '))
  if (bullets.length === 0) return { ok: false, reason: 'no bullets' }
  // The budget is the confidence claim. A profile from 20 events that comes back with
  // six assertions has gone beyond its evidence, whatever the prose looks like.
  if (bullets.length > maxBullets) return { ok: false, reason: `too many bullets (${bullets.length} > ${maxBullets})` }
  if (text.length > 1500) return { ok: false, reason: 'too long — likely confabulating' }

  // An instruction reaching a prompt is the injection risk this design closes by not
  // reading mail. Belt and braces: refuse a candidate that looks like one anyway.
  //
  // The first version of this guard allowed a single modifier word and so missed
  // "ignore ALL PREVIOUS instructions" — the most common phrasing there is. A guard
  // that is too narrow is worse than none, because it reads as protection.
  const INSTRUCTION_LIKE: RegExp[] = [
    /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(instruction|prompt|rule|direction|guideline)/i,
    /\bsystem\s+prompt\b/i,
    /\byou\s+are\s+now\b/i,
    /\bfrom\s+now\s+on[, ]/i,
    /\bmark\s+(everything|all)\b/i,
  ]
  if (INSTRUCTION_LIKE.some(re => re.test(text)))
    return { ok: false, reason: 'contains instruction-like text' }

  return { ok: true }
}

// ── Draft lifecycle ───────────────────────────────────────────────────────────
//
// A generated profile is a DRAFT. It becomes the active profile only when the user
// approves it in "What keel has learned" (src/app/learned). Until review existed,
// candidates carried only `promoted: false` and nothing could ever change it.

export type CandidateStatus = 'pending' | 'promoted' | 'rejected' | 'superseded'

/** Read a candidate's status, treating pre-review documents as awaiting review. */
export function candidateStatus(c: { status?: unknown; promoted?: unknown } | null | undefined): CandidateStatus {
  const st = c?.status
  if (st === 'pending' || st === 'promoted' || st === 'rejected' || st === 'superseded') return st
  return c?.promoted === true ? 'promoted' : 'pending'
}

/**
 * Is there already a usable draft describing exactly this much evidence?
 *
 * The nightly sweep would otherwise write a fresh, near-identical draft every day that
 * nobody has reviewed. A draft that exceeds the current claim budget does not count —
 * drafts written before the budget existed claim six things from 25 events and can
 * never be approved as they stand, so they must be replaced rather than preserved.
 */
export function hasCurrentDraft(
  pending: Array<{ markdown?: unknown; basedOn?: { events?: unknown } | null }>,
  events: number,
): boolean {
  return pending.some(p =>
    Number(p.basedOn?.events ?? -1) === events &&
    validateCandidate(String(p.markdown ?? ''), bulletBudget(events)).ok)
}

export type AiComplete = (db: Firestore, prompt: string, maxTokens: number) => Promise<{ text: string }>

export interface GenerationResult {
  uid:          string
  generated:    boolean
  reason?:      string
  candidateId?: string
  markdown?:    string
  basedOn:      { events: number; engaged: number; dismissed: number; budget: number }
}

/**
 * Generate a draft profile and store it for review.
 *
 * Shared by the nightly sweep (/api/brain/reflect) and the user's own "generate a new
 * draft" button (/api/brain/learned). One draft awaits review at a time: generating a
 * new one marks any older unreviewed draft superseded, since it describes less evidence
 * and would only compete with the new one.
 */
export async function generateProfileCandidate(
  db: Firestore,
  uid: string,
  aiComplete: AiComplete,
  { force = false, skipIfUnchanged = true }: { force?: boolean; skipIfUnchanged?: boolean } = {},
): Promise<GenerationResult> {
  const summary = await summariseEvidence(db, uid)
  const budget  = bulletBudget(summary.events)
  const basedOn = {
    events: summary.events, engaged: summary.engaged.length,
    dismissed: summary.dismissed.length, budget,
  }

  if (!force && !hasEnoughEvidence(summary)) {
    return { uid, generated: false, reason: `only ${summary.events} events; need ${MIN_EVENTS_FOR_PROFILE}`, basedOn }
  }

  const candidatesCol = db.collection(`users/${uid}/brain/profile/candidates`)
  const existing = await candidatesCol.get()
  const pending  = existing.docs.filter(d => candidateStatus(d.data()) === 'pending')

  if (skipIfUnchanged && hasCurrentDraft(pending.map(d => d.data()), summary.events)) {
    return { uid, generated: false, reason: 'no new evidence since the draft awaiting review', basedOn }
  }

  const { text } = await aiComplete(db, buildProfilePrompt(summary), 500)
  const check = validateCandidate(text, budget)
  if (!check.ok) return { uid, generated: false, reason: `candidate rejected: ${check.reason}`, basedOn }

  const ref   = candidatesCol.doc()
  const now   = Timestamp.now()
  const batch = db.batch()
  // Versioned, never overwritten: a profile's history is how drift becomes visible.
  batch.set(ref, {
    markdown: text.trim(), generatedAt: now,
    basedOn: { ...basedOn, overturnedRules: summary.overturnedRules },
    status: 'pending', promoted: false,
  })
  for (const d of pending) batch.update(d.ref, { status: 'superseded', supersededAt: now, supersededBy: ref.id })
  await batch.commit()

  return { uid, generated: true, candidateId: ref.id, markdown: text.trim(), basedOn }
}
