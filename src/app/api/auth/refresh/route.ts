import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

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
  try {
    const { uid } = await req.json()
    if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

    const db = getAdminDb()

    // Get stored refresh token
    const accountDoc = await db.doc(`users/${uid}/accounts/account_primary`).get()
    if (!accountDoc.exists) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    const refreshToken = accountDoc.data()?.refreshToken
    if (!refreshToken) {
      return NextResponse.json({ error: 'No refresh token stored — user must sign in again' }, { status: 401 })
    }

    // Exchange refresh token for new access token
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

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      console.error('Token refresh failed:', err)
      return NextResponse.json({ error: 'Token refresh failed' }, { status: 401 })
    }

    const tokenData = await tokenRes.json()
    const newAccessToken = tokenData.access_token as string
    const expiresIn      = tokenData.expires_in as number // seconds

    // Store new access token in Firestore
    await db.doc(`users/${uid}/accounts/account_primary`).update({
      accessToken:    newAccessToken,
      tokenUpdatedAt: Timestamp.now(),
      tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
    })

    console.log(`[Keel] Token refreshed for uid=${uid.slice(0,8)}`)

    return NextResponse.json({ accessToken: newAccessToken, expiresIn })

  } catch (error) {
    console.error('Token refresh error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
