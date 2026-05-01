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
    const { uid, accessToken, signalId, itemId } = await req.json()

    if (!uid || !accessToken || !signalId || !itemId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const db = getAdminDb()

    // Fetch the signal
    const sigDoc = await db.doc(`users/${uid}/signals/${signalId}`).get()
    if (!sigDoc.exists) {
      return NextResponse.json({ error: 'Signal not found' }, { status: 404 })
    }

    const sig = sigDoc.data()!

    // Fetch the item for context
    const itemDoc = await db.doc(`users/${uid}/items/${itemId}`).get()
    const item    = itemDoc.data()

    // Build the calendar event
    const detectedDate: Date = sig.detectedDate?.toDate() ?? new Date()

    // For all-day events (no specific time), use date only
    // For timed events, use dateTime
    const isAllDay = !sig.description?.includes(':') // rough heuristic

    const event: Record<string, any> = {
      summary:     sig.description || item?.aiTitle || item?.subject || 'Event',
      description: item?.aiSummary
        ? `${item.aiSummary}\n\nAdded by Keel from: ${item.senderName}`
        : `Added by Keel`,
    }

    if (isAllDay) {
      const dateStr = detectedDate.toISOString().split('T')[0]
      event.start = { date: dateStr }
      event.end   = { date: dateStr }
    } else {
      event.start = { dateTime: detectedDate.toISOString(), timeZone: 'Europe/London' }
      event.end   = {
        dateTime: new Date(detectedDate.getTime() + 60 * 60 * 1000).toISOString(),
        timeZone: 'Europe/London',
      }
    }

    // Add reminders
    event.reminders = {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 24 * 60 }, // 1 day before
        { method: 'popup', minutes: 60 },       // 1 hour before
      ],
    }

    // Create the calendar event
    const calRes = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    )

    if (!calRes.ok) {
      const err = await calRes.text()
      console.error('Calendar API error:', err)
      return NextResponse.json({ error: `Calendar API failed: ${calRes.status}` }, { status: 500 })
    }

    const calEvent = await calRes.json()

    // Update signal in Firestore
    await db.doc(`users/${uid}/signals/${signalId}`).update({
      calendarStatus:  'on_cal',
      calendarEventId: calEvent.id,
      updatedAt:       Timestamp.now(),
    })

    console.log(`✓ Calendar event created: ${event.summary} → ${calEvent.id}`)

    return NextResponse.json({
      success:       true,
      calendarEventId: calEvent.id,
      eventLink:     calEvent.htmlLink,
    })

  } catch (error) {
    console.error('Calendar add error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
