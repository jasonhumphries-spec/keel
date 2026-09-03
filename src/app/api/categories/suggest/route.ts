/**
 * POST /api/categories/suggest
 *
 * Proposes new categories from the items currently sitting UNCATEGORISED, for the
 * sorting flow. Same reasoning and same pipeline as the onboarding suggestion
 * (src/lib/server/categorySuggest.ts, docs §12) with a different evidence source: the
 * mail keel has already parsed, rather than raw Gmail headers.
 *
 * WHY THIS IS THE RIGHT MOMENT FOR IT. A pile of uncategorised mail is the clearest
 * possible statement that the existing categories do not fit. Onboarding has to guess
 * from a sample before anything is filed; here the evidence is exactly the mail that
 * had nowhere to go, which is a sharper signal than the inbox as a whole.
 *
 * No Gmail call: senders and titles are already in Firestore, so this is one LLM call.
 *
 * AUTH. uid comes from a verified Firebase ID token, never from the body.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { aiComplete } from '@/lib/aiComplete'
import { suggestCategories, suggestionId, type MessageHeader } from '@/lib/server/categorySuggest'

export const maxDuration = 60

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  })
}
const db = getFirestore()

/** Mirrors the uncategorised query the dashboard counts with (src/lib/hooks.ts). */
const UNCATEGORISED = ['cat_other', '', 'uncategorised']

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return NextResponse.json({ error: 'missing Firebase auth' }, { status: 401 })

  let uid: string
  try {
    uid = (await getAuth().verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'invalid Firebase token' }, { status: 401 })
  }

  try {
    const [itemsSnap, catsSnap] = await Promise.all([
      db.collection(`users/${uid}/items`).where('categoryId', 'in', UNCATEGORISED).limit(400).get(),
      db.collection(`users/${uid}/categories`).get(),
    ])

    // The existing names must include the ones the user already has, or the model will
    // helpfully propose categories they are already using.
    const existing = catsSnap.docs
      .map(d => String(d.data().name ?? '').trim())
      .filter(Boolean)

    const headers: MessageHeader[] = itemsSnap.docs.map(d => {
      const v = d.data()
      return {
        from:    String(v.senderEmail ?? ''),
        subject: String(v.aiTitle ?? v.subject ?? ''),
      }
    }).filter(h => h.from)

    const suggestions = await suggestCategories(db, headers, existing, aiComplete)

    return NextResponse.json({
      sampled: headers.length,
      suggestions: suggestions.map(s => ({ ...s, id: suggestionId(s.name) })),
    })
  } catch (e) {
    // Never block sorting on this — an empty list just means no suggestions offered.
    console.warn('[categories/suggest] non-fatal:', e)
    return NextResponse.json({ sampled: 0, suggestions: [], error: String(e).slice(0, 200) })
  }
}
