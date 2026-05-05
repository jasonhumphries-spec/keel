/**
 * nightlyArchive Cloud Function
 *
 * Runs nightly (02:00 Europe/London) and does two things:
 *
 * 1. ESCALATE TO OVERDUE
 *    Items with status 'awaiting_action' that have a payment or deadline signal
 *    whose detectedDate is more than 2 days in the past → set status = 'overdue'.
 *    The 2-day grace period avoids false positives on same-day items.
 *
 * 2. ARCHIVE STALE ITEMS
 *    - 'new' items with an event/rsvp/info signal whose detectedDate has passed → 'archived'
 *    - 'quietly_logged' items older than 90 days → 'archived'
 *    - 'new' items older than 30 days with aiImportanceScore < 0.5 → 'archived'
 *
 * Skips items with manualPriority = true (user has explicitly touched them).
 */

import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import * as logger from 'firebase-functions/logger'

const db = getFirestore()

const OPEN_STATUSES_TO_ESCALATE = ['awaiting_action', 'payment_due', 'action_required']
const ESCALATE_SIGNAL_TYPES     = ['payment', 'deadline', 'rsvp']
const ARCHIVE_SIGNAL_TYPES      = ['event', 'rsvp', 'info']

const GRACE_DAYS_OVERDUE        = 2   // days past signal date before escalating
const QUIET_ARCHIVE_DAYS        = 90  // days before quietly_logged items are archived
const NEW_ARCHIVE_DAYS          = 30  // days before low-importance 'new' items are archived

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

export async function handleNightlyArchive(): Promise<void> {
  const now     = new Date()
  const nowTs   = Timestamp.fromDate(now)

  logger.info('[Archive] Starting nightly archive run')

  // Fetch all user UIDs from /users collection
  const usersSnap = await db.collection('users').listDocuments()
  logger.info(`[Archive] Processing ${usersSnap.length} users`)

  let totalEscalated = 0
  let totalArchived  = 0

  for (const userRef of usersSnap) {
    const uid = userRef.id

    try {
      const [escalated, archived] = await processUser(uid, now, nowTs)
      totalEscalated += escalated
      totalArchived  += archived
    } catch (e) {
      logger.error(`[Archive] Error processing uid=${uid}:`, e)
      // Continue with other users — one failure shouldn't stop the run
    }
  }

  logger.info(`[Archive] Done. Escalated: ${totalEscalated}, Archived: ${totalArchived}`)
}

async function processUser(uid: string, now: Date, nowTs: Timestamp): Promise<[number, number]> {
  const itemsRef = db.collection(`users/${uid}/items`)
  let escalated  = 0
  let archived   = 0

  // ── 1. ESCALATE TO OVERDUE ─────────────────────────────────────────────────
  //
  // Fetch awaiting_action items (+ payment_due / action_required if used)
  const openSnap = await itemsRef
    .where('status', 'in', OPEN_STATUSES_TO_ESCALATE)
    .get()

  for (const doc of openSnap.docs) {
    const item = doc.data()

    // Never touch items the user has manually prioritised
    if (item.manualPriority) continue

    const signals: any[] = item.signals ?? []
    const graceCutoff    = daysAgo(GRACE_DAYS_OVERDUE)

    const isOverdue = signals.some(sig => {
      if (!ESCALATE_SIGNAL_TYPES.includes(sig.type)) return false
      if (!sig.detectedDate) return false
      const sigDate = sig.detectedDate.toDate ? sig.detectedDate.toDate() : new Date(sig.detectedDate)
      return sigDate < graceCutoff
    })

    if (isOverdue) {
      await doc.ref.update({
        status:    'overdue',
        updatedAt: nowTs,
      })
      escalated++
      logger.info(`[Archive] Escalated to overdue: uid=${uid} item=${doc.id} — ${item.aiTitle ?? item.subject}`)
    }
  }

  // ── 2. ARCHIVE STALE ITEMS ─────────────────────────────────────────────────

  // 2a. 'new' items whose event/rsvp signal date has passed
  const newItemsSnap = await itemsRef
    .where('status', '==', 'new')
    .get()

  for (const doc of newItemsSnap.docs) {
    const item    = doc.data()
    if (item.manualPriority) continue

    const signals: any[] = item.signals ?? []
    const receivedAt: Date = item.receivedAt?.toDate ? item.receivedAt.toDate() : new Date(item.receivedAt)

    // Archive if a date-based signal has passed
    const signalPassed = signals.some(sig => {
      if (!ARCHIVE_SIGNAL_TYPES.includes(sig.type)) return false
      if (!sig.detectedDate) return false
      const sigDate = sig.detectedDate.toDate ? sig.detectedDate.toDate() : new Date(sig.detectedDate)
      return sigDate < now
    })

    // Also archive old low-importance 'new' items
    const isStaleNew = (
      receivedAt < daysAgo(NEW_ARCHIVE_DAYS) &&
      (item.aiImportanceScore ?? 1) < 0.5
    )

    if (signalPassed || isStaleNew) {
      await doc.ref.update({
        status:     'archived',
        resolvedAt: nowTs,
        updatedAt:  nowTs,
      })
      archived++
      logger.info(`[Archive] Archived (${signalPassed ? 'signal passed' : 'stale'}): uid=${uid} item=${doc.id} — ${item.aiTitle ?? item.subject}`)
    }
  }

  // 2b. 'quietly_logged' items older than 90 days
  const quietCutoff   = Timestamp.fromDate(daysAgo(QUIET_ARCHIVE_DAYS))
  const quietSnap     = await itemsRef
    .where('status', '==', 'quietly_logged')
    .where('updatedAt', '<', quietCutoff)
    .get()

  for (const doc of quietSnap.docs) {
    const item = doc.data()
    if (item.manualPriority) continue

    await doc.ref.update({
      status:     'archived',
      resolvedAt: nowTs,
      updatedAt:  nowTs,
    })
    archived++
  }

  if (openSnap.size + newItemsSnap.size + quietSnap.size > 0) {
    logger.info(`[Archive] uid=${uid}: checked ${openSnap.size} open, ${newItemsSnap.size} new, ${quietSnap.size} quiet → escalated=${escalated} archived=${archived}`)
  }

  return [escalated, archived]
}
