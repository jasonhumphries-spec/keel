/**
 * Tests for L1 extraction — Stage 2, see docs/relevance-brain-design.md §3.
 *
 * The model's own accuracy is not testable here; that is what the shadow comparison
 * against the real corpus is for. What IS testable, and matters just as much, is that
 * the prompt asks only for facts, and that a bad answer degrades into something
 * visible rather than something confidently wrong.
 */

import { describe, it, expect } from 'vitest'
import { buildExtractionPrompt, parseExtraction, deriveDue } from '@/lib/extraction'

const TODAY = '2026-09-03'
const prompt = () => buildExtractionPrompt({
  subject: 'Invoice 56607', from: 'billing@x.com',
  threadBody: 'Please pay £192 by 10 September.', todayISO: TODAY,
})

describe('the prompt asks for facts, not judgement', () => {
  it('never asks the model to RETURN a score, rank or priority', () => {
    // The entire point of the split. Checked against the requested JSON schema
    // rather than the whole prompt: the prose legitimately says "do not assign a
    // priority", and a naive substring test would flag its own prohibition.
    const schema = prompt().slice(prompt().indexOf('Return ONLY valid JSON'),
                                 prompt().indexOf('OBLIGATION —'))
    for (const banned of ['importance', 'priority', 'score', 'rank', 'urgency']) {
      expect(schema.toLowerCase()).not.toContain(banned)
    }
  })

  it('says so explicitly, so the model does not volunteer a judgement', () => {
    expect(prompt()).toContain('Do NOT judge how important this is')
  })

  it('carries the thread and today\'s date', () => {
    const p = prompt()
    expect(p).toContain('Invoice 56607')
    expect(p).toContain('Please pay £192')
    expect(p).toContain(TODAY)
  })

  it('is far shorter than the prompt it replaces', () => {
    // The old one is ~6,000 tokens, of which ~900 are a scoring table now living in
    // scoring.ts. A smaller prompt is cheaper on every scan and easier to reason about.
    expect(prompt().length).toBeLessThan(4000)
  })

  it('caps the thread body so one enormous thread cannot blow the request', () => {
    const body = 'x'.repeat(50000)
    const p = buildExtractionPrompt({ subject: 's', from: 'f', threadBody: body, todayISO: TODAY })
    // Assert the truncation itself, not a magic total — the instruction text is
    // allowed to grow without breaking this test.
    expect(p).not.toContain(body)
    const longest = Math.max(...(p.match(/x+/g) ?? ['']).map(m => m.length))
    expect(longest).toBe(3000)
  })
})

describe('parsing', () => {
  const ok = JSON.stringify({
    obligation: 'payment_due', consequence: 'financial_penalty', ballWith: 'owner',
    isNoise: false, summary: 'Invoice for £192 due 10 September.',
    signals: [{ type: 'payment', description: 'Invoice 56607', date: '2026-09-10', amountPence: 19200 }],
  })

  it('reads a well-formed extraction', () => {
    const r = parseExtraction(ok, TODAY)!
    expect(r.obligation).toBe('payment_due')
    expect(r.consequence).toBe('financial_penalty')
    expect(r.ballWith).toBe('owner')
    expect(r.signals[0].amountPence).toBe(19200)
    expect(r.daysToDue).toBe(7)
    expect(r.dueType).toBe('payment')
  })

  it('tolerates prose around the JSON', () => {
    expect(parseExtraction('Here you go:\n' + ok + '\nHope that helps', TODAY)).not.toBeNull()
  })

  it('returns null on unparseable output rather than inventing facts', () => {
    expect(parseExtraction('sorry, I cannot help with that', TODAY)).toBeNull()
    expect(parseExtraction('', TODAY)).toBeNull()
  })

  it('falls back to a NEUTRAL obligation on an unknown value', () => {
    // Not "resolved" — a garbled extraction must never silence an item. Informational
    // scores mid-table, so the item stays visible and looks odd rather than vanishing.
    const r = parseExtraction(JSON.stringify({ ...JSON.parse(ok), obligation: 'nonsense' }), TODAY)!
    expect(r.obligation).toBe('informational')
  })

  it('drops signals with an unknown type or malformed date', () => {
    const r = parseExtraction(JSON.stringify({
      ...JSON.parse(ok),
      signals: [
        { type: 'wat', description: 'x', date: '2026-09-10', amountPence: null },
        { type: 'deadline', description: 'y', date: 'next Tuesday', amountPence: null },
      ],
    }), TODAY)!
    expect(r.signals).toHaveLength(1)          // the bad type is gone
    expect(r.signals[0].date).toBeNull()       // the vague date is discarded, not guessed
  })

  it('treats a missing isNoise as false rather than true', () => {
    const r = parseExtraction(JSON.stringify({ ...JSON.parse(ok), isNoise: undefined }), TODAY)!
    expect(r.isNoise).toBe(false)
  })
})

describe('deriving the due date', () => {
  type SigType = 'payment' | 'deadline' | 'event' | 'rsvp'
  const sig = (date: string | null, type: SigType = 'deadline') =>
    ({ type, description: 'x', date, amountPence: null })

  it('picks the NEAREST future signal', () => {
    const r = deriveDue([sig('2026-09-20'), sig('2026-09-05'), sig('2026-10-01')], TODAY)
    expect(r.daysToDue).toBe(2)
  })

  it('ignores dates in the past', () => {
    expect(deriveDue([sig('2026-08-01')], TODAY).daysToDue).toBeNull()
  })

  it('is null when nothing is dated', () => {
    expect(deriveDue([sig(null)], TODAY).daysToDue).toBeNull()
    expect(deriveDue([], TODAY).daysToDue).toBeNull()
  })

  it('reports which kind of signal is nearest', () => {
    expect(deriveDue([sig('2026-09-04', 'event'), sig('2026-09-30')], TODAY).dueType).toBe('event')
  })

  it('is computed, not asked for', () => {
    // The model has a measured history of getting date proximity wrong — the
    // hardcoded "within 2 days" override exists for exactly that reason. Arithmetic
    // belongs in code.
    expect(deriveDue([sig('2026-09-03')], TODAY).daysToDue).toBe(0)
    expect(deriveDue([sig('2026-09-04')], TODAY).daysToDue).toBe(1)
  })

  it('survives a malformed today', () => {
    expect(deriveDue([sig('2026-09-10')], 'not-a-date').daysToDue).toBeNull()
  })
})
