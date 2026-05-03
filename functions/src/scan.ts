/**
 * gmailScan Cloud Function
 *
 * Ported from src/app/api/gmail/scan/route.ts
 * Runs in europe-west1 with a 60-minute timeout — no Vercel serverless limit.
 * Called by AuthContext via NEXT_PUBLIC_SCAN_FUNCTION_URL env var in production.
 */

import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp, Firestore } from 'firebase-admin/firestore'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import * as logger from 'firebase-functions/logger'

// ─── Firebase Admin (auto-credentialed in Cloud Functions runtime) ─────────────

if (!getApps().length) initializeApp()
const db: Firestore = getFirestore()

// ─── Inlined aiComplete (can't use @/ path aliases in Functions) ──────────────

type AIProvider = 'claude-haiku' | 'claude-sonnet' | 'gemini-flash' | 'gemini-pro'

const PRICING: Record<string, { input: number; output: number; thinking?: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'gemini-2.5-flash':          { input: 0.15,  output: 0.60,  thinking: 3.50 },
  'gemini-2.5-pro':            { input: 1.25,  output: 10.00, thinking: 3.50 },
}

const PROVIDER_MODEL: Record<AIProvider, string> = {
  'claude-haiku':  'claude-haiku-4-5-20251001',
  'claude-sonnet': 'claude-sonnet-4-6',
  'gemini-flash':  'gemini-2.5-flash',
  'gemini-pro':    'gemini-2.5-pro',
}

function calcCost(model: string, inputTokens: number, outputTokens: number, thinkingTokens = 0): number {
  const p = PRICING[model] ?? PRICING['claude-haiku-4-5-20251001']
  const thinkingRate = (p as any).thinking ?? 0
  return (inputTokens / 1_000_000) * p.input
       + (outputTokens / 1_000_000) * p.output
       + (thinkingTokens / 1_000_000) * thinkingRate
}

let _cachedProvider: AIProvider = 'claude-haiku'
let _cacheExpiresAt = 0

async function getActiveProvider(): Promise<AIProvider> {
  if (Date.now() < _cacheExpiresAt) return _cachedProvider
  try {
    const doc = await db.collection('config').doc('aiProvider').get()
    if (doc.exists) {
      const raw = doc.data()!.provider as string
      const MAP: Record<string, AIProvider> = {
        'claude-haiku':  'claude-haiku',
        'claude-sonnet': 'claude-sonnet',
        'gemini-flash':  'gemini-flash',
        'gemini-pro':    'gemini-pro',
      }
      _cachedProvider = MAP[raw] ?? 'claude-haiku'
    }
  } catch (e) {
    logger.warn('Failed to read provider config:', e)
  }
  _cacheExpiresAt = Date.now() + 60_000
  return _cachedProvider
}

let _anthropic: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
    _anthropic = new Anthropic({ apiKey })
  }
  return _anthropic
}

let _gemini: GoogleGenerativeAI | null = null
function getGemini(): GoogleGenerativeAI {
  if (!_gemini) {
    const apiKey = process.env.GOOGLE_AI_API_KEY
    if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set')
    _gemini = new GoogleGenerativeAI(apiKey)
  }
  return _gemini
}

interface AIResult {
  text: string; inputTokens: number; outputTokens: number
  thinkingTokens: number; model: string; costUsd: number
}

async function completeWithClaude(model: string, prompt: string, maxTokens: number): Promise<AIResult> {
  const res = await getAnthropic().messages.create({
    model, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content: prompt }],
  })
  const text         = res.content[0].type === 'text' ? res.content[0].text : ''
  const inputTokens  = res.usage.input_tokens
  const outputTokens = res.usage.output_tokens
  return { text, inputTokens, outputTokens, thinkingTokens: 0, model, costUsd: calcCost(model, inputTokens, outputTokens) }
}

