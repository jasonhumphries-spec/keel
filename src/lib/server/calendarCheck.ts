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

  // Short title rule: both titles are very short and share a word.
  //
  // This used to take the SHORTER side, which does not say what the comment says: it
  // let ANY two-word calendar entry match a title of any length on one shared word.
  // Observed consequence — "Resonant Grid intro and meeting proposal" (from a VC, about
  // an introduction) was asserted to be "ResonantGrid/CHK/EXA meeting", on the strength
  // of the word "meeting". Both sides must be short for "short" to mean anything.
  const longest = Math.max(wa.size, wb.length)
  if (longest <= 2 && hits.length >= 1) return true

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


// ── Participant-aware matching ────────────────────────────────────────────────
//
// WHY THIS EXISTS. Same-day title matching cannot find a meeting that was merely
// PROPOSED in the mail. "Shall we meet Wednesday?" carries the one date guaranteed to
// be wrong once the meeting is actually booked, and the booked event is titled by
// whoever created it. The real case this was built from: an email from
// Joseph1.Guo@landisgyr.com proposing a meeting on 2 Sept, and a calendar entry
// "Resonant Grid | L+G - Sync Up" on 9 Sept organised by joseph1.guo@landisgyr.com.
// No same-day event, no title overlap with the signal description — but an exact
// address match sitting in the event's organizer field, unread.
//
// WHY NOTHING HERE IS A GATE. The obvious design is "require the sender to be on the
// event". That is wrong often enough to matter: invitations are sent by assistants,
// booking systems, no-reply addresses and colleagues forwarding someone else's thread,
// and in none of those cases is the sender an attendee. Equally, one sender may have
// several meetings in the window, so an address match alone cannot say WHICH. So every
// signal here is evidence, weighted and summed, and a confident match needs two
// independent signals to agree plus a clear margin over the runner-up. When the
// evidence is real but ambiguous the answer is 'probable', not a guess.

export interface CalEventLike {
  summary?:   string
  start?:     { date?: string; dateTime?: string }
  attendees?: Array<{ email?: string }>
  organizer?: { email?: string }
  calendarName?: string
}

function normEmail(e: string | undefined): string {
  return (e ?? '').trim().toLowerCase()
}

/** Every address on the event: organiser plus attendees. */
export function eventParticipants(e: CalEventLike): string[] {
  const out = new Set<string>()
  const org = normEmail(e.organizer?.email)
  if (org) out.add(org)
  for (const a of e.attendees ?? []) {
    const em = normEmail(a.email)
    if (em) out.add(em)
  }
  return [...out]
}

// Shared-domain evidence is worthless for consumer mail — half the world is on gmail,
// so "same domain" would match every personal address against every other.
const FREEMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','outlook.com','hotmail.com','yahoo.com','yahoo.co.uk',
  'icloud.com','me.com','mac.com','live.com','live.co.uk','aol.com','msn.com',
  'protonmail.com','proton.me','pm.me','gmx.com','mail.com','btinternet.com',
])

/**
 * How strongly the sender is tied to this event.
 *
 * 'exact'  — the sender is the organiser or an attendee.
 * 'domain' — someone from the sender's organisation is on the event. This is what
 *            catches the assistant who sends the invite on someone else's behalf, and
 *            the booking address that never attends anything. Freemail domains are
 *            excluded because they carry no organisational meaning.
 */
export function participantEvidence(senderEmail: string, e: CalEventLike): 'exact' | 'domain' | null {
  const sender = normEmail(senderEmail)
  if (!sender || !sender.includes('@')) return null
  const parts = eventParticipants(e)
  if (parts.includes(sender)) return 'exact'

  const domain = sender.split('@')[1] ?? ''
  if (!domain || FREEMAIL_DOMAINS.has(domain)) return null
  return parts.some(p => p.split('@')[1] === domain) ? 'domain' : null
}

/**
 * Graded title overlap, 0..1 — the continuous cousin of `titlesMatch`.
 *
 * Distinctive words count double: sharing "resonant" says far more than sharing
 * "meeting", and a boolean match cannot express that difference. Used to choose
 * BETWEEN candidates, which is where a yes/no answer is useless.
 */
export function titleOverlapScore(a: string, b: string, corpus?: MatchCorpus): number {
  const wa = new Set(sigWords(a))
  const wb = sigWords(b)
  if (!wa.size || !wb.length) return 0
  const hits = wb.filter(w => wa.has(w))
  if (!hits.length) return 0
  // Long words count double, and every word is scaled by how rare it is in this
  // person's calendar — sharing "landisgyr" is evidence, sharing their own company
  // name is not.
  const weight = hits.reduce((n, w) => n + (w.length >= 8 ? 2 : 1) * wordRarity(w, corpus), 0)
  return Math.min(1, weight / Math.max(wa.size, wb.length))
}

