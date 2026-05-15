'use client'

import { useState, useEffect, useRef } from 'react'
import type { KeelItem } from '@/lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PreviewData {
  html:         string | null
  from:         string
  date:         string
  subject:      string
  messageCount: number
}

interface EmailPreviewDrawerProps {
  item:    KeelItem
  uid:     string
  onClose: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPreviewDate(raw: string): string {
  try {
    return new Date(raw).toLocaleString('en-GB', {
      weekday: 'short',
      day:     'numeric',
      month:   'short',
      year:    'numeric',
      hour:    '2-digit',
      minute:  '2-digit',
    })
  } catch {
    return raw
  }
}

// Strip angle-bracket wrapping from an RFC 5322 From header:
// "Jane Smith <jane@example.com>" → { name: "Jane Smith", email: "jane@example.com" }
function parseFrom(from: string): { name: string; email: string } {
  const match = from.match(/^(.*?)\s*<([^>]+)>$/)
  if (match) return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2] }
  return { name: '', email: from }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EmailPreviewDrawer({ item, uid, onClose }: EmailPreviewDrawerProps) {
  const [preview,  setPreview]  = useState<PreviewData | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const iframeRef               = useRef<HTMLIFrameElement>(null)

  // Fetch thread HTML when the drawer opens or the item changes
  useEffect(() => {
    if (!item?.threadId || !uid) return

    setLoading(true)
    setError(null)
    setPreview(null)

    fetch(
      `/api/gmail/thread-preview?uid=${encodeURIComponent(uid)}&threadId=${encodeURIComponent(item.threadId)}`,
    )
      .then(r => {
        if (!r.ok) {
          return r.json().then(d => {
            throw new Error(d.error ?? `HTTP ${r.status}`)
          })
        }
        return r.json() as Promise<PreviewData>
      })
      .then(setPreview)
      .catch(e => setError(e.message ?? 'Failed to load email preview'))
      .finally(() => setLoading(false))
  }, [item?.threadId, uid])

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sender = preview ? parseFrom(preview.from) : null

  return (
    <>
      {/* ── Panel ──────────────────────────────────────────────────────── */}
      <div
        role="dialog"
        aria-label="Email preview"
        className="keel-email-preview-drawer"
        style={{
          position:      'fixed',
          top:           64,   // below topbar
          bottom:        0,
          right:         440,  // sits left of the ItemExpandedPanel (440px wide)
          width:         600,
          zIndex:        398,  // just behind the item panel at 400
          display:       'flex',
          flexDirection: 'column',
          background:    'var(--color-surface)',
          borderLeft:    '1px solid var(--color-border)',
          boxShadow:     '-6px 0 32px rgba(0,0,0,0.10)',
          animation:     'keel-preview-slide-in 0.22s ease',
        }}
      >
        {/* Header */}
        <div style={{
          padding:       '13px 18px 12px',
          borderBottom:  '1px solid var(--color-border)',
          flexShrink:    0,
          background:    'var(--color-surface)',
        }}>
          {/* Row 1: label + message count chip + close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{
              fontFamily:    'var(--font-dm-mono)',
              fontSize:      'var(--fs-xs)',
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color:         'var(--color-text-muted)',
            }}>
              Email Preview
            </span>

            {preview && preview.messageCount > 1 && (
              <span style={{
                background:   'var(--color-surface-raised)',
                color:        'var(--color-text-secondary)',
                fontSize:     'var(--fs-xs)',
                padding:      '1px 8px',
                borderRadius: 10,
                fontFamily:   'var(--font-dm-mono)',
              }}>
                {preview.messageCount} messages · showing latest
              </span>
            )}

            <button
              onClick={onClose}
              aria-label="Close preview"
              style={{
                marginLeft:   'auto',
                flexShrink:   0,
                padding:      '4px 9px',
                borderRadius: 'var(--radius-md)',
                border:       '1px solid var(--color-border)',
                background:   'transparent',
                color:        'var(--color-text-muted)',
                cursor:       'pointer',
                fontSize:     'var(--fs-base)',
                lineHeight:   1,
                transition:   'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-raised)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              ✕
            </button>
          </div>

          {/* Row 2: From + subject */}
          {loading && (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
              Loading…
            </div>
          )}
          {error && (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--fs-sm)' }}>
              {item.subject}
            </div>
          )}
          {preview && !loading && (
            <>
              <div style={{
                fontFamily:  'var(--font-serif)',
                fontSize:    'var(--fs-md)',
                fontWeight:  600,
                color:       'var(--color-text)',
                lineHeight:  1.3,
                marginBottom: 4,
              }}>
                {preview.subject || item.subject || '(no subject)'}
              </div>
              <div style={{
                display:    'flex',
                alignItems: 'baseline',
                gap:        8,
                fontSize:   'var(--fs-sm)',
                flexWrap:   'wrap',
              }}>
                {sender?.name && (
                  <span style={{ fontWeight: 500, color: 'var(--color-text)' }}>
                    {sender.name}
                  </span>
                )}
                <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-xs)' }}>
                  {sender?.email ?? preview.from}
                </span>
                {preview.date && (
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 'auto', fontSize: 'var(--fs-xs)' }}>
                    {formatPreviewDate(preview.date)}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative', background: '#ffffff' }}>
          {/* Loading state */}
          {loading && (
            <div style={{
              position:       'absolute',
              inset:          0,
              display:        'flex',
              flexDirection:  'column',
              alignItems:     'center',
              justifyContent: 'center',
              gap:            12,
              color:          'var(--color-text-muted)',
              background:     'var(--color-surface)',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, animation: 'spin 1.5s linear infinite' }}>
                <path d="M22 12A10 10 0 1 1 12 2"/>
              </svg>
              <span style={{ fontSize: 'var(--fs-sm)' }}>Fetching email…</span>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div style={{
              padding:  24,
              color:    'var(--color-text-secondary)',
              fontSize: 'var(--fs-sm)',
              background: 'var(--color-surface)',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--color-text)' }}>
                Couldn't load preview
              </div>
              <div style={{ marginBottom: 16 }}>{error}</div>
              <a
                href={`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--color-accent)', textDecoration: 'underline', fontWeight: 500 }}
              >
                Open in Gmail instead →
              </a>
            </div>
          )}

          {/* Email iframe */}
          {preview?.html && !loading && !error && (
            <iframe
              ref={iframeRef}
              srcDoc={preview.html}
              // allow-same-origin: lets the iframe read its own CSS
              // allow-popups: lets mailto: and external links open in new tab
              // No allow-scripts — email JS is never executed
              sandbox="allow-same-origin allow-popups"
              style={{
                width:      '100%',
                height:     '100%',
                border:     'none',
                display:    'block',
                background: '#ffffff',
              }}
              title={`Email preview: ${preview.subject}`}
            />
          )}

          {/* No body fallback */}
          {preview && !preview.html && !loading && !error && (
            <div style={{
              padding:    24,
              color:      'var(--color-text-secondary)',
              fontSize:   'var(--fs-sm)',
              background: 'var(--color-surface)',
            }}>
              <div style={{ marginBottom: 12 }}>No previewable content found in this email.</div>
              <a
                href={`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}
              >
                Open in Gmail →
              </a>
            </div>
          )}
        </div>

        {/* Footer: quick action links */}
        <div style={{
          padding:      '9px 18px',
          borderTop:    '1px solid var(--color-border)',
          flexShrink:   0,
          display:      'flex',
          gap:          12,
          alignItems:   'center',
          background:   'var(--color-surface)',
        }}>
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize:       'var(--fs-sm)',
              color:          'var(--color-text-muted)',
              textDecoration: 'none',
              display:        'flex',
              alignItems:     'center',
              gap:            5,
              transition:     'color 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
          >
            {/* Gmail icon */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
            Open in Gmail
          </a>

          {item.rfcMessageId && (
            <a
              href={`message://%3C${encodeURIComponent(item.rfcMessageId)}%3E`}
              style={{
                fontSize:       'var(--fs-sm)',
                color:          'var(--color-text-muted)',
                textDecoration: 'none',
                display:        'flex',
                alignItems:     'center',
                gap:            5,
                transition:     'color 0.12s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
            >
              {/* Mail icon */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                <polyline points="22,6 12,13 2,6"/>
              </svg>
              Open in Mail
            </a>
          )}

          <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)' }}>
            Showing latest message only
          </span>
        </div>
      </div>

      {/* ── Styles ─────────────────────────────────────────────────────────── */}
      <style>{`
        @keyframes keel-preview-slide-in {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0); }
        }

        /* On narrower viewports, the drawer takes full width as a full overlay */
        @media (max-width: 1099px) {
          .keel-email-preview-drawer {
            right:  0   !important;
            width:  100% !important;
            z-index: 500 !important;
          }
        }
      `}</style>
    </>
  )
}
