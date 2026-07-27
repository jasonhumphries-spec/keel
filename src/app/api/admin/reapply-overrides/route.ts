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

const DEFAULT_STATUSES = ['new', 'awaiting_action', 'awaiting_reply', 'quietly_logged']

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

    // Reconstruct a "parsed"-shaped object from the stored item + signals
    const parsedIn: any = {
      aiTitle:            stored.aiTitle,
      aiSummary:          stored.aiSummary,
      aiDetailedSummary:  stored.aiDetailedSummary,
      aiImportanceScore:  stored.aiImportanceScore ?? 0.5,
      status:             stored.status,
      autoQuietedReason:  stored.autoQuietedReason,
      // Signals are stored in a separate collection — read + splice them in
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

    // Deep clone to detect actual changes without mutating original view
    const before = JSON.parse(JSON.stringify({
      status: parsedIn.status, score: parsedIn.aiImportanceScore, signals: parsedIn.signals,
    }))
    const { parsed, applied } = applyPostClassificationOverrides(parsedIn, from, ownerEmail)

    // What changed? Track only status / score / signals delta.
    const statusChanged  = parsed.status !== before.status
    const scoreChanged   = Math.abs((parsed.aiImportanceScore ?? 0) - (before.score ?? 0)) > 0.001
    const signalsChanged = parsed.signals.length !== before.signals.length ||
                           parsed.signals.some((s: any, i: number) => s.type !== before.signals[i]?.type)

    if (!statusChanged && !scoreChanged && !signalsChanged) {
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
        oldStatus: String(before.status ?? ''),
        newStatus: String(parsed.status ?? ''),
        oldScore:  Number(before.score ?? 0),
        newScore:  Number(parsed.aiImportanceScore ?? 0),
        applied,
      })
    }

    if (!dryRun) {
      const now = Timestamp.now()
      await db.doc(`users/${uid}/items/${it.id}`).update({
        status:            parsed.status,
        aiImportanceScore: parsed.aiImportanceScore,
        autoQuietedReason: parsed.autoQuietedReason ?? stored.autoQuietedReason ?? null,
        overridesVersion:  OVERRIDES_VERSION,
        updatedAt:         now,
        overridesAppliedAt: FieldValue.serverTimestamp(),
        overridesApplied:   applied,
      })

      // Signal deltas: any doc-id present before but missing after → delete.
      if (signalsChanged) {
        const keptDocIds = new Set(parsed.signals.filter((s: any) => s._docId).map((s: any) => s._docId as string))
        for (const s of before.signals) {
          if (s._docId && !keptDocIds.has(s._docId)) {
            await db.doc(`users/${uid}/signals/${s._docId}`).delete()
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
