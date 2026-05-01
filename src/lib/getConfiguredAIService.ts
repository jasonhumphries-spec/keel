/**
 * getConfiguredAIService.ts
 *
 * Reads /config/aiProvider from Firestore and returns the correct AIService adapter.
 * Call this at the top of any API route that uses AI instead of hardcoding ClaudeAdapter.
 *
 * Usage:
 *   import { getConfiguredAIService } from '@/lib/getConfiguredAIService'
 *   const ai = await getConfiguredAIService(db)
 *   const result = await ai.classifyEmail(input)
 *
 * Falls back to ClaudeAdapter if config doc doesn't exist or on any error.
 */

import { Firestore } from 'firebase-admin/firestore'
import { ClaudeAdapter }  from './ClaudeAdapter'   // your existing adapter
import { GeminiAdapter }  from './GeminiAdapter'    // the new stub

export type AIProvider = 'claude-sonnet' | 'gemini-flash' | 'gemini-pro'

const PROVIDER_CACHE_TTL_MS = 60_000  // re-read Firestore at most once per minute

let cachedProvider:  AIProvider = 'claude-sonnet'
let cacheExpiresAt:  number     = 0

export async function getConfiguredAIService(db: Firestore) {
  const now = Date.now()

  // Use cache if still fresh
  if (now < cacheExpiresAt) {
    return instantiate(cachedProvider)
  }

  // Re-read from Firestore
  try {
    const doc = await db.collection('config').doc('aiProvider').get()
    if (doc.exists) {
      cachedProvider = (doc.data()!.provider as AIProvider) ?? 'claude-sonnet'
    }
  } catch (e) {
    console.warn('[getConfiguredAIService] Failed to read config, using cached/default:', e)
  }

  cacheExpiresAt = now + PROVIDER_CACHE_TTL_MS
  console.log(`[getConfiguredAIService] Provider: ${cachedProvider}`)
  return instantiate(cachedProvider)
}

function instantiate(provider: AIProvider) {
  switch (provider) {
    case 'gemini-flash':
      return new GeminiAdapter({ model: 'gemini-1.5-flash' })
    case 'gemini-pro':
      return new GeminiAdapter({ model: 'gemini-1.5-pro' })
    case 'claude-sonnet':
    default:
      return new ClaudeAdapter()
  }
}
