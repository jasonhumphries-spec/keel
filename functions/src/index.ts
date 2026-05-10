/**
 * Firebase Cloud Functions — Keel
 *
 * Exports:
 *   gmailScan              — HTTP triggered, handles onboarding + long scans
 *                            (existing, unchanged)
 *   handleGmailNotification — Pub/Sub triggered, background scanning
 *                            (new — Session 6)
 *   renewGmailWatches      — Scheduled every 6 days, renews Gmail watch() subscriptions
 *                            (new — Session 6)
 */

// Existing scan function — keep as-is
export { gmailScan } from './scan'

// Background scanning (Phase 2)
export { handleGmailNotification, renewGmailWatches } from './backgroundScan'
