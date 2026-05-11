/**
 * scanUtils.ts
 *
 * Shared AI classification logic used by all scan routes:
 *   - /api/gmail/scan          (manual + auto scans)
 *   - /api/gmail/background-scan (Pub/Sub triggered)
 *
 * Extracting here ensures all scan types use identical prompts and scoring.
 * Improving the prompt here improves all scan types simultaneously.
 *
 * Exports:
 *   ClassificationResult  — typed return shape from classifyThread()
 *   classifyThread()      — S1 classification: takes thread content, returns structured result
 *   runInBatches()        — generic parallel batch helper
 */

import { getFirestore } from 'firebase-admin/firestore'
import { aiComplete } from '@/lib/aiComplete'

// ── Types ──────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  shouldProcess:     boolean
  categoryId:        string
  categoryName:      string
  aiTitle:           string
  aiSummary:         string
  aiDetailedSummary: string
  aiImportanceScore: number
  signals: Array<{
    type:                 string
    description:          string
    detectedDate?:        string | null
    detectedAmountPence?: number | null
    currency?:            string | null
  }>
  isRecurring: boolean
  status:      string
  _usage?:     { inputTokens: number; outputTokens: number }
}

// ── Built-in category descriptions ────────────────────────────────────────
// Used to enrich AI prompts even when the user hasn't written their own description.

export const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  cat_finance:   'Bills, invoices, bank statements, payments. Energy, insurance, subscriptions, tax, HMRC, accountants.',
  cat_school:    'Schools, nurseries, universities, tutors. Term dates, fees, events, reports, teacher emails.',
  cat_home:      'Home or property emails. Letting agents, tradespeople, councils, home insurance.',
  cat_hired:     'Hired help — cleaners, gardeners, nannies, tutors, personal service providers.',
  cat_health:    'GP, dentist, physio, hospital. NHS letters, health insurance, test results.',
  cat_travel:    'Travel bookings. Flights, hotels, car hire, travel insurance, rail tickets.',
  cat_work:      'Work emails — clients, suppliers, colleagues, contracts, business invoices.',
  cat_it:        'Tech emails. Domain renewals, hosting, software subscriptions, security alerts.',
  cat_drama:     'Social events, invitations, RSVPs, event tickets, personal social plans.',
  cat_job:       'Job search. Applications, interviews, recruiter outreach, job alerts.',
  cat_other:     'Miscellaneous emails not fitting other categories.',
  cat_clients:   'Client and customer emails — enquiries, project updates, contracts.',
  cat_suppliers: 'Supplier and vendor emails — quotes, invoices, delivery, account management.',
  cat_hr:        'HR emails — applications, contracts, payroll, employee queries, recruitment.',
  cat_legal:     'Legal and compliance — contracts, NDAs, regulatory notices, company filings.',
  cat_projects:  'Project emails — status updates, deliverables, timelines.',
  cat_marketing: 'Marketing and PR — campaigns, press, agency, brand communications.',
}

// ── classifyThread ─────────────────────────────────────────────────────────

/**
 * S1 classification: takes a Gmail thread and returns a structured result
 * with category, importance score, status, signals, and AI-generated summaries.
 *
 * @param db        Firestore instance (for aiComplete provider lookup)
 * @param subject   Thread subject line
 * @param from      Original sender (full "Name <email>" string)
 * @param threadBody Pre-built thread body text (use buildThreadContext from the caller)
 * @param categories User's category list with descriptions
 * @param hints      User correction hints from categoryHints collection
 * @param isUK       Whether to use British English in AI output
 */
