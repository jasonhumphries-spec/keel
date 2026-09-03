/**
 * Tests for L2 deterministic scoring — Stage 2, see docs/relevance-brain-design.md §3.
 *
 * These are the cases the prompt's scoring table asserted in prose and no test has
 * ever executed. Several of them are the exact scenarios that required a hardcoded
 * override to be bolted on afterwards, because the model kept getting them wrong.
 * Encoding the precedence is what removes the need for those corrections.
 */

import { describe, it, expect } from 'vitest'
import {
  urgencyFrom, consequenceFrom, scoreFromFacts, bandOf,
  type ExtractedFacts,
} from '@/lib/scoring'

const facts = (o: Partial<ExtractedFacts> = {}): ExtractedFacts => ({
  obligation: 'action_required',
  consequence: 'none',
  daysToDue: null,
  dueType: null,
  isNoise: false,
  ...o,
})

describe('urgency is a pure function of time', () => {
  it.each([
    [-3, 1],     // already passed
    [0, 0.95],   // today
    [1, 0.95],   // tomorrow
    [3, 0.8],
    [7, 0.6],
    [14, 0.4],
    [30, 0.2],
    [90, 0.1],
  ])('%s days out -> %s', (days, want) => expect(urgencyFrom(days)).toBe(want))

  it('an undated thread has no urgency at all', () => {
    expect(urgencyFrom(null)).toBe(0)
  })

  it('is monotonic — nearer is never less urgent', () => {
    const days = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 60]
    const u = days.map(urgencyFrom)
    for (let i = 1; i < u.length; i++) expect(u[i]).toBeLessThanOrEqual(u[i - 1])
  })
})

describe('consequence sets the level', () => {
  it('ranks obligation classes the way the prompt did', () => {
    const of = (o: ExtractedFacts['obligation']) => consequenceFrom(facts({ obligation: o }))
    expect(of('overdue')).toBeGreaterThan(of('payment_due'))
    expect(of('payment_due')).toBeGreaterThan(of('action_required'))
    expect(of('action_required')).toBeGreaterThan(of('scheduled'))
    expect(of('scheduled')).toBeGreaterThan(of('informational'))
    expect(of('informational')).toBeGreaterThan(of('receipt'))
    expect(of('receipt')).toBeGreaterThan(of('resolved'))
  })

  it('a legal or medical flag lifts the floor regardless of class', () => {
    // The prompt's 0.95 tier: "legal/medical action required, anything the user
    // absolutely must not miss".
    expect(consequenceFrom(facts({ obligation: 'informational', consequence: 'legal' })))
      .toBeGreaterThanOrEqual(0.9)
    expect(consequenceFrom(facts({ obligation: 'scheduled', consequence: 'medical' })))
      .toBeGreaterThanOrEqual(0.9)
  })
})

