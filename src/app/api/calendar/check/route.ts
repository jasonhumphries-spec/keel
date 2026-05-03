import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
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

export async function POST(req: NextRequest) {
  try {
    const { uid } = await req.json()
    if (!uid) return NextResponse.json({ error: 'Missing uid' }, { status: 400 })

    const db          = getAdminDb()
    const accountSnap = await db.doc(`users/${uid}/accounts/account_primary`).get()
    const accessToken = accountSnap.data()?.accessToken as string
    if (!accessToken) return NextResponse.json({ error: 'No access token' }, { status: 401 })

    const result = await runCalendarCheck(db, uid, accessToken)
    return NextResponse.json(result)

  } catch (error) {
    console.error('[CalCheck] Error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
