/**
 * learned.ts — what the "What keel has learned" view shows. See docs §15.
 *
 * THE VIEW MUST NEVER DISAGREE WITH SCORING. Every weighting here is computed by calling
 * the same functions the scan path calls (`priorFromDoc`, `domainPrior`,
 * `applySenderPrior`), never by re-deriving the arithmetic. This codebase has already
 * been bitten three times by a private copy of shared logic drifting from the original
 * (see the `docToItem` duplicates); a view of learned behaviour that quietly showed
 * different numbers from the behaviour itself would be worse than no view.
 *
 * THE VIEW MUST NEVER IMPLY AN EFFECT THAT DOES NOT EXIST. An approved profile is
 * recorded but not yet read by any classifier, and most learned senders earn no lift.
 * Both are stated plainly rather than left for the reader to infer.
 */

import {
  applySenderPrior, domainPrior, domainOf, priorFromDoc,
  MAX_PRIOR_LIFT, ENGAGEMENT_THRESHOLD, FULL_CONFIDENCE_THREADS,
  type SenderPriorLookup,
} from './senderPrior'
import { validateCandidate, bulletBudget, candidateStatus, type CandidateStatus } from './reflection'

/**
 * Whether an approved profile currently influences scoring. It does not: approval is
 * recorded, but no classifier reads `brain/profile` yet. A constant, shown to the user
 * as such, so the view cannot claim otherwise. Flip it in the same change that wires
 * the active profile into a prompt.
 */
export const PROFILE_USED_IN_SCORING = false

// ── Learned weightings ────────────────────────────────────────────────────────

/** A sender needs this many threads before its rate is worth showing. */
export const MIN_THREADS_TO_SHOW = 3
/** A domain row is only informative when it pools more than one sender. */
export const MIN_DOMAIN_SENDERS = 2
export const MAX_WEIGHT_ROWS = 25

export interface WeightRow {
  /** Sender address, or domain. */
  key:                string
  threads:            number
  replied:            number
  /** The smoothed reply rate scoring actually uses. */
  rate:               number
  /** 0..1 — how far the rate is trusted, from thread count. */
  confidence:         number
  /** What this weighting adds to an item's score today (0 to MAX_PRIOR_LIFT). */
  lift:               number
  medianLatencyHours: number | null
  /** Domains only: how many learned senders the row pools. */
  senders?:           number
}

export interface Weightings {
  /** Share of all learned inbound threads the user replied to. */
  baseRate:      number | null
  totalThreads:  number
  totalSenders:  number
  /** Senders whose weighting currently adds anything to a score. */
  earningLift:   number
  senders:       WeightRow[]
  sendersShown:  number
  domains:       WeightRow[]
  domainsShown:  number
  rules: {
    threshold:             number
    fullConfidenceThreads: number
    maxLift:               number
    liftOnly:              true
  }
}

const liftOf       = (p: SenderPriorLookup) => applySenderPrior(0.5, p).lift
const confidenceOf = (n: number) => Math.min(1, n / FULL_CONFIDENCE_THREADS)
const byWeight     = (a: WeightRow, b: WeightRow) => b.lift - a.lift || b.rate - a.rate || b.threads - a.threads

export function summariseWeightings(docs: Array<Record<string, unknown>>): Weightings {
  const priors  = new Map<string, SenderPriorLookup>()
  const replied = new Map<string, number>()
  const latency = new Map<string, number | null>()

  for (const d of docs) {
    const p = priorFromDoc(d)
    if (!p) continue
    priors.set(p.email, p.prior)
    replied.set(p.email, Number(d.repliedThreads ?? 0))
    latency.set(p.email, d.medianLatencyHours == null ? null : Number(d.medianLatencyHours))
  }

  let totalThreads = 0, totalReplied = 0
  const senderRows: WeightRow[] = []
  const byDomain = new Map<string, { senders: number; replied: number }>()

  for (const [email, prior] of priors) {
    const rep = replied.get(email) ?? 0
    totalThreads += prior.n
    totalReplied += rep
    senderRows.push({
      key: email, threads: prior.n, replied: rep, rate: prior.rate,
      confidence: confidenceOf(prior.n), lift: liftOf(prior),
      medianLatencyHours: latency.get(email) ?? null,
    })
    const dom = domainOf(email)
    if (dom) {
      const agg = byDomain.get(dom) ?? { senders: 0, replied: 0 }
      agg.senders++
      agg.replied += rep
      byDomain.set(dom, agg)
    }
  }

  const shown = senderRows
    .filter(r => r.threads >= MIN_THREADS_TO_SHOW && r.replied >= 1)
    .sort(byWeight)

  const domainRows = [...byDomain.entries()]
    .filter(([, agg]) => agg.senders >= MIN_DOMAIN_SENDERS)
    .map(([dom, agg]): WeightRow => {
      // Exactly what an unseen sender at this domain would inherit during a scan.
      const p = domainPrior(priors, dom)
      return {
        key: dom, threads: p.n, replied: agg.replied, rate: p.rate,
        confidence: confidenceOf(p.n), lift: liftOf(p),
        medianLatencyHours: null, senders: agg.senders,
      }
    })
    .filter(r => r.threads >= MIN_THREADS_TO_SHOW && r.replied >= 1)
    .sort(byWeight)

  return {
    baseRate:     totalThreads > 0 ? totalReplied / totalThreads : null,
    totalThreads,
    totalSenders: priors.size,
    earningLift:  senderRows.filter(r => r.lift > 0).length,
    senders:      shown.slice(0, MAX_WEIGHT_ROWS),
    sendersShown: shown.length,
    domains:      domainRows.slice(0, MAX_WEIGHT_ROWS),
    domainsShown: domainRows.length,
    rules: {
      threshold: ENGAGEMENT_THRESHOLD, fullConfidenceThreads: FULL_CONFIDENCE_THREADS,
      maxLift: MAX_PRIOR_LIFT, liftOnly: true,
    },
  }
}