async function completeWithGemini(model: string, prompt: string): Promise<AIResult> {
  const genModel = getGemini().getGenerativeModel({
    model,
    generationConfig: { thinkingConfig: { thinkingBudget: 0 }, temperature: 0 } as any,
  })
  const result         = await genModel.generateContent(prompt)
  const text           = result.response.text()
  const meta           = (result.response as any).usageMetadata ?? {}
  const inputTokens    = meta.promptTokenCount     ?? 0
  const outputTokens   = meta.candidatesTokenCount ?? 0
  const thinkingTokens = meta.thoughtsTokenCount   ?? 0
  return { text, inputTokens, outputTokens, thinkingTokens, model, costUsd: calcCost(model, inputTokens, outputTokens, thinkingTokens) }
}

async function aiComplete(prompt: string, maxTokens = 1024): Promise<AIResult> {
  const provider = await getActiveProvider()
  const model    = PROVIDER_MODEL[provider]
  if (provider === 'gemini-flash' || provider === 'gemini-pro') {
    return completeWithGemini(model, prompt)
  }
  return completeWithClaude(model, prompt, maxTokens)
}

// ─── Gmail helpers ─────────────────────────────────────────────────────────────

async function fetchGmailMessages(accessToken: string, daysBack = 7) {
  const messages: { id: string; threadId: string }[] = []
  let pageToken: string | undefined
  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    url.searchParams.set('maxResults', '500')
    url.searchParams.set('q', `in:inbox newer_than:${daysBack}d -category:promotions -category:social`)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
    if (res.status === 401) throw Object.assign(new Error("Gmail token expired"), { code: "GMAIL_401" })
    if (!res.ok) throw new Error(`Gmail list failed: ${res.status}`)
    const data = await res.json()
    messages.push(...(data.messages ?? []))
    pageToken = data.nextPageToken
  } while (pageToken && messages.length < 2000)
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
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBody(message: any): string {
  const parts = message.payload?.parts ?? [message.payload]
  for (const part of parts) {
    if (part?.mimeType === 'text/plain' && part?.body?.data) {
      const text = Buffer.from(part.body.data, 'base64').toString('utf-8').slice(0, 2000)
      if (text.trim().length > 20) return text
    }
  }
  for (const part of parts) {
    if (part?.mimeType === 'text/html' && part?.body?.data) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf-8')
      const text = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
      if (text.length > 20) return text
    }
  }
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
  const result: string[] = []
  messages.forEach((msg: any, i: number) => {
    const headers  = msg.payload?.headers ?? []
    const from     = extractHeader(headers, 'from')
    const date     = extractHeader(headers, 'date')
    const isRecent = i >= messages.length - 3
    const maxLen   = isRecent ? 800 : 200
    const body     = decodeBody(msg).slice(0, maxLen)
    const label    = isRecent ? `[${date}] From: ${from}` : `[${date}] From: ${from} (earlier message)`
    result.push(`${label}\n${body}`)
  })
  return result.join('\n\n---\n\n')
}

function getThreadParticipants(thread: any): string[] {
  const messages = thread?.messages ?? []
  const seen     = new Set<string>()
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

// ─── Batch helper ──────────────────────────────────────────────────────────────

async function runInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    results.push(...await Promise.all(items.slice(i, i + batchSize).map(fn)))
  }
  return results
}

// ─── AI Classification ─────────────────────────────────────────────────────────

interface ClassificationResult {
  shouldProcess: boolean; categoryId: string; categoryName: string
  aiTitle: string; aiSummary: string; aiDetailedSummary: string
  aiImportanceScore: number; isRecurring: boolean; status: string
  signals: Array<{
    type: string; description: string
    detectedDate?: string | null; detectedAmountPence?: number | null; currency?: string | null
  }>
  _usage?: { inputTokens: number; outputTokens: number }
}

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
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

