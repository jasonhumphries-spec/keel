import { Firestore, Timestamp } from 'firebase-admin/firestore'

/**
 * getValidAccessToken
 *
 * Single source of truth for Google OAuth token management across all server-side routes.
 * Returns a valid access token for the given user, automatically refreshing it if it has
 * expired or will expire within the next 2 minutes.
 *
 * Reads from — and writes refreshed tokens back to — users/{uid}/accounts/account_primary.
 *
 * Returns null if:
 *   - account_primary document does not exist
 *   - No refresh token is available (user must sign in again)
 *   - Token refresh request fails (e.g. revoked credentials)
 *
 * Callers should treat a null return as a 401 and surface an auth error to the user.
 *
 * Used by:
 *   - /api/gmail/scan          (manual + auto scans)
 *   - /api/gmail/background-scan (Pub/Sub triggered)
 *   - /api/gmail/reanalyse     (single-item re-fetch)
 *   - /api/inbox-watch         (enable/disable Gmail watch)
 */
export async function getValidAccessToken(
  db:  Firestore,
  uid: string
): Promise<string | null> {
  const accountSnap = await db.doc(`users/${uid}/accounts/account_primary`).get()
  if (!accountSnap.exists) {
    console.warn(`[tokenUtils] account_primary not found for uid=${uid}`)
    return null
  }

  const data         = accountSnap.data()!
  const accessToken  = data.accessToken  as string | undefined
  const refreshToken = data.refreshToken as string | undefined
  const expiresAt    = (data.tokenExpiresAt as Timestamp | undefined)?.toMillis() ?? 0

  // Token is valid for at least 2 more minutes — return as-is
  if (accessToken && Date.now() < expiresAt - 120_000) {
    return accessToken
  }

  // Token expired or expiring soon — need to refresh
  if (!refreshToken) {
    console.warn(`[tokenUtils] No refresh token for uid=${uid} — user must sign in again`)
    return null
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.warn(`[tokenUtils] Token refresh failed for uid=${uid}: ${res.status} ${errText}`)
      return null
    }

    const td        = await res.json()
    const newToken  = td.access_token as string
    const expiresIn = (td.expires_in  as number) ?? 3600

    await db.doc(`users/${uid}/accounts/account_primary`).update({
      accessToken:    newToken,
      tokenExpiresAt: Timestamp.fromMillis(Date.now() + expiresIn * 1000),
      tokenUpdatedAt: Timestamp.now(),
    })

    console.log(`[tokenUtils] Token refreshed for uid=${uid}`)
    return newToken
  } catch (e) {
    console.warn(`[tokenUtils] Token refresh threw for uid=${uid}:`, e)
    return null
  }
}
