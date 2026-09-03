/**
 * Tests for the Stage 2 switch — see docs/relevance-brain-design.md §9.4.
 *
 * The scoring itself is covered by scoring.test.ts and measured against 371 human
 * labels. What is pinned here is the switch's safety: that the flag defaults OFF, that
 * a failure falls back rather than dropping mail, and that the status vocabulary the
 * rest of the app depends on is unchanged.
 */

import { describe, it, expect, vi } from 'vitest'
import { useSplitScoring } from '@/lib/server/splitScoring'
import type { Firestore } from 'firebase-admin/firestore'

/** Minimal Firestore stand-in: only `.doc().get()` is used by the flag read. */
const fakeDb = (userDoc: Record<string, unknown> | Error): Firestore => ({
  doc: () => ({
    get: async () => {
      if (userDoc instanceof Error) throw userDoc
      return { data: () => userDoc }
    },
  }),
}) as unknown as Firestore

describe('the flag defaults to OFF', () => {
  it('is off when the field is absent', async () => {
    expect(await useSplitScoring(fakeDb({ email: 'a@b.com' }), 'u')).toBe(false)
  })

  it('is off when explicitly false', async () => {
    expect(await useSplitScoring(fakeDb({ useSplitScoring: false }), 'u')).toBe(false)
  })

  it('is off when the read THROWS — never fail open', async () => {
    // A Firestore blip must not silently switch every user onto the new path.
    expect(await useSplitScoring(fakeDb(new Error('offline')), 'u')).toBe(false)
  })

  it('is off for a truthy-but-not-true value', async () => {
    expect(await useSplitScoring(fakeDb({ useSplitScoring: 'yes' }), 'u')).toBe(false)
    expect(await useSplitScoring(fakeDb({ useSplitScoring: 1 }), 'u')).toBe(false)
  })

  it('is on only for exactly true', async () => {
    expect(await useSplitScoring(fakeDb({ useSplitScoring: true }), 'u')).toBe(true)
  })
})

describe('classification via the split path', () => {
  const args = {
    subject: 'Outstanding invoice 56607', from: 'billing@x.com',
    threadBody: 'Your invoice remains unpaid.', categories: [],
  }
  const mockAi = (text: string) => {
    vi.doMock('@/lib/aiComplete', () => ({
      aiComplete: async () => ({ text, inputTokens: 10, outputTokens: 10 }),
    }))
  }

  it('returns null on unparseable output so the caller can fall back', async () => {
    // The caller does `split ?? oldClassifier`. Returning null is what makes a flagged
    // user degrade to the previous behaviour instead of losing the item entirely.
    vi.resetModules()
    mockAi('the model said something unhelpful')
    const { classifyThreadSplit: fn } = await import('@/lib/server/splitScoring')
    expect(await fn({} as Firestore, args)).toBeNull()
  })

  it('produces a status the rest of the app already understands', async () => {
    vi.resetModules()
    mockAi(JSON.stringify({
      obligation: 'payment_due', consequence: 'financial_penalty', ballWith: 'owner',
      isNoise: false, summary: 'Invoice unpaid.',
      signals: [{ type: 'payment', description: 'inv', date: null, amountPence: 19200 }],
    }))
    const { classifyThreadSplit: fn } = await import('@/lib/server/splitScoring')
    const r = await fn({} as Firestore, args)
    expect(r).not.toBeNull()
    // The status vocabulary is unchanged — the UI, expiry rules and evidence log all
    // key off it, and changing scoring and statuses at once would be unattributable.
    expect(['new', 'awaiting_action', 'awaiting_reply', 'quietly_logged']).toContain(r!.status)
    expect(r!.status).toBe('awaiting_action')
    expect(r!.aiImportanceScore).toBeGreaterThan(0.7)
  })

  it('quiets noise and records why', async () => {
    vi.resetModules()
    mockAi(JSON.stringify({
      obligation: 'informational', consequence: 'none', ballWith: 'nobody',
      isNoise: true, summary: 'Newsletter.', signals: [],
    }))
    const { classifyThreadSplit: fn } = await import('@/lib/server/splitScoring')
    const r = await fn({} as Firestore, args)
    expect(r!.status).toBe('quietly_logged')
    expect(r!.shouldProcess).toBe(false)
    expect((r as unknown as { quietedBy: string }).quietedBy).toBe('rule:promotional')
  })

  it('waits on the other party when the ball is theirs', async () => {
    vi.resetModules()
    mockAi(JSON.stringify({
      obligation: 'response_due', consequence: 'none', ballWith: 'other_party',
      isNoise: false, summary: 'Awaiting their reply.', signals: [],
    }))
    const { classifyThreadSplit: fn } = await import('@/lib/server/splitScoring')
    expect((await fn({} as Firestore, args))!.status).toBe('awaiting_reply')
  })

  it('carries the facts so a score can be explained', async () => {
    vi.resetModules()
    mockAi(JSON.stringify({
      obligation: 'overdue', consequence: 'financial_penalty', ballWith: 'owner',
      isNoise: false, summary: 'Overdue.', signals: [],
    }))
    const { classifyThreadSplit: fn } = await import('@/lib/server/splitScoring')
    const r = await fn({} as Firestore, args) as unknown as { extraction: Record<string, unknown> }
    expect(r.extraction.obligation).toBe('overdue')
    expect(r.extraction.scoredBy).toBe('split')
    expect(String(r.extraction.reason).length).toBeGreaterThan(0)
  })
})
