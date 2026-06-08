/**
 * Build a Gmail URL that targets the correct logged-in account.
 *
 * Gmail's `/u/<n>/` slot only accepts a numeric account index — passing an email
 * there returns "Temporary Error (404)". The reliable way to route to a specific
 * account is the `?authuser=<email>` query parameter on the bare /mail/ path.
 * Falls back to `/u/0/` (browser default account) if no email is available.
 */
export function buildGmailThreadUrl(
  userEmail: string | null | undefined,
  threadId: string,
  folder: 'inbox' | 'sent' | 'all' = 'inbox',
): string {
  if (userEmail) {
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(userEmail)}#${folder}/${threadId}`
  }
  return `https://mail.google.com/mail/u/0/#${folder}/${threadId}`
}
