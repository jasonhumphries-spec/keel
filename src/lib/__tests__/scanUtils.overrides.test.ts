/**
 * Characterisation + regression suite for applyPostClassificationOverrides.
 *
 * See docs/relevance-brain-design.md §4.1 and §9 (Stage 1).
 *
 * This function is where every regression in the recent commit history happened:
 * a regex is tightened, a rule is reordered, an over-fire is reverted, and the only
 * way to tell whether the change helped was to look at one email. It is a PURE
 * function of the AI's own output — no network, no clock except Date.now() (faked
 * here) — so it can be pinned down exhaustively at zero cost.
 *
 * Tests marked REGRESSION cite the commit whose bug they lock down. Deleting one
 * without understanding it re-opens a bug that was already fixed once.
 *
 * These tests assert CURRENT behaviour, including places where that behaviour looks
 * questionable. Where a test documents a smell rather than an intent, it says so.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyPostClassificationOverrides, OVERRIDES_VERSION } from '@/lib/scanUtils'

const NOW = new Date('2026-09-01T12:00:00Z')
const daysOut = (n: number) =>
  new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10)

/** Shapes the override function reads and writes. It is typed `any` at the call
 *  boundary because the AI's JSON is untrusted; these give the tests real types. */
interface Sig {
  type:         string
  description:  string
  detectedDate: string | null
}
interface Parsed {
  status:             string
  aiImportanceScore:  number
  aiTitle:            string
  aiSummary:          string
  aiDetailedSummary:  string
  signals?:           Sig[]
  autoQuietedReason?: string
  quietedBy?:         string
  quietedFromStatus?: string
  overridesVersion?:  number
}

/** A neutral classification result that triggers no override on its own. */
function mk(over: Partial<Parsed> = {}): Parsed {
  return {
    status:            'awaiting_action',
    aiImportanceScore: 0.60,
    aiTitle:           'Roof quote from builder',
    aiSummary:         'Builder sent a quote for the roof work.',
    aiDetailedSummary: '• PURPOSE: Quote for roof repairs.',
    signals:           [],
    ...over,
  }
}
const run = (p: Parsed, from = 'someone@example.com', owner = 'jason.humphries@gmail.com') =>
  applyPostClassificationOverrides(p, from, owner) as { parsed: Parsed; applied: string[] }
const types = (p: Parsed) => (p.signals ?? []).map(s => s.type)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(()  => { vi.useRealTimers() })

// ── Baseline ───────────────────────────────────────────────────────────────

describe('baseline', () => {
  it('leaves an ordinary item untouched and stamps the version', () => {
    const { parsed, applied } = run(mk())
    expect(applied).toEqual([])
    expect(parsed.status).toBe('awaiting_action')
    expect(parsed.aiImportanceScore).toBe(0.60)
    expect(parsed.overridesVersion).toBe(OVERRIDES_VERSION)
  })

  it('tolerates a missing signals array', () => {
    expect(() => run(mk({ signals: undefined }))).not.toThrow()
  })
})

// ── 1. Proximity ───────────────────────────────────────────────────────────

describe('proximity', () => {
  it('bumps to 0.88 when a signal falls within 2 days', () => {
    const { parsed, applied } = run(mk({
      signals: [{ type: 'deadline', description: 'Confirm attendance', detectedDate: daysOut(1) }],
    }))
    expect(applied).toContain('proximity')
    expect(parsed.aiImportanceScore).toBe(0.88)
  })

  it('ignores signals further out than 2 days', () => {
    const { parsed, applied } = run(mk({
      signals: [{ type: 'event', description: 'School fair', detectedDate: daysOut(9) }],
    }))
    expect(applied).not.toContain('proximity')
    expect(parsed.aiImportanceScore).toBe(0.60)
  })

  it('ignores past-dated signals — a date that has gone carries no urgency', () => {
    const { parsed } = run(mk({
      signals: [{ type: 'event', description: 'Last week', detectedDate: daysOut(-3) }],
    }))
    expect(parsed.aiImportanceScore).toBe(0.60)
  })

  it('does not lower an item already scored above the bump', () => {
    const { parsed } = run(mk({
      aiImportanceScore: 0.95,
      signals: [{ type: 'deadline', description: 'Pay', detectedDate: daysOut(1) }],
    }))
    expect(parsed.aiImportanceScore).toBe(0.95)
  })
})

// ── 2. Event → deadline ────────────────────────────────────────────────────

