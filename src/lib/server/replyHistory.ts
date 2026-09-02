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
}

export interface DomainPrior {
  domain:            string
  inboundThreads:    number
  repliedThreads:    number
  smoothedReplyRate: number
  senders:           number
}

export interface ReplyHistory {
  senders: SenderPrior[]
  domains: DomainPrior[]
  stats: {
    threadsSeen:      number
    threadsWithOwner: number
    inboundThreads:   number
    repliedThreads:   number
    distinctSenders:  number
    overallReplyRate: number
  }
}

// ── Smoothing ──────────────────────────────────────────────────────────────

/**
 * Beta prior: mean 0.25 with weight 4 (a=1, b=3).
 *
 * Chosen so the first interaction moves a sender meaningfully but not absurdly:
 * 1 inbound / 1 replied → 0.40, 5/5 → 0.67, 20/20 → 0.875. A sender needs a
 * sustained pattern before it reads as "always answered".
 */
const PRIOR_A = 1
const PRIOR_B = 3

export function smooth(replied: number, inbound: number): number {
  return (replied + PRIOR_A) / (inbound + PRIOR_A + PRIOR_B)
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

  const senders: SenderPrior[] = [...bySender.entries()].map(([senderEmail, a]) => ({
    senderEmail,
    senderDomain:       domainOf(senderEmail),
    inboundThreads:     a.inbound,
    repliedThreads:     a.replied,
    replyRate:          a.inbound ? a.replied / a.inbound : 0,
    smoothedReplyRate:  smooth(a.replied, a.inbound),
    medianLatencyHours: median(a.latencies),
    fastReplies:        a.fast,
    lastInboundAt:      a.lastInboundAt,
    lastRepliedAt:      a.lastRepliedAt,
  })).sort((x, y) => y.inboundThreads - x.inboundThreads)

  const byDomain = new Map<string, { inbound: number; replied: number; senders: Set<string> }>()
  for (const s of senders) {
    let d = byDomain.get(s.senderDomain)
    if (!d) { d = { inbound: 0, replied: 0, senders: new Set() }; byDomain.set(s.senderDomain, d) }
    d.inbound += s.inboundThreads
    d.replied += s.repliedThreads
    d.senders.add(s.senderEmail)
  }
  const domains: DomainPrior[] = [...byDomain.entries()].map(([domain, d]) => ({
    domain,
    inboundThreads:    d.inbound,
    repliedThreads:    d.replied,
    smoothedReplyRate: smooth(d.replied, d.inbound),
    senders:           d.senders.size,
  })).sort((x, y) => y.inboundThreads - x.inboundThreads)

  const inboundThreads = senders.reduce((n, s) => n + s.inboundThreads, 0)
  const repliedThreads = senders.reduce((n, s) => n + s.repliedThreads, 0)

  return {
    senders,
    domains,
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
 * The backfill is cursor-resumable across invocations, so priors accumulate over
 * several runs. Counts add; derived values are recomputed from the totals rather
 * than averaged, which would drift.
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
    smoothedReplyRate:  smooth(replied, inbound),
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
