/**
 * senderPrior.ts
 *
 * Connects the reply-history priors (§5) to scoring (L3 in §3).
 *
 * The backfill wrote 1,554 sender priors and nothing read them. This is the read
 * side: look a sender up, fall back through the hierarchy when they are unknown, and
 * convert engagement into a BOUNDED adjustment to the AI's importance score.
 *
 * WHY BOUNDED, AND WHY SO SMALL. Sender engagement is a weak signal, and we know
 * exactly how weak: scored against 371 hand-labelled items it reached 32% recall at
 * 50% precision (§10.2). It earns a nudge that reorders items within a band; it has
 * not earned the power to move something from Low to Urgent. The cap is what keeps a
 * weak signal from behaving like a strong one.
 *
 * WHAT IT CANNOT DO. A reply rate is blind to `noreply@` senders — you cannot reply
 * to Companies House — so it must never be used to SUPPRESS. Only to lift. An
 * unengaged sender leaves the score untouched rather than pushing it down, because
 * "never replied" and "cannot be replied to" are indistinguishable here.
 */

import type { Firestore } from 'firebase-admin/firestore'

/** Maximum the prior may move a score, in either direction of the band it sits in. */
export const MAX_PRIOR_LIFT = 0.08

export interface SenderPriorLookup {
  /** Smoothed reply rate for this sender, via the sender ← domain ← user chain. */
  rate:   number
  /** Where the number came from, stored on the item so a score can be explained. */
  source: 'sender' | 'domain' | 'user' | 'none'
  /** Raw counts behind it, for the same reason. */
  n:      number
}

/**
 * A user's priors, loaded once per scan.
 *
 * Deliberately a whole-collection read: a per-item lookup would be one Firestore read
 * per thread on a path that already runs in a 60s Pub/Sub window, and the collection
 * is ~1,500 small documents. Loaded once, consulted in memory.
 */
export async function loadSenderPriors(db: Firestore, uid: string): Promise<Map<string, SenderPriorLookup>> {
  const out = new Map<string, SenderPriorLookup>()
  try {
    const snap = await db.collection(`users/${uid}/priors`).get()
    for (const d of snap.docs) {
      const v = d.data()
      if (!v?.senderEmail) continue
      out.set(String(v.senderEmail).toLowerCase(), {
        rate:   Number(v.smoothedReplyRate ?? 0),
        source: 'sender',
        n:      Number(v.inboundThreads ?? 0),
      })
    }
  } catch {
    // A missing or unreadable priors collection must not break a scan. No priors
    // simply means no lift — the classifier behaves exactly as it did before.
  }
  return out
}

export function domainOf(email: string): string {
  const at = (email ?? '').lastIndexOf('@')
  return at > 0 ? email.slice(at + 1).toLowerCase() : ''
}

/**
 * Look a sender up, falling back through the hierarchy.
 *
 * An unseen address at a domain the user answers should inherit that domain — this is
 * the whole point of the cold-start prior, and the reason the hierarchy exists (§5.1).
 */
export function lookupSenderPrior(
  priors: Map<string, SenderPriorLookup>,
  senderEmail: string,
): SenderPriorLookup {
  const email = (senderEmail ?? '').toLowerCase().trim()
  if (!email) return { rate: 0, source: 'none', n: 0 }

  const exact = priors.get(email)
  if (exact) return exact

  // Aggregate the domain's senders. Cheap: the map is already in memory.
  const dom = domainOf(email)
  if (dom) {
    let n = 0, weighted = 0
    for (const [k, v] of priors) {
      if (domainOf(k) !== dom) continue
      n += v.n
      weighted += v.rate * v.n
    }
    if (n > 0) return { rate: weighted / n, source: 'domain', n }
  }
  return { rate: 0, source: 'none', n: 0 }
}

/**
 * Apply the prior to a score.
 *
 * Lift only, capped, and scaled by how much evidence stands behind the rate — a
 * sender with two threads moves an item far less than one with fifty. The AI's score
 * remains the substance; this reorders within it.
 *
 * @param score  the classifier's aiImportanceScore
 * @param prior  the looked-up engagement
 * @returns      the adjusted score, and the delta actually applied (for storage)
 */
export function applySenderPrior(
  score: number,
  prior: SenderPriorLookup,
): { score: number; lift: number } {
  const base = Number.isFinite(score) ? score : 0.5
  if (prior.source === 'none' || prior.n === 0) return { score: base, lift: 0 }

  // Confidence ramps to full at ~10 observed threads. Below that the lift is damped,
  // so one interaction with a new sender cannot reorder a dashboard.
  const confidence = Math.min(1, prior.n / 10)

  // Only engagement clearly above the population base rate earns anything. 0.15 is
  // roughly six times the measured 2.4% base rate — a sender the user genuinely
  // answers, not one they answered once.
  const excess = Math.max(0, prior.rate - 0.15) / 0.85

  const lift = Math.min(MAX_PRIOR_LIFT, MAX_PRIOR_LIFT * excess * confidence)
  return { score: Math.min(1, Math.round((base + lift) * 1000) / 1000), lift: Math.round(lift * 1000) / 1000 }
}