describe('event to deadline reclassification', () => {
  it.each([
    ['Ship by 8 June'],
    ['Register by Friday'],
    ['Respond before the 12th'],
  ])('reclassifies "%s" as a deadline', (description) => {
    const { parsed, applied } = run(mk({
      signals: [{ type: 'event', description, detectedDate: daysOut(10) }],
    }))
    expect(types(parsed)[0]).toBe('deadline')
    expect(applied).toContain('event-to-deadline')
  })

  it('leaves a genuine calendar event alone', () => {
    const { parsed, applied } = run(mk({
      signals: [{ type: 'event', description: 'Sports day at the school field', detectedDate: daysOut(10) }],
    }))
    expect(types(parsed)[0]).toBe('event')
    expect(applied).not.toContain('event-to-deadline')
  })
})

// ── 3. Auto-pay ────────────────────────────────────────────────────────────

describe('auto-pay', () => {
  it.each([
    ['direct debit'], ['standing order'], ['auto-renew'], ['will automatically'],
  ])('drops score and de-escalates status on "%s"', (phrase) => {
    const { parsed, applied } = run(mk({
      status: 'awaiting_action',
      aiImportanceScore: 0.90,
      aiSummary: `Your bill will be collected by ${phrase} on the 14th.`,
    }))
    expect(applied).toContain('auto-pay')
    expect(parsed.aiImportanceScore).toBe(0.18)
    expect(parsed.status).toBe('new')
  })

  it('does not fire on an item already scored low', () => {
    const { applied } = run(mk({ aiImportanceScore: 0.20, aiSummary: 'Paid by direct debit.' }))
    expect(applied).not.toContain('auto-pay')
  })
})

// ── 4. Resolved ────────────────────────────────────────────────────────────

describe('resolved', () => {
  it.each([
    ['No further action is required.'],
    ['No action is needed.'],
    ['The matter is resolved.'],
    ['This is for information only.'],
  ])('quiets on "%s"', (summary) => {
    const { parsed, applied } = run(mk({ aiSummary: summary }))
    expect(applied).toContain('resolved')
    expect(parsed.status).toBe('quietly_logged')
    expect(parsed.aiImportanceScore).toBe(0.10)
  })

  it('strips deadline and rsvp signals but keeps events', () => {
    const { parsed } = run(mk({
      aiSummary: 'No further action required.',
      signals: [
        { type: 'deadline', description: 'Cancel by the 3rd', detectedDate: daysOut(20) },
        { type: 'rsvp',     description: 'RSVP',              detectedDate: daysOut(20) },
        { type: 'event',    description: 'Concert',           detectedDate: daysOut(20) },
      ],
    }))
    expect(types(parsed)).toEqual(['event'])
  })
})

// ── 5 & 6. Self-consistency, and its ordering against payment-made ─────────

