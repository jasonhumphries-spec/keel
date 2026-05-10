import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { runCalendarCheck } from '@/lib/server/calendarCheck'

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

/** Returns a valid access token, refreshing if expired. */
async function getValidAccessToken(db: ReturnType<typeof getFirestore>, uid: string): Promise<string> {
  const accountRef = db.doc(`users/${uid}/accounts/account_primary`)
  const accountDoc = await accountRef.get()
  if (!accountDoc.exists) throw new Error('account_primary not found')

  const data         = accountDoc.data()!
  const accessToken  = data.accessToken  as string | undefined
  const refreshToken = data.refreshToken as string | undefined
  const expiresAt    = (data.tokenExpiresAt as Timestamp | undefined)?.toMillis() ?? 0

  // Return current token if still valid (with 60s buffer)
  if (accessToken && Date.now() < expiresAt - 60_000) return accessToken

  if (!refreshToken) {
    console.warn('[CalCheck] No refresh token — using potentially stale access token')
    return accessToken ?? ''
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })

  if (!tokenRes.ok) throw new Error(`Token refresh failed: ${await tokenRes.text()}`)

  const tokenData = await tokenRes.json()
  const newToken  = tokenData.access_token as string
  const expiresIn = (tokenData.expires_in  as number) ?? 3600

  await accountRef.update({
    accessToken:    newToken,
    tokenUpdatedAt: Timestamp.now(),
    tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
  })

  console.log(`[CalCheck] Refreshed access token for uid=${uid.slice(0, 8)}`)
  return newToken
}

export async function POST(req: NextRequest) {
  try {
    const { uid } = await req.json()
    if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

    const db          = getAdminDb()
    const accessToken = await getValidAccessToken(db, uid)
    if (!accessToken) return NextResponse.json({ error: 'No access token' }, { status: 401 })

    const result = await runCalendarCheck(db, uid, accessToken)
    return NextResponse.json(result)

  } catch (error) {
    console.error('[CalCheck] Error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
