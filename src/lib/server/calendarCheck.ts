import type { Firestore } from 'firebase-admin/firestore'
import { Timestamp } from 'firebase-admin/firestore'

// ── Fuzzy title matching ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','and','for','with','from','this','that','have','will','your',
  'their','been','were','they','about','when','where','what','which',
])

function sigWords(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
}

export function titlesMatch(a: string, b: string): boolean {
  const wa = new Set(sigWords(a))
  const wb = sigWords(b)
  if (!wa.size || !wb.length) return false
  const hits    = wb.filter(w => wa.has(w)).length
  const shorter = Math.min(wa.size, wb.length)
  // 2+ significant word overlap, or 100% overlap when both titles are very short
  return hits >= 2 || (shorter <= 2 && hits >= 1)
}

// ── Main check function ───────────────────────────────────────────────────────

export async function runCalendarCheck(
  db:          Firestore,
  uid:         string,
  accessToken: string
): Promise<{ matched: number; notMatched: number; total: number }> {

  // One GCal API call — past 7 days to future 35 days covers all relevant signals
  const now    = new Date()
  const past   = new Date(now.getTime() -  7 * 86400000)
  const future = new Date(now.getTime() + 35 * 86400000)

  const calUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  calUrl.searchParams.set('timeMin',       past.toISOString())
  calUrl.searchParams.set('timeMax',       future.toISOString())
  calUrl.searchParams.set('singleEvents',  'true')
  calUrl.searchParams.set('maxResults',    '500')
  calUrl.searchParams.set('orderBy',       'startTime')

  const calRes = await fetch(calUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!calRes.ok) {
    console.warn(`[CalCheck] GCal API failed: ${calRes.status}`)
    return { matched: 0, notMatched: 0, total: 0 }
  }

  const calEvents = ((await calRes.json()).items ?? []) as Array<{
    summary?: string
    start?:   { date?: string; dateTime?: string }
  }>

  console.log(`[CalCheck] Fetched ${calEvents.length} calendar events`)

  // Get active event/rsvp/deadline signals in window
  const signalsSnap = await db.collection(`users/${uid}/signals`)
    .where('status',       '==',  'active')
    .where('type',         'in',  ['event', 'rsvp', 'deadline'])
    .where('detectedDate', '>=',  Timestamp.fromDate(past))
    .where('detectedDate', '<=',  Timestamp.fromDate(future))
    .get()

  if (signalsSnap.empty) {
    console.log(`[CalCheck] No signals to check`)
    return { matched: 0, notMatched: 0, total: 0 }
  }

  // Batch-get items for aiTitle (better match candidate than raw signal description)
  const itemIds   = [...new Set(signalsSnap.docs.map(d => d.data().itemId as string).filter(Boolean))]
  const itemTitles = new Map<string, string>() // itemId → aiTitle

  if (itemIds.length > 0) {
    const chunks: string[][] = []
    for (let i = 0; i < itemIds.length; i += 10) chunks.push(itemIds.slice(i, i + 10))
    await Promise.all(chunks.map(async chunk => {
      const docs = await Promise.all(chunk.map(id => db.doc(`users/${uid}/items/${id}`).get()))
      for (const d of docs) {
        if (d.exists) itemTitles.set(d.id, d.data()?.aiTitle ?? '')
      }
    }))
  }

  // Match each signal against calendar events on the same day
  const batch  = db.batch()
  let matched  = 0
  let notMatched = 0

  for (const sigDoc of signalsSnap.docs) {
    const sig       = sigDoc.data()
    if (sig.calendarStatus === 'ignored') continue

    const sigDate   = (sig.detectedDate.toDate()) as Date
    const sigDesc   = (sig.description  ?? '') as string
    const itemTitle = itemTitles.get(sig.itemId as string) ?? ''

    // Same-day window: allow ±1 day for all-day events and timezone variance
    const dayStart = new Date(sigDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart.getTime() + 2 * 86400000)

    const sameDay = calEvents.filter(e => {
      const raw = e.start?.dateTime ?? e.start?.date ?? ''
      const d   = new Date(raw)
      return raw && d >= dayStart && d < dayEnd
    })

    // Match against signal description OR item aiTitle
    const isOnCal = sameDay.some(e => {
      const calTitle = e.summary ?? ''
      return (sigDesc   && titlesMatch(sigDesc,    calTitle))
          || (itemTitle && titlesMatch(itemTitle,  calTitle))
    })

    const newStatus = isOnCal ? 'on_cal' : 'not_on_cal'

    // Only write if status changed — avoids unnecessary Firestore writes
    if (sig.calendarStatus !== newStatus) {
      batch.update(sigDoc.ref, { calendarStatus: newStatus, updatedAt: Timestamp.now() })
    }

    if (isOnCal) matched++
    else notMatched++
  }

  await batch.commit()

  console.log(`[CalCheck] uid=${uid.slice(0,8)} — ${matched} on_cal · ${notMatched} not_on_cal · ${signalsSnap.size} total`)
  return { matched, notMatched, total: signalsSnap.size }
}
