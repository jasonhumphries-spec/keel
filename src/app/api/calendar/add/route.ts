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

    // ── Time extraction ────────────────────────────────────────────────────
    // Try to find a start (and optionally end) time from the signal description
    // and item summaries. Falls back to all-day if nothing found.

    /**
     * Parse a time string like "3:00pm", "15:00", "3pm", "11:40" into
     * { hours, minutes } in 24-hour format. Returns null if not parseable.
     */
    function parseTime(t: string): { hours: number; minutes: number } | null {
      const m = t.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
      if (!m) return null
      let hours   = parseInt(m[1], 10)
      const mins  = parseInt(m[2] ?? '0', 10)
      const ampm  = m[3]?.toLowerCase()
      if (ampm === 'pm' && hours < 12) hours += 12
      if (ampm === 'am' && hours === 12) hours = 0
      if (hours > 23 || mins > 59) return null
      return { hours, minutes: mins }
    }

    /**
     * Extract start and optional end times from a text string.
     * Handles: "3:00pm - 11:00pm BST", "08:00–08:30", "11:40am to 5:45pm",
     *          "starting at 1pm", "depart 11:40", "return 5:45pm"
     * Returns null if no time found.
     */
    function extractTimes(text: string): { start: { hours: number; minutes: number }; end?: { hours: number; minutes: number } } | null {
      if (!text) return null

      // Pattern: time SEPARATOR time (start–end range)
      const rangePattern = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:[-–—]|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi
      for (const m of text.matchAll(rangePattern)) {
        const start = parseTime(m[1])
        const end   = parseTime(m[2])
        if (start) return { start, end: end ?? undefined }
      }

      // Pattern: standalone time with contextual keyword
      const singlePattern = /(?:at|from|starting|start|depart(?:ure)?|arrive[sd]?|time[:]?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi
      for (const m of text.matchAll(singlePattern)) {
        const start = parseTime(m[1])
        if (start) return { start }
      }

      // Pattern: any bare time in HH:MM format (high confidence it's a time)
      const barePattern = /\b(\d{1,2}:\d{2})\s*(?:am|pm|BST|GMT|UTC)?\b/gi
      for (const m of text.matchAll(barePattern)) {
        const start = parseTime(m[1])
        if (start && start.hours <= 23) return { start }
      }

      return null
    }

    // Search for times in: signal description → aiSummary → aiDetailedSummary
    const searchTexts = [
      sig.description ?? '',
      item?.aiSummary ?? '',
      item?.aiDetailedSummary ?? '',
    ]

    let extractedTimes: { start: { hours: number; minutes: number }; end?: { hours: number; minutes: number } } | null = null
    for (const text of searchTexts) {
      extractedTimes = extractTimes(text)
      if (extractedTimes) break
    }

    // ── Build event date/time ─────────────────────────────────────────────
    const detectedDate: Date = sig.detectedDate?.toDate() ?? new Date()

    // Build calendar event description from aiDetailedSummary → aiSummary
    let calDescription = 'Added by Keel'
    if (item?.aiDetailedSummary && typeof item.aiDetailedSummary === 'string' && item.aiDetailedSummary.trim()) {
      calDescription = item.aiDetailedSummary.trim()
      if (item.senderName) calDescription += `\n\nFrom: ${item.senderName}`
      calDescription += '\n\nAdded by Keel'
    } else if (item?.aiSummary && typeof item.aiSummary === 'string' && item.aiSummary.trim()) {
      calDescription = item.aiSummary.trim()
      if (item.senderName) calDescription += `\n\nFrom: ${item.senderName}`
      calDescription += '\n\nAdded by Keel'
    }

    const event: Record<string, any> = {
      summary:     sig.description || item?.aiTitle || item?.subject || 'Event',
      description: calDescription,
    }

    if (extractedTimes) {
      // We have a time — create a timed event
      const startDate = new Date(detectedDate)
      startDate.setHours(extractedTimes.start.hours, extractedTimes.start.minutes, 0, 0)

      let endDate: Date
      if (extractedTimes.end) {
        endDate = new Date(detectedDate)
        endDate.setHours(extractedTimes.end.hours, extractedTimes.end.minutes, 0, 0)
        // Handle midnight crossover (e.g. 11pm–1am)
        if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1)
      } else {
        // No end time — default to 1 hour
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000)
      }

      event.start = { dateTime: startDate.toISOString(), timeZone: 'Europe/London' }
      event.end   = { dateTime: endDate.toISOString(),   timeZone: 'Europe/London' }
    } else {
      // No time found — all-day event
      const dateStr = detectedDate.toISOString().split('T')[0]
      event.start = { date: dateStr }
      event.end   = { date: dateStr }
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
    console.log(`[CalAdd] summary="${event.summary}" description="${calDescription.slice(0, 80)}..." timed=${!!extractedTimes}`)
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
