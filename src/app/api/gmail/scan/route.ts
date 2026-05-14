import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { aiComplete, calcCost, PROVIDER_MODEL, getActiveProvider } from '@/lib/aiComplete'
import { runCalendarCheck } from '@/lib/server/calendarCheck'
import { classifyThread, runInBatches, decodeBody, buildThreadContext, type ClassificationResult } from '@/lib/scanUtils'

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

// Returns a valid (non-expired) access token for the user.
// If the stored token is within 5 minutes of expiry (or already expired),
// exchanges the refresh token for a new one and writes it back to Firestore.
async function getValidAccessToken(db: FirebaseFirestore.Firestore, uid: string): Promise<string> {
  const accountRef  = db.doc(`users/${uid}/accounts/account_primary`)
  const accountSnap = await accountRef.get()
  if (!accountSnap.exists) throw new Error('Account not found')

  const data          = accountSnap.data()!
  const accessToken   = data.accessToken as string | undefined
  const refreshToken  = data.refreshToken as string | undefined
  const expiresAt     = data.tokenExpiresAt?.toMillis?.() as number | undefined

  // Still valid with >5 min headroom — use as-is
  const hasHeadroom = expiresAt && expiresAt - Date.now() > 5 * 60 * 1000
  if (accessToken && hasHeadroom) {
    return accessToken
  }

  // Token missing or about to expire — refresh
  if (!refreshToken) throw new Error('No refresh token — user must sign in again')

  console.log(`[Keel] Refreshing access token for uid=${uid.slice(0, 8)}…`)
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    console.error('[Keel] Token refresh failed:', err)
    throw new Error('Token refresh failed — please sign in again')
  }

  const tokenData    = await tokenRes.json()
  const newToken     = tokenData.access_token as string
  const expiresIn    = tokenData.expires_in as number // seconds

  await accountRef.update({
    accessToken:    newToken,
    tokenUpdatedAt: Timestamp.now(),
    tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
  })

  console.log(`[Keel] Token refreshed, valid for ${expiresIn}s`)
  return newToken
}

