/**
 * scoring.ts — Stage 2, layer L2. See docs/relevance-brain-design.md §3.
 *
 * The classifier prompt currently does two unrelated jobs in one pass. "This thread
 * contains a £117.50 payment due on 26 June" is an objective fact, identical for every
 * user, and the model is the right thing to read it. "This matters at 0.88" is a
 * judgement about one person's life, and prose is a terrible place to encode it —
 * roughly 900 tokens of the prompt are a scoring table that no test has ever executed.
 *
 * This module is that table, as code. Given the objective facts, it computes urgency
 * and consequence deterministically, so both become provable rather than hoped for.
 * Relevance (L3) stays separate and is the only part that learns.
 *
 * PORTED, NOT REDESIGNED. Every threshold below comes from the existing prompt. The
 * point of this change is to make the current behaviour testable, not to smuggle in
 * new judgement — a rewrite and a refactor at the same time would be impossible to
 * evaluate. Improvements come after the shadow comparison says the port is faithful.
 */

// ── The objective facts L1 extracts ────────────────────────────────────────

export type ObligationClass =
  | 'overdue'          // a deadline or payment already missed
  | 'payment_due'      // money owed, not yet late
  | 'action_required'  // the owner must do something; no money
  | 'response_due'     // someone is waiting on a reply
  | 'scheduled'        // a confirmed event; nothing to do but attend
  | 'informational'    // nothing is being asked
  | 'receipt'          // already paid or already done
  | 'resolved'         // explicitly closed

/** Raised consequence regardless of timing — the "must not miss" cases. */
export type ConsequenceFlag = 'legal' | 'medical' | 'financial_penalty' | 'none'

export interface ExtractedFacts {
  obligation:  ObligationClass
  consequence: ConsequenceFlag
  /** Days until the nearest future dated signal. Null when nothing is dated. */
  daysToDue:   number | null
  /** What that nearest signal is, when there is one. */
  dueType:     'payment' | 'deadline' | 'event' | 'rsvp' | null
  /** True when the model judged the thread purely promotional or automated noise. */
  isNoise:     boolean
}

export interface ScoreBreakdown {
  score:       number
  urgency:     number
  consequence: number
  /** Which rule decided it — stored so a priority can be explained, not asserted. */
  reason:      string
}

// ── Urgency: a pure function of time ───────────────────────────────────────

/**
 * How close the obligation is, 0–1.
 *
 * This is the part the prompt got least reliably right: the existing overrides
 * include a hard "signal within 2 days → 0.88" correction precisely because the model
 * kept under-scoring proximity. A date comparison should never have been the model's
 * job.
 */
export function urgencyFrom(daysToDue: number | null): number {
  if (daysToDue === null) return 0
  if (daysToDue < 0)  return 1        // already passed
  if (daysToDue <= 1) return 0.95     // today or tomorrow
  if (daysToDue <= 3) return 0.8
  if (daysToDue <= 7) return 0.6
  if (daysToDue <= 14) return 0.4
  if (daysToDue <= 30) return 0.2
  return 0.1
}

// ── Consequence: what it costs to miss it ──────────────────────────────────

/** Base weight per obligation class, before timing is considered. */
const OBLIGATION_WEIGHT: Record<ObligationClass, number> = {
  overdue:         0.95,
  payment_due:     0.80,
  action_required: 0.72,
  response_due:    0.70,
  scheduled:       0.62,
  informational:   0.35,
  receipt:         0.25,
  resolved:        0.10,
}

/** Flags that lift the floor regardless of timing — the prompt's 0.95 tier. */
const CONSEQUENCE_FLOOR: Record<ConsequenceFlag, number> = {
  legal:             0.90,
  medical:           0.90,
  financial_penalty: 0.90,
  none:              0,
}

export function consequenceFrom(facts: ExtractedFacts): number {
  return Math.max(
    OBLIGATION_WEIGHT[facts.obligation] ?? 0.5,
    CONSEQUENCE_FLOOR[facts.consequence] ?? 0,
  )
}

// ── Combining them ─────────────────────────────────────────────────────────

/**
 * Final priority from the objective facts.
 *
 * Consequence sets the level; urgency can only raise it. That ordering matters: a
 * receipt dated tomorrow is still a receipt, and the old prompt's blanket proximity
 * override was wrong about exactly that — it bumped auto-pay confirmations to Urgent
 * because a date happened to be near, which is why a separate auto-pay override had
 * to be bolted on afterwards to undo it. Encoding the precedence removes the need for
 * the correction.
 */
export function scoreFromFacts(facts: ExtractedFacts): ScoreBreakdown {
  const urgency = urgencyFrom(facts.daysToDue)
  const consequence = consequenceFrom(facts)

  if (facts.isNoise) {
    return { score: 0.10, urgency, consequence, reason: 'noise: promotional or automated' }
  }
  if (facts.obligation === 'resolved') {
    return { score: 0.10, urgency, consequence, reason: 'resolved: nothing outstanding' }
  }
  // Settled matters do not become urgent because a date is near.
  if (facts.obligation === 'receipt') {
    return { score: 0.25, urgency, consequence, reason: 'receipt: already paid' }
  }

  // Urgency lifts within the headroom above the consequence level, so a distant
  // obligation keeps its base weight and an imminent one approaches 1.
  const lifted = consequence + (1 - consequence) * urgency * 0.85

  // A confirmed event you simply attend tops out at High, never Urgent.
  //
  // The prompt contradicted itself here and porting it to code exposed it. One rule
  // reads "Event, appointment, commitment, or deadline due TODAY or TOMORROW —
  // proximity alone justifies Urgent" (0.88-0.92); another reads "Upcoming confirmed
  // event or activity within 7 days — even if no action required ... today/tomorrow
  // = 0.78" (High). BOTH use "a match tomorrow" as their example, with different
  // answers. No test could catch that in prose.
  //
  // Resolved toward the more specific rule: what separates them is whether an action
  // is required. A deadline tomorrow is Urgent; a match you turn up to is High. A
  // medical or legal flag still overrides the cap, so an appointment tomorrow is not
  // demoted by it.
  const capped = facts.obligation === 'scheduled' && facts.consequence === 'none'
    ? Math.min(lifted, 0.78)
    : lifted
  const score = Math.min(1, Math.round(capped * 100) / 100)

  const reason = facts.consequence !== 'none'
    ? `${facts.obligation} with ${facts.consequence} consequence`
    : facts.daysToDue === null
      ? `${facts.obligation}, no date`
      : `${facts.obligation}, ${facts.daysToDue}d away`

  return { score, urgency, consequence, reason }
}

/**
 * Map a score to the band the UI shows. Kept here so the thresholds live beside the
 * thing that produces them rather than being restated in each component.
 */
export function bandOf(score: number): 'low' | 'med' | 'high' | 'urgent' {
  if (score >= 0.85) return 'urgent'
  if (score >= 0.70) return 'high'
  if (score >= 0.40) return 'med'
  return 'low'
}
