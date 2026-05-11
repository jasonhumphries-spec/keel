'use client'

/**
 * SessionBanner
 *
 * A non-intrusive banner shown at the top of the dashboard when the Google
 * OAuth token has expired and automatic refresh has failed. This avoids silent
 * failures where scans and calendar checks fail with no user feedback.
 *
 * Usage: drop inside DashboardShell or any top-level layout component:
 *   import { SessionBanner } from '@/components/layout/SessionBanner'
 *   <SessionBanner />
 */

import { useAuth } from '@/contexts/AuthContext'

export function SessionBanner() {
  const { needsReauth, signIn } = useAuth()

  if (!needsReauth) return null

  return (
    <div style={{
      position:        'fixed',
      top:             0,
      left:            0,
      right:           0,
      zIndex:          1000,
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
      <span>Your session has expired — Keel can't reach Gmail or Calendar.</span>
      <button
        onClick={signIn}
        style={{
          background:   'rgba(255,255,255,0.2)',
          border:       '1px solid rgba(255,255,255,0.4)',
          borderRadius: 6,
          color:        '#fff',
          padding:      '5px 14px',
          fontSize:     12,
          fontWeight:   600,
          cursor:       'pointer',
          whiteSpace:   'nowrap',
          flexShrink:   0,
        }}
      >
        Sign in again
      </button>
    </div>
  )
}
