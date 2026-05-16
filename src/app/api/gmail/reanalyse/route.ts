/**
 * POST /api/gmail/reanalyse
 *
 * Re-evaluates a single item by fetching the full Gmail thread and running it
 * through the SAME classifyThread() pipeline as the scan route.
 *
 * Previously this had its own inline prompt — now it delegates entirely to
 * scanUtils.ts so all prompt improvements, scoring rules, and code-level
 * overrides (ownerHasReplied, proximity scoring) apply automatically.
 *
 * Body: { uid: string, itemId: string }
 */

import { NextRequest, NextResponse }  from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp }     from 'firebase-admin/firestore'
import { classifyThread, buildThreadContext } from '@/lib/scanUtils'
import { runCalendarCheck }            from '@/lib/server/calendarCheck'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Firebase Admin ────────────────────────────────────────────────────────────

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

// ── Token helper (identical to scan/route.ts) ─────────────────────────────────

async function getValidAccessToken(
  db:  ReturnType<typeof getAdminDb>,
  uid: string,
): Promise<string> {
  const accountRef  = db.doc(`users/${uid}/accounts/account_primary`)
  const accountSnap = await accountRef.get()
  if (!accountSnap.exists) throw new Error('Account not found')

  const data         = accountSnap.data()!
  const accessToken  = data.accessToken  as string | undefined
  const refreshToken = data.refreshToken as string | undefined
  const expiresAt    = data.tokenExpiresAt?.toMillis?.() as number | undefined

  if (accessToken && expiresAt && expiresAt - Date.now() > 5 * 60 * 1000) {
    return accessToken
  }

  if (!refreshToken) throw new Error('No refresh token — please sign out and sign back in')

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
    console.error('[reanalyse] Token refresh failed:', err)
    throw new Error(`Token refresh failed — please sign out and sign back in (${tokenRes.status})`)
  }

  const tokenData = await tokenRes.json()
  const newToken  = tokenData.access_token as string
  const expiresIn = tokenData.expires_in   as number

  await accountRef.update({
    accessToken:    newToken,
    tokenUpdatedAt: Timestamp.now(),
    tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
  })

  return newToken
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchThread(accessToken: string, threadId: string) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return { data: null, status: res.status }
  return { data: await res.json(), status: res.status }
}

