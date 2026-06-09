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

  const body       = await req.json().catch(() => ({}))
  const uid        = body.uid as string | undefined
  const itemId     = body.itemId as string | undefined
  const titleQuery = body.titleQuery as string | undefined  // case-insensitive substring search
  if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

  const db = getAdminDb()

  try {
    // Build the list of itemIds to dump: explicit itemId OR matches of titleQuery.
    let itemIds: string[] = []
    if (itemId) {
      itemIds = [itemId]
    } else if (titleQuery) {
      // Fetch all items and filter client-side (no Firestore substring search).
      const allSnap = await db.collection(`users/${uid}/items`).get()
      const q = titleQuery.toLowerCase()
      itemIds = allSnap.docs
        .filter(d => ((d.data().aiTitle ?? '') as string).toLowerCase().includes(q))
        .map(d => d.id)
        .slice(0, 5)  // cap at 5 matches
    }

    let itemDump: any = undefined
    if (itemIds.length > 0) {
      const dumps = await Promise.all(itemIds.map(async id => {
        const iSnap   = await db.doc(`users/${uid}/items/${id}`).get()
        const sigSnap = await db.collection(`users/${uid}/signals`).where('itemId', '==', id).get()
        return {
          itemId:           id,
          item: iSnap.exists ? {
            status:            iSnap.data()!.status,
            aiTitle:           iSnap.data()!.aiTitle,
            aiImportanceScore: iSnap.data()!.aiImportanceScore,
            receivedAt:        (iSnap.data()!.receivedAt as any)?.toDate?.()?.toISOString?.(),
            expiredBy:         iSnap.data()!.expiredBy ?? null,
          } : null,
          signals: sigSnap.docs.map(d => ({
            id:           d.id,
            type:         d.data().type,
            description:  d.data().description,
            detectedDate: (d.data().detectedDate as any)?.toDate?.()?.toISOString?.() ?? null,
            status:       d.data().status,
          })),
        }
      }))
      itemDump = dumps.length === 1 ? dumps[0] : dumps
    }

    // Also peek at the root user doc to see what's driving needsReauth in the UI.
    const rootSnap = await db.doc(`users/${uid}`).get()
    const rootData = rootSnap.data() ?? {}
    const watchExpiryMs = (rootData.watchExpiry as any)?.toMillis?.() ?? null
    const root = {
      tokenStatus:       rootData.tokenStatus ?? null,
      tokenStatusReason: rootData.tokenStatusReason ?? null,
      autoScanEnabled:   rootData.autoScanEnabled ?? false,
      watchExpiry:       watchExpiryMs,
      watchExpiryISO:    watchExpiryMs ? new Date(watchExpiryMs).toISOString() : null,
      watchAlive:        rootData.autoScanEnabled === true && (watchExpiryMs ?? 0) > Date.now(),
    }
    const snap = await db.doc(`users/${uid}/accounts/account_primary`).get()
    if (!snap.exists) {
      return NextResponse.json({ error: 'Account doc not found', root }, { status: 404 })
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
        root,
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
      tokenLooksLikeOAuth:  refreshToken.startsWith('1//'),
      googleStatus:         tokenRes.status,
      googleOk:             tokenRes.ok,
      googleBody,
      accessTokenObtained:  !!googleBody.access_token,
      expiresIn:            googleBody.expires_in,
      accessTokenStored:    !!accessTokenStored,
      accessTokenExpiry:    tokenExpiresAt,
      root,
      itemDump,
    })
  } catch (err: any) {
    console.error('[check-refresh-token] error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
