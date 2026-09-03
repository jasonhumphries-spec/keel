/**
 * Tests for wiring the reply-history priors into scoring — see §5.1 and §10.2.
 *
 * The properties that matter here are the guard rails, not the arithmetic. Sender
 * engagement is a measured-weak signal (32% recall, 50% precision against 371 labels).
 * These tests pin down that it stays weak: it lifts, never suppresses; it is capped;
 * and thin evidence is damped.
 */

import { describe, it, expect } from 'vitest'
import {
  lookupSenderPrior, applySenderPrior, domainOf, MAX_PRIOR_LIFT,
  type SenderPriorLookup,
} from '@/lib/server/senderPrior'

const priors = new Map<string, SenderPriorLookup>([
  ['head@school.org',   { rate: 0.70, source: 'sender', n: 40 }],
  ['bursar@school.org', { rate: 0.50, source: 'sender', n: 10 }],
  ['jobs@linkedin.com', { rate: 0.00, source: 'sender', n: 380 }],
  ['newone@x.com',      { rate: 0.40, source: 'sender', n: 1 }],
])

describe('lookup', () => {
  it('finds an exact sender', () => {
    expect(lookupSenderPrior(priors, 'head@school.org').rate).toBe(0.70)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(lookupSenderPrior(priors, '  Head@School.ORG ').rate).toBe(0.70)
  })

  it('an UNSEEN address inherits its domain — the point of a cold-start prior', () => {
    const p = lookupSenderPrior(priors, 'newteacher@school.org')
    expect(p.source).toBe('domain')
    // Weighted by evidence: head (0.70, n=40) dominates bursar (0.50, n=10).
    expect(p.rate).toBeCloseTo((0.70 * 40 + 0.50 * 10) / 50, 5)
  })

  it('an unseen address at a dead domain inherits nothing worth having', () => {
    expect(lookupSenderPrior(priors, 'recruiter@linkedin.com').rate).toBe(0)
  })

  it('an entirely unknown domain returns no prior at all', () => {
    expect(lookupSenderPrior(priors, 'someone@never-seen.com').source).toBe('none')
  })

  it('handles a malformed address without throwing', () => {
    expect(lookupSenderPrior(priors, 'not-an-email').source).toBe('none')
    expect(lookupSenderPrior(priors, '').source).toBe('none')
  })
})

describe('the guard rails', () => {
  it('NEVER suppresses — a never-answered sender leaves the score alone', () => {
    // Critical. A reply rate cannot see noreply@ senders, and that is exactly where
    // statutory obligations live: you cannot reply to Companies House. Pushing those
    // down would bury the very class the labels showed matters most.
    const dead = lookupSenderPrior(priors, 'jobs@linkedin.com')
    const { score, lift } = applySenderPrior(0.75, dead)
    expect(score).toBe(0.75)
    expect(lift).toBe(0)
  })

  it('an unknown sender is left alone too', () => {
    expect(applySenderPrior(0.6, { rate: 0, source: 'none', n: 0 }).score).toBe(0.6)
  })

  it('is capped, so a weak signal cannot behave like a strong one', () => {
    const perfect: SenderPriorLookup = { rate: 1, source: 'sender', n: 10000 }
    expect(applySenderPrior(0.5, perfect).lift).toBeLessThanOrEqual(MAX_PRIOR_LIFT)
    expect(MAX_PRIOR_LIFT).toBeLessThan(0.1)
  })

  it('cannot move an item across more than one band', () => {
    // Low (<0.40) must not become High (>=0.70) on sender engagement alone.
    const perfect: SenderPriorLookup = { rate: 1, source: 'sender', n: 10000 }
    expect(applySenderPrior(0.39, perfect).score).toBeLessThan(0.70)
  })

  it('damps thin evidence — one interaction barely moves anything', () => {
    const thin  = lookupSenderPrior(priors, 'newone@x.com')      // rate 0.40, n=1
    const solid = lookupSenderPrior(priors, 'head@school.org')   // rate 0.70, n=40
    expect(applySenderPrior(0.6, thin).lift).toBeLessThan(applySenderPrior(0.6, solid).lift)
    expect(applySenderPrior(0.6, thin).lift).toBeLessThan(0.02)
  })

  it('ignores engagement near the population base rate', () => {
    // 2.4% is the measured base rate. A sender at 10% is unremarkable, not a signal.
    const ordinary: SenderPriorLookup = { rate: 0.10, source: 'sender', n: 50 }
    expect(applySenderPrior(0.6, ordinary).lift).toBe(0)
  })

  it('lifts a genuinely engaged sender', () => {
    const engaged = lookupSenderPrior(priors, 'head@school.org')
    const { score, lift } = applySenderPrior(0.60, engaged)
    expect(lift).toBeGreaterThan(0.02)
    expect(score).toBeGreaterThan(0.60)
  })

  it('never exceeds 1.0', () => {
    const perfect: SenderPriorLookup = { rate: 1, source: 'sender', n: 10000 }
    expect(applySenderPrior(0.98, perfect).score).toBeLessThanOrEqual(1)
  })

  it('survives a malformed score', () => {
    const engaged = lookupSenderPrior(priors, 'head@school.org')
    expect(Number.isFinite(applySenderPrior(NaN, engaged).score)).toBe(true)
  })
})

describe('domainOf', () => {
  it.each([
    ['a@b.co.uk', 'b.co.uk'],
    ['A@B.COM', 'b.com'],
    ['malformed', ''],
    ['', ''],
  ])('%s -> %s', (input, want) => expect(domainOf(input)).toBe(want))
})
