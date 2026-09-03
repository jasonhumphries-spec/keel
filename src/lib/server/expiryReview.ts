/**
 * expiryReview.ts
 *
 * See docs/relevance-brain-design.md §10.3.
 *
 * When the stale timer buries a High or Urgent item, ask the model what it costs to
 * never see that item again — and keep the answer so the item can be surfaced for
 * review rather than silently deleted.
 *
 * WHY A QUESTION AND NOT A RULE. Four predicates were scored against 371 hand-labelled
 * items (§10.2). Sender engagement cannot see `noreply@` senders, which is exactly
 * where machine-generated obligations live. Learned keywords memorised *which
 * institutions matter to this user* and collapsed on held-out data. The best predicate
 * reached F1 0.49. Asking the model reached 76% recall — good enough to ORDER a review
 * list, not good enough to DECIDE on its own, which is precisely how it is used here.
 *
 * WHY "CONSEQUENCE" AND NOT "IS A TASK OPEN". The first version of this prompt asked
 * whether an obligation remained and scored 80% recall at 26% precision: it was
 * technically right — "respond to the Vinted offer" IS an open task — and still wrong,
 * because the user does not care. The dividing line in the labels is what it costs to
 * never act. That change alone cut wrongly-kept items from 56 to 36.
 */

/** The measured judgement, plus an unvalidated severity used only for ordering. */
export interface ExpiryReview {
  /** The binary from the evaluated prompt: would a real obligation be dropped? */
  open:   boolean
  /**
   * 0–1 severity, for ranking within the review list.
   *
   * NOT VALIDATED. The eval in §10.2 scored the binary only. This orders the list;
   * it must never gate a decision, or it would be asserting precision the evidence
   * does not support.
   */
  score:  number
  /** Short human-readable why, shown beside the item. */
  reason: string
}

/**
 * The prompt as evaluated (v2). Changing the wording invalidates the measured
 * 76%/35% — re-run `npm run eval:llm` against the 371 labels before shipping an edit.
 *
 * Deliberately withholds the item's band, score, and the fact that it was buried:
 * those are the label being predicted, and including them would leak it.
 */
export function buildExpiryPrompt(item: {
  subject?: string | null
  senderEmail?: string | null
  aiSummary?: string | null
  aiDetailedSummary?: string | null
}): string {
  const j = (v: unknown) => Array.isArray(v) ? v.join(' ') : (v ?? '')
  return `An email thread arrived and the account owner never acted on it. Weeks have passed. It is about to be hidden permanently.

SUBJECT: ${j(item.subject)}
FROM: ${j(item.senderEmail)}
SUMMARY: ${j(item.aiSummary)}
DETAIL: ${String(j(item.aiDetailedSummary)).slice(0, 900)}

Question: if this thread is hidden and the account owner NEVER sees it again, is there a real cost?

Answer YES only if never dealing with it means: money stays owed or unclaimed; a legal, tax or regulatory filing stays incomplete; a document stays unsigned; medical or school administration stays unresolved; or a specific person is left waiting on a reply the owner promised.

Answer NO if it is discretionary or low-stakes, even when a task technically remains: an optional purchase, offer, renewal or upgrade; an invitation the owner can simply decline or ignore; a marketing or loyalty prompt; a survey or feedback request; an app update or account nudge; a delivery, parcel or booking that resolves itself; social plans; anything already handled, superseded, or now in the past.

The test is not "is there something to do" — almost every email has something. The test is whether a real obligation would be silently dropped.

Reply with exactly two lines:
YES or NO
SEVERITY: <0-10, how costly it would be to never see this>|<six words why>`
}

/**
 * Parse the model's reply.
 *
 * Tolerant by design: a malformed answer must not crash a nightly sweep, and it must
 * not silently become a confident NO — an unparseable reply returns open=false with a
 * reason saying so, which shows up in the list as exactly that.
 */
export function parseExpiryReview(text: string): ExpiryReview {
  const raw = (text ?? '').trim()
  if (!raw) return { open: false, score: 0, reason: 'no answer from model' }

  const open = /^\s*yes\b/i.test(raw) || /\byes\b/i.test(raw.split('\n')[0] ?? '')

  const sevLine = raw.split('\n').find(l => /severity/i.test(l)) ?? ''
  const sevNum  = sevLine.match(/severity\s*:?\s*(\d{1,2})/i)?.[1]
  const sev     = sevNum === undefined ? null : Math.min(10, Math.max(0, parseInt(sevNum, 10)))

  const afterPipe = sevLine.split('|')[1]?.trim()
  const reason = (afterPipe && afterPipe.length > 0 ? afterPipe : raw.split('\n').slice(1).join(' ').trim())
    .replace(/^severity\s*:?\s*\d{0,2}\s*\|?\s*/i, '')
    .slice(0, 80) || (open ? 'obligation may remain' : 'no obligation identified')

  // With no severity given, fall back to the binary rather than inventing a number:
  // a YES sorts above every NO, and ties break on recency in the UI.
  const score = sev !== null ? sev / 10 : (open ? 0.6 : 0)
  return { open, score, reason }
}

/** Bands the review runs for. Low and Medium are not asked about — the labelled
 *  evidence covers High and Urgent only, and 90% of quieting is already correct. */
export function needsExpiryReview(item: {
  status?: string | null
  quietedBy?: string | null
  aiImportanceScore?: number | null
  expiryReviewedAt?: unknown
}): boolean {
  if (item.status !== 'quietly_logged') return false
  if (item.quietedBy !== 'expiry:stale') return false
  if ((item.aiImportanceScore ?? 0) < 0.70) return false
  return !item.expiryReviewedAt
}
