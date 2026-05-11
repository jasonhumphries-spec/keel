/**
 * Cloud Functions for Keel background scanning.
 *
 * Two exports:
 *
 *   handleGmailNotification  — Pub/Sub triggered. Fires whenever Gmail
 *     publishes a notification for a watched inbox. Stays thin:
 *     finds the user, checks debounce, then delegates all Gmail API
 *     and AI work to POST /api/gmail/background-scan on Vercel.
 *
 *   renewGmailWatches  — Scheduled (every 6 days). Gmail watch()
 *     subscriptions expire after 7 days. This renews all active watches
 *     by calling POST /api/inbox-watch?action=enable on Vercel.
 *
 * Secrets required (set via: firebase functions:secrets:set <NAME>):
 *   ADMIN_SECRET  — must match the value set in Vercel env vars
 *
 * Env vars (set in Firebase project / functions config):
 *   KEEL_APP_URL  — defaults to https://www.jaison.app
 */

import { onMessagePublished } from 'firebase-functions/v2/pubsub'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import * as logger from 'firebase-functions/logger'

// Initialise Firebase Admin (safe to call multiple times — it's a no-op if already init'd)
if (!admin.apps.length) admin.initializeApp()

const db = admin.firestore()

const adminSecret = defineSecret('ADMIN_SECRET')

// The Pub/Sub topic Gmail pushes notifications to.
// Must exist in the Firebase project before deployment.
// See README-background-scan.md for setup instructions.
const PUBSUB_TOPIC = 'gmail-inbox-notifications'

// Debounce window: if a background scan ran within this many seconds,
// skip this notification. Prevents AI call storms on inbox bursts.
const DEBOUNCE_SECONDS = 90

// The Vercel app URL. Override with KEEL_APP_URL env var if you rename the domain.
function getAppUrl(): string {
  return process.env.KEEL_APP_URL ?? 'https://www.jaison.app'
}

// ---------------------------------------------------------------------------
// handleGmailNotification
// ---------------------------------------------------------------------------

/**
 * Receives Gmail push notifications via Pub/Sub.
 *
 * Gmail message format (base64-decoded JSON):
 *   { emailAddress: string, historyId: string }
 *
 * Flow:
 *   1. Decode Pub/Sub message → emailAddress + historyId
 *   2. Find uid by emailAddress in Firestore
 *   3. Check autoScanEnabled + debounce
 *   4. Call POST /api/gmail/background-scan on Vercel
 */
export const handleGmailNotification = onMessagePublished(
  {
    topic: PUBSUB_TOPIC,
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    secrets: [adminSecret],
  },
  async (event) => {
    // Decode the Pub/Sub message
    const raw = event.data.message.json as {
      emailAddress?: string
      historyId?: string
    }

    const { emailAddress, historyId: newHistoryId } = raw

    if (!emailAddress || !newHistoryId) {
      logger.error('Invalid Pub/Sub message — missing emailAddress or historyId', raw)
      return
    }

    logger.info(`Notification received for ${emailAddress}, historyId=${newHistoryId}`)

    // ── Find user by email address ─────────────────────────────────────────
    const usersSnap = await db
      .collection('users')
      .where('email', '==', emailAddress)
      .limit(1)
      .get()

    if (usersSnap.empty) {
      logger.warn(`No Keel user found for email: ${emailAddress}`)
      return
    }

    const userDoc = usersSnap.docs[0]
    const uid = userDoc.id
    const account = userDoc.data()

    // ── Check feature enabled ──────────────────────────────────────────────
    if (!account.autoScanEnabled) {
      logger.info(`autoScanEnabled=false for uid=${uid} — skipping`)
      return
    }

    // ── Debounce check ─────────────────────────────────────────────────────
    // If we scanned recently, skip this notification.
    // The next notification will use the latest historyId and pick up everything.
    const lastScanAt: admin.firestore.Timestamp | undefined = account.lastBackgroundScanAt
    if (lastScanAt) {
      const secAgo = (Date.now() - lastScanAt.toMillis()) / 1000
      if (secAgo < DEBOUNCE_SECONDS) {
        logger.info(`Debounced uid=${uid} (last scan ${Math.round(secAgo)}s ago, threshold=${DEBOUNCE_SECONDS}s)`)
        return
      }
    }

    // ── Optimistic debounce stamp ─────────────────────────────────────────
    // Write this before the Vercel call to prevent concurrent CF invocations
    // from both proceeding. The background-scan route will update it again on
    // completion with a server timestamp.
    await userDoc.ref.update({
      lastBackgroundScanAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    // ── Delegate to Vercel ─────────────────────────────────────────────────
    const url = `${getAppUrl()}/api/gmail/background-scan`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-keel-admin-secret': adminSecret.value(),
        },
        body: JSON.stringify({ uid, newHistoryId }),
        // Signal: give Vercel up to 50s (CF timeout is 60s)
        signal: AbortSignal.timeout(50_000),
      })

      if (!res.ok) {
        const err = await res.text()
        logger.error(`background-scan endpoint returned ${res.status}: ${err}`)
        return
      }

      const result = await res.json() as {
        success?: boolean
        skipped?: boolean
        newItems?: number
        updatedItems?: number
        aiCostUsd?: number
        reason?: string
      }

      if (result.skipped) {
        logger.info(`uid=${uid} skipped: ${result.reason}`)
      } else {
        logger.info(
          `uid=${uid} new=${result.newItems} updated=${result.updatedItems} ` +
          `cost=$${(result.aiCostUsd ?? 0).toFixed(5)}`
        )
      }
    } catch (err: any) {
      if (err?.name === 'TimeoutError') {
        logger.error(`background-scan request timed out for uid=${uid}`)
      } else {
        logger.error(`Failed to call background-scan for uid=${uid}:`, err)
      }
    }
  }
)

