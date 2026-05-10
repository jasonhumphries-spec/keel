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
  db:         ReturnType<typeof getFirestore>,
  subject:    string,
  from:       string,
  threadBody: string,
  categories: { id: string; name: string; description: string }[],
  hints:      { categoryId: string; categoryName: string; senderEmail: string; senderName: string; subjectClue: string }[],
  isUK:       boolean = true
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

  const prompt = `You are Keel, a personal life admin AI. Classify this email thread and extract actionable signals.
${isUK ? 'Write all text in British English — use UK spellings throughout (e.g. "organise" not "organize", "colour" not "color", "enquire" not "inquire", "cheque" not "check", "licence" not "license").\n' : ''}
IMPORTANT: The thread below may contain older messages for full context, but your classification must reflect the CURRENT STATE of the thread — what is happening now, what action (if any) is still needed today. A thread that started months ago may already be fully resolved. Judge by the most recent messages.

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
- 0.95: Overdue payment, urgent deadline today or tomorrow, legal/medical action needed
- 0.85-0.90: Payment due within 7 days, important event RSVP needed, time-sensitive request
- 0.70-0.80: Action needed but not urgent, quote to review, appointment to confirm
- 0.50-0.65: FYI items needing light review, routine correspondence
- 0.25-0.35: Receipts (payment already made), informational only
- 0.10-0.20: Automated notifications, resolved matters, no action needed

STATUS RULES:
- "quietly_logged": Matter is fully resolved OR informational only with zero action needed
- "awaiting_reply": ONLY if most recent message is outbound AND contains an open question genuinely needing a response. NOT for confirmations, RSVP acceptances, or terminal actions.
- "awaiting_action": Something the user needs to do (pay, approve, respond to a question, attend)
- "new": Informational, no clear action required

RECEIPT vs INVOICE — critical distinction:
- RECEIPT (payment already made): status="new", aiImportanceScore=0.15-0.25, aiTitle MUST start with "Receipt:" e.g. "Receipt: Paxton singing £117.50", aiSummary MUST say "Receipt for £X paid to Y — no action needed", paymentSignal detectedDate = date paid (past). NEVER "awaiting_action" for completed payment.
- AUTO-PAY BILL (payment will be taken automatically — direct debit, standing order, automatic card charge, or any payment service that requires no user action): status="new", aiImportanceScore=0.15-0.25, aiTitle MUST start with "Bill:" e.g. "Bill: EDF Energy £87.40 — direct debit", aiSummary MUST say "£X will be automatically collected on [date] — no action needed". Treat identically to a receipt in terms of priority and status. NEVER "awaiting_action".
- Auto-pay clues: "direct debit", "standing order", "will be collected from your account", "will be charged to your card", "will be debited", "automatic payment", "auto-pay", "payment will be taken automatically", "no action is required", "nothing further is required from you", "will be paid automatically", any wording that makes clear no user intervention is needed for payment.
- INVOICE/BILL (payment still due, user must act): status="awaiting_action", aiImportanceScore=0.70-0.95, paymentSignal detectedDate = due date (future)
- Receipt clues: "receipt", "thank you for your payment", "payment received", "you paid", "paid to", "has been paid", "final invoice paid", past tense payment, confirmation number
- Invoice clues: "invoice", "bill", "amount due", "payment due", "please pay", future tense, bank details or payment link provided (implying user needs to pay manually)

RESOLVED THREADS: If fully closed with zero further action (e.g. "now resolved", "has been fixed", "all sorted", "issue closed", "no further action") — set status="quietly_logged", aiImportanceScore=0.10. When in doubt, lean toward quietly_logged.

TRANSIENT SAME-DAY ITEMS: Calendar reminders, delivery dispatch/out-for-delivery notifications, event day-of reminders, shipping alerts, and any purely informational notification about something happening today with no action required — set status="quietly_logged", aiImportanceScore=0.10-0.15. These are heads-up notifications, not actionable items. Exception: if the delivery has failed or requires a response (e.g. rebook, collect from depot), treat as awaiting_action.

RSVP HANDLING: If user has already RSVPd (confirmed attendance/acceptance), do NOT set status="awaiting_reply". RSVP is terminal. Only awaiting_reply if user sent an open question needing a response.

- aiTitle: 4-7 words, more useful than raw subject. Use real names from the thread (e.g. "Paxton orthodontist appointment June 26th"), never "user" or "the user".
- aiSummary: one sentence, current state, max 120 chars. Use real names, not "the user" or "you".
- aiDetailedSummary: 2-5 bullet points "• " prefix, structured as follows — only include bullets with genuine substance, no padding or repetition of aiSummary:
  • PURPOSE: What is this thread actually about and why does it matter? Include key context (e.g. the underlying goal, relationship, or project). Use real names.
  • EVOLUTION (only if meaningful): How did the thread develop — what was asked/proposed and what changed or was agreed along the way? Skip if single-message thread.
  • CURRENT STATE: The final agreed outcome with all concrete details — dates, times, locations, amounts, names, reference numbers. Be specific.
  • NEXT STEP: Who specifically needs to do what next, and by when? Identify the person by name — is it the account owner (${from.split('<')[0].trim() || 'the account owner'}) or the other party? Judge by the direction of the most recent message. If the most recent outbound message asks a question, the next step is waiting for the other party's reply. If nothing is needed, omit this bullet entirely.
- NAMES: Never use "the user", "you", or "the account owner" in summaries or next steps. Use real first names from the thread.
- SIGNALS — strict quality rules:
  • event: ONLY for confirmed, agreed, upcoming appointments or events. NOT for dates mentioned as obstacles, rejected options, past dates, or tentative proposals that weren't agreed. Do not create an event signal for a date that was declined or used only as context.
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

// ── runInBatches ───────────────────────────────────────────────────────────

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
