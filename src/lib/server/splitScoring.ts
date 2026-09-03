/**
 * splitScoring.ts — the Stage 2 switch. See docs/relevance-brain-design.md §9.4.
 *
 * Runs L1 extraction plus L2 deterministic scoring and returns the same shape the
 * single-pass classifier does, so the scan routes can use either without knowing which.
 *
 * BEHIND A FLAG, AND DELIBERATELY SO. The evidence supports the split — it separates
 * the 371 human labels (+0.075) where the current prompt does not (−0.010), it is
 * stable across repeated runs (100% band stability), and both regressions found by
 * inspection are fixed. But 4 of 10 items it calls Urgent are extraction errors
 * (shipping labels read as `overdue / financial_penalty`), which means something odd
 * will show up within a day. A config write must be enough to undo that; a redeploy is
 * not.
 *
 * The flag lives on the user document so it is per-user and instantly reversible:
 *   users/{uid}.useSplitScoring = true | false | undefined  (undefined = off)
 */

import type { Firestore } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'
import { buildExtractionPrompt, parseExtraction } from '@/lib/extraction'
import { scoreFromFacts } from '@/lib/scoring'
import type { ClassificationResult } from '@/lib/scanUtils'

/** Read the per-user flag. Absent, unreadable or false all mean "use the old path". */
export async function useSplitScoring(db: Firestore, uid: string): Promise<boolean> {
  try {
    const doc = await db.doc(`users/${uid}`).get()
    return doc.data()?.useSplitScoring === true
  } catch {
    return false
  }
}

/**
 * Map the extracted obligation onto the status the app already understands.
 *
 * The status vocabulary is unchanged: the UI, the expiry rules and the evidence log
 * all key off it, and changing scoring and status semantics in one step would be
 * impossible to attribute if something looked wrong.
 */
function statusFor(
  obligation: string,
  ballWith: 'owner' | 'other_party' | 'nobody',
  isNoise: boolean,
): ClassificationResult['status'] {
  if (isNoise) return 'quietly_logged'
  if (obligation === 'resolved' || obligation === 'receipt') return 'quietly_logged'
  if (ballWith === 'other_party') return 'awaiting_reply'
  if (ballWith === 'owner') return 'awaiting_action'
  return 'new'
}

/**
 * Classify by extraction + deterministic scoring.
 *
 * Returns null on failure so the caller can fall back to the single-pass classifier
 * rather than dropping the item — a flagged-on user must never lose mail because the
 * new path had a bad day.
 */
export async function classifyThreadSplit(
  db: Firestore,
  args: {
    subject: string
    from: string
    threadBody: string
    categories: { id: string; name: string; description: string }[]
    isUK?: boolean
  },
): Promise<(ClassificationResult & { extraction: Record<string, unknown> }) | null> {
  const today = new Date().toISOString().slice(0, 10)
  const prompt = buildExtractionPrompt({
    subject: args.subject, from: args.from, threadBody: args.threadBody,
    todayISO: today, isUK: args.isUK ?? true,
  })

  const { text, inputTokens, outputTokens } = await aiComplete(db, prompt, 700)
  const facts = parseExtraction(text, today)
  if (!facts) return null

  const scored = scoreFromFacts(facts)
  const status = statusFor(facts.obligation, facts.ballWith, facts.isNoise)

  return {
    shouldProcess: !facts.isNoise,
    // Category is NOT part of the split. The extraction prompt deliberately does not
    // choose one, so the caller keeps whatever category logic it already has.
    categoryId: '', categoryName: '',
    aiTitle: args.subject.slice(0, 90),
    aiSummary: facts.summary,
    aiDetailedSummary: scored.reason,
    aiImportanceScore: scored.score,
    signals: facts.signals.map(s => ({
      type: s.type,
      description: s.description,
      detectedDate: s.date,
      detectedAmountPence: s.amountPence,
      currency: s.amountPence !== null ? 'GBP' : null,
    })),
    isRecurring: false,
    status,
    autoQuietedReason: facts.isNoise ? 'promotional' : null,
    quietedBy: facts.isNoise ? 'rule:promotional' : null,
    _usage: { inputTokens, outputTokens },
    /** Stored on the item so a score can be explained and the path identified. */
    extraction: {
      obligation:  facts.obligation,
      consequence: facts.consequence,
      ballWith:    facts.ballWith,
      daysToDue:   facts.daysToDue,
      urgency:     scored.urgency,
      consequenceWeight: scored.consequence,
      reason:      scored.reason,
      scoredBy:    'split',
    },
  } as ClassificationResult & { extraction: Record<string, unknown> }
}