async function classifyThread(
  subject: string, from: string, threadBody: string,
  categories: { id: string; name: string; description: string }[],
  hints: { categoryId: string; categoryName: string; senderEmail: string; senderName: string; subjectClue: string }[],
  isUK = true
): Promise<ClassificationResult | null> {
  const categoryList = categories.map((c) => {
    const userDesc     = c.description?.trim() ?? ''
    const builtinDesc  = BUILTIN_DESCRIPTIONS[c.id] ?? ''
    const builtinShort = builtinDesc.length > 100 ? builtinDesc.slice(0, 100) + '…' : builtinDesc
    const desc = userDesc && builtinShort ? `${builtinShort} Also: ${userDesc}` : userDesc || builtinShort
    return `- ${c.id}: ${c.name}${desc ? ` — ${desc}` : ''}`
  }).join('\n')

  const hintList = hints.length > 0
    ? '\n\nUSER CORRECTIONS (use these to inform category choice):\n' +
      hints.map((h) => `- Emails from "${h.senderName}" (${h.senderEmail}) about "${h.subjectClue}" → ${h.categoryName}`).join('\n')
    : ''

  const prompt = `You are Keel, a personal life admin AI. Classify this email thread and extract actionable signals.
${isUK ? 'Write all text in British English — use UK spellings throughout.\n' : ''}
IMPORTANT: The thread below may contain older messages for full context, but your classification must reflect the CURRENT STATE of the thread — what is happening now, what action (if any) is still needed today.

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
- "awaiting_reply": ONLY if most recent message is outbound AND contains an open question genuinely needing a response
- "awaiting_action": Something the user needs to do (pay, approve, respond, attend)
- "new": Informational, no clear action required

RECEIPT vs INVOICE — critical distinction:
- RECEIPT (payment already made): status="new", aiImportanceScore=0.15-0.25, aiTitle MUST start with "Receipt:" e.g. "Receipt: Paxton singing £117.50", aiSummary MUST say "Receipt for £X paid to Y — no action needed", paymentSignal detectedDate = date paid (past)
- INVOICE/BILL (payment still due): status="awaiting_action", aiImportanceScore=0.70-0.95, paymentSignal detectedDate = due date (future)

RESOLVED THREADS: status="quietly_logged", aiImportanceScore=0.10

TRANSIENT SAME-DAY ITEMS: Calendar reminders, delivery dispatch notifications, event day-of reminders — status="quietly_logged", aiImportanceScore=0.10-0.15

- aiTitle: 4-7 words, more useful than raw subject
- aiSummary: one sentence, current state, max 120 chars
- aiDetailedSummary: 2-5 bullet points "• " prefix, structured as follows — only include bullets with genuine substance, no padding or repetition of aiSummary:
  • PURPOSE: What is this thread actually about and why does it matter? Include key context (e.g. the underlying goal, relationship, or project).
  • EVOLUTION (only if meaningful): How did the thread develop — what was asked/proposed and what changed or was agreed along the way? Skip if single-message thread.
  • CURRENT STATE: The final agreed outcome with all concrete details — dates, times, locations, amounts, names, reference numbers. Be specific.
  • NEXT STEP: What does the user need to do next, and by when? If nothing is needed, omit this bullet.
- Payment amounts: exact pence. £45.99 = 4599.
- Consider full thread — a reply may have resolved original action`

  try {
    const { text, inputTokens, outputTokens } = await aiComplete(prompt, 1024)
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return null
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch {
      logger.warn('Truncated JSON — attempting recovery')
      const titleMatch   = json.match(/"aiTitle"\s*:\s*"([^"]*)"/)
      const summaryMatch = json.match(/"aiSummary"\s*:\s*"([^"]*)"/)
      const catIdMatch   = json.match(/"categoryId"\s*:\s*"([^"]*)"/)
      const catNameMatch = json.match(/"categoryName"\s*:\s*"([^"]*)"/)
      const scoreMatch   = json.match(/"aiImportanceScore"\s*:\s*([\d.]+)/)
      if (!titleMatch) return null
      parsed = {
        shouldProcess: true, categoryId: catIdMatch?.[1] ?? 'cat_other',
        categoryName: catNameMatch?.[1] ?? 'Other', aiTitle: titleMatch?.[1] ?? '',
        aiSummary: summaryMatch?.[1] ?? '', aiDetailedSummary: '',
        aiImportanceScore: scoreMatch ? parseFloat(scoreMatch[1]) : 0.5,
        signals: [], isRecurring: false, status: 'new',
      }
    }
    return { ...parsed, _usage: { inputTokens, outputTokens } }
  } catch (e) {
    logger.error('AI classification error:', e)
    return null
  }
}

