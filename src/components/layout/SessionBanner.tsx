'use client'

/**
 * SessionBanner
 *
 * Shown at the top of the dashboard when something keeps Keel from reaching
 * Gmail/Calendar in the background. Distinguishes two failure modes:
 *
 *   token: the OAuth token can't be refreshed → user must sign in again
 *   watch: token is fine but the Gmail watch has expired → re-arm (1-click)
 *
 * Layout: sticky (not fixed) — pushes the dashboard content down so the
 * Settings cog stays clickable underneath.
 */

import { useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'

export function SessionBanner() {
  const { needsReauth, reauthReason, signIn, rearmWatch } = useAuth()
  const [busy, setBusy]       = useState(false)
  const [status, setStatus]   = useState<string | null>(null)

  if (!needsReauth) return null

  const isWatch = reauthReason === 'watch'

  const handleClick = async () => {
    if (isWatch) {
      setBusy(true)
      setStatus('Re-arming Gmail watch…')
      try {
        await rearmWatch()
        setStatus('✓ Background scan re-enabled')
        // Banner will go away once snapshot listener picks up new watchExpiry
      } catch {
        setStatus('Failed — try again')
      } finally {
        setBusy(false)
      }
    } else {
      signIn()
    }
  }

  const message = isWatch
    ? 'Background scan stopped — Gmail watch needs re-enabling.'
    : 'Your session has expired — Keel can\'t reach Gmail or Calendar.'

  const buttonLabel = isWatch ? 'Re-enable monitoring' : 'Sign in again'

  return (
    <div style={{
      position:        'sticky',
      top:             0,
      left:            0,
      right:           0,
      zIndex:          50,
      background:      'var(--color-destructive, #9C5E2B)',
      color:           '#fff',
      padding:         '10px 16px',
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'space-between',
      gap:             12,
      fontSize:        13,
      fontWeight:      500,
      boxShadow:       '0 2px 8px rgba(0,0,0,0.15)',
    }}>
      <span>
        {status ?? message}
      </span>
      <button
        onClick={handleClick}
        disabled={busy}
        style={{
          background:   busy ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.2)',
          border:       '1px solid rgba(255,255,255,0.4)',
          borderRadius: 6,
          color:        '#fff',
          padding:      '5px 14px',
          fontSize:     12,
          fontWeight:   600,
          cursor:       busy ? 'not-allowed' : 'pointer',
          whiteSpace:   'nowrap',
          flexShrink:   0,
          opacity:      busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Working…' : buttonLabel}
      </button>
    </div>
  )
}
