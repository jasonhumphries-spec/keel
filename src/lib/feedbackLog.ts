/**
 * feedbackLog.ts
 *
 * Stage 0 of the relevance brain — see docs/relevance-brain-design.md §3 (L4).
 *
 * Every user action on an item is an implicit label about what matters to them.
 * Today those labels are thrown away: only categoryHints and ignoredSenders
 * survive, and they feed category choice alone, never priority.
 *
 * This module records them to an append-only log at users/{uid}/feedback.
 * It changes no behaviour. Nothing reads the log yet — Stage 3 (priors) and
 * Stage 4 (reflection) do. It exists now because you cannot learn from data
 * you never recorded, and every week without it is a week of labels lost.
 *
 * Two rules govern the design:
 *
 *   1. NEVER BLOCK THE UI. Logging is fire-and-forget and swallows its own
 *      errors. A failed log must never break the user action that produced it.
 *      Call sites use `void logFeedback(...)` and do not await.
 *
 *   2. EVENTS ARE SELF-CONTAINED. Each event snapshots the item state as it
 *      was at the moment of the action. When reflection runs weeks later the
 *      item may have been re-classified, merged, resolved or deleted — the
 *      event must still be readable on its own. Snapshot, never reference.
 *
 * The score and status captured in `prior` are the system's belief immediately
 * before the user acted. That pairing — what we thought, what they did — is the
 * training label. Without it an event says only "something happened".
 */