// ─── Payment record helper ─────────────────────────────────────────────────────

async function maybeWritePaymentRecord(
  uid: string, itemId: string, senderName: string, senderEmail: string,
  classification: ClassificationResult, receivedAt: Date, now: ReturnType<typeof Timestamp.now>
) {
  if (!(classification.aiTitle ?? '').startsWith('Receipt:')) return
  const paymentSig  = (classification.signals ?? []).find((s) => s.type === 'payment')
  const amountPence = paymentSig?.detectedAmountPence ?? null
  const currency    = paymentSig?.currency ?? 'GBP'
  const paidAt      = paymentSig?.detectedDate ? new Date(paymentSig.detectedDate) : receivedAt
  const paymentId   = `pay_${itemId}`
  try {
    await db.doc(`users/${uid}/payments/${paymentId}`).set({
      paymentId, itemId, accountId: 'account_primary', payee: senderName, payeeEmail: senderEmail,
      description: classification.aiTitle ?? '', amountPence, currency,
      paidAt: Timestamp.fromDate(paidAt), categoryId: classification.categoryId || 'cat_other',
      categoryName: classification.categoryName || 'Other', source: 'receipt', createdAt: now,
    }, { merge: true })
  } catch (e) {
    logger.error('Payment record write failed:', e)
  }
}

// ─── Main scan handler — exported for use in index.ts ─────────────────────────

