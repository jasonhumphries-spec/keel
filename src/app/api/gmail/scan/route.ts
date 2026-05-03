import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete, calcCost, PROVIDER_MODEL, getActiveProvider } from '@/lib/aiComplete'

// ---- Firebase Admin init ----
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

// ---- Gmail API helpers ----
async function fetchGmailMessages(accessToken: string, daysBack = 7) {
  const messages: { id: string; threadId: string }[] = []
  let pageToken: string | undefined

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    url.searchParams.set('maxResults', '500')
    url.searchParams.set('q', `in:inbox newer_than:${daysBack}d -category:promotions -category:social`)
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`Gmail list failed: ${res.status}`)
    const data = await res.json()
    messages.push(...(data.messages ?? []))
    pageToken = data.nextPageToken
  } while (pageToken && messages.length < 2000) // cap at 2000 to avoid runaway

  return messages
}

async function fetchMessageDetail(accessToken: string, messageId: string) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) return null
  return res.json()
}

async function fetchThread(accessToken: string, threadId: string) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) return null
  return res.json()
}

function extractHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBody(message: any): string {
  const parts = message.payload?.parts ?? [message.payload]

  // Try plain text first
  for (const part of parts) {
    if (part?.mimeType === 'text/plain' && part?.body?.data) {
      const text = Buffer.from(part.body.data, 'base64').toString('utf-8').slice(0, 2000)
      if (text.trim().length > 20) return text
    }
  }

  // Fall back to HTML stripped of tags
  for (const part of parts) {
    if (part?.mimeType === 'text/html' && part?.body?.data) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf-8')
      const text = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000)
      if (text.length > 20) return text
    }
  }

  // Try nested multipart parts
  for (const part of parts) {
    if (part?.parts) {
      for (const subpart of part.parts) {
        if (subpart?.body?.data) {
          const text = Buffer.from(subpart.body.data, 'base64').toString('utf-8').slice(0, 2000)
          if (text.trim().length > 20) return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        }
      }
    }
  }

  return ''
}

function buildThreadContext(thread: any): string {
  const messages = thread?.messages ?? []
  if (messages.length === 0) return ''

  // Always include all messages — full thread history for context
  // Older messages get shorter excerpts to keep prompt size manageable
  const result: string[] = []

  messages.forEach((msg: any, i: number) => {
    const headers  = msg.payload?.headers ?? []
    const from     = extractHeader(headers, 'from')
    const date     = extractHeader(headers, 'date')
    const isRecent = i >= messages.length - 3 // last 3 messages get full content
    const maxLen   = isRecent ? 800 : 200      // older messages get brief excerpt
    const body     = decodeBody(msg).slice(0, maxLen)
    const label    = isRecent ? `[${date}] From: ${from}` : `[${date}] From: ${from} (earlier message)`
    result.push(`${label}\n${body}`)
  })

  return result.join('\n\n---\n\n')
}

function getThreadParticipants(thread: any): string[] {
  const messages  = thread?.messages ?? []
  const seen      = new Set<string>()
  const names: string[] = []
  for (const msg of messages) {
    const headers = msg.payload?.headers ?? []
    const from    = extractHeader(headers, 'from')
    const match   = from.match(/^(.*?)\s*<(.+?)>$/)
    const name    = match?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? from.split('@')[0]
    const email   = match?.[2] ?? from
    if (email.includes('noreply') || email.includes('no-reply') || email.includes('notifications')) continue
    if (!seen.has(email)) { seen.add(email); names.push(name) }
  }
  return names.slice(0, 4)
}

// ---- AI classification ----