export async function classifyThread(
  db:          ReturnType<typeof getFirestore>,
  subject:     string,
  from:        string,
  threadBody:  string,
  categories:  { id: string; name: string; description: string }[],
  hints:       { categoryId: string; categoryName: string; senderEmail: string; senderName: string; subjectClue: string }[],
  isUK:        boolean = true,
  isOutbound:  boolean = false
): Promise<ClassificationResult | null> {
  const categoryList = categories
    .map(c => {
      const userDesc     = c.description?.trim() ?? ''
      const builtinDesc  = BUILTIN_DESCRIPTIONS[c.id] ?? ''
      const builtinShort = builtinDesc.length > 100 ? builtinDesc.slice(0, 100) + '…' : builtinDesc
      const desc = userDesc && builtinShort
        ? `${builtinShort} Also: ${userDesc}`
        : userDesc || builtinShort
      return `- ${c.id}: ${c.name}${desc ? ` — ${desc}` : ''}`
    })
    .join('\n')

  const hintList = hints.length > 0
    ? '\n\nUSER CORRECTIONS (use these to inform category choice):\n' +
      hints.map(h => `- Emails from "${h.senderName}" (${h.senderEmail}) about "${h.subjectClue}" → ${h.categoryName}`).join('\n')
    : ''

  const outboundNote = isOutbound
    ? '\nDIRECTION: This is a thread the account owner initiated — they sent the first message. ' +
      'The recipient has not yet replied. If the message contains a genuine question, request, or ' +
      'anything requiring a response, classify as awaiting_reply with an appropriate importance score (0.55+). ' +
      'Only use quietly_logged if this is clearly automated, transactional, or requires no response at all.\n'
    : ''

  const prompt = `You are Keel, a personal life admin AI. Classify this email thread and extract actionable signals.
${isUK ? 'Write all text in British English — use UK spellings throughout (e.g. "organise" not "organize", "colour" not "color", "enquire" not "inquire", "cheque" not "check", "licence" not "license").\n' : ''}
${outboundNote}IMPORTANT: The thread below may contain older messages for full context, but your classification must reflect the CURRENT STATE of the thread — what is happening now, what action (if any) is still needed today. A thread that started months ago may already be fully resolved. Judge by the most recent messages.

CATEGORIES:
${categoryList}${hintList}

THREAD SUBJECT: ${subject}
ORIGINAL SENDER: ${from}

THREAD (most recent messages last):
${threadBody.slice(0, 3000)}

Respond with ONLY valid JSON matching this schema exactly:
{
  "shouldProcess": boolean,
  "categoryId": string,
  "categoryName": string,
  "aiTitle": string,
  "aiSummary": string,
  "aiDetailedSummary": string,
  "aiImportanceScore": number,
  "signals": [
    {
      "type": "event" | "deadline" | "payment" | "rsvp" | "awaiting",
      "description": string,
      "detectedDate": "YYYY-MM-DD" | null,
      "detectedAmountPence": number | null,
      "currency": "GBP" | "USD" | null
    }
  ],
  "isRecurring": boolean,
  "status": "new" | "awaiting_action" | "awaiting_reply" | "quietly_logged"
}

Rules:
- shouldProcess: false ONLY for pure newsletters, marketing, promotions with zero financial or personal relevance
- shouldProcess: true for everything else including bills, invoices, appointments, requests, personal correspondence, receipts, RSVPs, alerts

IMPORTANCE SCORING — be precise:
- 0.95: Overdue payment, urgent deadline today or tomorrow, legal/medical action required
- 0.85-0.90: Payment due within 7 days, important event RSVP needed, time-sensitive request
- 0.70-0.80: Action needed but not urgent, quote to review, appointment to confirm
- 0.72-0.78: Upcoming confirmed event or activity within 7 days — even if no action required. Proximity alone justifies High priority. A school trip in 2 days, a match tomorrow, a medical appointment this week — score 0.72 minimum so it surfaces as High. The closer the event, the higher within this range (today/tomorrow = 0.78, later this week = 0.72).
- 0.55-0.65: FYI items needing light review, routine correspondence, upcoming events more than 7 days away
- 0.25-0.35: Receipts (payment already made), informational only
- 0.10-0.20: Automated notifications, resolved matters, no action needed

STATUS RULES:
- "quietly_logged": Matter is fully resolved OR informational only with zero action needed
- "awaiting_reply": ONLY if the most recent outbound message contains a direct question to the other party AND the account owner's sole next step is to wait for their response. The account owner has nothing left to do until the other party replies.
- "awaiting_action": The account owner needs to do something — including cases where they have committed to following up after completing a task first (e.g. "I'll check and get back to you", "I'll confirm X", "let me look into that"). If the account owner still has a task to complete before they can reply, this is awaiting_action NOT awaiting_reply — even if an outbound message was the last one sent.
- CRITICAL DISTINCTION — "I asked them a question, now I wait for their answer" = awaiting_reply. "I said I'd do something, I still need to do it" = awaiting_action. When in doubt prefer awaiting_action — surfacing an item is always better than parking it passively.
- "new": Informational, no clear action required

RECEIPT vs INVOICE — critical distinction:
- RECEIPT (payment already made): status="new", aiImportanceScore=0.15-0.25, aiTitle MUST start with "Receipt:" e.g. "Receipt: Paxton singing £117.50", aiSummary MUST say "Receipt for £X paid to Y — no action needed", paymentSignal detectedDate = date paid (past). NEVER "awaiting_action" for completed payment.
- AUTO-PAY BILL (payment will be taken automatically — direct debit, standing order, automatic card charge, or any payment service that requires no user action): status="new", aiImportanceScore=0.15-0.25, aiTitle MUST start with "Bill:" e.g. "Bill: EDF Energy £87.40 — direct debit", aiSummary MUST say "£X will be automatically collected on [date] — no action needed". Treat identically to a receipt in terms of priority and status. NEVER "awaiting_action".
- Auto-pay clues: "direct debit", "standing order", "will be collected from your account", "will be charged to your card", "will be debited", "automatic payment", "auto-pay", "payment will be taken automatically", "no action is required", "nothing further is required from you", "will be paid automatically", any wording that makes clear no user intervention is needed for payment.
- INVOICE/BILL (payment still due, user must act): status="awaiting_action", aiImportanceScore=0.70-0.95, paymentSignal detectedDate = due date (future)
- Receipt clues: "receipt", "thank you for your payment", "payment received", "you paid", "paid to", "has been paid", "final invoice paid", past tense payment, confirmation number
- Invoice clues: "invoice", "bill", "amount due", "payment due", "please pay", future tense, bank details or payment link provided (implying user needs to pay manually)

CONDITIONAL/OPTIONAL PAYMENTS — important distinction:
- If payment is only due IF the user decides to participate/sign up/attend (e.g. "if you'd like to book", "if you wish to attend", "optional extra", "should you choose to"), treat as status="new", aiImportanceScore=0.50-0.65. Do NOT use "awaiting_action" — no action is required unless they choose to proceed.
- The payment signal should still be created so the amount is visible, but the description must make clear it's conditional: e.g. "Sports camp fee if attending — £37/day"
- Conditional payment clues: "if you wish", "if you would like", "should you decide", "optional", "only if", "to register", "to book", prices listed as information rather than demands

PAYMENT AMOUNTS — when multiple amounts appear:
- Capture the PRIMARY cost as the main payment signal (the largest or most essential amount)
- Optional add-ons or secondary charges should be separate payment signals with descriptions making clear they are optional
- Example: main camp £37/day = primary signal; early drop-off £10/day = secondary signal described as "Optional early drop-off add-on — £10/day"
- NEVER let an optional add-on amount overshadow or replace the primary cost

RESOLVED THREADS: If fully closed with zero further action (e.g. "now resolved", "has been fixed", "all sorted", "issue closed", "no further action") — set status="quietly_logged", aiImportanceScore=0.10. When in doubt, lean toward quietly_logged.

TRANSIENT SAME-DAY ITEMS: Calendar reminders, delivery dispatch/out-for-delivery notifications, event day-of reminders, shipping alerts, and any purely informational notification about something happening today with no action required — set status="quietly_logged", aiImportanceScore=0.10-0.15. These are heads-up notifications, not actionable items. Exception: if the delivery has failed or requires a response (e.g. rebook, collect from depot), treat as awaiting_action.

RSVP HANDLING: If user has already RSVPd (confirmed attendance/acceptance), do NOT set status="awaiting_reply". RSVP is terminal. Only awaiting_reply if user sent an open question needing a response.

- aiTitle: 4-7 words, more useful than raw subject. Use real names from the thread (e.g. "Paxton orthodontist appointment June 26th"), never "user" or "the user".
- aiSummary: one sentence, current state, max 120 chars. Use real names, not "the user" or "you".
- aiDetailedSummary: 2-5 bullet points "• " prefix, structured as follows — only include bullets with genuine substance, no padding or repetition of aiSummary:
  • PURPOSE: What is this thread actually about and why does it matter? Include key context (e.g. the underlying goal, relationship, or project). Use real names.
  • EVOLUTION (only if meaningful): How did the thread develop — what was asked/proposed and what changed or was agreed along the way? Skip if single-message thread.
  • CURRENT STATE: The final agreed outcome with all concrete details — dates, times, locations, amounts, names, reference numbers. Be specific.
  • NEXT STEP: Who specifically needs to do what next, and by when? Identify the person by name — is it the account owner (${from.split('<')[0].trim() || 'the account owner'}) or the other party? Judge by the direction of the most recent message. If the most recent outbound message asks a direct question and the account owner has nothing left to do, the next step is waiting for the other party's reply. If the account owner's last message was a commitment to follow up (e.g. 'I'll check', 'I'll confirm'), the next step is on the account owner — name what they need to do. If nothing is needed, omit this bullet entirely.
- NAMES: Never use "the user", "you", or "the account owner" in summaries or next steps. Use real first names from the thread.
- SIGNALS — strict quality rules:
  • event: For confirmed, agreed, upcoming appointments or events — including informational school/activity notices where a date and time are given, even if no parental action is required. The timing information is valuable regardless of whether action is needed. Create event signals for: school trips, matches, sports days, concerts, activities, medical appointments — any confirmed event with a known date. Do NOT create event signals for: rejected/declined options, past events, purely hypothetical future dates, or vague "sometime next week" references.
  • awaiting: ONLY when there is a genuinely open question in the most recent outbound message that has not yet been answered. If the appointment/matter is already confirmed, do NOT create an awaiting signal for it.
  • deadline: Only for hard deadlines with real consequences if missed.
  • payment: Only for actual money due or paid.
  • rsvp: Only for genuine RSVP requests that haven't yet been responded to.
- Payment amounts: exact pence. £45.99 = 4599. Never null if amount visible.
- Consider full thread — a reply may have resolved original action
- CLIPPED MESSAGES: Gmail clips long messages. If an outbound reply exists but body is empty or very short, assume the user sent a normal reply (likely confirming/accepting). Do NOT classify as awaiting_reply just because the body is empty or clipped.
- If no category match, use closest one`

  try {
    const { text, inputTokens, outputTokens } = await aiComplete(db, prompt, 1024)

    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return null

    let parsed
    try {
      parsed = JSON.parse(json)
    } catch {
      // Truncated JSON — attempt recovery from partial fields
      console.warn('[scanUtils] Truncated JSON from AI — attempting recovery')
      const titleMatch   = json.match(/"aiTitle"\s*:\s*"([^"]*)"/)
      const summaryMatch = json.match(/"aiSummary"\s*:\s*"([^"]*)"/)
      const catIdMatch   = json.match(/"categoryId"\s*:\s*"([^"]*)"/)
      const catNameMatch = json.match(/"categoryName"\s*:\s*"([^"]*)"/)
      const scoreMatch   = json.match(/"aiImportanceScore"\s*:\s*([\d.]+)/)
      if (!titleMatch) return null
      parsed = {
        shouldProcess:     true,
        categoryId:        catIdMatch?.[1]   ?? 'cat_other',
        categoryName:      catNameMatch?.[1] ?? 'Other',
        aiTitle:           titleMatch?.[1]   ?? '',
        aiSummary:         summaryMatch?.[1] ?? '',
        aiDetailedSummary: '',
        aiImportanceScore: scoreMatch ? parseFloat(scoreMatch[1]) : 0.5,
        signals:           [],
        isRecurring:       false,
        status:            'new',
      }
    }

    return {
      ...parsed,
      _usage: { inputTokens, outputTokens },
    }
  } catch (e) {
    console.error('[scanUtils] AI classification error:', e)
    return null
  }
}

