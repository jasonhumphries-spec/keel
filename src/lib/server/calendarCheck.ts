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

  const hits   = wb.filter(w => wa.has(w))
  const shorter = Math.min(wa.size, wb.length)

  // Standard rule: 2+ significant word overlap
  if (hits.length >= 2) return true

  // Short title rule: both titles are very short and share a word
  if (shorter <= 2 && hits.length >= 1) return true

  // High-entropy single word rule: one matching word of 8+ chars is sufficient.
  // "STONERYHENGE", "orthodontist", "portmandental" — these are so distinctive
  // that a single match is unambiguous. Common words (≤7 chars) still require 2.
  if (hits.some(w => w.length >= 8)) return true

  return false
}

/**
 * Fallback: check if the sender's domain name appears in the calendar event title.
 * Handles cases where the calendar entry title differs completely from the email
 * subject — e.g. email from "reception.donovansdentalcare@portmandental.co.uk"
 * matched against a calendar entry titled "Pax - Orthodontist Petworth Donovans Dentist".
 * Extracts meaningful parts of the domain (skips generic words like "reception",
 * "info", "noreply", "mail", "hello") and checks if any appear in the cal title.
 */
const GENERIC_EMAIL_PREFIXES = new Set([
  'reception','info','noreply','no-reply','hello','mail','contact',
  'admin','support','booking','appointments','enquiries','team',
])

export function senderMatchesCalTitle(senderEmail: string, calTitle: string): boolean {
  if (!senderEmail || !calTitle) return false
  // Extract domain parts — e.g. "donovansdentalcare" from "reception.donovansdentalcare@portmandental.co.uk"
  const emailLower = senderEmail.toLowerCase()
  const calLower   = calTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')

  // Try each dot-separated local part and each domain segment
  const localPart = emailLower.split('@')[0] ?? ''
  const domain    = emailLower.split('@')[1] ?? ''
  const domainBase = domain.split('.').filter(p => p.length > 3 && p !== 'co' && p !== 'com' && p !== 'org' && p !== 'net' && p !== 'uk')

  const candidates = [
    ...localPart.split('.').filter(p => p.length > 4 && !GENERIC_EMAIL_PREFIXES.has(p)),
    ...domainBase,
  ]

  // A candidate matches if it appears as a substring in the calendar title
  return candidates.some(c => c.length > 4 && calLower.includes(c))
}

// ── Main check function ───────────────────────────────────────────────────────

