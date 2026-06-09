/**
 * GET /api/auth/google-oauth-start
 *
 * Step 1 of the direct Google OAuth flow that bypasses Firebase Auth's broken
 * refresh-token capture. Generates a CSRF state, stores it in a cookie,
 * redirects to Google's authorization endpoint with all the scopes we need.
 */

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
]

export async function GET(req: NextRequest) {
  const state = crypto.randomBytes(32).toString('base64url')
  const cookieStore = await cookies()
  cookieStore.set('keel_oauth_state', state, {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: 600, path: '/',
  })
  const redirectUri = `${req.nextUrl.origin}/api/auth/google-oauth-callback`
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id',     process.env.GOOGLE_CLIENT_ID!)
  authUrl.searchParams.set('redirect_uri',  redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope',         SCOPES.join(' '))
  authUrl.searchParams.set('access_type',   'offline')
  authUrl.searchParams.set('prompt',        'consent')
  authUrl.searchParams.set('state',         state)
  return NextResponse.redirect(authUrl.toString())
}
