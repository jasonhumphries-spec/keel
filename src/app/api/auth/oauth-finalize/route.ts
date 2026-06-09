/**
 * POST /api/auth/oauth-finalize
 *
 * Step 4 of the direct OAuth flow. After the client has signed into Firebase
 * via signInWithCredential, it sends the Firebase ID token (Bearer) + session id.
 * We verify the Firebase token to get uid, then transfer the Google refresh
 * token from the session into the user's account_primary doc. Session is then
 * deleted.
 *
 * Also handles "new user" setup: creates onboarding state, autoScanEnabled,
 * scopes, etc. — mirroring what saveTokenAndScan used to do.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getAuth }   from 'firebase-admin/auth'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function adminInit() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    })
  }
}

export async function POST(req: NextRequest) {
  adminInit()

  const authHdr = req.headers.get('authorization') ?? ''
  const fbToken = authHdr.replace(/^Bearer\s+/i, '')
  if (!fbToken) return NextResponse.json({ error: 'missing Firebase auth' }, { status: 401 })

  let decoded
  try {
    decoded = await getAuth().verifyIdToken(fbToken)
  } catch (e: any) {
    return NextResponse.json({ error: 'invalid Firebase token', detail: e.message }, { status: 401 })
  }
  const uid   = decoded.uid
  const email = decoded.email ?? null
  const name  = decoded.name  ?? null

  const body = await req.json().catch(() => ({}))
  const session = body.session as string | undefined
  if (!session) return NextResponse.json({ error: 'missing session' }, { status: 400 })

  const db = getFirestore()
  const sessionRef = db.doc(`oauthSessions/${session}`)
  const snap = await sessionRef.get()
  if (!snap.exists) return NextResponse.json({ error: 'invalid session' }, { status: 404 })

  const data = snap.data()!
  if ((data.expiresAt as any).toMillis() < Date.now()) {
    await sessionRef.delete().catch(() => {})
    return NextResponse.json({ error: 'session expired' }, { status: 410 })
  }

  const accountRef  = db.doc(`users/${uid}/accounts/account_primary`)
  const existingSnap = await accountRef.get()
  const isNewUser   = !existingSnap.exists
  const createdAt   = existingSnap.data()?.createdAt ?? Timestamp.now()
  const scanCount   = (existingSnap.data()?.scanCount ?? 0) + 1

  await accountRef.set({
    accountId:      'account_primary',
    uid,
    email,
    displayName:    name,
    provider:       'google',
    accessToken:    data.googleAccessToken,
    refreshToken:   data.googleRefreshToken,
    tokenUpdatedAt: Timestamp.now(),
    tokenExpiresAt: Timestamp.fromMillis(Date.now() + 3600 * 1000),
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
    ],
    active:      true,
    aiService:   existingSnap.data()?.aiService ?? 'claude',
    plan:        existingSnap.data()?.plan ?? 'free_trial',
    createdAt,
    updatedAt:   Timestamp.now(),
    lastSignIn:  Timestamp.now(),
    scanCount,
  }, { merge: true })

  // Clear any prior reauth-needed stamp on the root user doc.
  await db.doc(`users/${uid}`).set({
    tokenStatus:          null,
    tokenStatusReason:    null,
    tokenStatusUpdatedAt: Timestamp.now(),
    ...(isNewUser ? { autoScanEnabled: false } : {}),  // initial state for new users
  }, { merge: true })

  await sessionRef.delete().catch(() => {})

  return NextResponse.json({ success: true, isNewUser, uid })
}