interface ClassificationResult {
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

async function classifyThread(
  db:         ReturnType<typeof getFirestore>,
  subject:    string,
  from:       string,
  threadBody: string,
  categories: { id: string; name: string; description: string }[],
  hints:      { categoryId: string; categoryName: string; senderEmail: string; senderName: string; subjectClue: string }[],
  isUK:       boolean = true
): Promise<ClassificationResult | null> {
  // Built-in default descriptions — used when user hasn't added their own
  const BUILTIN_DESCRIPTIONS: Record<string, string> = {
    cat_finance:  'Bills, invoices, bank statements, payments. Energy, insurance, subscriptions, tax, HMRC, accountants.',
    cat_school:   'Schools, nurseries, universities, tutors. Term dates, fees, events, reports, teacher emails.',
    cat_home:     'Home or property emails. Letting agents, tradespeople, councils, home insurance.',
    cat_hired:    'Hired help — cleaners, gardeners, nannies, tutors, personal service providers.',
    cat_health:   'GP, dentist, physio, hospital. NHS letters, health insurance, test results.',
    cat_travel:   'Travel bookings. Flights, hotels, car hire, travel insurance, rail tickets.',
    cat_work:     'Work emails — clients, suppliers, colleagues, contracts, business invoices.',
    cat_it:       'Tech emails. Domain renewals, hosting, software subscriptions, security alerts.',
    cat_drama:    'Social events, invitations, RSVPs, event tickets, personal social plans.',
    cat_job:      'Job search. Applications, interviews, recruiter outreach, job alerts.',
    cat_other:    'Miscellaneous emails not fitting other categories.',
    cat_clients:  'Client and customer emails — enquiries, project updates, contracts.',
    cat_suppliers:'Supplier and vendor emails — quotes, invoices, delivery, account management.',
    cat_hr:       'HR emails — applications, contracts, payroll, employee queries, recruitment.',
    cat_legal:    'Legal and compliance — contracts, NDAs, regulatory notices, company filings.',
    cat_projects: 'Project emails — status updates, deliverables, timelines.',
    cat_marketing:'Marketing and PR — campaigns, press, agency, brand communications.',
  }

  const categoryList = categories
    .map(c => {
      const userDesc    = c.description?.trim() ?? ''
      const builtinDesc = BUILTIN_DESCRIPTIONS[c.id] ?? ''
      // Truncate builtin to ~100 chars to keep prompt lean — user desc is additive
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
- INVOICE/BILL (payment still due): status="awaiting_action", aiImportanceScore=0.70-0.95, paymentSignal detectedDate = due date (future)
- Receipt clues: "receipt", "thank you for your payment", "payment received", "you paid", "paid to", "has been paid", "final invoice paid", past tense payment, confirmation number
- Invoice clues: "invoice", "bill", "amount due", "payment due", "please pay", future tense

RESOLVED THREADS: If fully closed with zero further action (e.g. "now resolved", "has been fixed", "all sorted", "issue closed", "no further action") — set status="quietly_logged", aiImportanceScore=0.10. When in doubt, lean toward quietly_logged.

TRANSIENT SAME-DAY ITEMS: Calendar reminders, delivery dispatch/out-for-delivery notifications, event day-of reminders, shipping alerts, and any purely informational notification about something happening today with no action required — set status="quietly_logged", aiImportanceScore=0.10-0.15. These are heads-up notifications, not actionable items. Exception: if the delivery has failed or requires a response (e.g. rebook, collect from depot), treat as awaiting_action.

RSVP HANDLING: If user has already RSVPd (confirmed attendance/acceptance), do NOT set status="awaiting_reply". RSVP is terminal. Only awaiting_reply if user sent an open question needing a response.

- aiTitle: 4-7 words, more useful than raw subject
- aiSummary: one sentence, current state, max 120 chars
- aiDetailedSummary: 2-5 bullet points "• " prefix. Only if genuine substance. No padding.
- Payment amounts: exact pence. £45.99 = 4599. Never null if amount visible.
- Consider full thread — a reply may have resolved original action
- CLIPPED MESSAGES: Gmail clips long messages. If an outbound reply exists but body is empty or very short, assume the user sent a normal reply (likely confirming/accepting). Do NOT classify as awaiting_reply just because the body is empty or clipped.
- If no category match, use closest one`

  try {
    const { text, inputTokens, outputTokens } = await aiComplete(db, prompt, 1024)

    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return null

    // Attempt parse — if it fails due to truncation, try to recover
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch (e) {
      // Truncated JSON — try to extract what we can with a minimal valid structure
      console.warn('Truncated JSON from AI — attempting recovery')
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
    console.error('AI classification error:', e)
    return null
  }
}

// ---- Batch helper ----
async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

// ---- Payment record helper ----
async function maybeWritePaymentRecord(
  db:             ReturnType<typeof getFirestore>,
  uid:            string,
  itemId:         string,
  senderName:     string,
  senderEmail:    string,
  classification: ClassificationResult,
  receivedAt:     Date,
  now:            ReturnType<typeof Timestamp.now>
) {
  // Only write if this is a receipt (title starts with "Receipt:" or low importance with payment signal)
  const isReceipt = (classification.aiTitle ?? '').startsWith('Receipt:')
  if (!isReceipt) return

  const paymentSig = (classification.signals ?? []).find(s => s.type === 'payment')
  if (!paymentSig && !isReceipt) return

  const amountPence = paymentSig?.detectedAmountPence ?? null
  const currency    = paymentSig?.currency ?? 'GBP'
  const paidAt      = paymentSig?.detectedDate
    ? new Date(paymentSig.detectedDate)
    : receivedAt

  const paymentId = `pay_${itemId}`

  try {
    await db.doc(`users/${uid}/payments/${paymentId}`).set({
      paymentId,
      itemId,
      accountId:    'account_primary',
      payee:        senderName,
      payeeEmail:   senderEmail,
      description:  classification.aiTitle ?? '',
      amountPence:  amountPence,
      currency,
      paidAt:       Timestamp.fromDate(paidAt),
      categoryId:   classification.categoryId || 'cat_other',
      categoryName: classification.categoryName || 'Other',
      source:       'receipt',
      createdAt:    now,
    }, { merge: true })
    console.log(`💳 Payment record: ${senderName} ${amountPence ? `£${(amountPence/100).toFixed(2)}` : '(no amount)'}`)
  } catch (e) {
    console.error('Payment record write failed:', e)
  }
}

// ---- Main handler ----
export async function POST(req: NextRequest) {
  try {
    const { uid, daysBack = 7, job = 'manual' } = await req.json()
    console.log(`[Keel] Scan request: uid=${uid?.slice(0,8)}, daysBack=${daysBack}`)

    if (!uid) {
      return NextResponse.json({ error: 'Missing uid' }, { status: 400 })
    }

    const db = getAdminDb()

    const scanStartedAt = Date.now()

    // Read access token from Firestore server-side — avoids stale/wrong client tokens
    const accountSnap = await db.doc(`users/${uid}/accounts/account_primary`).get()
    if (!accountSnap.exists) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }
    const accessToken = accountSnap.data()?.accessToken as string
    if (!accessToken) {
      return NextResponse.json({ error: 'No access token — please sign in again' }, { status: 401 })
    }
    console.log(`[Keel] Using stored token: ${accessToken.slice(0,10)}...`)

    // Firestore operation counters for cost tracking
    let fbReads   = 0
    let fbWrites  = 0
    let fbDeletes = 0

    // Firebase Blaze pricing (per operation, no free tier — tracked as unit cost)
    const FB_READ_COST   = 0.06 / 100_000   // $0.06 per 100K reads
    const FB_WRITE_COST  = 0.18 / 100_000   // $0.18 per 100K writes
    const FB_DELETE_COST = 0.02 / 100_000   // $0.02 per 100K deletes

    // Load categories, hints, account, and lastScanCompletedAt in parallel
    const [catsSnap, hintsSnap, accountDoc] = await Promise.all([
      db.collection(`users/${uid}/categories`).where('archived', '==', false).get(),
      db.collection(`users/${uid}/categoryHints`).limit(50).get(),
      db.doc(`users/${uid}/accounts/account_primary`).get(),
    ])
    fbReads += catsSnap.size + hintsSnap.size + 1

    const locale              = accountDoc.data()?.locale ?? 'en-GB'
    const isUK                = locale.startsWith('en-GB') || locale.startsWith('en-AU') || locale.startsWith('en-NZ')
    const lastScanCompletedAt = accountDoc.data()?.lastScanCompletedAt ?? null

    // Optimised items fetch — split into two cheap queries instead of one full collection read:
    //
    // Query A: all items, but ONLY threadId field — builds existence + dedup maps
    //          Firestore still charges 1 read/doc, but this is unavoidable for dedup.
    //          FUTURE OPT: maintain a threadIds[] array on the account doc to eliminate this.
    //
    // Query B: items updated since last scan — full fields needed for update logic
    //          On incremental scans this is typically 5-20 docs, not 500+.
    //
    const existenceQuery = db.collection(`users/${uid}/items`)
      .select('threadId', 'status', 'updatedAt', 'manualPriority', 'messageId')

    // Only fetch recently-changed full items if we have a lastScan timestamp
    const recentQuery = lastScanCompletedAt
      ? db.collection(`users/${uid}/items`)
          .where('updatedAt', '>=', lastScanCompletedAt)
          .select('threadId', 'status', 'updatedAt', 'manualPriority', 'messageId', 'categoryId', 'aiTitle')
      : null

    const [existingSnap, recentSnap] = await Promise.all([
      existenceQuery.get(),
      recentQuery ? recentQuery.get() : Promise.resolve(null),
    ])
    fbReads += existingSnap.size + (recentSnap?.size ?? 0)

    console.log(`Items: ${existingSnap.size} total, ${recentSnap?.size ?? 'all'} recently changed`)


    let categories = catsSnap.docs.map(d => ({
      id:          d.id,
      name:        d.data().name as string,
      description: (d.data().description as string) || '',
    }))

    if (categories.length === 0) {
      console.log(`No categories for ${uid} — creating defaults`)
      const defaults = [
        { id: 'cat_finance', name: 'Finance & Bills',    icon: 'banknote',   order: 1 },
        { id: 'cat_school',  name: 'School & Education', icon: 'graduation', order: 2 },
        { id: 'cat_home',    name: 'Home & Property',    icon: 'home',       order: 3 },
        { id: 'cat_hired',   name: 'Hired Help',         icon: 'users',      order: 4 },
        { id: 'cat_health',  name: 'Health',             icon: 'heart',      order: 5 },
        { id: 'cat_travel',  name: 'Holidays & Travel',  icon: 'plane',      order: 6 },
        { id: 'cat_work',    name: 'Work & Business',    icon: 'tag',        order: 7 },
        { id: 'cat_other',   name: 'Other',              icon: 'tag',        order: 8 },
      ]
      const now   = Timestamp.now()
      const batch = db.batch()
      for (const cat of defaults) {
        batch.set(db.doc(`users/${uid}/categories/${cat.id}`), {
          ...cat, parentId: null, archived: false, archivedAt: null,
          itemCount: 0, description: '', createdAt: now, updatedAt: now,
        })
      }
      await batch.commit()
      categories = defaults.map(d => ({ id: d.id, name: d.name, description: '' }))
      fbWrites += defaults.length
    }

    const hints = hintsSnap.docs.map(d => d.data() as {
      categoryId: string; categoryName: string;
      senderEmail: string; senderName: string; subjectClue: string; aiTitle: string;
    })

    const processedThreadIds = new Set(existingSnap.docs.map(d => d.data().threadId as string))
    const threadToItemId     = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.id]))
    const threadToStatus     = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.data().status as string]))
    const threadToUpdatedAt  = new Map(existingSnap.docs.map(d => {
      const ts = d.data().updatedAt
      return [d.data().threadId as string, ts?.toMillis ? ts.toMillis() : 0]
    }))
    const threadManualPrio   = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.data().manualPriority as boolean]))

    // Step 1: Fetch messages active within the thread activity window
    // This finds threads with recent activity — not a hard lookback cutoff
    // Items already on the dashboard are never evicted by this window
    let messages = await fetchGmailMessages(accessToken, daysBack)
    console.log(`Found ${messages.length} messages in ${daysBack}-day activity window`)

    // Adaptive extension: if fewer than 10 messages, widen the window up to 30 days
    if (messages.length < 10 && daysBack < 30) {
      console.log(`Fewer than 10 messages — extending window to 30 days`)
      messages = await fetchGmailMessages(accessToken, 30)
      console.log(`Extended scan found ${messages.length} messages`)
    }

    // Step 2: Fetch all message details in parallel batches of 10
    const allDetails = await runInBatches(
      messages,
      10,
      async ({ id: messageId }: { id: string }) => {
        const detail = await fetchMessageDetail(accessToken, messageId)
        return { messageId, detail }
      }
    )

    // Step 3: Deduplicate to one per thread
    const threadMap = new Map<string, { messageId: string; detail: any }>()
    for (const { messageId, detail } of allDetails) {
      if (!detail) continue
      const threadId = detail.threadId ?? messageId
      if (!threadMap.has(threadId)) threadMap.set(threadId, { messageId, detail })
    }
    console.log(`Deduplicated to ${threadMap.size} unique threads`)

    // Step 4: Filter threads we can skip cheaply
    const toProcess: { threadId: string; messageId: string; detail: any }[] = []
    let unchangedSkipped = 0
    for (const [threadId, { messageId, detail }] of threadMap) {
      const headers = detail.payload?.headers ?? []
      const subject = extractHeader(headers, 'subject')
      if (subject.includes('[PAXTON-CACHE]')) continue
      if (!subject && !decodeBody(detail)) continue
      const existingStatus = threadToStatus.get(threadId)
      if (existingStatus && ['done', 'paid', 'archived'].includes(existingStatus)) continue
      // Skip if this thread already exists and no new messages since last scan.
      // Exception: never skip threads with open signals — the situation may have resolved
      // (payment made, reply received) without a new email arriving in the scan window.
      if (processedThreadIds.has(threadId)) {
        const internalDate  = parseInt(detail.internalDate ?? '0', 10)
        const lastProcessed = threadToUpdatedAt.get(threadId) ?? 0
        // DEBUG — remove after diagnosis
        console.log(`[SKIP CHECK] ${threadId.slice(0,12)} internalDate=${internalDate} lastProcessed=${lastProcessed} diff=${internalDate - lastProcessed}ms status=${existingStatus ?? 'none'}`)
        // Skip if no new messages since we last processed this thread.
        // We previously exempted awaiting_reply/awaiting_action threads here on the theory
        // that a resolution might arrive without a new email — but re-running the AI on
        // identical content doesn't detect resolution either, and causes non-deterministic
        // output (scores shifting, status flipping) on every scan. If the user has resolved
        // something, they mark it manually; if a new email arrives, internalDate advances
        // past lastProcessed and the thread is picked up naturally.
        if (internalDate > 0 && lastProcessed > 0 && internalDate <= lastProcessed) {
          unchangedSkipped++
          continue
        }
      }
      toProcess.push({ threadId, messageId, detail })
    }
    console.log(`${toProcess.length} threads to process after filtering (${unchangedSkipped} unchanged — skipped)`)

    // Step 5: Fetch full threads in parallel batches of 5
    const withThreads = await runInBatches(
      toProcess,
      5,
      async ({ threadId, messageId, detail }) => {
        const thread       = await fetchThread(accessToken, threadId)
        const participants = thread ? getThreadParticipants(thread) : []
        const threadBody   = thread ? buildThreadContext(thread) : decodeBody(detail)
        return { threadId, messageId, detail, thread, participants, threadBody }
      }
    )

    // Step 6: Classify with Claude in parallel batches of 5
    let processed     = 0
    let updated       = 0
    let skipped       = 0
    let totalInputTok = 0
    let totalOutputTok = 0

    // Live feed for onboarding — write recent subjects to Firestore every 5 threads
    const feedRef    = db.doc(`users/${uid}/meta/scanFeed`)
    const feedItems: string[] = []
    let   feedCount  = 0

    const writeFeed = async (subject: string, senderName: string, status: string) => {
      const entry = `${senderName} — ${subject.slice(0, 60)}`
      feedItems.unshift(entry) // newest first
      if (feedItems.length > 30) feedItems.pop()
      feedCount++
      if (feedCount % 5 === 0 || feedCount <= 3) {
        try {
          await feedRef.set({ items: feedItems, updatedAt: Timestamp.now() }, { merge: true })
        } catch {}
      }
    }

    const classifications = await runInBatches(
      withThreads,
      5,
      async ({ threadId, messageId, detail, participants, threadBody }) => {
        const headers     = detail.payload?.headers ?? []
        const from        = extractHeader(headers, 'from')
        const subject     = extractHeader(headers, 'subject')
        const dateStr     = extractHeader(headers, 'date')
        const senderMatch = from.match(/^(.*?)\s*<(.+?)>$/)
        const senderName  = senderMatch?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? from.split('@')[0]
        const senderEmail = senderMatch?.[2] ?? from

        const classification = await classifyThread(db, subject, from, threadBody, categories, hints, isUK)
        await writeFeed(subject, senderName, classification?.status ?? 'processing')
        return { threadId, messageId, detail, participants, from, subject, dateStr, senderName, senderEmail, classification }
      }
    )

    // Clear feed when done
    try { await feedRef.delete() } catch {}

    // Step 7: Write results to Firestore (batch where possible)
    for (const { threadId, messageId, participants, subject, dateStr, senderName, senderEmail, classification } of classifications) {
      if (!classification) { skipped++; continue }

      if (classification._usage) {
        totalInputTok  += classification._usage.inputTokens  ?? 0
        totalOutputTok += classification._usage.outputTokens ?? 0
      }

      if (!classification.shouldProcess) {
        if (!processedThreadIds.has(threadId)) {
          const itemId     = `item_${threadId.slice(0, 16)}`
          const receivedAt = dateStr ? new Date(dateStr) : new Date()
          const now        = Timestamp.now()
          await db.doc(`users/${uid}/items/${itemId}`).set({
            itemId, messageId, threadId, accountId: 'account_primary',
            senderEmail, senderName, subject,
            receivedAt:        Timestamp.fromDate(receivedAt),
            categoryId:        classification.categoryId || 'cat_other',
            categoryName:      classification.categoryName || 'Other',
            subcategoryId:     null, subcategoryName: null,
            status:            'quietly_logged',
            importanceFlag:    false,
            aiImportanceScore: classification.aiImportanceScore || 0.1,
            snoozedUntil: null, linkedOutboundId: null, linkedItemId: null,
            isRecurring: classification.isRecurring || false,
            fromTrackedReply: false, trackedReplyId: null,
            createdAt: now, updatedAt: now, resolvedAt: null,
            participants,
            aiTitle:           classification.aiTitle ?? subject,
            aiSummary:         classification.aiSummary ?? 'Low priority — no action needed.',
            aiDetailedSummary: classification.aiDetailedSummary ?? '',
          })

          // Write payment record if this is a receipt
          await maybeWritePaymentRecord(db, uid, itemId, senderName, senderEmail, classification, receivedAt, now)

          console.log(`📁 Quietly logged: ${senderName} — ${subject.slice(0, 50)}`)
          fbWrites++
        }
        skipped++
        continue
      }

      // Handle quietly_logged status from Claude even when shouldProcess=true
      const effectiveStatus = classification.status === 'quietly_logged' ? 'quietly_logged' : classification.status

      const receivedAt = dateStr ? new Date(dateStr) : new Date()
      const now        = Timestamp.now()
      const isExisting = processedThreadIds.has(threadId)
      const itemId     = threadToItemId.get(threadId) ?? `item_${threadId.slice(0, 16)}`

      if (isExisting) {
        await db.doc(`users/${uid}/items/${itemId}`).update({
          aiTitle:           classification.aiTitle ?? subject,
          aiSummary:         classification.aiSummary,
          aiDetailedSummary: classification.aiDetailedSummary ?? '',
          participants,
          // Only update importance score if user hasn't manually set it
          ...(!threadManualPrio.get(threadId)
            ? { aiImportanceScore: classification.aiImportanceScore }
            : {}),
          status:            effectiveStatus,
          senderName, senderEmail, subject,
          updatedAt:         now,
          receivedAt:        Timestamp.fromDate(receivedAt),
        })
        updated++
        fbWrites++
        console.log(`↻ Updated: ${senderName} — ${subject.slice(0, 50)}`)
      } else {
        await db.doc(`users/${uid}/items/${itemId}`).set({
          itemId, messageId, threadId, accountId: 'account_primary',
          senderEmail, senderName, subject,
          receivedAt:        Timestamp.fromDate(receivedAt),
          categoryId:        classification.categoryId,
          categoryName:      classification.categoryName,
          subcategoryId:     null, subcategoryName: null,
          status:            effectiveStatus,
          importanceFlag:    false,
          aiImportanceScore: classification.aiImportanceScore,
          snoozedUntil:      null, linkedOutboundId: null, linkedItemId: null,
          isRecurring:       classification.isRecurring,
          fromTrackedReply:  false, trackedReplyId: null,
          createdAt:         now, updatedAt: now, resolvedAt: null,
          participants,
          aiTitle:           classification.aiTitle ?? subject,
          aiSummary:         classification.aiSummary,
          aiDetailedSummary: classification.aiDetailedSummary ?? '',
        })

        // Write signals
        const sigBatch = db.batch()
        for (const sig of classification.signals ?? []) {
          const sigId = `sig_${threadId.slice(0, 12)}_${sig.type}`
          sigBatch.set(db.doc(`users/${uid}/signals/${sigId}`), {
            signalId:            sigId,
            itemId,
            accountId:           'account_primary',
            type:                sig.type,
            detectedDate:        sig.detectedDate ? Timestamp.fromDate(new Date(sig.detectedDate)) : null,
            detectedAmountPence: sig.detectedAmountPence ?? null,
            currency:            sig.currency ?? null,
            description:         sig.description,
            calendarStatus:      null, calendarEventId: null, targetCalendarId: null,
            status:              'active',
            createdAt:           now, updatedAt: now,
          }, { merge: true })
        }
        if ((classification.signals ?? []).length > 0) {
          await sigBatch.commit()
          fbWrites += (classification.signals ?? []).length
        }

        // Write payment record if this is a receipt
        await maybeWritePaymentRecord(db, uid, itemId, senderName, senderEmail, classification, receivedAt, now)
        if ((classification.aiTitle ?? '').startsWith('Receipt:')) fbWrites++ // payment record write

        processed++
        fbWrites++ // new item write
        console.log(`✓ New: ${senderName} — ${subject.slice(0, 50)}`)
      }
    }

    // Track costs — pricing depends on active provider
    const activeProvider = await getActiveProvider(db)
    const activeModel    = PROVIDER_MODEL[activeProvider]
    const aiCostUsd      = calcCost(activeModel, totalInputTok, totalOutputTok)

    const fbReadCostUsd   = fbReads   * FB_READ_COST
    const fbWriteCostUsd  = fbWrites  * FB_WRITE_COST
    const fbDeleteCostUsd = fbDeletes * FB_DELETE_COST
    const fbCostUsd       = fbReadCostUsd + fbWriteCostUsd + fbDeleteCostUsd
    const totalCostUsd    = aiCostUsd + fbCostUsd

    try {
      const usageRef  = db.doc(`users/${uid}/meta/usage`)
      const usageSnap = await usageRef.get()
      const prev      = usageSnap.data() ?? {}
      await usageRef.set({
        // AI tokens
        totalInputTokens:   (prev.totalInputTokens  ?? 0) + totalInputTok,
        totalOutputTokens:  (prev.totalOutputTokens ?? 0) + totalOutputTok,
        aiCostUsd:          Number(((prev.aiCostUsd    ?? 0) + aiCostUsd).toFixed(6)),
        lastScanAiCostUsd:  Number(aiCostUsd.toFixed(6)),
        // Stage 1 AI breakdown
        stage1InputTokens:  (prev.stage1InputTokens  ?? 0) + totalInputTok,
        stage1OutputTokens: (prev.stage1OutputTokens ?? 0) + totalOutputTok,
        stage1CostUsd:      Number(((prev.stage1CostUsd ?? 0) + aiCostUsd).toFixed(6)),
        // Firebase ops
        totalFbReads:       (prev.totalFbReads   ?? 0) + fbReads,
        totalFbWrites:      (prev.totalFbWrites  ?? 0) + fbWrites,
        totalFbDeletes:     (prev.totalFbDeletes ?? 0) + fbDeletes,
        fbCostUsd:          Number(((prev.fbCostUsd ?? 0) + fbCostUsd).toFixed(6)),
        lastScanFbCostUsd:  Number(fbCostUsd.toFixed(6)),
        lastScanFbReads:    fbReads,
        lastScanFbWrites:   fbWrites,
        // Combined total
        totalCostUsd:       Number(((prev.totalCostUsd ?? 0) + totalCostUsd).toFixed(6)),
        lastScanCostUsd:    Number(totalCostUsd.toFixed(6)),
        lastScanAt:         Timestamp.now(),
        model:              activeModel,
        updatedAt:          Timestamp.now(),
      }, { merge: true })
    } catch (e) {
      console.error('Usage write failed:', e)
    }

    // Stamp lastScanCompletedAt on account doc so next scan can do incremental item fetch
    try {
      await db.doc(`users/${uid}/accounts/account_primary`).set(
        { lastScanCompletedAt: Timestamp.now() },
        { merge: true }
      )
      fbWrites++
    } catch (e) { /* non-fatal */ }

    // Write per-scan run record for admin drill-down
    try {
      const durationMs  = Date.now() - scanStartedAt
      const scanRunId   = `run_${Date.now()}`
      await db.doc(`users/${uid}/scanRuns/${scanRunId}`).set({
        scanRunId,
        scanAt:           Timestamp.now(),
        daysBack,
        threadsFound:     threadMap.size,
        threadsProcessed: processed + updated,
        newItems:         processed,
        updatedItems:     updated,
        skipped,
        inputTokens:      totalInputTok,
        outputTokens:     totalOutputTok,
        aiCostUsd:        Number(aiCostUsd.toFixed(6)),
        fbReads,
        fbWrites,
        fbCostUsd:        Number(fbCostUsd.toFixed(6)),
        totalCostUsd:     Number(totalCostUsd.toFixed(6)),
        model:            activeModel,
        provider:         activeProvider,
        job:              job as string,
        durationMs,
      })
    } catch (e) { /* non-fatal */ }

    console.log(`Scan complete — ${processed} new, ${updated} updated, ${skipped} skipped. AI: $${aiCostUsd.toFixed(4)} · FB: ${fbReads}r/${fbWrites}w ($${fbCostUsd.toFixed(4)}) · Total: $${totalCostUsd.toFixed(4)}`)

    return NextResponse.json({
      message: 'Scan complete',
      processed, updated, skipped,
      total:       threadMap.size,
      threadsFound: threadMap.size,
      messagesFound: messages.length,
      usage: {
        inputTokens:  totalInputTok,
        outputTokens: totalOutputTok,
        costUsd:      Number(totalCostUsd.toFixed(4)),
      },
    })

  } catch (error) {
    console.error('Gmail scan error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
