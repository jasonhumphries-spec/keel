/**
 * replyHistory.ts
 *
 * Stage 3 of the relevance brain — see docs/relevance-brain-design.md §5.
 *
 * Turns a user's Gmail history into per-sender relevance priors, using the single
 * strongest signal available: whether they reply, and how fast.
 *
 * The point is cold start. A new account has no feedback log and no labels, but it
 * has years of the user's own behaviour sitting in Gmail — who they answer within
 * the hour, who they never answer at all. That is free, needs no LLM, and produces
 * a better relevance estimate on day one than a prompt can.
 *
 * This module is deliberately pure: it takes thread metadata in and returns priors
 * out. All Gmail I/O lives in the route that calls it, so the judgement can be
 * tested exhaustively without network.
 */

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface ThreadMessageMeta {
  /** Sender address, lowercased, no display name. */
  fromEmail:    string
  /** Epoch ms. Gmail's internalDate. */
  internalDate: number
}

export interface ThreadMeta {
  threadId: string
  /** Chronological order is not assumed — this module sorts. */
  messages: ThreadMessageMeta[]
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface SenderPrior {
  senderEmail:  string
  senderDomain: string

  /** Threads this sender opened with the owner. */
  inboundThreads: number
  /** Of those, threads where the owner sent something afterwards. */
  repliedThreads: number

  /** Raw rate. Meaningless at low n — use smoothedReplyRate for scoring. */
  replyRate: number
  /**
   * Bayesian-smoothed toward the population prior so one interaction cannot
   * swing a sender to 0.0 or 1.0. A single answered email from a new sender
   * reads as 0.40, not 1.00.
   */
  smoothedReplyRate: number

  /** Median hours from their message to the owner's reply. Null if never replied. */
  medianLatencyHours: number | null
  /** Replies inside four hours — a sharper signal than the median for urgent senders. */
  fastReplies: number

  lastInboundAt:  number | null
  lastRepliedAt:  number | null

  /** The domain rate this sender was shrunk toward. Recorded so a score can be
   *  explained rather than merely asserted — same discipline as quiet provenance. */
  priorMean: number
}

export interface DomainPrior {
  domain:            string
  inboundThreads:    number
  repliedThreads:    number
  smoothedReplyRate: number
  senders:           number
  /** The user rate this domain was shrunk toward. */
  priorMean:         number
}

export interface ReplyHistory {
  senders: SenderPrior[]
  domains: DomainPrior[]
  /** Parameters in force, and the user rate fitted from this data. Stored with the
   *  priors so a later run can tell whether a change came from new evidence or
   *  from retuning. */
  params: PriorParams & { fittedUserRate: number }
  stats: {
    threadsSeen:      number
    threadsWithOwner: number
    inboundThreads:   number
    repliedThreads:   number
    distinctSenders:  number
    overallReplyRate: number
  }
}

// ── Hierarchical smoothing ─────────────────────────────────────────────────

/**
 * Priors are HIERARCHICAL and per-user: sender ← domain ← user ← global.
 *
 * The first version used one global beta prior with mean 0.25. Measurement killed
 * it: the real base rate on a personal account is ~2.4% (333 replies across 13,916
 * inbound threads over 8 months), so a 0.25 prior was an order of magnitude too
 * high — and wrong in the worst direction, inflating every unknown sender for a
 * system whose main job is suppressing noise.
 *
 * A single per-user rate is still too crude, because the population is bimodal,
 * not unimodal. Roughly 1,250 bulk senders sit near 0% and ~150 human
 * correspondents sit at 50–100%. A beta fitted to that mixture describes neither,
 * and applying the 2.4% mixture mean to a new HUMAN correspondent under-scores
 * them badly.
 *
 * Hence the chain. A sender is shrunk toward its DOMAIN, the domain toward the
 * USER's own rate, and the user toward a global default until they have enough
 * volume to speak for themselves. A first email from an unseen address at
 * dorsethouseschool.com (22 replies / 164 threads) starts near that domain's rate,
 * while an unseen linkedin.com address starts near zero — which is the whole point
 * of a cold-start prior.
 */
export interface PriorParams {
  /** Fallback base rate for a user with too little history to estimate their own. */
  globalBaseRate: number
  /** Inbound threads before a user's own rate outweighs the global default. */
  userWeight: number
  /** Inbound threads before a domain's rate outweighs the user's. */
  domainWeight: number
  /** Inbound threads before a sender's rate outweighs its domain's. */
  senderWeight: number
}

/**
 * globalBaseRate 0.03 is set from observation (2.4% measured, rounded up so a
 * brand-new user is not started below any plausible real rate).
 *
 * The weights are policy, not estimates — they encode how much evidence is
 * required before a level is trusted over its parent. userWeight is large because
 * a user with only 200 threads genuinely cannot characterise themselves;
 * senderWeight is small because a handful of replies from one person is
 * meaningful information about that person.
 */
export const DEFAULT_PRIOR_PARAMS: PriorParams = {
  globalBaseRate: 0.03,
  userWeight:     200,
  domainWeight:   10,
  senderWeight:   4,
}

/**
 * Beta-binomial posterior mean with pseudo-counts drawn from a parent prior.
 * `weight` is the strength of that prior in units of observations.
 */
export function shrink(successes: number, trials: number, priorMean: number, weight: number): number {
  return (successes + priorMean * weight) / (trials + weight)
}

/**
 * Flat smoothing against the global default.
 * Retained for callers with no hierarchy to hand; prefer the hierarchy.
 */
export function smooth(
  replied: number,
  inbound: number,
  p: PriorParams = DEFAULT_PRIOR_PARAMS,
): number {
  return shrink(replied, inbound, p.globalBaseRate, p.userWeight / 50)
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at > 0 ? email.slice(at + 1).toLowerCase() : ''
}

// ── Aggregation ────────────────────────────────────────────────────────────

const FAST_REPLY_MS = 4 * 60 * 60 * 1000

/**
 * Build per-sender priors from thread metadata.
 *
 * A thread counts for the sender of its FIRST inbound message — the person who
 * opened the conversation with the owner. Attributing every participant would
 * double-count group threads and inflate senders who are merely CC'd.
 *
 * A thread counts as replied when the owner sent a message AFTER that first
 * inbound one. An owner message that precedes it is not a reply to it; that is
 * the owner's own outbound thread, which carries no information about whether
 * this sender commands a response.
 *
 * @param threads     Thread metadata, any order.
 * @param ownerEmails Every address the owner sends as, lowercased.
 */
export function aggregateReplyHistory(
  threads:     ThreadMeta[],
  ownerEmails: string[],
  params:      PriorParams = DEFAULT_PRIOR_PARAMS,
): ReplyHistory {
  const owner = new Set(ownerEmails.map(e => e.toLowerCase().trim()).filter(Boolean))

  type Acc = {
    inbound: number; replied: number; latencies: number[]; fast: number
    lastInboundAt: number | null; lastRepliedAt: number | null
  }
  const bySender = new Map<string, Acc>()
  const acc = (k: string): Acc => {
    let a = bySender.get(k)
    if (!a) { a = { inbound: 0, replied: 0, latencies: [], fast: 0, lastInboundAt: null, lastRepliedAt: null }; bySender.set(k, a) }
    return a
  }

  let threadsWithOwner = 0

  for (const t of threads) {
    const msgs = [...(t.messages ?? [])]
      .filter(m => m?.fromEmail && Number.isFinite(m.internalDate))
      .map(m => ({ ...m, fromEmail: m.fromEmail.toLowerCase().trim() }))
      .sort((a, b) => a.internalDate - b.internalDate)
    if (msgs.length === 0) continue

    const firstInbound = msgs.find(m => !owner.has(m.fromEmail))
    if (!firstInbound) { threadsWithOwner++; continue }   // owner-only thread (notes to self, outbound)

    const a = acc(firstInbound.fromEmail)
    a.inbound++
    a.lastInboundAt = Math.max(a.lastInboundAt ?? 0, firstInbound.internalDate)

    // The owner's first message strictly after the opening inbound one.
    const reply = msgs.find(m => owner.has(m.fromEmail) && m.internalDate > firstInbound.internalDate)
    if (reply) {
      const latency = reply.internalDate - firstInbound.internalDate
      a.replied++
      a.latencies.push(latency / 3600000)
      if (latency <= FAST_REPLY_MS) a.fast++
      a.lastRepliedAt = Math.max(a.lastRepliedAt ?? 0, reply.internalDate)
    }
  }

  // Raw counts first. The hierarchy is then applied top-down: the user's own rate
  // is fitted, domains are shrunk toward it, and senders toward their domain.
  const raw = [...bySender.entries()].map(([senderEmail, a]) => ({
    senderEmail, senderDomain: domainOf(senderEmail), a,
  }))

  const inboundThreads = raw.reduce((n, r) => n + r.a.inbound, 0)
  const repliedThreads = raw.reduce((n, r) => n + r.a.replied, 0)

  // LEVEL 1 — the user, shrunk toward the global default. With a full year of
  // history this barely moves; with 50 threads it stays near the default, which is
  // the point: a new user cannot yet characterise themselves.
  const fittedUserRate = shrink(repliedThreads, inboundThreads, params.globalBaseRate, params.userWeight)

  // LEVEL 2 — domains, shrunk toward the user's rate.
  const byDomain = new Map<string, { inbound: number; replied: number; senders: Set<string> }>()
  for (const r of raw) {
    let d = byDomain.get(r.senderDomain)
    if (!d) { d = { inbound: 0, replied: 0, senders: new Set() }; byDomain.set(r.senderDomain, d) }
    d.inbound += r.a.inbound
    d.replied += r.a.replied
    d.senders.add(r.senderEmail)
  }
  const domainRate = new Map<string, number>()
  const domains: DomainPrior[] = [...byDomain.entries()].map(([domain, d]) => {
    const rate = shrink(d.replied, d.inbound, fittedUserRate, params.domainWeight)
    domainRate.set(domain, rate)
    return {
      domain,
      inboundThreads:    d.inbound,
      repliedThreads:    d.replied,
      smoothedReplyRate: rate,
      senders:           d.senders.size,
      priorMean:         fittedUserRate,
    }
  }).sort((x, y) => y.inboundThreads - x.inboundThreads)

  // LEVEL 3 — senders, shrunk toward their domain. An unseen address at a domain
  // the user answers starts high; one at a domain they never answer starts low.
  const senders: SenderPrior[] = raw.map(({ senderEmail, senderDomain, a }) => {
    const prior = domainRate.get(senderDomain) ?? fittedUserRate
    return {
      senderEmail,
      senderDomain,
      inboundThreads:     a.inbound,
      repliedThreads:     a.replied,
      replyRate:          a.inbound ? a.replied / a.inbound : 0,
      smoothedReplyRate:  shrink(a.replied, a.inbound, prior, params.senderWeight),
      medianLatencyHours: median(a.latencies),
      fastReplies:        a.fast,
      lastInboundAt:      a.lastInboundAt,
      lastRepliedAt:      a.lastRepliedAt,
      priorMean:          prior,
    }
  }).sort((x, y) => y.inboundThreads - x.inboundThreads)

  return {
    senders,
    domains,
    params: { ...params, fittedUserRate },
    stats: {
      threadsSeen:      threads.length,
      threadsWithOwner,
      inboundThreads,
      repliedThreads,
      distinctSenders:  senders.length,
      overallReplyRate: inboundThreads ? repliedThreads / inboundThreads : 0,
    },
  }
}

/**
 * Merge a freshly-computed batch into stored counts.
 *
 * The backfill is cursor-resumable, so priors accumulate over several runs.
 * Counts are the durable thing and simply add. `smoothedReplyRate` and
 * `priorMean` cannot be merged pairwise — they depend on the whole hierarchy,
 * which only exists once every batch has been seen — so the merged value here is
 * provisional and is overwritten by a recompute over the full totals. Store the
 * counts; treat the rates as derived.
 */
export function mergeSenderPriors(a: SenderPrior | null, b: SenderPrior): SenderPrior {
  if (!a) return b
  const inbound = a.inboundThreads + b.inboundThreads
  const replied = a.repliedThreads + b.repliedThreads
  const lat = [a.medianLatencyHours, b.medianLatencyHours].filter((x): x is number => x !== null)
  return {
    senderEmail:        b.senderEmail,
    senderDomain:       b.senderDomain,
    inboundThreads:     inbound,
    repliedThreads:     replied,
    replyRate:          inbound ? replied / inbound : 0,
    // Provisional: recomputed hierarchically once all batches are in.
    smoothedReplyRate:  shrink(replied, inbound, b.priorMean, DEFAULT_PRIOR_PARAMS.senderWeight),
    priorMean:          b.priorMean,
    // Approximate: the true median needs every latency, which is not worth storing.
    // Weighted by how many replies each side contributes.
    medianLatencyHours: lat.length === 0 ? null
      : lat.length === 1 ? lat[0]
      : (a.medianLatencyHours! * a.repliedThreads + b.medianLatencyHours! * b.repliedThreads)
        / Math.max(1, a.repliedThreads + b.repliedThreads),
    fastReplies:        a.fastReplies + b.fastReplies,
    lastInboundAt:      Math.max(a.lastInboundAt ?? 0, b.lastInboundAt ?? 0) || null,
    lastRepliedAt:      Math.max(a.lastRepliedAt ?? 0, b.lastRepliedAt ?? 0) || null,
  }
}

/** Parse an address out of a From header: `"Name" <a@b.com>` → `a@b.com`. */
export function parseAddress(header: string): string {
  const m = header?.match(/<([^>]+)>/)
  return (m ? m[1] : header ?? '').trim().toLowerCase()
}
