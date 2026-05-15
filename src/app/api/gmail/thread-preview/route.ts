import { NextRequest, NextResponse } from 'next/server'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Firebase Admin init ───────────────────────────────────────────────────────

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

// ── Token management (mirrors scan/route.ts) ──────────────────────────────────

async function getValidAccessToken(
  db:  FirebaseFirestore.Firestore,
  uid: string,
): Promise<string> {
  const accountRef  = db.doc(`users/${uid}/accounts/account_primary`)
  const accountSnap = await accountRef.get()
  if (!accountSnap.exists) throw new Error('Account not found')

  const data         = accountSnap.data()!
  const accessToken  = data.accessToken  as string | undefined
  const refreshToken = data.refreshToken as string | undefined
  const expiresAt    = data.tokenExpiresAt?.toMillis?.() as number | undefined

  // Still valid with >5 min headroom
  if (accessToken && expiresAt && expiresAt - Date.now() > 5 * 60 * 1000) {
    return accessToken
  }

  if (!refreshToken) throw new Error('No refresh token — user must sign in again')

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
    console.error('[thread-preview] Token refresh failed:', err)
    throw new Error('Token refresh failed — please sign in again')
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

// ── Email body extraction ─────────────────────────────────────────────────────

function decodeBase64Url(data: string): string {
  return Buffer.from(
    data.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf-8')
}

// Recursively find the first part with a given mimeType that has body data
function findPart(payload: any, mimeType: string): any {
  if (!payload) return null
  if (payload.mimeType === mimeType && payload.body?.data) return payload
  for (const part of (payload.parts ?? [])) {
    const found = findPart(part, mimeType)
    if (found) return found
  }
  return null
}

function extractBody(payload: any): { html: string | null; text: string | null } {
  const htmlPart  = findPart(payload, 'text/html')
  const plainPart = findPart(payload, 'text/plain')
  return {
    html: htmlPart  ? decodeBase64Url(htmlPart.body.data)  : null,
    text: plainPart ? decodeBase64Url(plainPart.body.data) : null,
  }
}

function getHeader(
  headers: { name: string; value: string }[],
  name:    string,
): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// Build a renderable HTML document from the raw email body.
// Injects a base style reset that works on both light and dark backgrounds.
function buildHtmlDoc(rawHtml: string): string {
  const injectedStyle = `<style>
    html,body{margin:0;padding:0;background:#ffffff;color:#1a1a1a;
      font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;
      font-size:14px;line-height:1.55}
    img{max-width:100%;height:auto;display:block}
    a{color:#B8964E}
    table{border-collapse:collapse}
    body>*:first-child{padding:16px}
  </style>`

  if (rawHtml.includes('</head>')) {
    return rawHtml.replace('</head>', `${injectedStyle}</head>`)
  }
  if (rawHtml.includes('<body')) {
    return `<!DOCTYPE html><html><head>${injectedStyle}</head>${rawHtml.slice(rawHtml.indexOf('<body'))}</html>`
  }
  return `<!DOCTYPE html><html><head>${injectedStyle}</head><body style="padding:16px">${rawHtml}</body></html>`
}

function buildPlainDoc(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return `<!DOCTYPE html><html><head><style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;
         font-size:14px;line-height:1.6;color:#1a1a1a;margin:0;padding:16px;background:#fff}
    a{color:#B8964E}
  </style></head><body>${escaped}</body></html>`
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const uid      = req.nextUrl.searchParams.get('uid')
    const threadId = req.nextUrl.searchParams.get('threadId')

    if (!uid || !threadId) {
      return NextResponse.json(
        { error: 'Missing uid or threadId' },
        { status: 400 },
      )
    }

    const db          = getAdminDb()
    const accessToken = await getValidAccessToken(db, uid)

    const gmailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )

    if (!gmailRes.ok) {
      const errText = await gmailRes.text()
      console.error('[thread-preview] Gmail API error:', gmailRes.status, errText)
      return NextResponse.json(
        { error: `Gmail API returned ${gmailRes.status}` },
        { status: gmailRes.status },
      )
    }

    const thread   = await gmailRes.json()
    const messages = (thread.messages ?? []) as any[]

    if (messages.length === 0) {
      return NextResponse.json({ error: 'Thread has no messages' }, { status: 404 })
    }

    // Show the most recent message in the thread
    const latestMsg = messages[messages.length - 1]
    const headers   = (latestMsg.payload?.headers ?? []) as { name: string; value: string }[]

    const from    = getHeader(headers, 'from')
    const date    = getHeader(headers, 'date')
    const subject = getHeader(headers, 'subject')

    const { html: rawHtml, text } = extractBody(latestMsg.payload)

    let html: string | null = null
    if (rawHtml) {
      html = buildHtmlDoc(rawHtml)
    } else if (text) {
      html = buildPlainDoc(text)
    }

    return NextResponse.json({
      html,
      from,
      date,
      subject,
      messageCount: messages.length,
    })
  } catch (err: any) {
    console.error('[thread-preview] Unhandled error:', err)
    return NextResponse.json(
      { error: err.message ?? 'Internal error' },
      { status: 500 },
    )
  }
}
