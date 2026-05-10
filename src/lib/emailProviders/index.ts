import { gmailProvider } from './gmail'
import type { EmailProvider, EmailProviderId } from './types'

// Registry of all supported email providers.
// Add new providers here as they are implemented.
const providers: Record<string, EmailProvider> = {
  gmail: gmailProvider,
  // outlook: outlookProvider,   ← Phase 3
  // imap: imapProvider,         ← Phase 3
}

/**
 * Returns the EmailProvider for the given provider ID.
 * Throws if the provider is not registered.
 */
export function getEmailProvider(id: EmailProviderId): EmailProvider {
  const provider = providers[id]
  if (!provider) {
    throw new Error(
      `Email provider "${id}" is not registered. ` +
      `Registered providers: ${Object.keys(providers).join(', ')}`
    )
  }
  return provider
}

// Re-export types so consumers only need to import from this index file.
export type {
  EmailProvider,
  EmailProviderId,
  OAuthTokens,
  WatchResult,
  ThreadChange,
  ProviderNotificationPayload,
} from './types'
