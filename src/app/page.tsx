'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'

export default function SignInPage() {
  const { user, loading, signIn } = useAuth()
  const router = useRouter()
  const [showButton, setShowButton] = useState(false)

  useEffect(() => {
    if (!loading && user) router.push('/dashboard')
  }, [user, loading, router])

  // After 1.5s always show the sign-in button regardless of loading state
  // This handles the mobile redirect flow where loading can hang
  useEffect(() => {
    const t = setTimeout(() => setShowButton(true), 1500)
    return () => clearTimeout(t)
  }, [])

  const isReady = !loading || showButton

  if (!isReady) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)' }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--color-border)', borderTopColor: 'var(--color-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--color-bg)',
      padding: '24px',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '380px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-xl)',
        padding: '40px 32px',
        boxShadow: 'var(--shadow-md)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <svg width="56" height="56" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
              <circle cx="128" cy="128" r="110" fill="none" stroke="#B8964E" strokeWidth="8"/>
              <path d="M 108 83 L 128 93 L 148 83"   fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M 110 101 L 128 111 L 146 101" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M 112 119 L 128 129 L 144 119" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M 114 137 L 128 147 L 142 137" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M 116 155 L 128 165 L 140 155" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M 118 173 L 128 183 L 138 173" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h1 style={{
            fontSize: '20px',
            fontWeight: 700,
            color: '#B8964E',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            marginBottom: '4px',
            fontFamily: 'var(--font-dm-sans)',
          }}>KEEL</h1>
          <p style={{
            fontSize: '11px',
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-dm-mono)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>Keeping it even</p>
        </div>

        {/* Headline */}
        <h2 style={{
          fontSize: '16px',
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          textAlign: 'center',
          marginBottom: '8px',
        }}>
          Get started
        </h2>
        <p style={{
          fontSize: '12px',
          color: 'var(--color-text-secondary)',
          textAlign: 'center',
          marginBottom: '24px',
          lineHeight: 1.6,
        }}>
          Connect your Gmail to automatically organise what needs your attention.
        </p>

        {/* Google sign-in button */}
        <button
          onClick={signIn}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            width: '100%',
            padding: '12px 16px',
            background: 'var(--color-surface)',
            border: '1.5px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-md)',
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            cursor: 'pointer',
            fontFamily: 'var(--font-dm-sans)',
            transition: 'all 0.15s ease',
            marginBottom: '16px',
          }}
          onMouseOver={e => {
            (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-raised)'
            ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)'
          }}
          onMouseOut={e => {
            (e.currentTarget as HTMLElement).style.background = 'var(--color-surface)'
            ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-strong)'
          }}
        >
          {/* Google G logo */}
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>

        {/* Privacy note */}
        <div style={{
          background: 'var(--color-surface-recessed)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: '10px 12px',
          fontSize: '11px',
          color: 'var(--color-text-muted)',
          textAlign: 'center',
          lineHeight: 1.6,
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="var(--color-status-positive)" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }}>
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          Keel reads each email, extracts key details (who sent it, what's needed, any dates or amounts), then discards the content.{' '}
          <strong style={{ color: 'var(--color-text-secondary)' }}>
            The words of your emails are never saved anywhere.
          </strong>{' '}
          What we do store — sender names, subjects, dates, and AI summaries — is encrypted at rest using AES-256.{' '}
          <a href="/privacy" style={{ color: 'var(--color-accent)', textDecoration: 'none' }}>Privacy policy →</a>
        </div>
      </div>
    </div>
  )
}
