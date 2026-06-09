/**
 * POST /api/admin/check-refresh-token
 *
 * Diagnostic: read the stored Gmail OAuth refresh token for a user and attempt
 * to use it against Google's token endpoint. Reports back what Google says —
 * lets us tell whether the token Keel is storing is a valid Google OAuth refresh
 * token (vs the Firebase Auth refresh token, which Google would reject).
 *
 * Returns:
 *   { hasToken, tokenPrefix, tokenLength, googleStatus, googleBody, accessTokenObtained, expiresIn }
 *
 * Body: { uid: string }
 * Auth: x-keel-admin-secret header
 *
 * Does NOT expose the actual refresh token value — only a 12-char prefix for sanity.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

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
  const secret = req.headers.get('x-keel-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const uid  = body.uid as string | undefined
  if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

  const db = getAdminDb()

  try {
    const snap = await db.doc(`users/${uid}/accounts/account_primary`).get()
    if (!snap.exists) {
      return NextResponse.json({ error: 'Account doc not found' }, { status: 404 })
    }
    const data         = snap.data()!
    const refreshToken = data.refreshToken as string | undefined
    const tokenExpiresAt = (data.tokenExpiresAt as any)?.toMillis?.() as number | undefined
    const accessTokenStored = data.accessToken as string | undefined

    if (!refreshToken) {
      return NextResponse.json({
        hasToken:            false,
        message:             'No refresh token stored in account_primary',
        accessTokenStored:   !!accessTokenStored,
        accessTokenExpiry:   tokenExpiresAt,
      })
    }

    const tokenPrefix = refreshToken.slice(0, 12)
    const tokenLength = refreshToken.length

    // Try to use the stored refresh token to mint a fresh access token.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID     ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    })

    const googleBody = await tokenRes.json().catch(() => ({}))

    return NextResponse.json({
      hasToken:             true,
      tokenPrefix,
      tokenLength,
      tokenLooksLikeOAuth:  refreshToken.startsWith('1//'),  // Google OAuth refresh tokens start with "1//"
      googleStatus:         tokenRes.status,
      googleOk:             tokenRes.ok,
      googleBody,
      accessTokenObtained:  !!googleBody.access_token,
      expiresIn:            googleBody.expires_in,
      accessTokenStored:    !!accessTokenStored,
      accessTokenExpiry:    tokenExpiresAt,
    })
  } catch (err: any) {
    console.error('[check-refresh-token] error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