export async function handleGmailScan(req: any, res: any) {
  // CORS headers — set for all requests including preflight
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://www.jaison.app',
    'https://jaison.app',
  ]
  const origin = req.headers.origin ?? ''
  if (allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { uid, daysBack = 7, job = 'manual' } = req.body ?? {}
    logger.info(`[Keel] Scan request: uid=${uid?.slice(0, 8)}, daysBack=${daysBack}, job=${job}`)

    if (!uid) { res.status(400).json({ error: 'Missing uid' }); return }

    const scanStartedAt = Date.now()

    // Read OAuth token from Firestore — refresh if expired or expiring within 5 minutes
    const accountSnap = await db.doc(`users/${uid}/accounts/account_primary`).get()
    if (!accountSnap.exists) { res.status(404).json({ error: 'Account not found' }); return }

    const accountData    = accountSnap.data()!
    let   accessToken    = accountData.accessToken as string
    const refreshToken   = accountData.refreshToken as string | undefined
    const tokenExpiresAt = accountData.tokenExpiresAt?.toMillis?.() ?? 0
    const fiveMinutes    = 5 * 60 * 1000
    // Refresh if: expiry unknown (0), already expired, or expiring within 5 min
    const tokenExpired   = tokenExpiresAt === 0 || tokenExpiresAt < Date.now() + fiveMinutes

    if ((!accessToken || tokenExpired) && refreshToken) {
      logger.info(`[Keel] Access token expired or missing — refreshing for uid=${uid.slice(0,8)}`)
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id:     process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            refresh_token: refreshToken,
            grant_type:    'refresh_token',
          }),
        })
        if (!tokenRes.ok) throw new Error(`Token refresh HTTP ${tokenRes.status}`)
        const tokenData    = await tokenRes.json()
        accessToken        = tokenData.access_token as string
        const expiresIn    = tokenData.expires_in as number
        await db.doc(`users/${uid}/accounts/account_primary`).update({
          accessToken,
          tokenUpdatedAt: Timestamp.now(),
          tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
        })
        logger.info(`[Keel] Token refreshed successfully for uid=${uid.slice(0,8)}`)
      } catch (e) {
        logger.error(`[Keel] Token refresh failed:`, e)
        res.status(401).json({ error: 'Token refresh failed — please sign in again' }); return
      }
    }

    if (!accessToken) { res.status(401).json({ error: 'No access token — please sign in again' }); return }

    // Cost tracking
    let fbReads = 0; let fbWrites = 0; let fbDeletes = 0
    const FB_READ_COST = 0.06 / 100_000
    const FB_WRITE_COST = 0.18 / 100_000
    const FB_DELETE_COST = 0.02 / 100_000

    // Load categories, hints, account in parallel
    const [catsSnap, hintsSnap, accountDoc] = await Promise.all([
      db.collection(`users/${uid}/categories`).where('archived', '==', false).get(),
      db.collection(`users/${uid}/categoryHints`).limit(50).get(),
      db.doc(`users/${uid}/accounts/account_primary`).get(),
    ])
    fbReads += catsSnap.size + hintsSnap.size + 1

    const locale              = accountDoc.data()?.locale ?? 'en-GB'
    const isUK                = locale.startsWith('en-GB') || locale.startsWith('en-AU') || locale.startsWith('en-NZ')
    const lastScanCompletedAt = accountDoc.data()?.lastScanCompletedAt ?? null

    // Optimised items fetch
    const existenceQuery = db.collection(`users/${uid}/items`)
      .select('threadId', 'status', 'updatedAt', 'manualPriority', 'messageId')
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
    logger.info(`Items: ${existingSnap.size} total, ${recentSnap?.size ?? 'all'} recently changed`)

    let categories = catsSnap.docs.map((d) => ({
      id: d.id, name: d.data().name as string, description: (d.data().description as string) || '',
    }))

    if (categories.length === 0) {
      logger.info(`No categories for ${uid} — creating defaults`)
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
      categories = defaults.map((d) => ({ id: d.id, name: d.name, description: '' }))
      fbWrites += defaults.length
    }

    const hints = hintsSnap.docs.map((d) => d.data() as {
      categoryId: string; categoryName: string; senderEmail: string; senderName: string; subjectClue: string; aiTitle: string
    })

    const processedThreadIds = new Set(existingSnap.docs.map((d) => d.data().threadId as string))
    const threadToItemId     = new Map(existingSnap.docs.map((d) => [d.data().threadId as string, d.id]))
    const threadToStatus     = new Map(existingSnap.docs.map((d) => [d.data().threadId as string, d.data().status as string]))
    const threadToUpdatedAt  = new Map(existingSnap.docs.map((d) => {
      const ts = d.data().updatedAt
      return [d.data().threadId as string, ts?.toMillis ? ts.toMillis() : 0]
    }))
    const threadManualPrio   = new Map(existingSnap.docs.map((d) => [d.data().threadId as string, d.data().manualPriority as boolean]))

    // Step 1: Fetch messages
    let messages = await fetchGmailMessages(accessToken, daysBack)
    logger.info(`Found ${messages.length} messages in ${daysBack}-day window`)
    if (messages.length < 10 && daysBack < 30) {
      logger.info('Fewer than 10 messages — extending to 30 days')
      messages = await fetchGmailMessages(accessToken, 30)
    }

    // Step 2: Fetch message details
    const allDetails = await runInBatches(messages, 10, async ({ id: messageId }: { id: string }) => {
      const detail = await fetchMessageDetail(accessToken, messageId)
      return { messageId, detail }
    })

    // Step 3: Deduplicate to one per thread
    const threadMap = new Map<string, { messageId: string; detail: any }>()
    for (const { messageId, detail } of allDetails) {
      if (!detail) continue
      const threadId = detail.threadId ?? messageId
      if (!threadMap.has(threadId)) threadMap.set(threadId, { messageId, detail })
    }
    logger.info(`Deduplicated to ${threadMap.size} unique threads`)

    // Step 4: Filter
    const toProcess: { threadId: string; messageId: string; detail: any }[] = []
    let unchangedSkipped = 0
    for (const [threadId, { messageId, detail }] of threadMap) {
      const headers = detail.payload?.headers ?? []
      const subject = extractHeader(headers, 'subject')
      if (subject.includes('[PAXTON-CACHE]')) continue
      if (!subject && !decodeBody(detail)) continue
      const existingStatus = threadToStatus.get(threadId)
      if (existingStatus && ['done', 'paid', 'archived'].includes(existingStatus)) continue
      if (processedThreadIds.has(threadId)) {
        const internalDate  = parseInt(detail.internalDate ?? '0', 10)
        const lastProcessed = threadToUpdatedAt.get(threadId) ?? 0
        // Previously exempted awaiting_reply/awaiting_action threads — removed because
        // re-running AI on identical content causes non-deterministic output (score/status drift).
        if (internalDate > 0 && lastProcessed > 0 && internalDate <= lastProcessed) { unchangedSkipped++; continue }
      }
      toProcess.push({ threadId, messageId, detail })
    }
    logger.info(`${toProcess.length} to process (${unchangedSkipped} skipped)`)

    // Step 5: Fetch full threads
    const withThreads = await runInBatches(toProcess, 5, async ({ threadId, messageId, detail }) => {
      const thread       = await fetchThread(accessToken, threadId)
      const participants = thread ? getThreadParticipants(thread) : []
      const threadBody   = thread ? buildThreadContext(thread) : decodeBody(detail)
      return { threadId, messageId, detail, thread, participants, threadBody }
    })

    // Step 6: Classify
    let processed = 0; let updated = 0; let skipped = 0
    let totalInputTok = 0; let totalOutputTok = 0

    const feedRef = db.doc(`users/${uid}/meta/scanFeed`)
    const feedItems: string[] = []
    let feedCount = 0
    const writeFeed = async (subject: string, senderName: string) => {
      feedItems.unshift(`${senderName} — ${subject.slice(0, 60)}`)
      if (feedItems.length > 30) feedItems.pop()
      feedCount++
      if (feedCount % 5 === 0 || feedCount <= 3) {
        try { await feedRef.set({ items: feedItems, updatedAt: Timestamp.now() }, { merge: true }) } catch { /* ok */ }
      }
    }

    const classifications = await runInBatches(withThreads, 5, async ({ threadId, messageId, detail, participants, threadBody }) => {
      const headers     = detail.payload?.headers ?? []
      const from        = extractHeader(headers, 'from')
      const subject     = extractHeader(headers, 'subject')
      const dateStr     = extractHeader(headers, 'date')
      const senderMatch = from.match(/^(.*?)\s*<(.+?)>$/)
      const senderName  = senderMatch?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? from.split('@')[0]
      const senderEmail = senderMatch?.[2] ?? from
      const classification = await classifyThread(subject, from, threadBody, categories, hints, isUK)
      await writeFeed(subject, senderName)
      return { threadId, messageId, detail, participants, from, subject, dateStr, senderName, senderEmail, classification }
    })

    try { await feedRef.delete() } catch { /* ok */ }

    // Step 7: Write results
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
            receivedAt: Timestamp.fromDate(receivedAt),
            categoryId: classification.categoryId || 'cat_other', categoryName: classification.categoryName || 'Other',
            subcategoryId: null, subcategoryName: null, status: 'quietly_logged',
            importanceFlag: false, aiImportanceScore: classification.aiImportanceScore || 0.1,
            snoozedUntil: null, linkedOutboundId: null, linkedItemId: null,
            isRecurring: classification.isRecurring || false,
            fromTrackedReply: false, trackedReplyId: null,
            createdAt: now, updatedAt: now, resolvedAt: null, participants,
            aiTitle: classification.aiTitle ?? subject,
            aiSummary: classification.aiSummary ?? 'Low priority — no action needed.',
            aiDetailedSummary: classification.aiDetailedSummary ?? '',
          })
          await maybeWritePaymentRecord(uid, itemId, senderName, senderEmail, classification, receivedAt, now)
          fbWrites++
        }
        skipped++
        continue
      }

      const effectiveStatus = classification.status === 'quietly_logged' ? 'quietly_logged' : classification.status
      const receivedAt      = dateStr ? new Date(dateStr) : new Date()
      const now             = Timestamp.now()
      const isExisting      = processedThreadIds.has(threadId)
      const itemId          = threadToItemId.get(threadId) ?? `item_${threadId.slice(0, 16)}`

      if (isExisting) {
        await db.doc(`users/${uid}/items/${itemId}`).update({
          aiTitle: classification.aiTitle ?? subject, aiSummary: classification.aiSummary,
          aiDetailedSummary: classification.aiDetailedSummary ?? '', participants,
          ...(!threadManualPrio.get(threadId) ? { aiImportanceScore: classification.aiImportanceScore } : {}),
          status: effectiveStatus, senderName, senderEmail, subject,
          updatedAt: now, receivedAt: Timestamp.fromDate(receivedAt),
        })
        updated++; fbWrites++
      } else {
        await db.doc(`users/${uid}/items/${itemId}`).set({
          itemId, messageId, threadId, accountId: 'account_primary',
          senderEmail, senderName, subject, receivedAt: Timestamp.fromDate(receivedAt),
          categoryId: classification.categoryId, categoryName: classification.categoryName,
          subcategoryId: null, subcategoryName: null, status: effectiveStatus,
          importanceFlag: false, aiImportanceScore: classification.aiImportanceScore,
          snoozedUntil: null, linkedOutboundId: null, linkedItemId: null,
          isRecurring: classification.isRecurring, fromTrackedReply: false, trackedReplyId: null,
          createdAt: now, updatedAt: now, resolvedAt: null, participants,
          aiTitle: classification.aiTitle ?? subject, aiSummary: classification.aiSummary,
          aiDetailedSummary: classification.aiDetailedSummary ?? '',
        })

        const sigBatch = db.batch()
        for (const sig of classification.signals ?? []) {
          const sigId = `sig_${threadId.slice(0, 12)}_${sig.type}`
          sigBatch.set(db.doc(`users/${uid}/signals/${sigId}`), {
            signalId: sigId, itemId, accountId: 'account_primary', type: sig.type,
            detectedDate: sig.detectedDate ? Timestamp.fromDate(new Date(sig.detectedDate)) : null,
            detectedAmountPence: sig.detectedAmountPence ?? null, currency: sig.currency ?? null,
            description: sig.description, calendarStatus: null, calendarEventId: null, targetCalendarId: null,
            status: 'active', createdAt: now, updatedAt: now,
          }, { merge: true })
        }
        if ((classification.signals ?? []).length > 0) { await sigBatch.commit(); fbWrites += classification.signals!.length }
        await maybeWritePaymentRecord(uid, itemId, senderName, senderEmail, classification, receivedAt, now)
        if ((classification.aiTitle ?? '').startsWith('Receipt:')) fbWrites++
        processed++; fbWrites++
      }
    }

    // Cost tracking
    const activeProvider = await getActiveProvider()
    const activeModel    = PROVIDER_MODEL[activeProvider]
    const aiCostUsd      = calcCost(activeModel, totalInputTok, totalOutputTok)
    const fbCostUsd      = fbReads * FB_READ_COST + fbWrites * FB_WRITE_COST + fbDeletes * FB_DELETE_COST
    const totalCostUsd   = aiCostUsd + fbCostUsd

    try {
      const usageRef  = db.doc(`users/${uid}/meta/usage`)
      const prev      = (await usageRef.get()).data() ?? {}
      await usageRef.set({
        totalInputTokens:  (prev.totalInputTokens  ?? 0) + totalInputTok,
        totalOutputTokens: (prev.totalOutputTokens ?? 0) + totalOutputTok,
        aiCostUsd:         Number(((prev.aiCostUsd     ?? 0) + aiCostUsd).toFixed(6)),
        lastScanAiCostUsd: Number(aiCostUsd.toFixed(6)),
        stage1InputTokens:  (prev.stage1InputTokens  ?? 0) + totalInputTok,
        stage1OutputTokens: (prev.stage1OutputTokens ?? 0) + totalOutputTok,
        stage1CostUsd:      Number(((prev.stage1CostUsd ?? 0) + aiCostUsd).toFixed(6)),
        totalFbReads:       (prev.totalFbReads   ?? 0) + fbReads,
        totalFbWrites:      (prev.totalFbWrites  ?? 0) + fbWrites,
        totalFbDeletes:     (prev.totalFbDeletes ?? 0) + fbDeletes,
        fbCostUsd:         Number(((prev.fbCostUsd     ?? 0) + fbCostUsd).toFixed(6)),
        lastScanFbCostUsd: Number(fbCostUsd.toFixed(6)),
        lastScanFbReads:   fbReads, lastScanFbWrites: fbWrites,
        totalCostUsd:      Number(((prev.totalCostUsd   ?? 0) + totalCostUsd).toFixed(6)),
        lastScanCostUsd:   Number(totalCostUsd.toFixed(6)),
        lastScanAt:        Timestamp.now(), model: activeModel, updatedAt: Timestamp.now(),
      }, { merge: true })
    } catch (e) { logger.error('Usage write failed:', e) }

    try {
      await db.doc(`users/${uid}/accounts/account_primary`).set(
        { lastScanCompletedAt: Timestamp.now() }, { merge: true }
      )
      fbWrites++
    } catch { /* ok */ }

    try {
      const durationMs = Date.now() - scanStartedAt
      const runId      = `run_${Date.now()}`
      await db.doc(`users/${uid}/scanRuns/${runId}`).set({
        scanRunId: runId, scanAt: Timestamp.now(), daysBack,
        threadsFound: threadMap.size, threadsProcessed: processed + updated,
        newItems: processed, updatedItems: updated, skipped,
        inputTokens: totalInputTok, outputTokens: totalOutputTok,
        aiCostUsd: Number(aiCostUsd.toFixed(6)), fbReads, fbWrites,
        fbCostUsd: Number(fbCostUsd.toFixed(6)), totalCostUsd: Number(totalCostUsd.toFixed(6)),
        model: activeModel, provider: activeProvider, job, durationMs,
      })
    } catch { /* ok */ }

    logger.info(`Scan complete — ${processed} new, ${updated} updated, ${skipped} skipped. AI: $${aiCostUsd.toFixed(4)} FB: $${fbCostUsd.toFixed(4)}`)

    res.json({
      message: 'Scan complete', processed, updated, skipped,
      total: threadMap.size, threadsFound: threadMap.size, messagesFound: messages.length,
      usage: { inputTokens: totalInputTok, outputTokens: totalOutputTok, costUsd: Number(totalCostUsd.toFixed(4)) },
    })

  } catch (error: any) {
    if (error?.code === 'GMAIL_401') {
      logger.warn('Gmail token expired — client must re-authenticate')
      res.status(401).json({ error: 'token_expired', message: 'Gmail access token expired — please sign in again' })
    } else {
      logger.error('Gmail scan error:', error)
      res.status(500).json({ error: String(error) })
    }
  }
}
