/**
 * Tests for participant-aware calendar matching.
 *
 * The behaviour pinned here is the discrimination, not the matching. Finding SOME event
 * for a signal is easy; the failure modes that matter are claiming the wrong meeting is
 * "already on your calendar" and refusing to look past a date the email only proposed.
 * Two properties do most of the work: the sender is never required, and an address match
 * is never allowed to decide on its own.
 */

import { describe, it, expect } from 'vitest'
import {
  eventParticipants, participantEvidence, titleOverlapScore,
  scoreCandidate, pickCalendarEvent, type CalEventLike,
} from '@/lib/server/calendarCheck'

const ev = (
  summary: string,
  startISO: string,
  people: string[] = [],
  organizer?: string,
): CalEventLike => ({
  summary,
  start: { dateTime: startISO },
  attendees: people.map(email => ({ email })),
  organizer: organizer ? { email: organizer } : undefined,
  calendarName: 'work',
})

const ctx = (o: Partial<Parameters<typeof scoreCandidate>[0]> = {}) => ({
  senderEmail: 'joseph1.guo@landisgyr.com',
  texts: ['Proposed meeting with Joseph Guo', 'Resonant Grid & L+G - Meeting for commercial terms'],
  sigDate: new Date('2026-09-02T00:00:00Z'),
  ...o,
})

describe('reading the people off an event', () => {
  it('includes the organiser, who is often not in the attendee list', () => {
    const e = ev('Sync', '2026-09-09T18:00:00Z', ['a@x.com'], 'boss@x.com')
    expect(eventParticipants(e).sort()).toEqual(['a@x.com', 'boss@x.com'])
  })

  it('matches addresses case-insensitively', () => {
    // The real case: Gmail reported the sender as Joseph1.Guo@landisgyr.com and the
    // calendar reported the organiser as joseph1.guo@landisgyr.com.
    const e = ev('Sync', '2026-09-09T18:00:00Z', [], 'joseph1.guo@landisgyr.com')
    expect(participantEvidence('Joseph1.Guo@landisgyr.com', e)).toBe('exact')
  })

  it('accepts a colleague of the sender as weaker evidence', () => {
    // An assistant books the meeting; the person attending is someone else at the
    // same company. Requiring the sender to attend would throw this away.
    const e = ev('Sync', '2026-09-09T18:00:00Z', ['joseph1.guo@landisgyr.com'])
    expect(participantEvidence('assistant@landisgyr.com', e)).toBe('domain')
  })

  it('REFUSES to treat a shared freemail domain as evidence', () => {
    // Otherwise every gmail sender "matches" every event with a gmail attendee, which
    // is most personal events — the failure would be silent and enormous.
    const e = ev('Party', '2026-09-09T18:00:00Z', ['someone@gmail.com'])
    expect(participantEvidence('unrelated@gmail.com', e)).toBeNull()
  })

  it('returns nothing for a no-reply sender on nobody’s event', () => {
    const e = ev('Sync', '2026-09-09T18:00:00Z', ['a@x.com'])
    expect(participantEvidence('noreply@eventbrite.com', e)).toBeNull()
  })
})

describe('graded title overlap', () => {
  it('scores a distinctive shared word above a common one', () => {
    const distinctive = titleOverlapScore('Resonant Grid meeting', 'Resonant Grid sync')
    const common      = titleOverlapScore('Team meeting today', 'Project meeting notes')
    expect(distinctive).toBeGreaterThan(common)
  })

  it('is zero when nothing meaningful is shared', () => {
    expect(titleOverlapScore('Dentist appointment', 'Board review')).toBe(0)
  })
})

describe('the case this was built for', () => {
  // Email from Joseph1.Guo@landisgyr.com proposing a meeting on 2 Sept. The meeting was
  // actually booked as "Resonant Grid | L+G - Sync Up" on 9 Sept, organised by him.
  // Same-day matching cannot see it and the signal description shares no words with it.
  const theMeeting = ev(
    'Resonant Grid | L+G - Sync Up', '2026-09-09T18:00:00Z',
    ['michael@resonant-grid.com', 'jason@resonant-grid.com', 'joseph1.guo@landisgyr.com'],
    'joseph1.guo@landisgyr.com',
  )

  it('finds a meeting booked a week after the date the mail proposed', () => {
    const hit = pickCalendarEvent(ctx(), [theMeeting])
    expect(hit).not.toBeNull()
    expect(hit!.event.summary).toBe('Resonant Grid | L+G - Sync Up')
    expect(hit!.confident).toBe(true)
    expect(hit!.signals).toContain('participant:exact')
  })

  it('still finds it among the rest of a real working week', () => {
    const week = [
      ev('Weekly RG Status', '2026-09-09T08:30:00Z', ['michael@resonant-grid.com']),
      ev('Workshop: Fundraising Strategy', '2026-09-09T09:00:00Z', []),
      ev('ResonantGrid/CHK/EXA meeting', '2026-09-10T08:00:00Z', ['chk@exasys.com']),
      theMeeting,
    ]
    const hit = pickCalendarEvent(ctx(), week)
    expect(hit!.event.summary).toBe('Resonant Grid | L+G - Sync Up')
    expect(hit!.confident).toBe(true)
  })
})

