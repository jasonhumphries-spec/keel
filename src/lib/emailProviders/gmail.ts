import type { EmailProvider, OAuthTokens, ThreadChange, WatchResult } from './types'

// The Pub/Sub topic Gmail will publish notifications to.
// Must exist in the Firebase project before deploying the Cloud Function.
const PUBSUB_TOPIC_NAME = `projects/${process.env.FIREBASE_PROJECT_ID}/topics/gmail-inbox-notifications`

async function gmailFetch(path: string, accessToken: string, options: RequestInit = {}) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) throw Object.assign(new Error(`Gmail API error: ${res.status}`), { code: res.status, status: res.status })
  return res.json()
}

export const gmailProvider: EmailProvider = {
  id: 'gmail',

  async setupWatch(_uid: string, tokens: OAuthTokens): Promise<WatchResult> {
    const data = await gmailFetch('/users/me/watch', tokens.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        topicName: PUBSUB_TOPIC_NAME,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      }),
    })
    if (!data.expiration || !data.historyId) {
      throw new Error('Gmail watch() returned incomplete response')
    }
    return {
      expiry: new Date(parseInt(data.expiration, 10)),
      historyId: data.historyId,
    }
  },

  async stopWatch(_uid: string, tokens: OAuthTokens): Promise<void> {
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
  },

  async renewWatch(uid: string, tokens: OAuthTokens): Promise<WatchResult> {
    return this.setupWatch(uid, tokens)
  },

  async getChangedThreadIds(
    tokens: OAuthTokens,
    lastCursor: string,
    _newCursor: string
  ): Promise<ThreadChange[]> {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history')
    url.searchParams.set('startHistoryId', lastCursor)
    url.searchParams.set('historyTypes', 'messageAdded')
    url.searchParams.set('labelId', 'INBOX')
    url.searchParams.set('maxResults', '100')

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })

    if (res.status === 404) {
      console.warn('[gmail] historyId too old — returning empty set')
      return []
    }
    if (!res.ok) throw Object.assign(new Error(`Gmail history.list failed: ${res.status}`), { code: res.status, status: res.status })

    const data = await res.json()
    const seen = new Set<string>()
    const changes: ThreadChange[] = []

    for (const item of data.history ?? []) {
      for (const added of item.messagesAdded ?? []) {
        const { threadId, id: messageId } = added.message ?? {}
        if (!threadId || seen.has(threadId)) continue
        seen.add(threadId)
        changes.push({ threadId, isNew: messageId === threadId })
      }
    }
    return changes
  },
}
