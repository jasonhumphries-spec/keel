import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete, calcCost, PROVIDER_MODEL, getActiveProvider } from '@/lib/aiComplete'

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


interface Item {
  itemId:       string
  categoryId:   string
  aiTitle:      string
  aiSummary:    string
  senderName:   string
  senderEmail:  string
  subject:      string
  threadId:     string
  participants: string[]
}

async function findMergeGroups(db: ReturnType<typeof getFirestore>, items: Item[]): Promise<{ primary: string; duplicates: string[]; usage?: { inputTokens: number; outputTokens: number } }[]> {
  if (items.length < 2) return []

  const prompt = `You are helping deduplicate email items in a personal admin dashboard.

Below are email items from the same category. Identify groups that are CLEARLY about the exact same matter — same topic, same people, same thread of conversation that got split into separate items.

Apply a HIGH BAR: only merge if you are very confident they are the same conversation or directly related sub-threads about the exact same specific matter. Different emails about similar broad topics (e.g. two different school events) should NOT be merged.

ITEMS:
${items.map((item, i) => `[${i}] ID:${item.itemId}
  Title: ${item.aiTitle}
  Summary: ${item.aiSummary}
  From: ${item.senderName} (${item.senderEmail})
  Participants: ${item.participants.join(', ')}
  Subject: ${item.subject}`).join('\n\n')}

Respond with ONLY valid JSON:
{
  "mergeGroups": [
    {
      "primary": "itemId_to_keep",
      "duplicates": ["itemId_to_merge_1", "itemId_to_merge_2"]
    }
  ]
}

If no clear merges, return: {"mergeGroups": []}
Only include groups where you are very confident. When in doubt, do not merge.`

  try {
    const { text, inputTokens, outputTokens } = await aiComplete(db, prompt, 500)
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return []
    const parsed = JSON.parse(json)
    return (parsed.mergeGroups ?? []).map((g: any) => ({
      ...g,
      usage: { inputTokens, outputTokens },
    }))
  } catch (e) {
    console.error('Merge classification error:', e)
    return []
  }
}

export async function POST(req: NextRequest) {
  try {
    const { uid } = await req.json()
    if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

    const db = getAdminDb()

    // Get all active items
    const itemsSnap = await db.collection(`users/${uid}/items`)
      .where('status', 'in', ['new', 'awaiting_action', 'awaiting_reply'])
      .get()

    const items: Item[] = itemsSnap.docs.map(d => ({
      itemId:       d.id,
      categoryId:   d.data().categoryId ?? '',
      aiTitle:      d.data().aiTitle ?? '',
      aiSummary:    d.data().aiSummary ?? '',
      senderName:   d.data().senderName ?? '',
      senderEmail:  d.data().senderEmail ?? '',
      subject:      d.data().subject ?? '',
      threadId:     d.data().threadId ?? '',
      participants: d.data().participants ?? [],
    }))

    // Group by category and run merge detection per category
    const byCategory = new Map<string, Item[]>()
    for (const item of items) {
      if (!byCategory.has(item.categoryId)) byCategory.set(item.categoryId, [])
      byCategory.get(item.categoryId)!.push(item)
    }

    let totalMerged    = 0
    let totalInputTok  = 0
    let totalOutputTok = 0
    const mergeResults: { primary: string; duplicates: string[] }[] = []

    for (const [categoryId, catItems] of byCategory) {
      if (catItems.length < 2) continue
      console.log(`Checking ${catItems.length} items in category ${categoryId} for merges`)
      const groups = await findMergeGroups(db, catItems)

      for (const group of groups) {
        totalInputTok  += group.usage?.inputTokens  ?? 0
        totalOutputTok += group.usage?.outputTokens ?? 0

        const primaryDoc = await db.doc(`users/${uid}/items/${group.primary}`).get()
        if (!primaryDoc.exists) continue
        const primaryData = primaryDoc.data()!

        for (const dupId of group.duplicates) {
          const dupDoc = await db.doc(`users/${uid}/items/${dupId}`).get()
          if (!dupDoc.exists) continue
          const dupData = dupDoc.data()!
          const mergedThreadIds = [...(primaryData.mergedThreadIds ?? []), dupData.threadId].filter(Boolean)
          await db.doc(`users/${uid}/items/${group.primary}`).update({ mergedThreadIds, updatedAt: Timestamp.now() })
          await db.doc(`users/${uid}/items/${dupId}`).update({ status: 'archived', mergedInto: group.primary, updatedAt: Timestamp.now() })
          totalMerged++
          console.log(`Merged ${dupId} into ${group.primary}`)
        }
        mergeResults.push({ primary: group.primary, duplicates: group.duplicates })
      }
    }

    // Track Stage 2 costs — pricing depends on active provider
    const activeProvider = await getActiveProvider(db)
    const activeModel    = PROVIDER_MODEL[activeProvider]
    const totalCostUsd   = calcCost(activeModel, totalInputTok, totalOutputTok)

    try {
      const usageRef  = db.doc(`users/${uid}/meta/usage`)
      const usageSnap = await usageRef.get()
      const prev      = usageSnap.data() ?? {}
      await usageRef.set({
        totalInputTokens:   (prev.totalInputTokens  ?? 0) + totalInputTok,
        totalOutputTokens:  (prev.totalOutputTokens ?? 0) + totalOutputTok,
        totalCostUsd:       Number(((prev.totalCostUsd ?? 0) + totalCostUsd).toFixed(6)),
        stage2InputTokens:  (prev.stage2InputTokens  ?? 0) + totalInputTok,
        stage2OutputTokens: (prev.stage2OutputTokens ?? 0) + totalOutputTok,
        stage2CostUsd:      Number(((prev.stage2CostUsd ?? 0) + totalCostUsd).toFixed(6)),
        lastStage2CostUsd:  Number(totalCostUsd.toFixed(6)),
        lastMergeAt:        Timestamp.now(),
        updatedAt:          Timestamp.now(),
      }, { merge: true })
    } catch (e) { console.error('Usage write failed:', e) }

    return NextResponse.json({
      message: 'Merge complete',
      merged:  totalMerged,
      groups:  mergeResults,
    })

  } catch (error) {
    console.error('Merge error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
