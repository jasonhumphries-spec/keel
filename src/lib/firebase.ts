import { initializeApp, getApps } from 'firebase/app'
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId:     process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
}

// Prevent duplicate app initialisation in Next.js hot reload
const app = getApps().length === 0
  ? initializeApp(firebaseConfig)
  : getApps()[0]

export const auth = getAuth(app)
export const db   = getFirestore(app)
export const googleProvider = new GoogleAuthProvider()

// Explicitly set LOCAL persistence so session survives browser restarts
// (this is the default but being explicit prevents some browser-specific clearing)
if (typeof window !== 'undefined') {
  setPersistence(auth, browserLocalPersistence).catch(() => {})
}

// Request Gmail and Calendar scopes during sign-in
googleProvider.addScope('https://www.googleapis.com/auth/gmail.readonly')
googleProvider.addScope('https://www.googleapis.com/auth/gmail.send')
googleProvider.addScope('https://www.googleapis.com/auth/calendar')

// Request offline access to get refresh token.
// 'consent' (not 'select_account') ensures Google always returns a refresh token —
// 'select_account' skips the consent screen on repeat sign-ins and may omit the refresh token.
googleProvider.setCustomParameters({
  access_type: 'offline',
  prompt: 'consent',
})

export default app