describe('combining them', () => {
  it('an overdue payment lands in the Urgent band', () => {
    expect(bandOf(scoreFromFacts(facts({ obligation: 'overdue', daysToDue: -2 })).score))
      .toBe('urgent')
  })

  it('a payment due tomorrow is Urgent; the same payment in a month is not', () => {
    const soon = scoreFromFacts(facts({ obligation: 'payment_due', daysToDue: 1, dueType: 'payment' }))
    const later = scoreFromFacts(facts({ obligation: 'payment_due', daysToDue: 30, dueType: 'payment' }))
    expect(bandOf(soon.score)).toBe('urgent')
    expect(soon.score).toBeGreaterThan(later.score)
    expect(bandOf(later.score)).toBe('high')
  })

  it('an event this week surfaces as High on proximity alone', () => {
    // The prompt asked for 0.72 minimum here and the model kept under-scoring it,
    // which is why a hardcoded proximity override exists.
    expect(bandOf(scoreFromFacts(facts({ obligation: 'scheduled', daysToDue: 3, dueType: 'event' })).score))
      .toBe('high')
  })

  it('a confirmed event tomorrow is High, not Urgent — resolving the prompt clash', () => {
    // Two rules in the prompt both used "a match tomorrow" as their example and gave
    // different scores (0.88-0.92 vs 0.78). Settled on the more specific one: what
    // makes something Urgent is a required action, not a nearby date.
    const evt = scoreFromFacts(facts({ obligation: 'scheduled', daysToDue: 1, dueType: 'event' }))
    expect(bandOf(evt.score)).toBe('high')
    expect(evt.score).toBeLessThanOrEqual(0.78)

    // But a DEADLINE tomorrow is Urgent — that is the actual distinction.
    expect(bandOf(scoreFromFacts(facts({ obligation: 'action_required', daysToDue: 1, dueType: 'deadline' })).score))
      .toBe('urgent')
  })

  it('the cap never demotes a medical appointment', () => {
    const appt = scoreFromFacts(facts({ obligation: 'scheduled', consequence: 'medical', daysToDue: 1 }))
    expect(bandOf(appt.score)).toBe('urgent')
  })

  it('an undated request still scores on its consequence', () => {
    // The whole buried-mail problem: an unsigned document has no date, and the
    // stale timer then hid it. It must not score as nothing.
    const s = scoreFromFacts(facts({ obligation: 'action_required', daysToDue: null }))
    expect(bandOf(s.score)).toBe('high')
  })
})

describe('precedence — the cases that needed overrides bolted on', () => {
  it('a receipt dated tomorrow is STILL a receipt', () => {
    // The old blanket proximity override bumped anything with a near date to 0.88,
    // which is exactly why a separate auto-pay override had to undo it afterwards.
    const s = scoreFromFacts(facts({ obligation: 'receipt', daysToDue: 1, dueType: 'payment' }))
    expect(s.score).toBe(0.25)
    expect(bandOf(s.score)).toBe('low')
  })

  it('a resolved thread stays quiet however near its dates', () => {
    expect(scoreFromFacts(facts({ obligation: 'resolved', daysToDue: 0 })).score).toBe(0.10)
  })

  it('promotional noise is never lifted by a deadline', () => {
    // "Offer valid until Friday" is artificial urgency, not an obligation.
    const s = scoreFromFacts(facts({ obligation: 'action_required', daysToDue: 1, isNoise: true }))
    expect(s.score).toBe(0.10)
  })

  it('consequence outranks timing: a distant legal matter beats a near trivial one', () => {
    const legal = scoreFromFacts(facts({ obligation: 'action_required', consequence: 'legal', daysToDue: 30 }))
    const trivial = scoreFromFacts(facts({ obligation: 'informational', daysToDue: 1 }))
    expect(legal.score).toBeGreaterThan(trivial.score)
  })
})

describe('explainability', () => {
  it('every score carries a reason', () => {
    for (const o of ['overdue', 'payment_due', 'action_required', 'response_due',
                     'scheduled', 'informational', 'receipt', 'resolved'] as const) {
      const s = scoreFromFacts(facts({ obligation: o, daysToDue: 5 }))
      expect(s.reason.length).toBeGreaterThan(0)
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.score).toBeLessThanOrEqual(1)
    }
  })

  it('names the consequence when one applies', () => {
    expect(scoreFromFacts(facts({ consequence: 'medical' })).reason).toContain('medical')
  })

  it('names the distance when the thread is dated', () => {
    expect(scoreFromFacts(facts({ daysToDue: 5 })).reason).toContain('5d')
  })
})

describe('bands', () => {
  it.each([
    [0.95, 'urgent'], [0.85, 'urgent'],
    [0.84, 'high'],   [0.70, 'high'],
    [0.69, 'med'],    [0.40, 'med'],
    [0.39, 'low'],    [0, 'low'],
  ])('%s -> %s', (s, want) => expect(bandOf(s)).toBe(want))
})
