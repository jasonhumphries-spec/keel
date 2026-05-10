import { google } from 'googleapis'
import type { EmailProvider, OAuthTokens, ThreadChange, WatchResult } from './types'

// The Pub/Sub topic Gmail will publish notifications to.
// Must exist in the Firebase project before deploying the Cloud Function.
// See README-background-scan.md for setup instructions.
const PUBSUB_TOPIC_NAME = `projects/${process.env.FIREBASE_PROJECT_ID}/topics/gmail-inbox-notifications`

// Gmail History API returns at most this many records per page.
// 100 is the default max; sufficient for a debounced notification window.
const MAX_HISTORY_RESULTS = 100

function buildGmailClient(tokens: OAuthTokens) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  auth.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  })
  return google.gmail({ version: 'v1', auth })
}

export const gmailProvider: EmailProvider = {
  id: 'gmail',

  async setupWatch(_uid: string, tokens: OAuthTokens): Promise<WatchResult> {
    const gmail = buildGmailClient(tokens)

    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: PUBSUB_TOPIC_NAME,
        // Only watch INBOX — ignore Sent, Drafts, Spam etc.
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      },
    })

    const { expiration, historyId } = res.data
    if (!expiration || !historyId) {
      throw new Error('Gmail watch() returned incomplete response — missing expiration or historyId')
    }

    return {
      expiry: new Date(parseInt(expiration, 10)),
      historyId,
    }
  },

  async stopWatch(_uid: string, tokens: OAuthTokens): Promise<void> {
    const gmail = buildGmailClient(tokens)
    await gmail.users.stop({ userId: 'me' })
  },

  async renewWatch(uid: string, tokens: OAuthTokens): Promise<WatchResult> {
    // Gmail watch renewal is identical to initial setup — just call watch() again.
    // Google will reset the 7-day expiry clock.
    return this.setupWatch(uid, tokens)
  },

  async getChangedThreadIds(
    tokens: OAuthTokens,
    lastCursor: string,
    _newCursor: string
  ): Promise<ThreadChange[]> {
    const gmail = buildGmailClient(tokens)

    try {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: lastCursor,
        // We only care about new messages arriving in INBOX.
        // labelsAdded would also catch items moved into INBOX, but
        // messageAdded is sufficient for the common case.
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        maxResults: MAX_HISTORY_RESULTS,
      })

      const historyItems = res.data.history ?? []
      const seen = new Set<string>()
      const changes: ThreadChange[] = []

      for (const item of historyItems) {
        for (const added of item.messagesAdded ?? []) {
          const { threadId, id: messageId } = added.message ?? {}
          if (!threadId || seen.has(threadId)) continue
          seen.add(threadId)
          // A brand-new thread has messageId === threadId (first message in the thread).
          // A reply has a different messageId.
          changes.push({ threadId, isNew: messageId === threadId })
        }
      }

      return changes
    } catch (err: any) {
      // HTTP 404 from the History API means the startHistoryId is too old
      // (Gmail only retains ~7 days of history). This can happen if the watch
      // was renewed but no notification arrived for a while.
      // Return empty — the next manual scan will catch up on missed threads.
      if (err?.code === 404 || err?.status === 404) {
        console.warn(
          `[gmail] historyId ${lastCursor} is too old — returning empty set. ` +
          `User should trigger a manual scan to catch up.`
        )
        return []
      }
      throw err
    }
  },
}