// ---------------------------------------------------------------------------
// renewGmailWatches
// ---------------------------------------------------------------------------

/**
 * Runs every 6 days to renew Gmail watch subscriptions before they expire (7 days).
 *
 * Queries all users with autoScanEnabled=true and watchExpiry within the next
 * 2 days, then calls POST /api/inbox-watch?action=enable on Vercel for each.
 * Vercel calls provider.renewWatch() which is identical to setupWatch() for Gmail.
 *
 * Schedule: "every 6 days" — runs more frequently than expiry to provide buffer.
 * If the job fails, the next run 6 days later provides a second chance.
 */
export const renewGmailWatches = onSchedule(
  {
    schedule: 'every 144 hours',  // every 6 days
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 300,
    secrets: [adminSecret],
  },
  async () => {
    const now = Date.now()
    const renewBefore = new Date(now + 2 * 24 * 60 * 60 * 1000) // 2 days from now

    logger.info(`renewGmailWatches: checking for watches expiring before ${renewBefore.toISOString()}`)

    // Find users with active watches expiring soon (or already expired)
    const snap = await db
      .collection('users')
      .where('autoScanEnabled', '==', true)
      .where('watchExpiry', '<=', admin.firestore.Timestamp.fromDate(renewBefore))
      .get()

    if (snap.empty) {
      logger.info('No watches need renewal')
      return
    }

    logger.info(`Renewing ${snap.size} watch(es)`)

    const url = `${getAppUrl()}/api/inbox-watch`

    // Process users sequentially to avoid hammering Gmail API
    for (const doc of snap.docs) {
      const uid = doc.id
      const account = doc.data()

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-keel-admin-secret': adminSecret.value(),
          },
          body: JSON.stringify({
            uid,
            action: 'enable',
            providerId: account.watchProvider ?? 'gmail',
          }),
          signal: AbortSignal.timeout(30_000),
        })

        if (res.ok) {
          const data = await res.json() as { expiry?: string }
          logger.info(`Renewed watch for uid=${uid}, new expiry: ${data.expiry}`)
        } else {
          const err = await res.text()
          logger.error(`Failed to renew watch for uid=${uid}: ${res.status} ${err}`)
          // Mark as error so the user sees it in settings
          await doc.ref.update({ watchStatus: 'error' })
        }
      } catch (err: any) {
        logger.error(`Exception renewing watch for uid=${uid}:`, err)
        await doc.ref.update({ watchStatus: 'error' })
      }

      // Small delay between users — be polite to Gmail API rate limits
      await new Promise(r => setTimeout(r, 500))
    }

    logger.info('renewGmailWatches complete')
  }
)

// ---------------------------------------------------------------------------
// nightly Item Expiry
// ---------------------------------------------------------------------------

