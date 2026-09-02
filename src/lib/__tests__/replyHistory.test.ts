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
  aggregateReplyHistory, smooth, shrink, mergeSenderPriors, parseAddress, domainOf,
  DEFAULT_PRIOR_PARAMS,
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

describe('shrinkage', () => {
  it('a single interaction does not read as certainty', () => {
    // Toward a domain that replies half the time, one answered email lands
    // between the domain rate and 1.0 — not at either.
    const v = shrink(1, 1, 0.5, 4)
    expect(v).toBeGreaterThan(0.5)
    expect(v).toBeLessThan(0.7)
  })

  it('converges on the observed rate as evidence accumulates', () => {
    expect(shrink(100, 100, 0.03, 4)).toBeGreaterThan(0.96)
    expect(shrink(0, 500, 0.5, 4)).toBeLessThan(0.01)
  })

  it('ranks a sustained replier above a one-off', () => {
    expect(shrink(9, 10, 0.03, 4)).toBeGreaterThan(shrink(1, 1, 0.03, 4))
  })

  it('with no evidence it returns the prior exactly', () => {
    expect(shrink(0, 0, 0.14, 4)).toBeCloseTo(0.14, 10)
  })

  it('flat smooth() uses the measured global base rate, not the old 0.25', () => {
    // The original prior was 0.25 against a measured base rate of ~2.4% — an
    // order of magnitude too high, inflating every unknown sender.
    expect(DEFAULT_PRIOR_PARAMS.globalBaseRate).toBeLessThan(0.05)
    expect(smooth(0, 1)).toBeLessThan(0.05)
  })
})

describe('hierarchy: sender <- domain <- user <- global', () => {
  /** One replying domain, one dead domain, plus bulk volume to set the user rate. */
  const corpus = (): ThreadMeta[] => {
    const t: ThreadMeta[] = []
    for (let i = 0; i < 20; i++)                       // school replies often
      t.push(th(`s${i}`, [[`staff${i % 4}@school.org`, 0], ['jason.humphries@gmail.com', 2]]))
    for (let i = 0; i < 200; i++)                      // newsletters never answered
      t.push(th(`n${i}`, [[`bulk${i % 5}@spam.com`, 0]]))
    return t
  }

  it('fits the user rate from their own data', () => {
    const r = aggregateReplyHistory(corpus(), OWNER)
    // 20 replied of 220 inbound ≈ 9%, shrunk toward the 3% global default.
    expect(r.params.fittedUserRate).toBeGreaterThan(0.03)
    expect(r.params.fittedUserRate).toBeLessThan(0.09)
  })

  it('a replying domain sits far above a dead one', () => {
    const r = aggregateReplyHistory(corpus(), OWNER)
    const school = r.domains.find(d => d.domain === 'school.org')!
    const spam   = r.domains.find(d => d.domain === 'spam.com')!
    expect(school.smoothedReplyRate).toBeGreaterThan(0.5)
    expect(spam.smoothedReplyRate).toBeLessThan(0.02)
  })

  it('an UNSEEN address inherits its domain — the whole point of a cold-start prior', () => {
    const base = corpus()
    // One inbound, never answered, at each domain. Identical evidence; the only
    // difference is which domain they belong to.
    base.push(th('new1', [['newperson@school.org', 0]]))
    base.push(th('new2', [['newbulk@spam.com', 0]]))
    const r = aggregateReplyHistory(base, OWNER)
    const atSchool = r.senders.find(s => s.senderEmail === 'newperson@school.org')!
    const atSpam   = r.senders.find(s => s.senderEmail === 'newbulk@spam.com')!
    expect(atSchool.smoothedReplyRate).toBeGreaterThan(atSpam.smoothedReplyRate * 5)
    expect(atSchool.priorMean).toBeGreaterThan(atSpam.priorMean)
  })

  it('records the prior each level was shrunk toward, so a score is explainable', () => {
    const r = aggregateReplyHistory(corpus(), OWNER)
    for (const d of r.domains) expect(d.priorMean).toBeCloseTo(r.params.fittedUserRate, 10)
    for (const s of r.senders) {
      const dom = r.domains.find(d => d.domain === s.senderDomain)!
      expect(s.priorMean).toBeCloseTo(dom.smoothedReplyRate, 10)
    }
  })

  it('a thin user stays near the global default rather than over-fitting', () => {
    // Three threads, all answered. A flat estimator would call this a 100% user.
    const r = aggregateReplyHistory([
      th('a', [['x@y.com', 0], ['jason.humphries@gmail.com', 1]]),
      th('b', [['x@y.com', 5], ['jason.humphries@gmail.com', 6]]),
      th('c', [['z@y.com', 0], ['jason.humphries@gmail.com', 1]]),
    ], OWNER)
    expect(r.params.fittedUserRate).toBeLessThan(0.08)
  })

  it('a domain with little history inherits the USER rate, not the global default', () => {
    // Caught by mutation testing: the earlier corpus had a fitted user rate close
    // to the 3% global default, so shrinking domains to global instead of to the
    // user was indistinguishable. A user who replies to most things must pull
    // their thin domains UP with them — that is the whole purpose of the level.
    const chatty: ThreadMeta[] = []
    for (let i = 0; i < 400; i++)
      chatty.push(th(`c${i}`, [[`p${i % 40}@friends.com`, 0], ['jason.humphries@gmail.com', 1]]))
    chatty.push(th('thin', [['someone@newdomain.com', 0]]))   // 1 inbound, unanswered

    const r = aggregateReplyHistory(chatty, OWNER)
    expect(r.params.fittedUserRate).toBeGreaterThan(0.5)

    const thin = r.domains.find(d => d.domain === 'newdomain.com')!
    // Shrunk toward the user's own high rate, so far above the 3% global default.
    expect(thin.smoothedReplyRate).toBeGreaterThan(0.4)
    expect(thin.priorMean).toBeCloseTo(r.params.fittedUserRate, 10)
  })

  it('parameters are reported back with the result', () => {
    const r = aggregateReplyHistory(corpus(), OWNER, DEFAULT_PRIOR_PARAMS)
    expect(r.params.globalBaseRate).toBe(DEFAULT_PRIOR_PARAMS.globalBaseRate)
    expect(r.params.senderWeight).toBe(DEFAULT_PRIOR_PARAMS.senderWeight)
  })

  it('accepts overridden parameters', () => {
    const r = aggregateReplyHistory(corpus(), OWNER,
      { ...DEFAULT_PRIOR_PARAMS, globalBaseRate: 0.5, userWeight: 100000 })
    expect(r.params.fittedUserRate).toBeGreaterThan(0.45)
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
    // Counts are the durable thing. The rate is provisional — it depends on the
    // whole hierarchy and is recomputed once every batch is in.
    expect(m.smoothedReplyRate).toBeCloseTo(shrink(1, 2, m.priorMean, DEFAULT_PRIOR_PARAMS.senderWeight), 6)
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