/**
 * How distinctive a piece of evidence is, measured against the calendar itself.
 *
 * WHY THIS IS NECESSARY. Without it the matcher produced a confident, wrong answer on
 * its first real run: an email about an Itron conference on 1 Oct was attached to an
 * "L+G Sync Up" on 9 Sept, on three agreeing signals. All three were worthless. The mail
 * came from a COLLEAGUE, who is an attendee on nearly every event in the calendar, and
 * its title contained the company's own name, which appears in many of those events
 * too. Three signals agreed because all three match almost anything.
 *
 * So evidence is weighted by what it discriminates. An address on one event in the
 * window is strong; an address on fifty is nearly meaningless. A shared word that
 * appears in one event title is strong; the user's own company name, appearing in
 * twenty, is not. This is ordinary inverse-document-frequency reasoning, applied to a
 * corpus of one person's calendar — which is the only corpus that matters, because
 * distinctiveness is a property of THEIR calendar, not of English.
 *
 * It also removes the need to special-case internal senders, freemail domains or
 * company names: each of those is just a low-rarity signal, and falls out for free.
 */
export interface MatchCorpus {
  totalEvents: number
  /** Events each address appears on, as organiser or attendee. */
  senderFreq:  Map<string, number>
  /** Events each significant title word appears in. */
  wordFreq:    Map<string, number>
}

export function buildCorpus(events: CalEventLike[]): MatchCorpus {
  const senderFreq = new Map<string, number>()
  const wordFreq   = new Map<string, number>()
  for (const e of events) {
    for (const p of eventParticipants(e)) senderFreq.set(p, (senderFreq.get(p) ?? 0) + 1)
    for (const w of new Set(sigWords(e.summary ?? ''))) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1)
  }
  return { totalEvents: events.length, senderFreq, wordFreq }
}

/**
 * 1.0 for an address seen once, decaying as it appears on more events.
 * A colleague on fifty events contributes almost nothing.
 */
export function participantRarity(email: string, corpus?: MatchCorpus): number {
  if (!corpus) return 1
  const freq = corpus.senderFreq.get(normEmail(email)) ?? 0
  return Math.min(1, 3 / (2 + Math.max(freq, 1)))
}

/** 1.0 for a word unique to one event title, falling towards 0 for ubiquitous ones. */
export function wordRarity(word: string, corpus?: MatchCorpus): number {
  if (!corpus || corpus.totalEvents < 4) return 1
  const df = corpus.wordFreq.get(word) ?? 0
  return Math.log(1 + corpus.totalEvents / (1 + df)) / Math.log(1 + corpus.totalEvents)
}

/**
 * Weights. These are judgement, not measurement — there is no labelled set of
 * signal-to-event pairs to fit them against, and they are written out here so they can
 * be argued with rather than reverse-engineered.
 *
 * An exact address match is the single most trustworthy thing available, because it is
 * string equality on an identifier rather than fuzzy overlap on prose. It is still not
 * allowed to decide alone: MIN_SIGNALS below is what stops a weekly 1:1 with the same
 * person from swallowing every unrelated mention of them.
 */
const W_PARTICIPANT_EXACT  = 0.45
const W_PARTICIPANT_DOMAIN = 0.20
const W_TITLE              = 0.35
const W_SENDER_IN_TITLE    = 0.15
const W_DATE               = 0.20

/** A confident match needs this score AND this many independent signals AND the margin. */
const CONFIDENT_SCORE  = 0.55
const PROBABLE_SCORE   = 0.35
const MIN_SIGNALS      = 2
/**
 * Below these, a signal contributes score but is not INDEPENDENT evidence.
 * A colleague who attends everything, or the user's own company name, can nudge a
 * ranking; neither may help satisfy MIN_SIGNALS.
 */
const RARITY_FLOOR       = 0.34
const TITLE_SIGNAL_FLOOR = 0.15
const CONFIDENT_MARGIN = 0.12
/** Days either side of the signal's date to consider. */
export const MATCH_WINDOW_DAYS = 30

export interface CalMatchContext {
  /** Address the mail came from. May be a robot; may not attend anything. */
  senderEmail: string
  /** Signal description and item title — whichever matches best is used. */
  texts:       string[]
  /** The date the MAIL claimed, which for a proposal is a hypothesis, not a fact. */
  sigDate:     Date
}

export interface ScoredCandidate {
  event:   CalEventLike
  score:   number
  /** Which independent signals fired — carried so a match can be explained. */
  signals: string[]
  dayGap:  number
}