describe('one sender, several meetings', () => {
  const a = ev('Commercial terms discussion', '2026-09-09T10:00:00Z', [], 'jo@landisgyr.com')
  const b = ev('Technical integration review', '2026-09-11T10:00:00Z', [], 'jo@landisgyr.com')

  it('uses the title to pick between them when the mail says which', () => {
    const hit = pickCalendarEvent(ctx({
      senderEmail: 'jo@landisgyr.com',
      texts: ['Meeting to agree commercial terms'],
    }), [a, b])
    expect(hit!.event.summary).toBe('Commercial terms discussion')
    expect(hit!.confident).toBe(true)
  })

  it('REFUSES to assert a match when it cannot tell them apart', () => {
    // Two meetings with the same person, neither resembling the mail. There is real
    // evidence something is on the calendar, and no basis for saying which — so the
    // honest answer is 'probable', not a coin flip presented as a fact.
    const hit = pickCalendarEvent(ctx({
      senderEmail: 'jo@landisgyr.com',
      texts: ['Follow-up call'],
    }), [a, b])
    expect(hit).not.toBeNull()
    expect(hit!.confident).toBe(false)
  })

  it('REFUSES two well-evidenced candidates that are too close to separate', () => {
    // Both meetings are with the sender, both share a word with the mail, both are days
    // away — each on its own would be a confident match. What decides it is the gap
    // BETWEEN them, and there isn't one. Without the margin rule the winner would be
    // whichever happened to sort first, asserted to the user as fact.
    const near = [
      ev('Pricing discussion with Landis', '2026-09-04T10:00:00Z', [], 'jo@landisgyr.com'),
      ev('Pricing review with Landis',     '2026-09-05T10:00:00Z', [], 'jo@landisgyr.com'),
    ]
    const hit = pickCalendarEvent(ctx({
      senderEmail: 'jo@landisgyr.com',
      texts: ['Pricing conversation'],
    }), near)
    expect(hit).not.toBeNull()
    expect(hit!.score).toBeGreaterThan(0.55)
    expect(hit!.signals.length).toBeGreaterThanOrEqual(2)  // not the signal-count rule
    expect(hit!.confident).toBe(false)                     // the margin rule
  })

  it('treats instances of one recurring series as the same meeting, not rivals', () => {
    // singleEvents=true expands a weekly sync into many identical entries. Without the
    // same-title exemption the margin test could never be satisfied and a genuinely
    // unambiguous match would be downgraded forever.
    const weekly = [
      ev('L+G Weekly Sync', '2026-09-02T10:00:00Z', [], 'jo@landisgyr.com'),
      ev('L+G Weekly Sync', '2026-09-09T10:00:00Z', [], 'jo@landisgyr.com'),
      ev('L+G Weekly Sync', '2026-09-16T10:00:00Z', [], 'jo@landisgyr.com'),
    ]
    const hit = pickCalendarEvent(ctx({
      senderEmail: 'jo@landisgyr.com',
      texts: ['L+G Weekly Sync'],
    }), weekly)
    expect(hit!.confident).toBe(true)
  })
})

describe('what it must NOT match', () => {
  it('an address match alone is never enough, even when it scores well', () => {
    // A colleague appears on dozens of unrelated events. If an exact match could decide
    // by itself, every mention of that person would attach to an arbitrary one of them.
    //
    // The date is chosen deliberately. Four days out clears the score floor on
    // proximity alone, so this case can ONLY be refused by the signal-count rule — an
    // earlier version of this test used a distant event and was silently passing
    // because of the floor, leaving the rule it claimed to cover untested.
    const unrelated = ev('Dentist', '2026-09-06T10:00:00Z', [], 'jo@landisgyr.com')
    const hit = pickCalendarEvent(ctx({
      senderEmail: 'jo@landisgyr.com',
      texts: ['Quarterly pricing paperwork'],
    }), [unrelated])
    expect(hit).not.toBeNull()
    expect(hit!.score).toBeGreaterThan(0.55)   // would pass on score
    expect(hit!.signals).toHaveLength(1)       // but stands on one leg
    expect(hit!.confident).toBe(false)
  })

  it('returns nothing when no candidate clears the floor', () => {
    const hit = pickCalendarEvent(ctx({
      senderEmail: 'noreply@newsletter.com',
      texts: ['Your weekly digest'],
    }), [ev('Board review', '2026-09-20T10:00:00Z', ['x@y.com'])])
    expect(hit).toBeNull()
  })

  it('ignores events beyond the window entirely', () => {
    const farOff = ev('Resonant Grid | L+G - Sync Up', '2027-03-01T10:00:00Z',
                      [], 'joseph1.guo@landisgyr.com')
    expect(scoreCandidate(ctx(), farOff)).toBeNull()
    expect(pickCalendarEvent(ctx(), [farOff])).toBeNull()
  })

  it('survives an event with no usable start date', () => {
    expect(scoreCandidate(ctx(), { summary: 'Broken', start: {} })).toBeNull()
  })
})