import { addDoc, collection, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { KeelItem, KeelSignal } from '@/lib/types'

// ── Actions ────────────────────────────────────────────────────────────────

/**
 * Every action a user can take that carries information about relevance.
 *
 * Grouped by what they tell us:
 *
 *   Negative  — the item mattered less than we scored it
 *   Positive  — the item mattered more, or mattered at the right level
 *   Timing    — right item, wrong moment (distinct from relevance; see §10.3)
 *   Category  — we filed it wrong (relevance may still be correct)
 *   Attention — weak signal, high volume, useful only in aggregate
 *
 * Not listed here: "dismissed without ever opening", which is a strong negative.
 * It is deliberately NOT emitted by the client, because the client only knows
 * about opens in the current session. Reflection derives it by joining a resolve
 * event against the absence of any prior `opened` event for the same itemId.
 */
export type FeedbackAction =
  // Negative
  | 'ignored_item'          // manually quieted — we surfaced noise
  | 'ignored_sender'        // hard negative, generalises beyond this item
  | 'categorise_skipped'    // sent to quiet from the To Categorise queue
  // Positive
  | 'marked_done'           // was genuinely actionable
  | 'marked_paid'           // payment signal was real and acted on
  | 'archived'
  | 'priority_raised'       // we under-scored it
  | 'priority_lowered'      // we over-scored it
  | 'priority_reset'        // user withdrew their own manual override
  | 'restored_from_quiet'   // STRONG: our auto-quiet was wrong
  | 'undone'                // user reversed their own resolve — it did matter
  | 'note_added'            // enough investment to write something down
  | 'calendar_added'        // event signal was real
  // Timing
  | 'snoozed'
  | 'unsnoozed'
  // Category
  | 'recategorised'
  | 'categorised'           // assigned from the To Categorise queue
  // Signal-level
  | 'calendar_ignored'      // event signal was noise, or already handled
  // Attention
  | 'opened'                // expanded the item — attention without action

/** Where the action was taken. Useful for weighting: a deliberate action in the
 *  expanded panel is stronger evidence than a fast swipe in a list. */
export type FeedbackSource =
  | 'expanded_panel'
  | 'category_grid'
  | 'categorise_modal'
  | 'quietly_logged'
  | 'awaiting_reply'
  | 'all_mail'
  | 'dashboard'

// ── Event shape ────────────────────────────────────────────────────────────

export interface FeedbackEvent {
  action:    FeedbackAction
  source:    FeedbackSource
  itemId:    string
  createdAt: Timestamp

  /** The system's belief immediately before the user acted. This is the label. */
  prior: {
    score:             number | null
    status:            string | null
    categoryId:        string | null
    manualPriority:    boolean
    autoQuietedReason: string | null
  }

  /** Item facts, snapshotted. Stage 2 will replace this with true L1 extraction
   *  output; until then these are the closest thing we have to objective facts. */
  facts: {
    senderEmail:  string | null
    senderDomain: string | null
    aiTitle:      string | null
    threadId:     string | null
    isOutbound:   boolean
    isRecurring:  boolean
    /** Hours between the email arriving and the user acting on it. The clearest
     *  urgency-calibration signal available at Stage 0. */
    ageHours:     number | null
    /** Signal types present, and the nearest future dated signal, if any. */
    signalTypes:  string[]
    nearestSignalDays: number | null
  }

  /** Action-specific payload — the new priority band, the target category, the
   *  snooze length. Shape varies by action; readers must tolerate absence. */
  detail?: Record<string, unknown>
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Items already logged as `opened` this session.
 *
 * Expanding an item is by far the highest-volume action, and re-expanding the
 * same item in one sitting says nothing new. Deduping here keeps the log — and
 * the Firestore write bill — proportionate to the signal it carries.
 */
const openedThisSession = new Set<string>()

function domainOf(email: string | null | undefined): string | null {
  const at = (email ?? '').lastIndexOf('@')
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null
}

function buildFacts(item: KeelItem, signals?: KeelSignal[]): FeedbackEvent['facts'] {
  const mine = (signals ?? []).filter(s => s.itemId === item.itemId)

  // Nearest signal still in the future, in whole days. Past-dated signals are
  // excluded — an event that already happened carries no urgency information.
  let nearestSignalDays: number | null = null
  for (const s of mine) {
    if (!s.detectedDate) continue
    const days = Math.round((s.detectedDate.getTime() - Date.now()) / 86400000)
    if (days < 0) continue
    if (nearestSignalDays === null || days < nearestSignalDays) nearestSignalDays = days
  }

  const receivedMs = item.receivedAt instanceof Date ? item.receivedAt.getTime() : null

  return {
    senderEmail:  item.senderEmail ?? null,
    senderDomain: domainOf(item.senderEmail),
    aiTitle:      item.aiTitle ?? null,
    threadId:     item.threadId ?? null,
    isOutbound:   item.isOutbound ?? false,
    isRecurring:  item.isRecurring ?? false,
    ageHours:     receivedMs === null ? null : Math.round((Date.now() - receivedMs) / 3600000),
    signalTypes:  [...new Set(mine.map(s => s.type))],
    nearestSignalDays,
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a user action against an item.
 *
 * Fire-and-forget: never throws, never blocks. Call as `void logFeedback(...)`
 * alongside the Firestore write it accompanies — not instead of awaiting it.
 *
 * @param uid     Signed-in user id. Falsy uid is a no-op.
 * @param action  What the user did.
 * @param source  Which surface they did it on.
 * @param item    Item snapshot as it was *before* the write.
 * @param detail  Action-specific extras (new band, target category, snooze days).
 * @param signals All loaded signals; filtered to this item internally. Optional.
 */
export async function logFeedback(
  uid:     string | null | undefined,
  action:  FeedbackAction,
  source:  FeedbackSource,
  item:    KeelItem | null | undefined,
  detail?: Record<string, unknown>,
  signals?: KeelSignal[],
): Promise<void> {
  if (!uid || !item?.itemId) return

  if (action === 'opened') {
    if (openedThisSession.has(item.itemId)) return
    openedThisSession.add(item.itemId)
  }

  try {
    const event: FeedbackEvent = {
      action,
      source,
      itemId:    item.itemId,
      createdAt: Timestamp.now(),
      prior: {
        score:             item.aiImportanceScore ?? null,
        status:            item.status ?? null,
        categoryId:        item.categoryId ?? null,
        manualPriority:    item.manualPriority ?? false,
        autoQuietedReason: item.autoQuietedReason ?? null,
      },
      facts: buildFacts(item, signals),
      ...(detail && Object.keys(detail).length > 0 ? { detail } : {}),
    }

    await addDoc(collection(db, `users/${uid}/feedback`), event)
  } catch (e) {
    // Deliberately swallowed. A failed label is a lost label, never a broken
    // user action. Logged at debug volume so it is visible when investigating
    // an unexpectedly sparse log, without adding noise to normal console use.
    console.debug('[feedbackLog] write failed (non-fatal):', action, e)
  }
}

/**
 * Classify a manual priority change into raised / lowered / reset.
 *
 * The direction is the signal — "user touched priority" tells us nothing, while
 * "user raised this from Low to Urgent" is a precise correction of our score.
 */
export function priorityAction(
  previousScore: number | null | undefined,
  newScore:      number | null,
): Extract<FeedbackAction, 'priority_raised' | 'priority_lowered' | 'priority_reset'> {
  if (newScore === null) return 'priority_reset'
  const prev = previousScore ?? 0.5
  return newScore >= prev ? 'priority_raised' : 'priority_lowered'
}