export async function runCalendarCheck(
  db:          Firestore,
  uid:         string,
  accessToken: string
): Promise<{ matched: number; notMatched: number; total: number }> {

  // Check user preference for all-calendars mode
  const accountSnap = await db.doc(`users/${uid}/accounts/account_primary`).get()
  const checkAllCalendars = accountSnap.data()?.checkAllCalendars ?? false

  // One GCal API call — past 7 days to future 365 days covers all relevant signals
  const now    = new Date()
  const past   = new Date(now.getTime() -   7 * 86400000)
  const future = new Date(now.getTime() + 365 * 86400000)

  // Build list of calendar IDs to query
  let calendarIds: Array<{ id: string; name: string }> = [{ id: 'primary', name: 'Primary' }]

  if (checkAllCalendars) {
    try {
      const listRes = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      if (listRes.ok) {
        const listData = await listRes.json()
        calendarIds = (listData.items ?? [])
          .filter((c: any) => ['owner', 'writer', 'reader'].includes(c.accessRole))
          .map((c: any) => ({ id: c.id, name: c.summary ?? c.id }))
        console.log(`[CalCheck] Checking ${calendarIds.length} calendars: ${calendarIds.map(c => c.name).join(', ')}`)
      }
    } catch (e) {
      console.warn('[CalCheck] Failed to fetch calendar list, falling back to primary:', e)
    }
  }

  // Fetch events from all calendars
  type CalEvent = { summary?: string; start?: { date?: string; dateTime?: string }; calendarName: string }
  const allEvents: CalEvent[] = []

  await Promise.all(calendarIds.map(async ({ id, name }) => {
    const calUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`)
    calUrl.searchParams.set('timeMin',      past.toISOString())
    calUrl.searchParams.set('timeMax',      future.toISOString())
    calUrl.searchParams.set('singleEvents', 'true')
    calUrl.searchParams.set('maxResults',   '2500')
    calUrl.searchParams.set('orderBy',      'startTime')

    const res = await fetch(calUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) { console.warn(`[CalCheck] Calendar ${name} failed: ${res.status}`); return }
    const items = ((await res.json()).items ?? []) as any[]
    items.forEach(e => allEvents.push({ ...e, calendarName: name }))
  }))

  console.log(`[CalCheck] Fetched ${allEvents.length} total calendar events`)

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

  const itemIds    = [...new Set(signalsSnap.docs.map(d => d.data().itemId as string).filter(Boolean))]
  // Batch-get items for aiTitle + senderEmail (better match candidates than raw signal description)
  const itemTitles  = new Map<string, string>()  // itemId → aiTitle
  const itemSenders = new Map<string, string>()  // itemId → senderEmail

  if (itemIds.length > 0) {
    const chunks: string[][] = []
    for (let i = 0; i < itemIds.length; i += 10) chunks.push(itemIds.slice(i, i + 10))
    await Promise.all(chunks.map(async chunk => {
      const docs = await Promise.all(chunk.map(id => db.doc(`users/${uid}/items/${id}`).get()))
      for (const d of docs) {
        if (d.exists) {
          itemTitles.set(d.id,  d.data()?.aiTitle     ?? '')
          itemSenders.set(d.id, d.data()?.senderEmail ?? '')
        }
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
    const sigDesc    = (sig.description  ?? '') as string
    const itemTitle  = itemTitles.get(sig.itemId as string)  ?? ''
    const senderEmail = itemSenders.get(sig.itemId as string) ?? ''

    // Same-day window: allow ±1 day for all-day events and timezone variance
    const dayStart = new Date(sigDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart.getTime() + 2 * 86400000)

    const sameDay = allEvents.filter(e => {
      const raw = e.start?.dateTime ?? e.start?.date ?? ''
      const d   = new Date(raw)
      return raw && d >= dayStart && d < dayEnd
    })

    // Match against signal description, item aiTitle, or sender domain (in that order).
    // Sender domain handles cases where the calendar entry title was written by the user
    // and shares no words with the email subject — e.g. "Pax - Orthodontist Petworth
    // Donovans Dentist" matched via "donovansdentalcare" in the sender email address.
    const matchedEvent = sameDay.find(e => {
      const calTitle = e.summary ?? ''
      return (sigDesc    && titlesMatch(sigDesc,    calTitle))
          || (itemTitle  && titlesMatch(itemTitle,  calTitle))
          || (senderEmail && senderMatchesCalTitle(senderEmail, calTitle))
    })
    const isOnCal = !!matchedEvent

    const newStatus = isOnCal ? 'on_cal' : 'not_on_cal'
    const update: Record<string, any> = { calendarStatus: newStatus, updatedAt: Timestamp.now() }
    if (isOnCal && matchedEvent?.calendarName && matchedEvent.calendarName !== 'Primary') {
      update.matchedCalendarName = matchedEvent.calendarName
    } else if (!isOnCal) {
      update.matchedCalendarName = null
    }

    // Only write if status changed — avoids unnecessary Firestore writes
    if (sig.calendarStatus !== newStatus || (isOnCal && update.matchedCalendarName !== (sig.matchedCalendarName ?? null))) {
      batch.update(sigDoc.ref, update)
    }

    if (isOnCal) matched++
    else notMatched++
  }

  await batch.commit()

  console.log(`[CalCheck] uid=${uid.slice(0,8)} — ${matched} on_cal · ${notMatched} not_on_cal · ${signalsSnap.size} total`)
  return { matched, notMatched, total: signalsSnap.size }
}
