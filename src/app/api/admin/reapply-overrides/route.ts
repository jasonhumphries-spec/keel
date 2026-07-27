/**
 * POST /api/admin/reapply-overrides
 *
 * Tier-1 catch-up: replays the deterministic post-classification overrides
 * (applyPostClassificationOverrides) over stored items whose `overridesVersion`
 * is stale — or over every active item if `force=true`. No AI calls, so free.
 *
 * Body: { uid: string, force?: boolean, dryRun?: boolean, maxItems?: number, statuses?: string[] }
 * Auth: x-keel-admin-secret header
 *
 * Response includes counts of items whose status / score / signals actually changed
 * plus a summary of which override rules fired.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { applyPostClassificationOverrides, OVERRIDES_VERSION } from '@/lib/scanUtils'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    })
  }
  return getFirestore()
}

const DEFAULT_STATUSES = ['new', 'awaiting_action', 'awaiting_reply', 'quietly_logged', 'overdue']

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-keel-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const db   = getAdminDb()
  const body = await req.json().catch(() => ({}))
  const uid       = body.uid as string | undefined
  const force     = !!body.force
  const dryRun    = !!body.dryRun
  const maxItems  = typeof body.maxItems === 'number' ? body.maxItems : 5000
  const statuses  = Array.isArray(body.statuses) && body.statuses.length > 0 ? body.statuses : DEFAULT_STATUSES
  if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

  const ownerEmail = ((await db.doc(`users/${uid}/accounts/account_primary`).get()).data()?.email as string ?? '').toLowerCase()

  // Fetch candidate items — Firestore 'in' caps at 10 so we may need chunks
  const items: Array<{ id: string; data: FirebaseFirestore.DocumentData }> = []
  for (let i = 0; i < statuses.length; i += 10) {
    const chunk = statuses.slice(i, i + 10)
    const snap  = await db.collection(`users/${uid}/items`).where('status', 'in', chunk).get()
    for (const d of snap.docs) items.push({ id: d.id, data: d.data() })
    if (items.length >= maxItems) break
  }
  const candidates = items.slice(0, maxItems)

  let examined     = 0
  let alreadyCurrent = 0
  let updated      = 0
  const rulesFired: Record<string, number> = {}
  const samples: Array<{ itemId: string; title: string; oldStatus: string; newStatus: string; oldScore: number; newScore: number; applied: string[] }> = []

  for (const it of candidates) {
    examined++
    const stored = it.data
    const storedVersion = (stored.overridesVersion as number | undefined) ?? 0
    if (!force && storedVersion >= OVERRIDES_VERSION) { alreadyCurrent++; continue }

    // If the item was previously touched by a reversible override (promotional /
    // feedback_request / payment-made / auto-pay), start the re-run from a
    // NEUTRAL state — otherwise a rule that was over-firing or a mis-ordered rule
    // would leave items stuck in stale status even after the rule is tightened
    // or the ordering fixed. User-set autoQuietedReasons (e.g. 'manual') aren't touched.
    const OVERRIDE_REASONS   = new Set(['promotional', 'feedback_request'])
    const REVERSIBLE_RULES   = new Set(['payment-made', 'auto-pay', 'self-consistency:action-to-reply', 'self-consistency:reply-to-action'])
    const wasOverrideQuieted = OVERRIDE_REASONS.has(stored.autoQuietedReason)
    const priorApplied       = Array.isArray(stored.overridesApplied) ? stored.overridesApplied as string[] : []
    const hadReversibleOverride = priorApplied.some(r => REVERSIBLE_RULES.has(r))
    const shouldReset        = wasOverrideQuieted || hadReversibleOverride

    // Neutral baseline for reset items: awaiting_action + 0.7 is a safe assumption —
    // if that's wrong the current pass's overrides will move it to the right bucket.
    const startStatus = shouldReset
      ? (wasOverrideQuieted ? 'new' : 'awaiting_action')
      : stored.status
    const startScore  = shouldReset
      ? (wasOverrideQuieted ? 0.5 : 0.70)
      : (stored.aiImportanceScore ?? 0.5)
    const startAutoQuietedReason = wasOverrideQuieted ? null : stored.autoQuietedReason

    // Reconstruct a "parsed"-shaped object from the stored item + signals
    const parsedIn: any = {
      aiTitle:            stored.aiTitle,
      aiSummary:          stored.aiSummary,
      aiDetailedSummary:  stored.aiDetailedSummary,
      aiImportanceScore:  startScore,
      status:             startStatus,
      autoQuietedReason:  startAutoQuietedReason,
      signals:            [],
    }

    // Load signals for this item (limits: cost = 1 read per candidate)
    const sigsSnap = await db.collection(`users/${uid}/signals`).where('itemId', '==', it.id).get()
    parsedIn.signals = sigsSnap.docs.map(d => ({
      _docId:              d.id,
      type:                d.data().type,
      description:         d.data().description,
      detectedDate:        d.data().detectedDate ? (d.data().detectedDate.toDate() as Date).toISOString() : null,
      detectedAmountPence: d.data().detectedAmountPence ?? null,
      currency:            d.data().currency ?? null,
    }))

    const from = `${stored.senderName ?? ''} <${stored.senderEmail ?? ''}>`

    // Snapshot the currently-persisted state so we can detect if the re-run
    // ended up differently from what's in Firestore right now. When we reset
    // an over-quieted item to 'new' before running overrides, "stored" is the
    // over-quieted state and "parsed" is where the new rules land it.
    const persisted = {
      status:            stored.status,
      score:             stored.aiImportanceScore ?? 0.5,
      autoQuietedReason: stored.autoQuietedReason ?? null,
      signalsLen:        parsedIn.signals.length,
    }
    // Capture original signal doc-ids BEFORE overrides mutate the array.
    const originalSigDocIds: string[] = (parsedIn.signals as Array<{ _docId?: string }>).map(s => s._docId ?? '').filter(Boolean)
    const { parsed, applied } = applyPostClassificationOverrides(parsedIn, from, ownerEmail)

    // What changed vs currently persisted state
    const statusChanged  = parsed.status !== persisted.status
    const scoreChanged   = Math.abs((parsed.aiImportanceScore ?? 0) - persisted.score) > 0.001
    const reasonChanged  = (parsed.autoQuietedReason ?? null) !== persisted.autoQuietedReason
    const signalsChanged = parsed.signals.length !== persisted.signalsLen

    if (!statusChanged && !scoreChanged && !reasonChanged && !signalsChanged) {
      // No change but bump version so next run skips this item
      if (!dryRun) await db.doc(`users/${uid}/items/${it.id}`).update({ overridesVersion: OVERRIDES_VERSION })
      continue
    }

    updated++
    for (const r of applied) rulesFired[r] = (rulesFired[r] ?? 0) + 1

    if (samples.length < 15) {
      samples.push({
        itemId:    it.id,
        title:     (stored.aiTitle as string ?? '').slice(0, 80),
        oldStatus: String(persisted.status ?? ''),
        newStatus: String(parsed.status ?? ''),
        oldScore:  Number(persisted.score ?? 0),
        newScore:  Number(parsed.aiImportanceScore ?? 0),
        applied,
      })
    }

    if (!dryRun) {
      const now = Timestamp.now()
      // Explicitly write autoQuietedReason as null when overrides didn't set one
      // (so a rule that fired last time and no longer fires clears its stale reason).
      await db.doc(`users/${uid}/items/${it.id}`).update({
        status:            parsed.status,
        aiImportanceScore: parsed.aiImportanceScore,
        autoQuietedReason: parsed.autoQuietedReason ?? null,
        overridesVersion:  OVERRIDES_VERSION,
        updatedAt:         now,
        overridesAppliedAt: FieldValue.serverTimestamp(),
        overridesApplied:   applied,
      })

      // Signal deltas: any doc-id originally loaded but missing after overrides → delete.
      if (signalsChanged) {
        const keptDocIds = new Set((parsed.signals as any[]).filter((s: any) => s._docId).map((s: any) => s._docId as string))
        for (const docId of originalSigDocIds) {
          if (!keptDocIds.has(docId)) {
            await db.doc(`users/${uid}/signals/${docId}`).delete()
          }
        }
      }
    }
  }

  console.log(`[reapply-overrides] uid=${uid.slice(0,8)} examined=${examined} alreadyCurrent=${alreadyCurrent} updated=${updated} version=${OVERRIDES_VERSION} dryRun=${dryRun}`)

  return NextResponse.json({
    success:          true,
    overridesVersion: OVERRIDES_VERSION,
    dryRun,
    examined,
    alreadyCurrent,
    updated,
    rulesFired,
    samples,
  })
}