/**
 * Runs nightly to expire items whose event date has passed.
 *
 * Two behaviours based on item status:
 *
 *   status = 'new' (informational) + all event signal dates in the past
 *     → set status = 'quietly_logged' (auto-archived, no action was needed)
 *
 *   status = 'awaiting_action' + all event/deadline signal dates in the past
 *     → set status = 'overdue' (user missed something — surface prominently)
 *
 * Items with payment signals, awaiting_reply, or future dates are untouched.
 *
 * A 1-day grace period is applied — items expire the day AFTER their event
 * date, so same-day events stay visible until midnight.
 */
export const nightlyItemExpiry = onSchedule(
  {
    schedule: '0 1 * * *',  // 1:00 AM UTC every day
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    // Expiry threshold: anything dated before yesterday midnight (1-day grace)
    const threshold = new Date()
    threshold.setDate(threshold.getDate() - 1)
    threshold.setHours(0, 0, 0, 0)
    const thresholdTs = admin.firestore.Timestamp.fromDate(threshold)

    logger.info(`nightlyItemExpiry: expiring events before ${threshold.toISOString()}`)

    let archived = 0
    let overdue  = 0
    let skipped  = 0

    // Get all users
    const usersSnap = await db.collection('users').select().get()

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id

      try {
        // Fetch active items that could be candidates for expiry
        const itemsSnap = await db
          .collection(`users/${uid}/items`)
          .where('status', 'in', ['new', 'awaiting_action'])
          .get()

        if (itemsSnap.empty) continue

        const itemIds = itemsSnap.docs.map(d => d.id)

        // Fetch all event/deadline signals for these items in one query
        // Process in chunks of 10 (Firestore 'in' limit)
        const signalsByItem = new Map<string, { type: string; detectedDate: admin.firestore.Timestamp | null }[]>()

        for (let i = 0; i < itemIds.length; i += 10) {
          const chunk = itemIds.slice(i, i + 10)
          const sigsSnap = await db
            .collection(`users/${uid}/signals`)
            .where('itemId', 'in', chunk)
            .where('type', 'in', ['event', 'deadline', 'rsvp'])
            .get()

          for (const sigDoc of sigsSnap.docs) {
            const sig = sigDoc.data()
            const existing = signalsByItem.get(sig.itemId) ?? []
            existing.push({ type: sig.type, detectedDate: sig.detectedDate })
            signalsByItem.set(sig.itemId, existing)
          }
        }

        // Evaluate each item
        const batch = db.batch()
        let batchCount = 0

        for (const itemDoc of itemsSnap.docs) {
          const item     = itemDoc.data()
          const signals  = signalsByItem.get(itemDoc.id) ?? []

          // Skip items with no event signals — they expire through other means
          if (signals.length === 0) { skipped++; continue }

          // Check: does this item have any FUTURE event/deadline dates?
          const hasFutureDate = signals.some(sig => {
            if (!sig.detectedDate) return false
            return sig.detectedDate.toMillis() > thresholdTs.toMillis()
          })

          if (hasFutureDate) { skipped++; continue }

          // All event dates are in the past — expire this item
          const itemRef = db.doc(`users/${uid}/items/${itemDoc.id}`)
          const now     = admin.firestore.FieldValue.serverTimestamp()

          if (item.status === 'new') {
            // Informational item — event happened, quietly archive it
            batch.update(itemRef, {
              status:     'quietly_logged',
              resolvedAt: now,
              updatedAt:  now,
              expiredBy:  'nightly_expiry',
            })
            archived++
          } else if (item.status === 'awaiting_action') {
            // User needed to act and didn't — mark overdue
            batch.update(itemRef, {
              status:    'overdue',
              updatedAt: now,
              expiredBy: 'nightly_expiry',
            })
            overdue++
          }

          batchCount++

          // Commit in batches of 400 (Firestore limit is 500)
          if (batchCount % 400 === 0) {
            await batch.commit()
            batchCount = 0
          }
        }

        // Commit any remaining
        if (batchCount > 0) await batch.commit()

      } catch (err) {
        logger.error(`nightlyItemExpiry: error processing uid=${uid}:`, err)
      }
    }

    logger.info(`nightlyItemExpiry complete: archived=${archived} overdue=${overdue} skipped=${skipped}`)
  }
)