async function fetchGmailMessages(accessToken: string, daysBack = 7, excludedLabels: string[] = ['promotions', 'social']) {
  const messages: { id: string; threadId: string }[] = []
  let pageToken: string | undefined

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    url.searchParams.set('maxResults', '500')
    // Build query — exclude labels the user hasn't opted in to
    const exclusions = excludedLabels.map(l => `-category:${l}`).join(' ')
    url.searchParams.set('q', `{in:inbox in:sent} newer_than:${daysBack}d${exclusions ? ' ' + exclusions : ''}`)
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

    // Get a valid (auto-refreshed if needed) access token
    let accessToken: string
    try {
      accessToken = await getValidAccessToken(db, uid)
    } catch (e: any) {
      console.error('[Keel] Token error:', e.message)
      const isAuthErr = e.message?.includes('sign in') || e.message?.includes('refresh')
      return NextResponse.json(
        { error: e.message },
        { status: isAuthErr ? 401 : 500 },
      )
    }
    console.log(`[Keel] Using token: ${accessToken.slice(0, 10)}…`)

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
    const accountEmail        = (accountDoc.data()?.email as string ?? '').toLowerCase()
    const isUK                = locale.startsWith('en-GB') || locale.startsWith('en-AU') || locale.startsWith('en-NZ')
    const lastScanCompletedAt = accountDoc.data()?.lastScanCompletedAt ?? null
    // Labels excluded from scanning — defaults to promotions + social if not set
    const excludedLabels: string[] = accountDoc.data()?.excludedLabels ?? ['promotions', 'social']

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
          .select('threadId', 'status', 'updatedAt', 'manualPriority', 'messageId', 'categoryId', 'aiTitle', 'manualCategory')
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

    const processedThreadIds = new Set(existingSnap.docs.map(d => d.data().threadId as string).filter(Boolean))
    const existingItemIds    = new Set(existingSnap.docs.map(d => d.id))  // fallback: match by computed itemId
    const threadToItemId     = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.id]))
    const threadToStatus     = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.data().status as string]))
    const threadToUpdatedAt  = new Map(existingSnap.docs.map(d => {
      // Prefer lastMessageInternalDate (Gmail ms) over updatedAt (Keel write time)
      // to avoid falsely skipping threads where a reply arrived just after our last write
      const gmailTs = d.data().lastMessageInternalDate
      const keelTs  = d.data().updatedAt
      const ms      = gmailTs ?? (keelTs?.toMillis ? keelTs.toMillis() : 0)
      return [d.data().threadId as string, ms]
    }))
    const threadManualPrio     = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.data().manualPriority as boolean]))
    const threadManualCategory = new Map(existingSnap.docs.map(d => [d.data().threadId as string, d.data().manualCategory as boolean]))

    // Step 1: Fetch messages active within the thread activity window
    // This finds threads with recent activity — not a hard lookback cutoff
    // Items already on the dashboard are never evicted by this window
    let messages = await fetchGmailMessages(accessToken, daysBack, excludedLabels)
    console.log(`Found ${messages.length} messages in ${daysBack}-day activity window`)

    // Adaptive extension: if fewer than 10 messages, widen the window up to 30 days
    if (messages.length < 10 && daysBack < 30) {
      console.log(`Fewer than 10 messages — extending window to 30 days`)
      messages = await fetchGmailMessages(accessToken, 30, excludedLabels)
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

        // isOutbound: true when the user sent the first message in the thread
        const isOutbound     = senderEmail.toLowerCase() === accountEmail
        const classification = await classifyThread(db, subject, from, threadBody, categories, hints, isUK, isOutbound)
        await writeFeed(subject, senderName, classification?.status ?? 'processing')
        return { threadId, messageId, detail, participants, from, subject, dateStr, senderName, senderEmail, isOutbound, classification }
      }
    )

    // Clear feed when done
    try { await feedRef.delete() } catch {}

    // Step 7: Write results to Firestore (batch where possible)
    for (const { threadId, messageId, detail, participants, subject, dateStr, senderName, senderEmail, isOutbound, classification } of classifications) {
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
            isOutbound:   isOutbound ?? false,
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
      const isExisting    = processedThreadIds.has(threadId) || existingItemIds.has(`item_${threadId.slice(0, 16)}`)
      const computedItemId = `item_${threadId.slice(0, 16)}`
      const itemId         = threadToItemId.get(threadId) ?? computedItemId
      const existingStatus = threadToStatus.get(threadId)

      // Never resurrect items the user has explicitly resolved or archived
      const TERMINAL_STATUSES = new Set(['done', 'archived', 'paid'])
      const isTerminal = existingStatus && TERMINAL_STATUSES.has(existingStatus)

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
          // Never overwrite a terminal status (done / archived / paid) — user explicitly resolved this
          ...(!isTerminal ? { status: effectiveStatus } : {}),
          // categoryId is intentionally NOT updated here — never overwrite existing category assignment
          // Repair threadId if missing (fixes future isExisting detection)
          ...(!processedThreadIds.has(threadId) ? { threadId } : {}),
          senderName, senderEmail, subject,
          lastMessageInternalDate: parseInt(detail?.internalDate ?? '0', 10) || null,
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
          isOutbound:        isOutbound ?? false,
          snoozedUntil:      null, linkedOutboundId: null, linkedItemId: null,
          isRecurring:       classification.isRecurring,
          fromTrackedReply:  false, trackedReplyId: null,
          createdAt:         now, updatedAt: now, resolvedAt: null,
          lastMessageInternalDate: parseInt(detail?.internalDate ?? '0', 10) || null,
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

    // Fire-and-forget calendar status check — non-fatal, runs after scan completes
    runCalendarCheck(db, uid, accessToken).catch(e => console.warn('[CalCheck] Non-fatal error:', e))

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
