/**
 * Tests for the reply-history aggregation — the cold-start relevance signal.
 * See docs/relevance-brain-design.md §5.
 *
 * Pure logic, no network. The judgements worth pinning down are the ones that are
 * easy to get subtly wrong: what counts as a reply, who a thread is attributed to,
 * and how hard a single interaction is allowed to move a sender's score.
 */

import { describe, it, expect } from 'vitest'
import {
  aggregateReplyHistory, smooth, mergeSenderPriors, parseAddress, domainOf,
  type ThreadMeta,
} from '@/lib/server/replyHistory'

const OWNER = ['jason.humphries@gmail.com']
const H = 3600000
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0)

/** Build a thread from [fromEmail, hoursAfterT0] pairs. */
const th = (threadId: string, msgs: Array<[string, number]>): ThreadMeta => ({
  threadId,
  messages: msgs.map(([fromEmail, h]) => ({ fromEmail, internalDate: T0 + h * H })),
})

const bySender = (r: ReturnType<typeof aggregateReplyHistory>, e: string) =>
  r.senders.find(s => s.senderEmail === e)!

describe('what counts as a reply', () => {
  it('counts an owner message after the opening inbound one', () => {
    const r = aggregateReplyHistory([
      th('t1', [['school@bedales.org.uk', 0], ['jason.humphries@gmail.com', 2]]),
    ], OWNER)
    const s = bySender(r, 'school@bedales.org.uk')
    expect(s.inboundThreads).toBe(1)
    expect(s.repliedThreads).toBe(1)
    expect(s.medianLatencyHours).toBe(2)
  })

  it('does NOT count an owner message that precedes the inbound one', () => {
    // The owner opened this thread; the other party answering says nothing about
    // whether that sender commands a response from the owner.
    const r = aggregateReplyHistory([
      th('t1', [['jason.humphries@gmail.com', 0], ['builder@example.com', 3]]),
    ], OWNER)
    const s = bySender(r, 'builder@example.com')
    expect(s.inboundThreads).toBe(1)
    expect(s.repliedThreads).toBe(0)
  })

  it('ignores threads containing only the owner (notes to self)', () => {
    const r = aggregateReplyHistory([
      th('t1', [['jason.humphries@gmail.com', 0], ['jason.humphries@gmail.com', 1]]),
    ], OWNER)
    expect(r.senders).toHaveLength(0)
    expect(r.stats.threadsWithOwner).toBe(1)
  })

  it('never replied → rate 0 and null latency', () => {
    const r = aggregateReplyHistory([
      th('t1', [['noreply@marketing.com', 0]]),
      th('t2', [['noreply@marketing.com', 24]]),
    ], OWNER)
    const s = bySender(r, 'noreply@marketing.com')
    expect(s.repliedThreads).toBe(0)
    expect(s.replyRate).toBe(0)
    expect(s.medianLatencyHours).toBeNull()
  })
})

describe('thread attribution', () => {
  it('attributes a thread to whoever opened it, not to everyone in it', () => {
    // A CC'd party must not accrue credit for a thread they did not start —
    // otherwise every busy group thread inflates its bystanders.
    const r = aggregateReplyHistory([
      th('t1', [
        ['head@bedales.org.uk', 0],
        ['bursar@bedales.org.uk', 1],
        ['jason.humphries@gmail.com', 2],
      ]),
    ], OWNER)
    expect(bySender(r, 'head@bedales.org.uk').inboundThreads).toBe(1)
    expect(r.senders.find(s => s.senderEmail === 'bursar@bedales.org.uk')).toBeUndefined()
  })

  it('sorts messages itself — input order is not trusted', () => {
    const t: ThreadMeta = { threadId: 't1', messages: [
      { fromEmail: 'jason.humphries@gmail.com', internalDate: T0 + 5 * H },
      { fromEmail: 'gp@nhs.uk',                 internalDate: T0 },
    ]}
    const s = bySender(aggregateReplyHistory([t], OWNER), 'gp@nhs.uk')
    expect(s.repliedThreads).toBe(1)
    expect(s.medianLatencyHours).toBe(5)
  })

  it('handles multiple owner addresses', () => {
    const r = aggregateReplyHistory([
      th('t1', [['x@y.com', 0], ['jason@resonant-grid.com', 1]]),
    ], ['jason.humphries@gmail.com', 'jason@resonant-grid.com'])
    expect(bySender(r, 'x@y.com').repliedThreads).toBe(1)
  })
})

