/**
 * Tests for the expiry review — see docs/relevance-brain-design.md §10.3.
 *
 * The model call itself is not tested here (that is what the 371-label eval is for,
 * `npm run eval:llm`). What is pinned down is everything around it: which items get
 * asked about, and that a malformed answer degrades safely rather than becoming a
 * confident "nothing to see here".
 */

import { describe, it, expect } from 'vitest'
import {
  buildExpiryPrompt, parseExpiryReview, needsExpiryReview,
} from '@/lib/server/expiryReview'

describe('which items get reviewed', () => {
  const base = {
    status: 'quietly_logged',
    quietedBy: 'expiry:stale',
    aiImportanceScore: 0.8,
    expiryReviewedAt: null,
  }

  it('reviews a High item buried by the stale timer', () => {
    expect(needsExpiryReview(base)).toBe(true)
  })

  it('reviews Urgent too', () => {
    expect(needsExpiryReview({ ...base, aiImportanceScore: 0.95 })).toBe(true)
  })

  it('skips Low and Medium — no labelled evidence that they matter', () => {
    expect(needsExpiryReview({ ...base, aiImportanceScore: 0.69 })).toBe(false)
    expect(needsExpiryReview({ ...base, aiImportanceScore: 0.2 })).toBe(false)
  })

  it('skips other quiet causes — this is about the timer, not the rules', () => {
    // A promotional quiet is a judgement about content and was measured as
    // 100% correct on the labelled set. Nothing to review.
    expect(needsExpiryReview({ ...base, quietedBy: 'rule:promotional' })).toBe(false)
    expect(needsExpiryReview({ ...base, quietedBy: 'ai' })).toBe(false)
    expect(needsExpiryReview({ ...base, quietedBy: 'expiry:past_event' })).toBe(false)
  })

  it('skips items that are not quiet at all', () => {
    expect(needsExpiryReview({ ...base, status: 'awaiting_action' })).toBe(false)
  })

  it('is idempotent — an already-reviewed item is never asked about twice', () => {
    expect(needsExpiryReview({ ...base, expiryReviewedAt: new Date() })).toBe(false)
  })
})

describe('parsing the answer', () => {
  it('reads a well-formed YES with severity', () => {
    const r = parseExpiryReview('YES\nSEVERITY: 8|tax filing still incomplete')
    expect(r.open).toBe(true)
    expect(r.score).toBeCloseTo(0.8, 5)
    expect(r.reason).toBe('tax filing still incomplete')
  })

  it('reads a well-formed NO', () => {
    const r = parseExpiryReview('NO\nSEVERITY: 1|optional retail offer only')
    expect(r.open).toBe(false)
    expect(r.score).toBeCloseTo(0.1, 5)
    expect(r.reason).toBe('optional retail offer only')
  })

  it('clamps an out-of-range severity', () => {
    expect(parseExpiryReview('YES\nSEVERITY: 99|x').score).toBe(1)
  })

  it('falls back to the binary when severity is missing', () => {
    // Better to sort every YES above every NO than to invent a number.
    const yes = parseExpiryReview('YES — document still unsigned')
    expect(yes.open).toBe(true)
    expect(yes.score).toBeGreaterThan(0)
    expect(parseExpiryReview('NO').score).toBe(0)
  })

  it('an unparseable answer degrades to "not open" and SAYS SO', () => {
    // The dangerous failure is a garbled reply silently reading as "nothing to see
    // here". The reason field has to carry that, or a broken model looks like a
    // clean inbox.
    const r = parseExpiryReview('')
    expect(r.open).toBe(false)
    expect(r.score).toBe(0)
    expect(r.reason).toMatch(/no answer/i)
  })

  it('never returns an empty reason', () => {
    for (const t of ['YES', 'NO', 'YES\nSEVERITY: 5|', 'garbage']) {
      expect(parseExpiryReview(t).reason.length).toBeGreaterThan(0)
    }
  })

  it('does not mistake a NO containing the word yes', () => {
    expect(parseExpiryReview('NO\nSEVERITY: 0|yes it was already paid').open).toBe(false)
  })
})

describe('the prompt', () => {
  const item = {
    subject: 'Outstanding invoice 56607',
    senderEmail: 'billing@example.com',
    aiSummary: 'Invoice remains unpaid.',
    aiDetailedSummary: '• NEXT STEP: pay the invoice',
  }

  it('includes the thread content the judgement depends on', () => {
    const p = buildExpiryPrompt(item)
    expect(p).toContain('Outstanding invoice 56607')
    expect(p).toContain('billing@example.com')
    expect(p).toContain('Invoice remains unpaid.')
  })

  it('LEAKS NOTHING about the label being predicted', () => {
    // Band, score and the fact of burial are all downstream of the very judgement
    // being asked for. Including any of them would inflate the eval.
    const p = buildExpiryPrompt(item).toLowerCase()
    for (const leak of ['urgent', 'high priority', 'aiimportancescore', 'band']) {
      expect(p).not.toContain(leak)
    }
  })

  it('asks about cost, not about whether a task exists', () => {
    // v1 asked "is a task open?" and scored 26% precision — technically right,
    // practically useless. The consequence framing is the measured one.
    const p = buildExpiryPrompt(item)
    expect(p).toContain('is there a real cost')
    expect(p).toContain('The test is not "is there something to do"')
  })

  it('tolerates missing fields without producing "undefined"', () => {
    const p = buildExpiryPrompt({})
    expect(p).not.toContain('undefined')
    expect(p).not.toContain('null')
  })

  it('caps the detail so one enormous thread cannot blow the request', () => {
    const p = buildExpiryPrompt({ ...item, aiDetailedSummary: 'x'.repeat(5000) })
    expect(p.length).toBeLessThan(3000)
  })
})
