'use client'

/**
 * BackgroundScanToggle
 *
 * Drop this component into SettingsPanel.tsx wherever you want the
 * background scanning toggle to appear.
 *
 * Usage:
 *   import { BackgroundScanToggle } from '@/components/settings/BackgroundScanToggle'
 *   // inside SettingsPanel render:
 *   <BackgroundScanToggle uid={user.uid} accountData={accountData} />
 *
 * Reads autoScanEnabled, watchStatus, watchExpiry, lastBackgroundScanAt
 * from accountData (which comes from your AuthContext onSnapshot listener).
 * These fields are automatically present once this feature is enabled once.
 */

import { useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type WatchStatus = 'active' | 'inactive' | 'pending' | 'error'

interface AccountData {
  autoScanEnabled?: boolean
  watchStatus?: WatchStatus
  watchExpiry?: { toDate: () => Date }
  lastBackgroundScanAt?: { toDate: () => Date }
  backgroundScanCostUsd?: number
  backgroundScanRuns?: number
}

interface Props {
  uid: string
  accountData: AccountData
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BackgroundScanToggle({ uid, accountData }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEnabled = accountData.autoScanEnabled ?? false
  const status: WatchStatus = accountData.watchStatus ?? 'inactive'
  const isPending = status === 'pending' || loading

  // Format last scan time
  const lastScan = accountData.lastBackgroundScanAt?.toDate()
  const lastScanLabel = lastScan
    ? formatRelative(lastScan)
    : null

  // Format watch expiry
  const expiry = accountData.watchExpiry?.toDate()
  const expiryLabel = expiry
    ? `Renews ${expiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
    : null

  // Cost stats
  const totalCost = accountData.backgroundScanCostUsd ?? 0
  const totalRuns = accountData.backgroundScanRuns ?? 0

  async function toggle() {
    if (isPending) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/inbox-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid,
          action: isEnabled ? 'disable' : 'enable',
          providerId: 'gmail',
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to update background scanning')
      }
      // accountData will update via the existing onSnapshot listener in AuthContext —
      // no local state needed for the enabled/status values.
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.container}>
      {/* Header row */}
      <div style={styles.headerRow}>
        <div style={styles.labelGroup}>
          <span style={styles.label}>Background scanning</span>
          <span style={styles.proTag}>Pro</span>
        </div>

        {/* Toggle switch */}
        <button
          onClick={toggle}
          disabled={isPending}
          style={{
            ...styles.toggle,
            ...(isEnabled ? styles.toggleOn : styles.toggleOff),
            ...(isPending ? styles.toggleDisabled : {}),
          }}
          aria-checked={isEnabled}
          role="switch"
          aria-label="Toggle background scanning"
        >
          <span
            style={{
              ...styles.thumb,
              ...(isEnabled ? styles.thumbOn : styles.thumbOff),
            }}
          />
        </button>
      </div>

      {/* Description */}
      <p style={styles.description}>
        {isEnabled
          ? 'Keel will process new emails as they arrive — no scan button needed.'
          : 'Keel will classify new emails in the background as they arrive.'}
      </p>

      {/* Status strip (only shown when enabled or pending) */}
      {(isEnabled || isPending) && (
        <div style={styles.statusRow}>
          <StatusDot status={isPending ? 'pending' : status} />
          <span style={styles.statusLabel}>
            {isPending && 'Setting up…'}
            {!isPending && status === 'active' && 'Active'}
            {!isPending && status === 'inactive' && 'Inactive'}
            {!isPending && status === 'error' && 'Error — try disabling and re-enabling'}
          </span>
          {!isPending && status === 'active' && expiryLabel && (
            <span style={styles.expiryLabel}>{expiryLabel}</span>
          )}
        </div>
      )}

      {/* Last scan + cost (only when active and we have data) */}
      {isEnabled && status === 'active' && (lastScanLabel || totalRuns > 0) && (
        <div style={styles.statsRow}>
          {lastScanLabel && (
            <span style={styles.stat}>Last scan: {lastScanLabel}</span>
          )}
          {totalRuns > 0 && (
            <span style={styles.stat}>
              {totalRuns} background {totalRuns === 1 ? 'scan' : 'scans'} · ${totalCost.toFixed(4)} total
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          background: 'rgba(156,94,43,0.08)',
          border: '1px solid rgba(156,94,43,0.3)',
          borderRadius: 6,
          padding: '8px 10px',
        }}>
          <p style={{ ...styles.error, fontWeight: 600, marginBottom: 3 }}>Setup failed</p>
          <p style={{ ...styles.error, fontSize: 11, opacity: 0.85 }}>{error}</p>
        </div>
      )}

      {/* Pro note */}
      <p style={styles.proNote}>
        Background scanning will be a Pro feature when Keel launches publicly.
        It&apos;s available to all alpha testers now.
      </p>
    </div>
  )
}

// ─── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: WatchStatus | 'pending' }) {
  const colour: Record<string, string> = {
    active: '#3D7A6B',
    inactive: '#6B7A82',
    pending: '#C4A265',
    error: '#9C5E2B',
  }
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: colour[status] ?? '#6B7A82',
        flexShrink: 0,
        // Pulse animation for pending
        ...(status === 'pending'
          ? { animation: 'keel-pulse 1.4s ease-in-out infinite' }
          : {}),
      }}
    />
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  return `${diffDays}d ago`
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Uses raw style objects to avoid coupling to a specific CSS framework.
// Replace with your Tailwind classes or theme CSS vars as needed.

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '14px 0',
    borderBottom: '1px solid var(--border, #E2DDD6)',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  labelGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-primary, #1C2A2E)',
  },
  proTag: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    color: 'var(--accent, #B8964E)',
    border: '1px solid var(--accent, #B8964E)',
    borderRadius: 3,
    padding: '1px 5px',
    lineHeight: 1.6,
  },
  description: {
    fontSize: 12,
    color: 'var(--text-muted, #6B7280)',
    margin: 0,
    lineHeight: 1.5,
  },
  // Toggle switch
  toggle: {
    position: 'relative' as const,
    width: 40,
    height: 22,
    borderRadius: 11,
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
    transition: 'background-color 0.2s ease',
  },
  toggleOn: {
    backgroundColor: 'var(--accent, #B8964E)',
  },
  toggleOff: {
    backgroundColor: 'var(--border, #D1D5DB)',
  },
  toggleDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  thumb: {
    position: 'absolute' as const,
    top: 3,
    width: 16,
    height: 16,
    borderRadius: '50%',
    backgroundColor: '#fff',
    transition: 'left 0.2s ease',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  },
  thumbOn: { left: 21 },
  thumbOff: { left: 3 },
  // Status
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  statusLabel: {
    fontSize: 12,
    color: 'var(--text-secondary, #4A5568)',
  },
  expiryLabel: {
    fontSize: 11,
    color: 'var(--text-muted, #6B7280)',
    marginLeft: 4,
  },
  // Stats
  statsRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  stat: {
    fontSize: 11,
    color: 'var(--text-muted, #6B7280)',
  },
  // Error
  error: {
    fontSize: 12,
    color: 'var(--destructive, #9C5E2B)',
    margin: 0,
  },
  // Pro note
  proNote: {
    fontSize: 11,
    color: 'var(--text-muted, #9CA3AF)',
    margin: 0,
    lineHeight: 1.5,
    fontStyle: 'italic' as const,
  },
}