describe('latency', () => {
  it('takes the median, so one outlier does not define a sender', () => {
    const r = aggregateReplyHistory([
      th('t1', [['a@b.com', 0],  ['jason.humphries@gmail.com', 1]]),
      th('t2', [['a@b.com', 10], ['jason.humphries@gmail.com', 12]]),
      th('t3', [['a@b.com', 20], ['jason.humphries@gmail.com', 20 + 500]]),
    ], OWNER)
    const s = bySender(r, 'a@b.com')
    expect(s.medianLatencyHours).toBe(2)     // not the ~168 a mean would give
    expect(s.repliedThreads).toBe(3)
  })

  it('counts replies inside four hours as fast', () => {
    const r = aggregateReplyHistory([
      th('t1', [['a@b.com', 0], ['jason.humphries@gmail.com', 1]]),
      th('t2', [['a@b.com', 0], ['jason.humphries@gmail.com', 9]]),
    ], OWNER)
    expect(bySender(r, 'a@b.com').fastReplies).toBe(1)
  })
})

describe('smoothing', () => {
  it('stops a single interaction from reading as certainty', () => {
    expect(smooth(1, 1)).toBeCloseTo(0.40, 2)
    expect(smooth(0, 1)).toBeCloseTo(0.20, 2)
  })

  it('converges toward the raw rate as evidence accumulates', () => {
    expect(smooth(5, 5)).toBeCloseTo(0.67, 2)
    expect(smooth(20, 20)).toBeCloseTo(0.875, 3)
    expect(smooth(100, 100)).toBeGreaterThan(0.97)
  })

  it('ranks a sustained replier above a one-off', () => {
    const oneOff    = smooth(1, 1)
    const sustained = smooth(9, 10)
    expect(sustained).toBeGreaterThan(oneOff)
  })

  it('a never-answered bulk sender lands near the floor', () => {
    expect(smooth(0, 50)).toBeLessThan(0.02)
  })
})

describe('domain priors', () => {
  it('aggregates senders within a domain, for unseen addresses', () => {
    const r = aggregateReplyHistory([
      th('t1', [['head@bedales.org.uk', 0],   ['jason.humphries@gmail.com', 1]]),
      th('t2', [['bursar@bedales.org.uk', 0], ['jason.humphries@gmail.com', 2]]),
      th('t3', [['spam@promo.com', 0]]),
    ], OWNER)
    const d = r.domains.find(x => x.domain === 'bedales.org.uk')!
    expect(d.inboundThreads).toBe(2)
    expect(d.repliedThreads).toBe(2)
    expect(d.senders).toBe(2)
    expect(d.smoothedReplyRate).toBeGreaterThan(
      r.domains.find(x => x.domain === 'promo.com')!.smoothedReplyRate)
  })
})

describe('merging across resumable runs', () => {
  it('adds counts and recomputes rates from totals', () => {
    const a = aggregateReplyHistory([th('t1', [['a@b.com', 0], ['jason.humphries@gmail.com', 1]])], OWNER).senders[0]
    const b = aggregateReplyHistory([th('t2', [['a@b.com', 0]])], OWNER).senders[0]
    const m = mergeSenderPriors(a, b)
    expect(m.inboundThreads).toBe(2)
    expect(m.repliedThreads).toBe(1)
    expect(m.replyRate).toBe(0.5)
    // Recomputed from totals, not averaged from the two smoothed values.
    expect(m.smoothedReplyRate).toBeCloseTo(smooth(1, 2), 6)
  })

  it('merging into nothing yields the new value', () => {
    const b = aggregateReplyHistory([th('t1', [['a@b.com', 0]])], OWNER).senders[0]
    expect(mergeSenderPriors(null, b)).toEqual(b)
  })
})

describe('address parsing', () => {
  it.each([
    ['"Bedales School" <head@bedales.org.uk>', 'head@bedales.org.uk'],
    ['head@bedales.org.uk',                    'head@bedales.org.uk'],
    ['Jason <Jason.Humphries@GMAIL.com>',      'jason.humphries@gmail.com'],
  ])('parses %s', (h, want) => expect(parseAddress(h)).toBe(want))

  it('extracts domains', () => {
    expect(domainOf('a@b.co.uk')).toBe('b.co.uk')
    expect(domainOf('malformed')).toBe('')
  })
})

describe('robustness', () => {
  it('tolerates empty and malformed threads', () => {
    const r = aggregateReplyHistory([
      { threadId: 'empty', messages: [] },
      { threadId: 'bad', messages: [{ fromEmail: '', internalDate: NaN }] },
      th('ok', [['a@b.com', 0]]),
    ], OWNER)
    expect(r.senders).toHaveLength(1)
    expect(r.stats.threadsSeen).toBe(3)
  })

  it('reports overall stats', () => {
    const r = aggregateReplyHistory([
      th('t1', [['a@b.com', 0], ['jason.humphries@gmail.com', 1]]),
      th('t2', [['c@d.com', 0]]),
    ], OWNER)
    expect(r.stats.inboundThreads).toBe(2)
    expect(r.stats.repliedThreads).toBe(1)
    expect(r.stats.overallReplyRate).toBe(0.5)
    expect(r.stats.distinctSenders).toBe(2)
  })
})
