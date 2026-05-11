'use client'

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react'
import {
  User,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
} from 'firebase/auth'
import { doc, setDoc, getDoc, Timestamp } from 'firebase/firestore'
import { auth, googleProvider, db } from '@/lib/firebase'

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'error'

export interface ScanProgress {
  status:    ScanStatus
  processed: number
  total:     number
  message:   string
}

interface AuthContextType {
  user:         User | null
  loading:      boolean
  accessToken:  string | null
  scanProgress: ScanProgress
  lastScanned:  Date | null
  needsReauth:  boolean
  signIn:       () => Promise<void>
  signOut:      () => Promise<void>
  triggerScan:  (job?: 'onboarding' | 'manual' | 'auto') => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)
const IDLE: ScanProgress = { status: 'idle', processed: 0, total: 0, message: '' }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,         setUser]         = useState<User | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [accessToken,  setAccessToken]  = useState<string | null>(null)
  const [scanProgress, setScanProgress] = useState<ScanProgress>(IDLE)
  const [lastScanned,  setLastScanned]  = useState<Date | null>(null)
  const [needsReauth,  setNeedsReauth]  = useState(false)

  useEffect(() => {
    // Check for redirect result first (fires after Google redirects back)
    getRedirectResult(auth).then(async (result) => {
      if (result) {
        const credential = GoogleAuthProvider.credentialFromResult(result)
        const token      = credential?.accessToken ?? null
        if (token && result.user) {
          setAccessToken(token)
          setNeedsReauth(false)
          await saveTokenAndScan(result.user, token)
        }
      }
    }).catch(e => console.error('Redirect result error:', e))

    // Watch auth state
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser)
      if (firebaseUser) {
        try {
          const accountDoc = await getDoc(doc(db, `users/${firebaseUser.uid}/accounts`, 'account_primary'))
          if (accountDoc.exists()) {
            const data       = accountDoc.data()
            const token      = data?.accessToken as string | undefined
            const expiresAt  = data?.tokenExpiresAt?.toMillis?.() ?? 0

            if (token) {
              setAccessToken(token)
              // If token is expired or about to expire (within 5 min), refresh immediately
              if (Date.now() > expiresAt - 5 * 60 * 1000) {
                console.log('[Keel] Token expired or expiring soon — refreshing on load')
                const refreshed = await refreshAccessTokenForUid(firebaseUser.uid)
                if (!refreshed) setNeedsReauth(true)
              } else {
                setNeedsReauth(false)
              }
            }
          }
        } catch (e) {
          console.log('Could not restore access token:', e)
        }
      } else {
        setAccessToken(null)
        setNeedsReauth(false)
      }
      setLoading(false)
    })

    return unsubscribe
  }, [])

  // Proactive refresh every 45 minutes (tokens expire after 60 min)
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!user) return
      console.log('[Keel] Proactive token refresh (45min interval)')
      const refreshed = await refreshAccessTokenForUid(user.uid)
      if (!refreshed) setNeedsReauth(true)
    }, 45 * 60 * 1000)
    return () => clearInterval(interval)
  }, [user])

  // Refresh when tab becomes visible (user may have been away for hours)
  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== 'visible' || !user) return
      const accountDoc = await getDoc(doc(db, `users/${user.uid}/accounts`, 'account_primary'))
        .catch(() => null)
      const expiresAt = accountDoc?.data()?.tokenExpiresAt?.toMillis?.() ?? 0
      if (Date.now() > expiresAt - 5 * 60 * 1000) {
        console.log('[Keel] Tab refocused with expired/expiring token — refreshing')
        const refreshed = await refreshAccessTokenForUid(user.uid)
        if (!refreshed) setNeedsReauth(true)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [user])

  const saveTokenAndScan = async (firebaseUser: User, token: string, refreshToken?: string) => {
    const uid        = firebaseUser.uid
    const accountRef = doc(db, `users/${uid}/accounts`, 'account_primary')

    const existing  = await getDoc(accountRef)
    const isNewUser = !existing.exists()
    const createdAt = existing.data()?.createdAt ?? Timestamp.now()
    const scanCount = (existing.data()?.scanCount ?? 0) + 1

    await setDoc(accountRef, {
      accountId:      'account_primary',
      uid,
      email:          firebaseUser.email,
      displayName:    firebaseUser.displayName,
      provider:       'google',
      accessToken:    token,
      // Store locale for AI localisation (en-GB, en-US etc)
      locale:         firebaseUser.metadata ? navigator.language : 'en-GB',
      ...(refreshToken ? { refreshToken } : {}),
      tokenUpdatedAt: Timestamp.now(),
      tokenExpiresAt: Timestamp.fromMillis(Date.now() + 3600 * 1000), // 1 hour
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/calendar',
      ],
      active:      true,
      aiService:   'claude',
      plan:        existing.data()?.plan ?? 'free_trial',
      createdAt,
      updatedAt:   Timestamp.now(),
      lastSignIn:  Timestamp.now(),
      scanCount,
    }, { merge: true })

    // New users go to onboarding
    if (isNewUser) {
      if (typeof window !== 'undefined') {
        window.location.href = '/onboarding'
      }
      return
    }

    // Existing users: only auto-scan if last scan was >30 minutes ago
    // (prevents double-scan after onboarding redirect back to dashboard)
    const lastScanAt = existing.data()?.lastScanAt
    const lastScanMs = lastScanAt ? lastScanAt.toMillis() : 0
    const minutesSinceLastScan = (Date.now() - lastScanMs) / 60000
    if (minutesSinceLastScan < 30) {
      console.log(`[Keel] Skipping auto-scan — last scan was ${Math.round(minutesSinceLastScan)}m ago`)
      return
    }

    const daysBack = typeof window !== 'undefined'
      ? parseInt(localStorage.getItem('keel_scan_days_back') ?? '7', 10)
      : 14
    await runScan(uid, daysBack, 'auto')
  }

  // Internal token refresh — returns new token or null if refresh fails
  const refreshAccessTokenForUid = async (uid: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid }),
      })
      if (!res.ok) {
        console.warn('[Keel] Token refresh returned', res.status)
        return null
      }
      const data     = await res.json()
      const newToken = data.accessToken as string
      setAccessToken(newToken)
      setNeedsReauth(false)
      console.log('[Keel] Access token refreshed')
      return newToken
    } catch (e) {
      console.error('[Keel] Token refresh failed:', e)
      return null
    }
  }

  // Silently refresh the access token using the stored refresh token
  const refreshAccessToken = async (uid: string): Promise<string | null> => {
    return refreshAccessTokenForUid(uid)
  }

  const runScan = async (uid: string, daysBack = 7, job: 'onboarding' | 'manual' | 'auto' = 'manual') => {
    try {
      const accountRef = doc(db, `users/${uid}/accounts`, 'account_primary')
      const existing   = await getDoc(accountRef)
      if (existing.exists()) {
        const scanCount = (existing.data()?.scanCount ?? 0) + 1
        await setDoc(accountRef, { scanCount, lastScanAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true })
      }
    } catch (e) { /* non-fatal */ }

    const phases = [
      { msg: 'Connecting to Gmail…',                    pct: 5  },
      { msg: 'Fetching your inbox…',                    pct: 12 },
      { msg: 'Grouping email threads…',                 pct: 25 },
      { msg: 'Reading full thread history for context…',pct: 38 },
      { msg: 'Classifying emails with AI…',             pct: 52 },
      { msg: 'Classifying emails with AI…',             pct: 63 },
      { msg: 'Extracting signals and dates…',           pct: 76 },
      { msg: 'Finding payment items…',                  pct: 85 },
      { msg: 'Almost there…',                           pct: 93 },
    ]
    let phaseIndex = 0
    setScanProgress({ status: 'scanning', processed: phases[0].pct, total: 100, message: phases[0].msg })

    const messageTimer = setInterval(() => {
      phaseIndex = Math.min(phaseIndex + 1, phases.length - 1)
      setScanProgress(prev => {
        if (prev.status !== 'scanning') { clearInterval(messageTimer); return prev }
        return { ...prev, processed: phases[phaseIndex].pct, message: phases[phaseIndex].msg }
      })
    }, 5000)

    try {
      const SCAN_URL = process.env.NEXT_PUBLIC_SCAN_FUNCTION_URL ?? '/api/gmail/scan'
      const res = await fetch(SCAN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid, daysBack, job }),
      })

      clearInterval(messageTimer)
      if (res.status === 401) {
        // Token expired — attempt silent refresh then retry once
        console.log('[Keel] Scan got 401 — attempting token refresh')
        const newToken = await refreshAccessTokenForUid(uid)
        if (newToken) {
          // Retry the scan with fresh token (server reads token from Firestore)
          await runScan(uid, daysBack, job)
          return
        }
        // Refresh failed — user needs to sign in again
        setNeedsReauth(true)
        setScanProgress({ status: 'error', processed: 0, total: 0, message: 'Session expired — please sign in again' })
        setTimeout(() => setScanProgress(IDLE), 6000)
        return
      }
      if (!res.ok) throw new Error(`Scan failed: ${res.status}`)
      const data = await res.json()

      const newCount      = data.processed ?? 0
      const updateCount   = data.updated ?? 0
      const threadsFound  = data.threadsFound ?? data.total ?? 0
      const summary = newCount > 0
        ? `${newCount} new item${newCount !== 1 ? 's' : ''} added`
        : updateCount > 0
        ? `${updateCount} thread${updateCount !== 1 ? 's' : ''} updated`
        : 'All caught up — nothing new'

      setScanProgress({ status: 'done', processed: newCount, total: threadsFound, message: summary })
      setLastScanned(new Date())
      setTimeout(() => setScanProgress(IDLE), 5000)

    } catch (e) {
      clearInterval(messageTimer)
      console.error('[Keel] Scan fetch error:', e)
      setScanProgress({ status: 'error', processed: 0, total: 0, message: 'Scan failed — try again' })
      setTimeout(() => setScanProgress(IDLE), 4000)
    }
  }

  const signIn = async () => {
    try {
      const result     = await signInWithPopup(auth, googleProvider)
      const credential = GoogleAuthProvider.credentialFromResult(result)
      const token      = credential?.accessToken ?? null
      if (token && result.user) {
        setAccessToken(token)
        setNeedsReauth(false)
        await saveTokenAndScan(result.user, token)
      }
    } catch (error: any) {
      if (
        error?.code === 'auth/popup-blocked' ||
        error?.code === 'auth/popup-closed-by-user' ||
        error?.code === 'auth/cancelled-popup-request' ||
        error?.message?.includes('Cross-Origin')
      ) {
        // Popup was closed or superseded — not an error worth surfacing
        console.log('Popup dismissed or superseded:', error.code)
      } else {
        console.error('Sign-in error:', error)
        throw error
      }
    }
  }

  const triggerScan = async (job: 'onboarding' | 'manual' | 'auto' = 'manual') => {
    if (!user) { console.warn('triggerScan: no user'); return }
    if (scanProgress.status === 'scanning') return

    const daysBack = typeof window !== 'undefined'
      ? parseInt(localStorage.getItem('keel_scan_days_back') ?? '7', 10)
      : 7

    console.log(`[Keel] Triggering scan with daysBack=${daysBack}`)
    await runScan(user.uid, daysBack, job)
  }

  const signOut = async () => {
    setAccessToken(null)
    setScanProgress(IDLE)
    await firebaseSignOut(auth)
  }

  return (
    <AuthContext.Provider value={{ user, loading, accessToken, scanProgress, lastScanned, needsReauth, signIn, signOut, triggerScan }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
