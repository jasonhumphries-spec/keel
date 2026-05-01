import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete, getActiveProvider, PROVIDER_MODEL, calcCost } from '@/lib/aiComplete'

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

// Run promises in batches to avoid rate limits
async function runInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    results.push(...await Promise.all(batch.map(fn)))
  }
  return results
}

interface ReclassifyResult {
  itemId:       string
  oldCategory:  string
  newCategory:  string
  changed:      boolean
}

async function reclassifyItem(
  db: ReturnType<typeof getAdminDb>,
  uid: string,
  item: FirebaseFirestore.DocumentData,
  itemId: string,
  categories: { id: string; name: string; description: string }[],
): Promise<ReclassifyResult & { inputTokens: number; outputTokens: number; costUsd: number }> {

  const catList = categories.map(c =>
    `- ${c.id}: "${c.name}"${c.description ? ` — ${c.description}` : ''}`
  ).join('\n')

  const prompt = `You are reclassifying an email item in an inbox manager called Keel.

Item:
Title: ${item.aiTitle || item.subject || '(untitled)'}
Summary: ${item.aiSummary || '(no summary)'}
From: ${item.senderName || ''} <${item.senderEmail || ''}>
Current category: ${item.categoryName || 'Other'}

Available categories:
${catList}

Which category best fits this item? Use "cat_other" only if nothing fits.
Return raw JSON only, no markdown:
{ "categoryId": "...", "categoryName": "..." }`

  try {
    const result = await aiComplete(db, prompt, 256)
    const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed  = JSON.parse(cleaned)

    const newCatId   = parsed.categoryId   ?? item.categoryId
    const newCatName = parsed.categoryName ?? item.categoryName
    const changed    = newCatId !== item.categoryId && newCatId !== '' && newCatId !== null

    if (changed) {
      await db.doc(`users/${uid}/items/${itemId}`).update({
        categoryId:   newCatId,
        categoryName: newCatName,
        updatedAt:    Timestamp.now(),
      })
    }

    return {
      itemId,
      oldCategory:  item.categoryName ?? 'Other',
      newCategory:  newCatName,
      changed,
      inputTokens:  result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd:      result.costUsd,
    }
  } catch (e) {
    // Non-fatal — skip this item
    console.warn(`[reclassify] Failed to reclassify item ${itemId}:`, e)
    return { itemId, oldCategory: item.categoryName ?? '', newCategory: item.categoryName ?? '', changed: false, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  }
}

export async function POST(req: NextRequest) {
  try {
    const { uid, daysBack = 7 } = await req.json()
    if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

    const db           = getAdminDb()
    const now          = Timestamp.now()
    const startedAt    = Date.now()
    const cutoff = Timestamp.fromMillis(Date.now() - daysBack * 24 * 60 * 60 * 1000)

    // Load categories
    const catsSnap = await db.collection(`users/${uid}/categories`)
      .where('archived', '==', false).get()
    const categories = catsSnap.docs.map(d => ({
      id:          d.id,
      name:        d.data().name as string,
      description: (d.data().description as string) || '',
    }))

    if (categories.length === 0) {
      return NextResponse.json({ error: 'No categories found' }, { status: 400 })
    }

    // Fetch active dashboard items (all statuses except done/paid/archived/quietly_logged)
    const activeSnap = await db.collection(`users/${uid}/items`)
      .where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply', 'snoozed'])
      .get()

    // Fetch recently quiet-logged items within the thread activity window
    // Requires composite index on (status, receivedAt) — falls back to empty if not yet built
    let quietSnap: FirebaseFirestore.QuerySnapshot
    try {
      quietSnap = await db.collection(`users/${uid}/items`)
        .where('status', '==', 'quietly_logged')
        .where('receivedAt', '>=', cutoff)
        .get()
    } catch (e: any) {
      if (e?.code === 9) {
        console.warn('[reclassify] Missing index for quietly_logged+receivedAt — skipping quiet items. Create the index via the link in the error above.')
        quietSnap = { docs: [], size: 0 } as any
      } else {
        throw e
      }
    }

    const allDocs = [
      ...activeSnap.docs.map(d => ({ id: d.id, data: d.data() })),
      ...quietSnap.docs.map(d => ({ id: d.id, data: d.data() })),
    ]

    console.log(`[reclassify] uid=${uid.slice(0,8)} — ${allDocs.length} items (${activeSnap.size} active + ${quietSnap.size} quiet-logged in ${daysBack}d)`)

    if (allDocs.length === 0) {
      return NextResponse.json({ examined: 0, reclassified: 0, message: 'Nothing to reclassify' })
    }

    // Reclassify in batches of 8
    const results = await runInBatches(allDocs, 8, async ({ id, data }) =>
      reclassifyItem(db, uid, data, id, categories)
    )

    const reclassified  = results.filter(r => r.changed)
    const totalInputTok = results.reduce((a, r) => a + r.inputTokens, 0)
    const totalOutputTok= results.reduce((a, r) => a + r.outputTokens, 0)
    const totalCost     = results.reduce((a, r) => a + r.costUsd, 0)

    // Write usage — track reclassify separately from scan costs
    try {
      const usageRef  = db.doc(`users/${uid}/meta/usage`)
      const usageSnap = await usageRef.get()
      const prev      = usageSnap.data() ?? {}
      await usageRef.set({
        totalInputTokens:     (prev.totalInputTokens      ?? 0) + totalInputTok,
        totalOutputTokens:    (prev.totalOutputTokens     ?? 0) + totalOutputTok,
        aiCostUsd:            Number(((prev.aiCostUsd            ?? 0) + totalCost).toFixed(6)),
        reclassifyCostUsd:    Number(((prev.reclassifyCostUsd    ?? 0) + totalCost).toFixed(6)),
        reclassifyInputTokens:(prev.reclassifyInputTokens  ?? 0) + totalInputTok,
        reclassifyOutputTokens:(prev.reclassifyOutputTokens ?? 0) + totalOutputTok,
        reclassifyRuns:       (prev.reclassifyRuns         ?? 0) + 1,
        totalCostUsd:         Number(((prev.totalCostUsd         ?? 0) + totalCost).toFixed(6)),
        updatedAt:            Timestamp.now(),
      }, { merge: true })
    } catch (e) { /* non-fatal */ }

    // Write a scanRun doc so admin drill-down shows reclassify runs alongside scans
    try {
      const durationMs = Date.now() - startedAt
      const runId      = `run_${Date.now()}`
      await db.doc(`users/${uid}/scanRuns/${runId}`).set({
        scanRunId:        runId,
        scanAt:           Timestamp.now(),
        daysBack,
        threadsFound:     allDocs.length,
        threadsProcessed: reclassified.length,
        newItems:         0,
        updatedItems:     reclassified.length,
        skipped:          results.length - reclassified.length,
        inputTokens:      totalInputTok,
        outputTokens:     totalOutputTok,
        aiCostUsd:        Number(totalCost.toFixed(6)),
        fbReads:          0,
        fbWrites:         reclassified.length,
        fbCostUsd:        0,
        totalCostUsd:     Number(totalCost.toFixed(6)),
        model:            await getActiveProvider(db).then(p => PROVIDER_MODEL[p]),
        provider:         await getActiveProvider(db),
        job:              'reclassify',
        durationMs,
      })
    } catch (e) { /* non-fatal */ }

    console.log(`[reclassify] Complete — ${results.length} examined, ${reclassified.length} recategorised. Cost: $${totalCost.toFixed(4)}`)

    return NextResponse.json({
      examined:      results.length,
      reclassified:  reclassified.length,
      changes:       reclassified.map(r => ({ itemId: r.itemId, from: r.oldCategory, to: r.newCategory })),
      costUsd:       Number(totalCost.toFixed(4)),
      message:       reclassified.length > 0
        ? `${reclassified.length} item${reclassified.length !== 1 ? 's' : ''} moved to better categories`
        : 'All items already in the best category',
    })

  } catch (error) {
    console.error('[reclassify] Error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
