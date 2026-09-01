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

// Weaker match — same-day event exists but title overlap is only 1 word (< 8 chars).
// Used to set calendarStatus: 'probable' rather than 'not_on_cal'.
// "Bedales Senior Welcome Evening" vs "Bedales Block 3 Evening" → hits: ["bedales","evening"] → confident match
// "School Play" vs "Paxton Nativity" → hits: [] → no match, not even probable
// "Dentist Paxton" vs "Dental Appointment" → hits: [] → not probable (no shared words)
export function titlesMatchProbable(a: string, b: string): boolean {
  if (titlesMatch(a, b)) return false // already a confident match — caller uses on_cal
  const wa = new Set(sigWords(a))
  const wb = sigWords(b)
  if (!wa.size || !wb.length) return false
  const hits = wb.filter(w => wa.has(w))
  // Single meaningful word overlap (5+ chars) = probable
  return hits.some(w => w.length >= 5)
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

  // First pass: a candidate appears as a substring in the calendar title.
  // e.g. cal title "Pax - Orthodontist Petworth Donovans Dentist" contains "donovansdentalcare"? no,
  // but contains "portmandental"? no. Cal title is short and curated by the user.
  if (candidates.some(c => c.length > 4 && calLower.includes(c))) return true

  // Stem fallback for brief cal titles: if any cal word (5+ chars) has its
  // 4-char prefix as a substring in any sender candidate, count it as a match.
  // e.g. cal "JH Dentist and hyg" → cal word "dentist" → prefix "dent" → matches
  // sender candidate "donovansdentalcare" (contains "dent"). Loose enough to handle
  // dental/dentist/dentistry variants without hard-coding stems.
  const calWords = calLower.split(/\s+/).filter(w => w.length >= 5)
  return calWords.some(cw => {
    const stem = cw.slice(0, 4)
    return candidates.some(c => c.length > 4 && c.includes(stem))
  })
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

  // Get active event/rsvp + calendarWorthy deadline signals in window.
  // Ordinary deadlines are excluded — they belong on the item, not the calendar.
  const rawSignalsSnap = await db.collection(`users/${uid}/signals`)
    .where('status',       '==',  'active')
    .where('type',         'in',  ['event', 'rsvp', 'deadline'])
    .where('detectedDate', '>=',  Timestamp.fromDate(past))
    .where('detectedDate', '<=',  Timestamp.fromDate(future))
    .get()
  const filteredDocs = rawSignalsSnap.docs.filter(d => {
    const t = d.data().type as string
    return t !== 'deadline' || d.data().calendarWorthy === true
  })
  const signalsSnap = { empty: filteredDocs.length === 0, docs: filteredDocs, size: filteredDocs.length }

  if (signalsSnap.empty) {
    console.log(`[CalCheck] No signals to check`)
    return { matched: 0, notMatched: 0, total: 0 }
  }

  const itemIds    = [...new Set(signalsSnap.docs.map(d => d.data().itemId as string).filter(Boolean))]
  // Batch-get items for aiTitle + senderEmail (better match candidates than raw signal description),
  // plus status + manualPriority so we can downgrade 'new' items whose event is on the calendar.
  const itemTitles    = new Map<string, string>()
  const itemSenders   = new Map<string, string>()
  const itemStatuses  = new Map<string, string>()
  const itemManualPri = new Map<string, boolean>()

  if (itemIds.length > 0) {
    const chunks: string[][] = []
    for (let i = 0; i < itemIds.length; i += 10) chunks.push(itemIds.slice(i, i + 10))
    await Promise.all(chunks.map(async chunk => {
      const docs = await Promise.all(chunk.map(id => db.doc(`users/${uid}/items/${id}`).get()))
      for (const d of docs) {
        if (d.exists) {
          const data = d.data() ?? {}
          itemTitles.set(d.id,    data.aiTitle        ?? '')
          itemSenders.set(d.id,   data.senderEmail    ?? '')
          itemStatuses.set(d.id,  data.status         ?? '')
          itemManualPri.set(d.id, data.manualPriority ?? false)
        }
      }
    }))
  }

  // Track items whose signal matched on_cal — we'll downgrade these after the signal batch.
  const itemsMatchedOnCal = new Set<string>()

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

    // Check for a probable match (same day, weaker title overlap)
    const probableEvent = !matchedEvent && sameDay.find(e => {
      const calTitle = e.summary ?? ''
      return (sigDesc   && titlesMatchProbable(sigDesc,   calTitle))
          || (itemTitle && titlesMatchProbable(itemTitle, calTitle))
    })

    const newStatus: string = matchedEvent ? 'on_cal' : probableEvent ? 'probable' : 'not_on_cal'
    const update: Record<string, any> = { calendarStatus: newStatus, updatedAt: Timestamp.now() }
    if (matchedEvent?.calendarName && matchedEvent.calendarName !== 'Primary') {
      update.matchedCalendarName = matchedEvent.calendarName
    } else {
      update.matchedCalendarName = null
    }

    // Only write if status changed — avoids unnecessary Firestore writes
    if (sig.calendarStatus !== newStatus || (newStatus === 'on_cal' && update.matchedCalendarName !== (sig.matchedCalendarName ?? null))) {
      batch.update(sigDoc.ref, update)
    }

    if (newStatus === 'on_cal') {
      matched++
      if (sig.itemId) itemsMatchedOnCal.add(sig.itemId as string)
    } else if (newStatus === 'probable') {
      matched++
    } else {
      notMatched++
    }
  }

  await batch.commit()

  // Soften priority of items whose event is already on the user's calendar.
  // Rule: if an item is status='new' (AI saw no action needed), the user hasn't
  // manually set priority, and the event has a confident calendar match → drop
  // score to Medium so it sits in 'On your radar' rather than commanding attention.
  // Original status preserved so the user still sees it; calendar reminds of the event.
  let downgraded = 0
  if (itemsMatchedOnCal.size > 0) {
    const downgradeBatch = db.batch()
    const ts = Timestamp.now()
    for (const itemId of itemsMatchedOnCal) {
      if (itemStatuses.get(itemId) !== 'new')     continue
      if (itemManualPri.get(itemId) === true)     continue
      // Score-down only — keep status='new' so the item stays visible in FYI/On your radar.
      // The calendar tells the user about the event; we just signal it's no longer 'High'.
      downgradeBatch.update(db.doc(`users/${uid}/items/${itemId}`), {
        aiImportanceScore:  0.45,
        autoQuietedReason:  'on_calendar',
        // NB: no quietedBy — this is a score downgrade, not a quiet. Status stays
        // 'new' so the item remains visible. Legacy items carrying
        // autoQuietedReason='on_calendar' AND status='quietly_logged' predate this.
        updatedAt:          ts,
      })
      downgraded++
    }
    if (downgraded > 0) await downgradeBatch.commit()
  }

  console.log(`[CalCheck] uid=${uid.slice(0,8)} — ${matched} on_cal · ${notMatched} not_on_cal · ${signalsSnap.size} total · ${downgraded} items auto-quieted`)
  return { matched, notMatched, total: signalsSnap.size }
}
