/**
 * calendarUtils.ts
 *
 * Shared utilities for building Google Calendar event URLs.
 * Used by CalendarColumn and ItemExpandedPanel when the user clicks "+ Add to calendar".
 */

import type { KeelItem, KeelSignal } from './types'

// ── Time extraction ────────────────────────────────────────────────────────

function parseTime(t: string): { hours: number; minutes: number } | null {
  const m = t.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return null
  let hours  = parseInt(m[1], 10)
  const mins = parseInt(m[2] ?? '0', 10)
  const ampm = m[3]?.toLowerCase()
  if (ampm === 'pm' && hours < 12) hours += 12
  if (ampm === 'am' && hours === 12) hours = 0
  if (hours > 23 || mins > 59) return null
  return { hours, minutes: mins }
}

function extractTimes(text: string): {
  start: { hours: number; minutes: number }
  end?: { hours: number; minutes: number }
} | null {
  if (!text) return null

  // Range: "3:00pm - 11:00pm", "08:00–08:30", "11:40am to 5:45pm"
  const rangePattern = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:[-–—]|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi
  for (const m of text.matchAll(rangePattern)) {
    const start = parseTime(m[1])
    const end   = parseTime(m[2])
    if (start) return { start, end: end ?? undefined }
  }

  // Single time with keyword: "at 3pm", "starting 1pm", "depart 11:40", "from 15:00"
  const singlePattern = /(?:at|from|starting|start|depart(?:ure)?|arrive[sd]?|time[:]?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi
  for (const m of text.matchAll(singlePattern)) {
    const start = parseTime(m[1])
    if (start) return { start }
  }

  // Bare HH:MM time — include am/pm in capture so parseTime gets full context
  const barePattern = /\b(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*(?:BST|GMT|UTC)?\b/gi
  for (const m of text.matchAll(barePattern)) {
    const start = parseTime(m[1])
    if (start && start.hours <= 23) return { start }
  }

  return null
}

// ── URL builder ────────────────────────────────────────────────────────────

/**
 * Build a Google Calendar "Add event" URL for the given signal + item.
 *
 * - If a time is found in the signal description or item summaries → timed event
 * - Otherwise → all-day event
 * - Description uses aiDetailedSummary if available, falls back to aiSummary
 */
export function buildCalendarUrl(signal: KeelSignal, item?: KeelItem): string {
  const date   = signal.detectedDate!
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const pad    = (n: number) => String(n).padStart(2, '0')

  // Search for times in signal description → aiSummary → aiDetailedSummary
  const searchTexts = [
    signal.description ?? '',
    item?.aiSummary ?? '',
    item?.aiDetailedSummary ?? '',
  ]
  let times: ReturnType<typeof extractTimes> = null
  for (const text of searchTexts) {
    times = extractTimes(text)
    if (times) break
  }

  let dateParam: string

  if (times) {
    // Timed event
    const startDate = new Date(date)
    startDate.setHours(times.start.hours, times.start.minutes, 0, 0)

    let endDate: Date
    if (times.end) {
      endDate = new Date(date)
      endDate.setHours(times.end.hours, times.end.minutes, 0, 0)
      if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1)
    } else {
      endDate = new Date(startDate.getTime() + 60 * 60 * 1000) // 1hr default
    }

    const fmt = (d: Date) =>
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `T${pad(d.getHours())}${pad(d.getMinutes())}00`

    dateParam = `${fmt(startDate)}/${fmt(endDate)}`
  } else {
    // All-day event
    const y = date.getFullYear()
    const m = pad(date.getMonth() + 1)
    const d = pad(date.getDate())
    dateParam = `${y}${m}${d}/${y}${m}${d}`
  }

  // Build description: aiDetailedSummary → aiSummary → signal description
  let description = signal.description || ''
  if (item?.aiDetailedSummary && typeof item.aiDetailedSummary === 'string' && item.aiDetailedSummary.trim()) {
    description = item.aiDetailedSummary.trim()
    if (item.senderName) description += `\n\nFrom: ${item.senderName}`
    description += '\n\nAdded by Keel'
  } else if (item?.aiSummary && typeof item.aiSummary === 'string' && item.aiSummary.trim()) {
    description = item.aiSummary.trim()
    if (item.senderName) description += `\n\nFrom: ${item.senderName}`
    description += '\n\nAdded by Keel'
  }

  const params = new URLSearchParams({
    text:    item?.aiTitle || signal.description || 'Event',
    dates:   dateParam,
    details: description,
    ctz:     userTz,
  })

  return `https://calendar.google.com/calendar/r/eventedit?${params.toString()}`
}
