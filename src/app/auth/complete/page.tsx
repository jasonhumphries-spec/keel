'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signInWithCredential, GoogleAuthProvider } from 'firebase/auth'
import { auth } from '@/lib/firebase'

export default function AuthCompletePage() {
  const router = useRouter()
  const params = useSearchParams()
  const session = params.get('session')

  const [message, setMessage] = useState('Finishing sign-in…')
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!session) {
      setError('Missing session parameter')
      return
    }

    let cancelled = false

    ;(async () => {
      try {
        setMessage('Verifying with Google…')
        const redeem = await fetch('/api/auth/oauth-session-redeem', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ session }),
        })
        if (!redeem.ok) {
          const err = await redeem.json().catch(() => ({}))
          throw new Error(err.error ?? `Redeem failed (${redeem.status})`)
        }
        const { googleIdToken, googleAccessToken } = await redeem.json()
        if (cancelled) return

        setMessage('Signing into Keel…')
        const credential = GoogleAuthProvider.credential(googleIdToken, googleAccessToken)
        const result = await signInWithCredential(auth, credential)
        if (cancelled) return

        setMessage('Storing your secure tokens…')
        const fbIdToken = await result.user.getIdToken()
        const finalize = await fetch('/api/auth/oauth-finalize', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fbIdToken}` },
          body:    JSON.stringify({ session }),
        })
        if (!finalize.ok) {
          const err = await finalize.json().catch(() => ({}))
          throw new Error(err.error ?? `Finalize failed (${finalize.status})`)
        }
        const { isNewUser } = await finalize.json()
        if (cancelled) return

        router.replace(isNewUser ? '/onboarding' : '/dashboard2')
      } catch (e: any) {
        console.error('[auth/complete] error:', e)
        if (!cancelled) setError(e.message ?? 'Unknown error')
      }
    })()

    return () => { cancelled = true }
  }, [session, router])

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', flexDirection: 'column', gap: 12, padding: 20, fontFamily: 'var(--font-dm-sans, system-ui)' }}>
      {error ? (
        <>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#9C5E2B' }}>Sign-in failed</div>
          <div style={{ fontSize: 13, color: '#666' }}>{error}</div>
          <button onClick={() => router.replace('/')} style={{ marginTop: 16, padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', background: 'white', cursor: 'pointer' }}>
            Back to home
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{message}</div>
          <div style={{ fontSize: 12, color: '#888' }}>One moment.</div>
        </>
      )}
    </div>
  )
}