function eventDate(e: CalEventLike): Date | null {
  const raw = e.start?.dateTime ?? e.start?.date ?? ''
  if (!raw) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

export function scoreCandidate(
  ctx: CalMatchContext,
  e: CalEventLike,
  windowDays = MATCH_WINDOW_DAYS,
  corpus?: MatchCorpus,
): ScoredCandidate | null {
  const d = eventDate(e)
  if (!d) return null

  const dayGap = Math.abs(d.getTime() - ctx.sigDate.getTime()) / 86400000
  if (dayGap > windowDays) return null

  const calTitle = e.summary ?? ''
  const signals: string[] = []
  let score = 0

  // Every signal is scaled by how much it discriminates. A signal that is common
  // across this calendar can still contribute score, but it must not be counted as
  // INDEPENDENT evidence — that is what let three worthless agreements produce a
  // confident wrong answer.
  const pe    = participantEvidence(ctx.senderEmail, e)
  const pRare = participantRarity(ctx.senderEmail, corpus)
  if (pe === 'exact')  { score += W_PARTICIPANT_EXACT  * pRare }
  if (pe === 'domain') { score += W_PARTICIPANT_DOMAIN * pRare }
  if (pe && pRare >= RARITY_FLOOR) signals.push(`participant:${pe}`)

  const title = Math.max(0, ...ctx.texts.map(t => (t ? titleOverlapScore(t, calTitle, corpus) : 0)))
  if (title > 0) { score += title * W_TITLE }
  if (title >= TITLE_SIGNAL_FLOOR) signals.push('title')

  if (ctx.senderEmail && calTitle && senderMatchesCalTitle(ctx.senderEmail, calTitle)) {
    score += W_SENDER_IN_TITLE * pRare
    if (pRare >= RARITY_FLOOR) signals.push('sender-in-title')
  }

  // Date proximity decays across the window. It contributes score always, but only
  // counts as an independent SIGNAL when it is tight — an event three weeks away is
  // not evidence of anything on its own.
  score += (1 - dayGap / windowDays) * W_DATE
  if (dayGap <= 3) signals.push('date')

  return { event: e, score: Math.min(1, score), signals, dayGap }
}

/**
 * Choose the calendar event a signal refers to, if any.
 *
 * Returns `confident: false` when the evidence is real but cannot distinguish between
 * candidates — several meetings with the same person, none of whose titles resemble the
 * mail. The caller turns that into 'probable', which shows the user the possibility
 * without asserting it.
 */
export function pickCalendarEvent(
  ctx: CalMatchContext,
  events: CalEventLike[],
  windowDays = MATCH_WINDOW_DAYS,
  corpus?: MatchCorpus,
): { event: CalEventLike; confident: boolean; signals: string[]; score: number } | null {
  // Distinctiveness is measured against the whole calendar, not just the candidates in
  // the window — a colleague is no less ubiquitous for being busy next week.
  const c = corpus ?? buildCorpus(events)
  const scored = events
    .map(e => scoreCandidate(ctx, e, windowDays, c))
    .filter((c): c is ScoredCandidate => c !== null && c.score >= PROBABLE_SCORE)
    .sort((a, b) => b.score - a.score || a.dayGap - b.dayGap)

  if (!scored.length) return null
  const top = scored[0]

  const strong = top.score >= CONFIDENT_SCORE && top.signals.length >= MIN_SIGNALS
  if (!strong) return { event: top.event, confident: false, signals: top.signals, score: top.score }

  // Instances of one recurring series are not competing candidates — they are the same
  // meeting. Without this, singleEvents=true expansion turns a weekly sync into a dozen
  // identical rivals and the margin test can never be satisfied.
  const norm = (t?: string) => (t ?? '').trim().toLowerCase()
  const rival = scored.slice(1).find(c => norm(c.event.summary) !== norm(top.event.summary))
  const clear = !rival || (top.score - rival.score) >= CONFIDENT_MARGIN

  return { event: top.event, confident: clear, signals: top.signals, score: top.score }
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
  type CalEvent = CalEventLike & { calendarName: string }
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

    // Second pass — only runs when same-day title matching found nothing confident, so
    // it can add matches but never take one away. This is what catches a meeting that
    // was proposed for one date and booked for another, under a title the user chose.
    const ctx = { senderEmail, texts: [sigDesc, itemTitle], sigDate }
    const participantHit = matchedEvent ? null : pickCalendarEvent(ctx, allEvents)

    const confidentEvent = matchedEvent
      ?? (participantHit?.confident ? (participantHit.event as typeof allEvents[number]) : undefined)
    // An exact-address match that cannot pick between candidates still beats a single
    // fuzzy word shared with a same-day event, so it is preferred for 'probable' too.
    const weakEvent = probableEvent
      ?? (participantHit && !participantHit.confident ? (participantHit.event as typeof allEvents[number]) : undefined)

    const matchedEventFinal = confidentEvent
    const newStatus: string = confidentEvent ? 'on_cal' : weakEvent ? 'probable' : 'not_on_cal'
    if (participantHit && !matchedEvent) {
      console.log(`[CalCheck] participant pass: "${participantHit.event.summary}" score=${participantHit.score.toFixed(2)} signals=[${participantHit.signals.join(',')}] confident=${participantHit.confident}`)
    }
    const update: Record<string, any> = { calendarStatus: newStatus, updatedAt: Timestamp.now() }
    if (matchedEventFinal?.calendarName && matchedEventFinal.calendarName !== 'Primary') {
      update.matchedCalendarName = matchedEventFinal.calendarName
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