function extractHeader(
  headers: { name: string; value: string }[],
  name:    string,
): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { uid, itemId } = await req.json()
    if (!uid || !itemId) {
      return NextResponse.json({ error: 'Missing uid or itemId' }, { status: 400 })
    }

    const db = getAdminDb()

    // ── Auth ────────────────────────────────────────────────────────────────
    let accessToken: string
    try {
      accessToken = await getValidAccessToken(db, uid)
    } catch (e: any) {
      return NextResponse.json(
        { error: e.message ?? 'Auth expired — please sign out and sign back in', authError: true },
        { status: 401 },
      )
    }

    // ── Load existing item ──────────────────────────────────────────────────
    const itemSnap = await db.doc(`users/${uid}/items/${itemId}`).get()
    if (!itemSnap.exists) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }
    const item = itemSnap.data()!

    // ── Fetch Gmail thread ──────────────────────────────────────────────────
    const { data: thread, status: threadStatus } = await fetchThread(accessToken, item.threadId)
    if (!thread) {
      if (threadStatus === 404) {
        return NextResponse.json({ skipped: true, reason: 'Thread not found in Gmail' })
      }
      return NextResponse.json({ error: `Gmail returned ${threadStatus}` }, { status: 502 })
    }

    const msgs    = thread.messages ?? []
    const latest  = msgs[msgs.length - 1]
    const headers = (latest?.payload?.headers ?? []) as { name: string; value: string }[]

    const subject      = extractHeader(headers, 'subject') || item.subject
    const from         = extractHeader(headers, 'from')
    const rfcMessageId = extractHeader(headers, 'message-id').replace(/^<|>$/g, '') || null
    const threadBody   = buildThreadContext(thread)

    // ── Load account context ────────────────────────────────────────────────
    const accountSnap  = await db.doc(`users/${uid}/accounts/account_primary`).get()
    const accountData  = accountSnap.data() ?? {}
    const accountEmail = (accountData.email as string ?? '').toLowerCase()
    const locale       = accountData.locale as string ?? 'en-GB'
    const isUK         = locale.startsWith('en-GB') || locale.startsWith('en-AU') || locale.startsWith('en-NZ')

    // ── ownerHasReplied — computed from message headers ─────────────────────
    const ownerHasReplied = msgs.some((msg: any) => {
      const msgFrom = ((msg.payload?.headers ?? []) as any[])
        .find((h: any) => h.name.toLowerCase() === 'from')?.value ?? ''
      return msgFrom.toLowerCase().includes(accountEmail)
    })

    // ── isOutbound ──────────────────────────────────────────────────────────
    const fromMatch   = from.match(/^(.*?)\s*<(.+?)>$/)
    const senderEmail = fromMatch?.[2] ?? from
    const isOutbound  = senderEmail.toLowerCase() === accountEmail

    // ── Load categories + hints ─────────────────────────────────────────────
    const [catsSnap, hintsSnap] = await Promise.all([
      db.collection(`users/${uid}/categories`).where('archived', '==', false).get(),
      db.collection(`users/${uid}/categoryHints`).orderBy('createdAt', 'desc').limit(50).get(),
    ])

    const categories = catsSnap.docs.map(d => ({
      id:          d.id,
      name:        d.data().name        as string,
      description: (d.data().description as string) || '',
    }))

    const hints = hintsSnap.docs.map(d => ({
      categoryId:   d.data().categoryId   as string,
      categoryName: d.data().categoryName as string,
      senderEmail:  d.data().senderEmail  as string,
      senderName:   d.data().senderName   as string,
      subjectClue:  d.data().subjectClue  as string,
    }))

    // ── Classify — identical pipeline to the scan route ─────────────────────
    // classifyThread() in scanUtils.ts contains all prompt rules, scoring bands,
    // ownerHasReplied override, and proximity score override.
    // Improvements to scanUtils.ts now automatically apply here too.
    const classification = await classifyThread(
      db, subject, from, threadBody,
      categories, hints, isUK, isOutbound, ownerHasReplied,
    )

    if (!classification) {
      return NextResponse.json({ error: 'AI classification returned null' }, { status: 500 })
    }

    // ── Preserve manual overrides ───────────────────────────────────────────
    const preserveCategory = !!item.manualCategory
    const preservePriority = !!item.manualPriority

    const now = Timestamp.now()

    // Guard: never silently move an active item to quietly_logged via re-evaluate
    const wasActive      = item.status !== 'quietly_logged'
    const resolvedStatus = (classification.status === 'quietly_logged' && wasActive)
      ? item.status
      : (classification.status ?? item.status)

    const update: Record<string, any> = {
      aiTitle:           classification.aiTitle           ?? item.aiTitle,
      aiSummary:         classification.aiSummary         ?? item.aiSummary,
      aiDetailedSummary: classification.aiDetailedSummary ?? item.aiDetailedSummary,
      status:            resolvedStatus,
      updatedAt:         now,
      isRecurring:       classification.isRecurring ?? item.isRecurring,
      ...(rfcMessageId ? { rfcMessageId } : {}),
    }

    if (!preservePriority) {
      update.aiImportanceScore = classification.aiImportanceScore ?? item.aiImportanceScore
    }

    if (!preserveCategory && classification.categoryId) {
      update.categoryId   = classification.categoryId
      update.categoryName = classification.categoryName
    }

    await db.doc(`users/${uid}/items/${itemId}`).update(update)

    // ── Rewrite signals ─────────────────────────────────────────────────────
    const newSignals = Array.isArray(classification.signals) ? classification.signals : []
    if (newSignals.length > 0) {
      const signalsSnap = await db.collection(`users/${uid}/signals`)
        .where('itemId', '==', itemId).get()
      const batch = db.batch()
      signalsSnap.docs.forEach(d => batch.delete(d.ref))
      for (const sig of newSignals) {
        const sigId  = `sig_${itemId}_${sig.type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const sigRef = db.doc(`users/${uid}/signals/${sigId}`)
        batch.set(sigRef, {
          signalId:            sigId,
          itemId,
          type:                sig.type,
          description:         sig.description         ?? '',
          detectedDate:        sig.detectedDate
            ? Timestamp.fromDate(new Date(sig.detectedDate as string))
            : null,
          detectedAmountPence: sig.detectedAmountPence ?? null,
          currency:            sig.currency            ?? 'GBP',
          importanceFlag:      (classification.aiImportanceScore ?? 0) >= 0.7,
          calendarStatus:      null,
          status:              'active',
          createdAt:           now,
          updatedAt:           now,
        })
      }
      await batch.commit()
    }

    // ── Calendar check — fire-and-forget ────────────────────────────────────
    runCalendarCheck(db, uid, accessToken).catch(e =>
      console.warn('[reanalyse] Cal check non-fatal:', e),
    )

    const inputTokens  = classification._usage?.inputTokens  ?? 0
    const outputTokens = classification._usage?.outputTokens ?? 0

    console.log(
      `[reanalyse] uid=${uid.slice(0, 8)} item=${itemId.slice(0, 12)} ` +
      `score=${classification.aiImportanceScore} status=${resolvedStatus} ` +
      `signals=${newSignals.length} tokens=${inputTokens}+${outputTokens}`,
    )

    return NextResponse.json({
      success:      true,
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000,
    })

  } catch (err) {
    console.error('[reanalyse]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
