// Keel — Service Worker
// Strategy: network-first for all requests.
// Caches the app shell so the UI loads instantly and works when the
// device is briefly offline (e.g. poor mobile signal).
// Gmail / Firestore API calls always go to the network — no stale data risk.

const CACHE_NAME = 'keel-shell-v1'

// App shell assets to pre-cache on install
const SHELL_URLS = [
  '/',
  '/dashboard',
]

// ── Install — pre-cache the shell ────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Pre-cache the root. Non-fatal if individual URLs fail.
      return cache.addAll(SHELL_URLS).catch((err) => {
        console.warn('[SW] Pre-cache partially failed (non-fatal):', err)
      })
    })
  )
  // Take control immediately — don't wait for old SW to stop
  self.skipWaiting()
})

// ── Activate — clean up old caches ───────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  )
  // Claim all open tabs immediately
  self.clients.claim()
})

// ── Fetch — network-first strategy ───────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return
  if (url.origin !== self.location.origin) return

  // API routes, Firebase, and Google APIs always go straight to network
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('google.com')
  ) {
    return
  }

  // Network-first for everything else (navigation, static assets, fonts)
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for the app shell
        if (response.ok && response.type !== 'opaque') {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        }
        return response
      })
      .catch(() => {
        // Network failed — try the cache
        return caches.match(request).then((cached) => {
          if (cached) return cached
          // For navigation requests, return the root (SPA fallback)
          if (request.mode === 'navigate') {
            return caches.match('/')
          }
          // Nothing we can do
          return new Response('Offline', { status: 503 })
        })
      })
  )
})