// ── Email body decoding ────────────────────────────────────────────────────

/**
 * Extract structured data (dates, times, locations) from HTML before stripping tags.
 *
 * Rich invitation emails (Paperless Post, Eventbrite, etc.) embed date/time/location
 * in HTML tables and structured blocks. Plain tag-stripping loses this data entirely.
 * This function extracts it first and returns a concise structured summary to prepend
 * to the decoded body so the AI always sees it.
 */
export function extractStructuredFromHtml(html: string): string {
  const found: string[] = []

  // 1. <time> elements with datetime attribute
  for (const m of html.matchAll(/<time[^>]*datetime="([^"]*)"[^>]*>([^<]*)<\/time>/gi)) {
    const attr = m[1]?.trim()
    const text = m[2]?.trim()
    if (text) found.push(`Date/Time: ${text}${attr ? ` (${attr})` : ''}`)
    else if (attr) found.push(`Date/Time: ${attr}`)
  }

  // Strip tags for pattern matching on the remaining text
  const plain = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')

  // 2. Date patterns — "Sat. Jun. 20", "Saturday, June 20", "20 June 2026"
  const datePatterns = [
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}(?:,?\s+\d{4})?/gi,
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?/gi,
    /\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/gi,
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/gi,
  ]
  const seenDates = new Set<string>()
  for (const pattern of datePatterns) {
    for (const m of plain.matchAll(pattern)) {
      const d = m[0].trim()
      if (!seenDates.has(d.toLowerCase())) {
        seenDates.add(d.toLowerCase())
        found.push(`Date: ${d}`)
      }
    }
  }

  // 3. Time patterns — "3:00pm - 11:00pm BST", "15:00–23:00"
  const timePattern = /\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?\s*(?:[–\-]\s*\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)?\s*(?:BST|GMT|UTC|EST|PST|CET|IST)?/g
  const times = [...plain.matchAll(timePattern)]
    .map(m => m[0].trim())
    .filter(t => t.length > 4)
    .slice(0, 3)
  for (const t of times) found.push(`Time: ${t}`)

  // 4. UK postcode — reliably identifies a location block
  for (const m of plain.matchAll(/[A-Z]{1,2}\d{1,2}[A-Z]?\s+\d[A-Z]{2}/g)) {
    found.push(`Postcode: ${m[0]}`)
    break // one is enough
  }

  // 5. Location hints — "at [Venue Name]", "Venue: ...", "Location: ..."
  for (const m of plain.matchAll(/(?:at|venue|location|address)\s*:?\s*([A-Z][^,.!?\n]{5,60})/gi)) {
    const loc = m[1].trim()
    if (loc.split(' ').length >= 2) { found.push(`Location: ${loc}`); break }
  }

  if (found.length === 0) return ''
  return `[STRUCTURED DATA EXTRACTED FROM EMAIL]\n${found.join('\n')}\n\n`
}