describe('self-consistency', () => {
  it('flips awaiting_action to awaiting_reply when a named person owes the next move', () => {
    const { parsed, applied } = run(mk({
      status: 'awaiting_action',
      aiImportanceScore: 0.80,
      aiDetailedSummary: '• NEXT STEP: Steven Friel needs to confirm the survey date.',
    }))
    expect(applied).toContain('self-consistency:action-to-reply')
    expect(parsed.status).toBe('awaiting_reply')
    expect(parsed.aiImportanceScore).toBe(0.55)   // urgency capped — ball is elsewhere
  })

  it('flips awaiting_reply back to awaiting_action when the owner owes the next move', () => {
    const { parsed, applied } = run(mk({
      status: 'awaiting_reply',
      aiDetailedSummary: '• NEXT STEP: Jason needs to send the signed form.',
    }))
    expect(applied).toContain('self-consistency:reply-to-action')
    expect(parsed.status).toBe('awaiting_action')
  })

  it('does nothing without a NEXT STEP bullet', () => {
    const { applied } = run(mk({ aiDetailedSummary: '• PURPOSE: Something.' }))
    expect(applied.some(a => a.startsWith('self-consistency'))).toBe(false)
  })

  it('does nothing when no owner email is supplied', () => {
    const { applied } = run(
      mk({ aiDetailedSummary: '• NEXT STEP: Steven Friel needs to confirm.' }),
      'someone@example.com',
      '',
    )
    expect(applied.some(a => a.startsWith('self-consistency'))).toBe(false)
  })

  // ── Characterisation of the actor-detection heuristic ───────────────────
  //
  // These record what the heuristic ACTUALLY does, not what it ideally would.
  // 5c0428e narrowed it to avoid firing on organisation names, and it does now
  // ignore single-word ones — but a two-word org name still reads as a person.
  // Left as-is deliberately: changing it alters live classification, and there is
  // no golden set yet to prove the change is an improvement. Fix in Stage 2/3,
  // measured. See docs/relevance-brain-design.md §4.1.

  it('ignores single-word organisation names (5c0428e)', () => {
    const { applied } = run(mk({
      aiDetailedSummary: '• NEXT STEP: LinkedIn will send a confirmation.',
    }))
    expect(applied.some(a => a.startsWith('self-consistency'))).toBe(false)
  })

  it('KNOWN GAP: a two-word organisation name still reads as a human actor', () => {
    const { parsed, applied } = run(mk({
      aiDetailedSummary: '• NEXT STEP: Companies House needs to process the filing.',
    }))
    // Documents current behaviour. "Companies House", "Royal Mail", "Land Registry"
    // all satisfy the two-capitalised-words test that stands in for "is a person".
    expect(applied).toContain('self-consistency:action-to-reply')
    expect(parsed.status).toBe('awaiting_reply')
  })

  it('fires the passive branch on any "waiting for X" phrasing', () => {
    // The regex offers ([A-Z][a-z]+|[a-z]+) but is tested against a lowercased
    // string, so the capitalised alternative is unreachable — any noun matches.
    const { applied } = run(mk({
      aiDetailedSummary: '• NEXT STEP: Waiting for the surveyor to confirm.',
    }))
    expect(applied).toContain('self-consistency:action-to-reply')
  })

  it('does not fire on a lowercase institutional actor', () => {
    const { applied } = run(mk({
      aiDetailedSummary: '• NEXT STEP: The school office must send the form.',
    }))
    expect(applied.some(a => a.startsWith('self-consistency'))).toBe(false)
  })

  // REGRESSION — fe7b00b "reorder overrides: self-consistency runs before payment-made".
  // Paying an invoice must not bury a thread where the counterparty still owes a reply.
  it('REGRESSION fe7b00b: self-consistency wins over payment-made', () => {
    const { parsed, applied } = run(mk({
      status: 'awaiting_action',
      aiImportanceScore: 0.80,
      aiSummary: 'The invoice has been paid.',
      aiDetailedSummary: '• NEXT STEP: Steven Friel needs to confirm receipt.',
    }))
    expect(parsed.status).toBe('awaiting_reply')
    expect(applied).not.toContain('payment-made')
  })
})

describe('payment-made', () => {
  it('de-escalates a paid invoice still sitting in awaiting_action', () => {
    const { parsed, applied } = run(mk({
      status: 'awaiting_action',
      aiImportanceScore: 0.85,
      aiSummary: 'Payment was made on the 3rd.',
    }))
    expect(applied).toContain('payment-made')
    expect(parsed.status).toBe('new')
    expect(parsed.aiImportanceScore).toBe(0.25)
  })

  it('leaves statuses other than awaiting_action alone', () => {
    const { applied } = run(mk({ status: 'new', aiSummary: 'The invoice has been paid.' }))
    expect(applied).not.toContain('payment-made')
  })
})

// ── 7a. Feedback requests ──────────────────────────────────────────────────

describe('feedback-request', () => {
  it.each([
    ['AIRDO Flight ADO024 Feedback Request', 'title'],
    ['Please rate your stay with us',        'rate your X'],
    ['We would love to hear your thoughts',  'love to hear'],
    ['Leave us a review',                    'leave a review'],
  ])('quiets "%s" (%s)', (text) => {
    const { parsed, applied } = run(mk({ aiTitle: text, aiSummary: text }))
    expect(applied).toContain('feedback-request')
    expect(parsed.status).toBe('quietly_logged')
    expect(parsed.autoQuietedReason).toBe('feedback_request')
  })

  // REGRESSION — 99c65eb "tighten feedback-request patterns".
  // The bare verb "review" appears constantly in legitimate admin.
  it.each([
    ['Please review the details of the contract before Friday'],
    ['Review the roles and confirm which you want'],
    ['Your annual review meeting is scheduled'],
  ])('REGRESSION 99c65eb: does not fire on "%s"', (summary) => {
    const { applied } = run(mk({ aiTitle: 'Contract', aiSummary: summary }))
    expect(applied).not.toContain('feedback-request')
  })

  // REGRESSION — dc7b50b "broader feedback patterns (seeking/requesting phrasing)".
  it('REGRESSION dc7b50b: fires on "seeking your feedback" phrasing', () => {
    const { applied } = run(mk({ aiSummary: 'The airline is seeking your feedback on the flight.' }))
    expect(applied).toContain('feedback-request')
  })
})

// ── Quiet provenance ───────────────────────────────────────────────────────
//
// Every route to quietly_logged must name its cause, or no quiet rule's precision
// can ever be measured — the model's judgement, lifecycle expiry and a rule firing
// are otherwise indistinguishable in the data. See docs §9.2.1.

