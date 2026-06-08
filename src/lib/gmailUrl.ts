/**
 * Build a Gmail URL that targets the correct logged-in account.
 *
 * Gmail's multi-account routing uses /u/<index-or-email>/. Hardcoding /u/0/ opens
 * whichever account happens to be first in the user's browser sign-in list, which
 * may not be the Keel-linked account. Passing the email address routes to the
 * correct inbox regardless of order. Falls back to /u/0/ if no email is available
 * (e.g. user object hasn't loaded yet).
 */
export function buildGmailThreadUrl(
  userEmail: string | null | undefined,
  threadId: string,
  folder: 'inbox' | 'sent' | 'all' = 'inbox',
): string {
  const account = userEmail ? encodeURIComponent(userEmail) : '0'
  return `https://mail.google.com/mail/u/${account}/#${folder}/${threadId}`
}
