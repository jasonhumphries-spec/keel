/**
 * POST /api/auth/oauth-session-redeem
 *
 * Step 3 of the direct OAuth flow. Returns the Google id_token + access_token
 * stored in the session, so the client can sign into Firebase via
 * signInWithCredential. Does NOT return the refresh_token — that's transferred
 * server-side via /oauth-finalize once the Firebase user exists.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const session = body.session as string | undefined
  if (!session) return NextResponse.json({ error: 'missing session' }, { status: 400 })

  const db = getAdminDb()
  const snap = await db.doc(`oauthSessions/${session}`).get()
  if (!snap.exists) return NextResponse.json({ error: 'invalid session' }, { status: 404 })

  const data = snap.data()!
  if ((data.expiresAt as any).toMillis() < Date.now()) {
    await snap.ref.delete().catch(() => {})
    return NextResponse.json({ error: 'session expired' }, { status: 410 })
  }

  return NextResponse.json({
    googleIdToken:     data.googleIdToken,
    googleAccessToken: data.googleAccessToken,
  })
}