describe('quietedBy provenance', () => {
  it('stamps rule:resolved', () => {
    const { parsed } = run(mk({ aiSummary: 'No further action is required.' }))
    expect(parsed.quietedBy).toBe('rule:resolved')
  })

  it('stamps rule:feedback_request', () => {
    const { parsed } = run(mk({ aiSummary: 'Please rate your stay with us.' }))
    expect(parsed.quietedBy).toBe('rule:feedback_request')
  })

  it('stamps rule:promotional', () => {
    const { parsed } = run(mk({ aiSummary: 'Get 20% off your next order.' }))
    expect(parsed.quietedBy).toBe('rule:promotional')
  })

  it('leaves quietedBy unset when no rule quiets the item', () => {
    // The scan routes fall back to 'ai' in this case — the override function must
    // not claim a quiet it did not cause.
    const { parsed } = run(mk())
    expect(parsed.quietedBy).toBeUndefined()
  })

  it.each([
    ['awaiting_action', 'No further action is required.',   'rule:resolved'],
    ['awaiting_action', 'Please rate your stay with us.',   'rule:feedback_request'],
    ['new',             'Get 20% off your next order.',     'rule:promotional'],
  ])('records what was silenced: %s + %s', (status, summary, cause) => {
    const { parsed } = run(mk({ status, aiSummary: summary }))
    expect(parsed.quietedBy).toBe(cause)
    // quietedFromStatus captures the status the override overrode — without it,
    // "buried an actionable item" and "tidied an informational one" look identical.
    expect(parsed.quietedFromStatus).toBe(status)
    expect(parsed.status).toBe('quietly_logged')
  })

  it('does not record a from-status when nothing was quieted', () => {
    const { parsed } = run(mk())
    expect(parsed.quietedFromStatus).toBeUndefined()
  })

  it('every quieting override sets a cause', () => {
    for (const summary of [
      'No further action is required.',
      'Please rate your stay with us.',
      'Get 20% off your next order.',
    ]) {
      const { parsed } = run(mk({ aiSummary: summary }))
      expect(parsed.status).toBe('quietly_logged')
      expect(parsed.quietedBy).toMatch(/^rule:/)
    }
  })
})

// ── 7b. Promotional ────────────────────────────────────────────────────────

describe('promotional', () => {
  // REGRESSION — 7903287 "promotional regex no longer matches accounting language".
  // "£648 credit" is money owed to the customer, not a discount. This wrongly quieted
  // a real DPC Accountants invoice.
  it.each([
    ['DPC Accountants invoice B4664 includes a £648 credit against the balance.'],
    ['Your account shows £50 back from the overpayment.'],
    ['A 5% credit has been applied to your account.'],
  ])('REGRESSION 7903287: does not quiet accounting language — "%s"', (summary) => {
    const { parsed, applied } = run(mk({ aiTitle: 'Invoice B4664', aiSummary: summary }))
    expect(applied).not.toContain('promotional')
    expect(parsed.status).toBe('awaiting_action')
  })

  it.each([
    ['Get 20% off your next order'],
    ['Save £15 off when you spend £50'],
    ['Special offer — limited time only'],
    ['Use promo code SUMMER for money off'],
  ])('quiets genuine discount language — "%s"', (summary) => {
    const { parsed, applied } = run(mk({ aiSummary: summary }))
    expect(applied).toContain('promotional')
    expect(parsed.status).toBe('quietly_logged')
    expect(parsed.autoQuietedReason).toBe('promotional')
  })

  it.each([
    ['rewards@retailer.com'], ['news@brand.co.uk'], ['offers@shop.com'],
    ['newsletter-weekly@brand.com'], ['promo.uk@brand.com'],
  ])('quiets on marketing sender local-part "%s"', (from) => {
    const { applied } = run(mk(), from)
    expect(applied).toContain('promotional')
  })

  it('does not quiet an ordinary sender whose name merely contains a marketing word', () => {
    const { applied } = run(mk(), 'jane.newsome@builders.co.uk')
    expect(applied).not.toContain('promotional')
  })

  it('strips payment and deadline signals when quieting, keeping events', () => {
    const { parsed } = run(mk({
      aiSummary: '20% off ends soon',
      signals: [
        { type: 'payment',  description: 'Offer price £1.99', detectedDate: null },
        { type: 'deadline', description: 'Offer valid until', detectedDate: daysOut(20) },
        { type: 'event',    description: 'In-store launch',   detectedDate: daysOut(20) },
      ],
    }))
    expect(types(parsed)).toEqual(['event'])
  })
})
