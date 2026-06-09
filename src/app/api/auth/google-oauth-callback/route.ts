/**
 * GET /api/auth/google-oauth-callback
 *
 * Step 2 of the direct Google OAuth flow. Validates CSRF state, exchanges the
 * authorization code for tokens, stores them in a short-lived Firestore session
 * (5-min TTL), redirects to /auth/complete which finishes the Firebase sign-in.
 */

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import crypto from 'crypto'

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

function errorRedirect(req: NextRequest, code: string, detail?: string) {
  const url = new URL('/', req.nextUrl.origin)
  url.searchParams.set('oauth_error', code)
  if (detail) url.searchParams.set('detail', detail.slice(0, 200))
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const code     = req.nextUrl.searchParams.get('code')
  const stateUrl = req.nextUrl.searchParams.get('state')
  const errParam = req.nextUrl.searchParams.get('error')

  if (errParam)            return errorRedirect(req, errParam)
  if (!code || !stateUrl)  return errorRedirect(req, 'missing_params')

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get('keel_oauth_state')?.value
  if (!stateCookie || stateCookie !== stateUrl) {
    return errorRedirect(req, 'state_mismatch')
  }

  const redirectUri = `${req.nextUrl.origin}/api/auth/google-oauth-callback`
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    console.error('[oauth-callback] token exchange failed:', text)
    return errorRedirect(req, 'token_exchange_failed', text)
  }

  const tokens = await tokenRes.json() as {
    access_token?:  string
    refresh_token?: string
    id_token?:      string
    expires_in?:    number
  }

  if (!tokens.refresh_token) {
    console.error('[oauth-callback] no refresh_token returned')
    return errorRedirect(req, 'no_refresh_token')
  }
  if (!tokens.id_token || !tokens.access_token) {
    return errorRedirect(req, 'missing_token_fields')
  }

  const sessionId = crypto.randomBytes(32).toString('base64url')
  const db = getAdminDb()
  await db.doc(`oauthSessions/${sessionId}`).set({
    googleIdToken:      tokens.id_token,
    googleAccessToken:  tokens.access_token,
    googleRefreshToken: tokens.refresh_token,
    expiresAt:          Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    createdAt:          Timestamp.now(),
  })

  cookieStore.delete('keel_oauth_state')
  return NextResponse.redirect(new URL(`/auth/complete?session=${sessionId}`, req.nextUrl.origin))
}
