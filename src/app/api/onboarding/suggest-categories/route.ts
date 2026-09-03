/**
 * POST /api/onboarding/suggest-categories
 *
 * Reads a sample of the user's message HEADERS and proposes categories grounded in who
 * actually writes to them. See src/lib/server/categorySuggest.ts for the reasoning, and
 * docs/relevance-brain-design.md §12.
 *
 * AUTH. Takes the uid from a verified Firebase ID token, never from the body. Six older
 * routes in this app read a uid straight out of the request body and act on it with the
 * server's stored Google token; that is being fixed separately, and this route does not
 * add a seventh.
 *
 * COST. Headers only — format=metadata with three header names. No bodies are fetched,
 * so this is one cheap Gmail page plus one LLM call, which is what makes it affordable
 * inside the onboarding flow rather than after it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { aiComplete } from '@/lib/aiComplete'
import { getValidAccessToken } from '@/lib/server/tokenUtils'
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

/** One page of inbox headers. Deliberately not paginated — a sample is enough. */
async function fetchHeaders(accessToken: string, max = 200): Promise<MessageHeader[]> {
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', String(max))
  listUrl.searchParams.set('q', 'in:inbox -in:chats newer_than:120d')

  const listRes = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`)
  const ids = ((await listRes.json()).messages ?? []) as Array<{ id: string }>

  const out: MessageHeader[] = []
  // Modest concurrency: this runs while someone is watching a spinner, and Gmail
  // answers 403 userRateLimitExceeded rather than 429 when pushed (see §5.2).
  const CONCURRENCY = 6
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const slice = ids.slice(i, i + CONCURRENCY)
    const got = await Promise.all(slice.map(async ({ id }) => {
      const u = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`)
      u.searchParams.set('format', 'metadata')
      u.searchParams.append('metadataHeaders', 'From')
      u.searchParams.append('metadataHeaders', 'Subject')
      const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
      if (!r.ok) return null
      const h = ((await r.json()).payload?.headers ?? []) as Array<{ name: string; value: string }>
      const pick = (n: string) => h.find(x => x.name.toLowerCase() === n)?.value ?? ''
      const from = pick('from')
      return from ? { from, subject: pick('subject') } : null
    }))
    for (const g of got) if (g) out.push(g)
  }
  return out
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return NextResponse.json({ error: 'missing Firebase auth' }, { status: 401 })

  let uid: string
  try {
    uid = (await getAuth().verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'invalid Firebase token' }, { status: 401 })
  }

  const { existing = [] } = await req.json().catch(() => ({}))

  try {
    const accessToken = await getValidAccessToken(db, uid)
    if (!accessToken) return NextResponse.json({ error: 'no Google access token' }, { status: 401 })

    const headers = await fetchHeaders(accessToken)
    const suggestions = await suggestCategories(
      db, headers, Array.isArray(existing) ? existing.map(String) : [], aiComplete,
    )

    return NextResponse.json({
      sampled: headers.length,
      suggestions: suggestions.map(s => ({ ...s, id: suggestionId(s.name) })),
    })
  } catch (e) {
    // Never block onboarding on this. An empty list leaves the presets in place.
    console.warn('[suggest-categories] non-fatal:', e)
    return NextResponse.json({ sampled: 0, suggestions: [], error: String(e).slice(0, 200) })
  }
}
