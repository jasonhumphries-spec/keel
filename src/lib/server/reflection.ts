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
    .filter(([, e]) => e.pos.size > 0)
    .map(([sender, e]) => ({ sender, domain: e.domain, actions: [...e.pos], n: e.n }))
    .sort((a, b) => b.n - a.n).slice(0, 25)

  const dismissed = [...perSender.entries()]
    .filter(([, e]) => e.neg > 0 && e.pos.size === 0)
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
 * Below this the log describes a handful of afternoons, not a person, and an LLM asked
 * to characterise it will confabulate a personality from noise. The number is a
 * judgement rather than a measurement — there is no data yet to fit it — and it is
 * stated here so it can be argued with.
 */
export const MIN_EVENTS_FOR_PROFILE = 150

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

Write at most 6 bullet points, each one sentence, each traceable to a count above. Prefer concrete senders and domains over adjectives. Write nothing you cannot point at.

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
export function validateCandidate(markdown: string): { ok: boolean; reason?: string } {
  const text = (markdown ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }

  const bullets = text.split('\n').filter(l => l.trim().startsWith('- '))
  if (bullets.length === 0) return { ok: false, reason: 'no bullets' }
  if (bullets.length > 8) return { ok: false, reason: `too many bullets (${bullets.length})` }
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
