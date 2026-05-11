/**
 * POST /api/inbox-watch
 *
 * Enables or disables Gmail push notification subscriptions (background scanning).
 * Also called by the renewGmailWatches Cloud Function to renew expiring watches.
 *
 * Body: { uid: string, action: 'enable' | 'disable' }
 * Auth: x-keel-admin-secret header (from CF) or same-origin request (from client via BackgroundScanToggle)
 *
 * On enable:  calls Gmail watch() API, stores watchHistoryId + watchExpiry on root account doc
 * On disable: calls Gmail stop() API, clears watch fields
 *
 * Watch fields are stored on root users/{uid} doc (queried by emailAddress in CF).
 * Auth tokens are read from users/{uid}/accounts/account_primary.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Firebase Admin ─────────────────────────────────────────────────────────

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

import { getValidAccessToken } from '@/lib/server/tokenUtils'

// ── Pub/Sub topic ──────────────────────────────────────────────────────────

const PUBSUB_TOPIC = `projects/${process.env.FIREBASE_PROJECT_ID}/topics/gmail-inbox-notifications`

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Allow both CF calls (admin secret) and direct client calls (same-origin).
  // For client calls we rely on Firebase Auth being checked by the caller;
  // the uid must match the authenticated user.
  const isAdminCall = req.headers.get('x-keel-admin-secret') === process.env.ADMIN_SECRET

  try {
    const body = await req.json()
    const { uid, action } = body as { uid: string; action: 'enable' | 'disable' }

    if (!uid || (action !== 'enable' && action !== 'disable')) {
      return NextResponse.json({ error: 'Missing uid or invalid action' }, { status: 400 })
    }

    const db       = getAdminDb()
    const rootRef  = db.doc(`users/${uid}`)

    // ── Enable ───────────────────────────────────────────────────────────
    if (action === 'enable') {
      // Read account_primary to get the user's email (needed for CF lookup)
      // and to validate tokens exist before attempting watch setup
      const accountDoc = await db.doc(`users/${uid}/accounts/account_primary`).get()
      if (!accountDoc.exists) {
        return NextResponse.json({ error: 'account_primary not found' }, { status: 404 })
      }
      const email = accountDoc.data()?.email as string | undefined

      // Mark as pending — use set+merge so root doc is created if it doesn't exist yet
      await rootRef.set({
        watchStatus:     'pending',
        autoScanEnabled: true,
        ...(email ? { email } : {}),
      }, { merge: true })

      let accessToken: string
      try {
        const tok = await getValidAccessToken(db, uid)
        if (!tok) throw new Error('Token unavailable')
        accessToken = tok
      } catch (err: any) {
        await rootRef.update({ watchStatus: 'error' })
        return NextResponse.json({ error: err.message }, { status: 400 })
      }

      // Call Gmail watch() API
      const watchRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/watch',
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            topicName:           PUBSUB_TOPIC,
            labelIds:            ['INBOX'],
            labelFilterBehavior: 'include',
          }),
        }
      )

      if (!watchRes.ok) {
        const err = await watchRes.text()
        console.error('[inbox-watch] Gmail watch() failed:', err)
        await rootRef.update({ watchStatus: 'error' })
        return NextResponse.json(
          { error: `Gmail watch() failed: ${watchRes.status}. Check OAuth scopes and Pub/Sub setup.` },
          { status: 500 }
        )
      }

      const watchData = await watchRes.json()
      const historyId = watchData.historyId  as string
      const expiration = watchData.expiration as string   // epoch ms as string

      const expiryDate = new Date(parseInt(expiration, 10))

      await rootRef.set({
        autoScanEnabled:      true,
        watchStatus:          'active',
        watchProvider:        'gmail',
        watchExpiry:          Timestamp.fromDate(expiryDate),
        watchHistoryId:       historyId,
        lastBackgroundScanAt: FieldValue.delete(),
        ...(email ? { email } : {}),
      }, { merge: true })

      console.log(`[inbox-watch] Watch enabled for uid=${uid}, expires ${expiryDate.toISOString()}`)

      return NextResponse.json({
        success:   true,
        historyId,
        expiry:    expiryDate.toISOString(),
      })
    }

    // ── Disable ──────────────────────────────────────────────────────────
    if (action === 'disable') {
      // Attempt to clean up the Gmail watch — non-fatal if it fails
      try {
        const accessToken = await getValidAccessToken(db, uid)
        if (!accessToken) throw new Error('Token unavailable')
        const stopRes = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/stop',
          {
            method:  'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        )
        if (!stopRes.ok) {
          console.warn(`[inbox-watch] Gmail stop() returned ${stopRes.status} for uid=${uid}`)
        }
      } catch (err) {
        console.warn(`[inbox-watch] Could not stop Gmail watch for uid=${uid}:`, err)
      }

      await rootRef.set({
        autoScanEnabled:      false,
        watchStatus:          'inactive',
        watchExpiry:          FieldValue.delete(),
        watchHistoryId:       FieldValue.delete(),
        lastBackgroundScanAt: FieldValue.delete(),
      }, { merge: true })

      console.log(`[inbox-watch] Watch disabled for uid=${uid}`)
      return NextResponse.json({ success: true })
    }

  } catch (err: any) {
    console.error('[inbox-watch] error:', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}
