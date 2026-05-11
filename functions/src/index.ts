/**
 * Firebase Cloud Functions — Keel
 *
 * Exports:
 *   handleGmailScan         — HTTP triggered, handles onboarding + long scans
 *   handleGmailNotification — Pub/Sub triggered, background scanning
 *   renewGmailWatches       — Scheduled every 6 days, renews Gmail watch() subscriptions
 *   nightlyItemExpiry       — Scheduled nightly, expires past events + marks overdue
 */

export { handleGmailScan } from './scan'

export { handleGmailNotification, renewGmailWatches, nightlyItemExpiry } from './backgroundScan'