// ── What it is actually changing ──────────────────────────────────────────────

export const EFFECT_WINDOW_DAYS = 7
/** The route reads at most this many lifted items; at the limit, the total is a floor. */
export const LIFTED_QUERY_LIMIT = 200
const DAY_MS = 86_400_000

export interface LiftedItem {
  title:  string
  sender: string
  lift:   number
  at:     Date | null
}

export interface Effects {
  /** Items whose score consulted a learned weighting at all. */
  consulted:              number
  liftedLastWindow:       number
  liftedAllTime:          number
  allTimeIsLowerBound:    boolean
  largestLift:            number
  recent:                 Array<{ title: string; sender: string; lift: number; at: string | null }>
  lastProcessedAt:        string | null
  daysSinceLastProcessed: number | null
  profileUsedInScoring:   boolean
  windowDays:             number
}

export function summariseEffects(
  lifted: LiftedItem[],
  ctx: { consulted: number; lastProcessedAt: Date | null; now: Date },
): Effects {
  const since = ctx.now.getTime() - EFFECT_WINDOW_DAYS * DAY_MS
  const recent = [...lifted]
    .sort((a, b) => (b.at?.getTime() ?? -Infinity) - (a.at?.getTime() ?? -Infinity) || b.lift - a.lift)
    .slice(0, 8)
    .map(i => ({ title: i.title, sender: i.sender, lift: i.lift, at: i.at ? i.at.toISOString() : null }))

  return {
    consulted:              ctx.consulted,
    liftedLastWindow:       lifted.filter(i => i.at && i.at.getTime() >= since).length,
    liftedAllTime:          lifted.length,
    allTimeIsLowerBound:    lifted.length >= LIFTED_QUERY_LIMIT,
    largestLift:            lifted.reduce((m, i) => Math.max(m, i.lift), 0),
    recent,
    lastProcessedAt:        ctx.lastProcessedAt ? ctx.lastProcessedAt.toISOString() : null,
    // Surfaced because "nothing was lifted" means something different when nothing
    // was processed at all.
    daysSinceLastProcessed: ctx.lastProcessedAt
      ? Math.floor((ctx.now.getTime() - ctx.lastProcessedAt.getTime()) / DAY_MS)
      : null,
    profileUsedInScoring:   PROFILE_USED_IN_SCORING,
    windowDays:             EFFECT_WINDOW_DAYS,
  }
}

// ── Reviewing a draft profile ─────────────────────────────────────────────────

export interface CandidateLike {
  markdown?: unknown
  status?:   unknown
  promoted?: unknown
  basedOn?:  { events?: unknown } | null
}

export function bulletsIn(markdown: string): number {
  return (markdown ?? '').split('\n').filter(l => l.trim().startsWith('- ')).length
}

/** What the review card needs to know about a draft. */
export function describeCandidate(c: CandidateLike) {
  const markdown = String(c.markdown ?? '')
  const events   = Number(c.basedOn?.events ?? 0)
  const budget   = bulletBudget(events)
  const bullets  = bulletsIn(markdown)
  return {
    markdown, events, budget, bullets,
    // Drafts written before the claim budget existed can say more than their evidence
    // allows. They are shown, but cannot be approved without being cut down.
    overBudget: bullets > budget,
    status:     candidateStatus(c) as CandidateStatus,
  }
}

export type ReviewAction = 'promote' | 'reject'

export type ReviewCheck =
  | { ok: true; markdown: string; edited: boolean }
  | { ok: false; code: 'not_pending' | 'invalid'; reason: string }

/**
 * Validate a review decision before anything is written.
 *
 * An edited profile is held to exactly the same rules as a generated one — the claim
 * budget for the evidence it was built from, and the instruction-like guard. The user
 * is trusted to judge what is TRUE; the guards exist because the text is destined for a
 * prompt, and that does not change because a person typed it.
 */
export function checkReview(c: CandidateLike, action: ReviewAction, editedMarkdown?: string): ReviewCheck {
  if (candidateStatus(c) !== 'pending') {
    return { ok: false, code: 'not_pending', reason: 'this draft has already been reviewed' }
  }
  const original = String(c.markdown ?? '').trim()
  if (action === 'reject') return { ok: true, markdown: original, edited: false }

  const markdown = (editedMarkdown ?? original).trim()
  const check = validateCandidate(markdown, bulletBudget(Number(c.basedOn?.events ?? 0)))
  if (!check.ok) return { ok: false, code: 'invalid', reason: check.reason ?? 'invalid profile' }
  return { ok: true, markdown, edited: markdown !== original }
}

/** One user-triggered draft per window, so a curious click cannot run up model spend. */
export const GENERATE_COOLDOWN_MS = 10 * 60 * 1000

/** When generation is next allowed, or null if it is allowed now. */
export function nextGenerationAt(lastGeneratedAt: Date | null, now: Date): Date | null {
  if (!lastGeneratedAt) return null
  const next = lastGeneratedAt.getTime() + GENERATE_COOLDOWN_MS
  return next > now.getTime() ? new Date(next) : null
}