/**
 * Decode a Gmail message payload to plain text.
 * Tries text/plain first, falls back to HTML with structured data extraction.
 * Handles nested multipart messages.
 */
export function decodeBody(message: any, maxLen = 2000): string {
  const parts = message.payload?.parts ?? [message.payload]

  // Recursive helper to find a part by mimeType
  function findPart(parts: any[], mimeType: string): any {
    for (const part of parts) {
      if (!part) continue
      if (part.mimeType === mimeType && part.body?.data) return part
      if (part.parts) {
        const found = findPart(part.parts, mimeType)
        if (found) return found
      }
    }
    return null
  }

  // Always try to extract structured data from HTML first —
  // rich invitation emails (Paperless Post, Eventbrite etc.) encode dates/times/
  // locations in HTML blocks that get lost in plain text or tag-stripping.
  // We prepend this to whatever body we find so the AI always sees it.
  let structured = ''
  const htmlPart = findPart(parts, 'text/html')
  if (htmlPart) {
    const html = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8')
    structured = extractStructuredFromHtml(html)
  }

  // Prefer plain text for the body — most reliable for AI parsing
  const plainPart = findPart(parts, 'text/plain')
  if (plainPart) {
    const text = Buffer.from(plainPart.body.data, 'base64').toString('utf-8')
    if (text.trim().length > 20) {
      const structuredLen = structured.length
      const bodyLen = Math.max(200, maxLen - structuredLen)
      return structured + text.slice(0, bodyLen)
    }
  }

  // Fall back to HTML — strip tags but keep structured data prepended
  if (htmlPart) {
    const html = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8')
    const stripped = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    const structuredLen = structured.length
    const bodyLen = Math.max(200, maxLen - structuredLen)
    const combined = structured + stripped.slice(0, bodyLen)
    if (combined.trim().length > 20) return combined
  }

  return ''
}

/**
 * Build a full thread context string for the AI prompt.
 * Most recent 3 messages get full content, older messages get brief excerpts.
 */
export function buildThreadContext(thread: any, maxLen = 800): string {
  const messages = thread?.messages ?? []
  if (messages.length === 0) return ''

  const result: string[] = []
  messages.forEach((msg: any, i: number) => {
    const headers  = msg.payload?.headers ?? []
    const from     = headers.find((h: any) => h.name.toLowerCase() === 'from')?.value ?? ''
    const date     = headers.find((h: any) => h.name.toLowerCase() === 'date')?.value ?? ''
    const isRecent = i >= messages.length - 3
    const body     = decodeBody(msg, isRecent ? maxLen : 200)
    const label    = isRecent ? `[${date}] From: ${from}` : `[${date}] From: ${from} (earlier message)`
    result.push(`${label}\n${body}`)
  })

  return result.join('\n\n---\n\n')
}

/**
 * Run an async function over an array in parallel batches.
 * Keeps concurrent AI/API calls bounded to avoid rate limit errors.
 */
export async function runInBatches<T, R>(
  items:     T[],
  batchSize: number,
  fn:        (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    results.push(...await Promise.all(batch.map(fn)))
  }
  return results
}
