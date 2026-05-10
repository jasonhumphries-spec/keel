/**
 * Email provider abstraction layer.
 *
 * Currently supports Gmail. Designed to accommodate Outlook,
 * IMAP, and other providers without changing call-sites.
 *
 * All provider-specific behaviour (watch setup, history polling,
 * notification decoding) is isolated behind these interfaces.
 */

export type EmailProviderId = 'gmail' | 'outlook' | 'imap'

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt?: number
}

/** Returned when a watch subscription is set up or renewed. */
export interface WatchResult {
  /** When this watch expires. Gmail: max 7 days from setup. */
  expiry: Date
  /**
   * Provider's current position cursor at time of watch setup.
   * Stored on the account doc and used as `startHistoryId` on
   * the next notification to fetch only genuinely new messages.
   * Gmail: historyId string. Future providers may use a different type.
   */
  historyId: string
}

/** A single thread that changed according to the provider. */
export interface ThreadChange {
  threadId: string
  /** True if this is a brand-new thread, false if a reply arrived. */
  isNew: boolean
}

/**
 * Decoded payload from a provider push notification.
 * The Cloud Function decodes the raw Pub/Sub message into this shape
 * before calling getChangedThreadIds().
 */
export interface ProviderNotificationPayload {
  providerId: EmailProviderId
  /** The email address whose inbox changed. */
  emailAddress: string
  /**
   * The provider's new cursor position as of this notification.
   * For Gmail this is the historyId carried in the Pub/Sub message.
   */
  newCursor: string
}

/** Core interface every email provider must implement. */
export interface EmailProvider {
  readonly id: EmailProviderId

  /**
   * Set up a push notification subscription for this user's inbox.
   * Called when the user enables background scanning in settings.
   * Returns the initial cursor position and expiry timestamp.
   */
  setupWatch(uid: string, tokens: OAuthTokens): Promise<WatchResult>

  /**
   * Tear down the push notification subscription.
   * Called when the user disables background scanning.
   * Safe to call even if no watch is currently active.
   */
  stopWatch(uid: string, tokens: OAuthTokens): Promise<void>

  /**
   * Renew an expiring watch subscription.
   * Gmail watches expire after 7 days — the scheduled Cloud Function
   * calls this every 6 days for all users with autoScanEnabled.
   * Returns a fresh expiry and cursor.
   */
  renewWatch(uid: string, tokens: OAuthTokens): Promise<WatchResult>

  /**
   * Return the threadIds that changed between lastCursor and newCursor.
   * Called inside the background-scan endpoint after a notification arrives.
   *
   * Returns an empty array if:
   * - Nothing changed
   * - The cursor is too old (Gmail only keeps ~7 days of history)
   * - The provider cannot determine what changed
   *
   * Callers must update their stored cursor to newCursor after this call
   * regardless of the returned array contents.
   */
  getChangedThreadIds(
    tokens: OAuthTokens,
    lastCursor: string,
    newCursor: string
  ): Promise<ThreadChange[]>
}
