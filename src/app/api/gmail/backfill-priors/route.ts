/**
 * POST /api/gmail/backfill-priors
 *
 * Thin wrapper over runBackfillSlice — see src/lib/server/backfillRunner.ts and
 * docs/relevance-brain-design.md §5. The walk itself lives in the lib module so
 * onboarding and the nightly cron can call it directly rather than making an HTTP hop
 * into our own API, and so there is exactly one implementation of it.
 *
 * Body: { uid, months?, maxThreads?, reset?, dryRun?, query? }
 * Auth: ADMIN_SECRET via x-admin-secret.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { runBackfillSlice } from '@/lib/server/backfillRunner'

export const maxDuration = 300

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

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-secret') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }
  const { uid, ...opts } = await req.json()
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 })
  const result = await runBackfillSlice(db, uid, opts)
  return NextResponse.json(result, { status: result.error ? 400 : 200 })
}
