/**
 * aiComplete.ts
 *
 * Provider-aware drop-in replacement for direct anthropic.messages.create() calls.
 * Reads the active provider from Firestore /config/aiProvider (cached 60s).
 * Returns a consistent shape regardless of which provider is active.
 *
 * Usage in scan/route.ts and merge/route.ts — replace:
 *
 *   import Anthropic from '@anthropic-ai/sdk'
 *   const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
 *   ...
 *   const response = await anthropic.messages.create({
 *     model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
 *     messages: [{ role: 'user', content: prompt }],
 *   })
 *   const text = response.content[0].type === 'text' ? response.content[0].text : ''
 *   const inputTokens  = response.usage.input_tokens
 *   const outputTokens = response.usage.output_tokens
 *
 * With:
 *
 *   import { aiComplete, getActiveProvider } from '@/lib/aiComplete'
 *   ...
 *   const { text, inputTokens, outputTokens, model, costUsd } = await aiComplete(db, prompt, 1024)
 *
 * That's the only change needed in each route. All prompt logic, JSON parsing,
 * cost tracking, and Firestore writes remain exactly as they are.
 */

import { Firestore } from 'firebase-admin/firestore'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AIProvider = 'claude-haiku' | 'claude-sonnet' | 'gemini-flash' | 'gemini-pro'

export interface AICompleteResult {
  text:          string
  inputTokens:   number
  outputTokens:  number
  thinkingTokens?: number
  model:         string
  costUsd:       number
}

// ─── Pricing (per million tokens) ────────────────────────────────────────────

const PRICING: Record<string, { input: number; output: number; thinking?: number }> = {
  'claude-haiku-4-5-20251001':      { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':              { input: 3.00,  output: 15.00 },
  'gemini-2.5-flash':               { input: 0.15,  output: 0.60,  thinking: 3.50 },
  'gemini-2.5-pro':                 { input: 1.25,  output: 10.00, thinking: 3.50 },
}

function calcCost(model: string, inputTokens: number, outputTokens: number, thinkingTokens = 0): number {
  const p = PRICING[model] ?? PRICING['claude-haiku-4-5-20251001']
  const thinkingRate = (p as any).thinking ?? 0
  return (inputTokens / 1_000_000) * p.input
       + (outputTokens / 1_000_000) * p.output
       + (thinkingTokens / 1_000_000) * thinkingRate
}

// ─── Provider → model name mapping ───────────────────────────────────────────

const PROVIDER_MODEL: Record<AIProvider, string> = {
  'claude-haiku':  'claude-haiku-4-5-20251001',
  'claude-sonnet': 'claude-sonnet-4-6',
  'gemini-flash':  'gemini-2.5-flash',
  'gemini-pro':    'gemini-2.5-pro',
}

// ─── Config cache ─────────────────────────────────────────────────────────────

let cachedProvider: AIProvider = 'claude-haiku'
let cacheExpiresAt: number     = 0
const CACHE_TTL_MS             = 60_000

async function getActiveProvider(db: Firestore): Promise<AIProvider> {
  const now = Date.now()
  if (now < cacheExpiresAt) return cachedProvider

  try {
    const doc = await db.collection('config').doc('aiProvider').get()
    if (doc.exists) {
      const raw = doc.data()!.provider as string
      // Map admin console values to internal provider keys
      const MAP: Record<string, AIProvider> = {
        'claude-sonnet': 'claude-sonnet',
        'claude-haiku':  'claude-haiku',
        'gemini-flash':  'gemini-flash',
        'gemini-pro':    'gemini-pro',
      }
      cachedProvider = MAP[raw] ?? 'claude-haiku'
    }
  } catch (e) {
    console.warn('[aiComplete] Failed to read provider config, using cached/default:', e)
  }

  cacheExpiresAt = now + CACHE_TTL_MS
  console.log(`[aiComplete] Active provider: ${cachedProvider} (${PROVIDER_MODEL[cachedProvider]})`)
  return cachedProvider
}

// ─── Claude completion ────────────────────────────────────────────────────────

let _anthropic: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    _anthropic = new Anthropic({ apiKey })
  }
  return _anthropic
}

async function completeWithClaude(model: string, prompt: string, maxTokens: number): Promise<AICompleteResult> {
  const response = await getAnthropic().messages.create({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages:   [{ role: 'user', content: prompt }],
  })
  const text         = response.content[0].type === 'text' ? response.content[0].text : ''
  const inputTokens  = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  return { text, inputTokens, outputTokens, model, costUsd: calcCost(model, inputTokens, outputTokens) }
}

// ─── Gemini completion ────────────────────────────────────────────────────────

let _gemini: GoogleGenerativeAI | null = null
function getGemini(): GoogleGenerativeAI {
  if (!_gemini) {
    const apiKey = process.env.GOOGLE_AI_API_KEY
    if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not set')
    _gemini = new GoogleGenerativeAI(apiKey)
  }
  return _gemini
}

async function completeWithGemini(model: string, prompt: string): Promise<AICompleteResult> {
  const genModel  = getGemini().getGenerativeModel({
    model,
    // Disable thinking — adds ~10-30s per call, not needed for JSON classification
    // temperature: 0 — deterministic output, prevents score/status drift on re-scans
    generationConfig: { thinkingConfig: { thinkingBudget: 0 }, temperature: 0 } as any,
  })
  const result    = await genModel.generateContent(prompt)
  const text      = result.response.text()

  // Gemini returns token counts in usageMetadata
  // thoughtsTokenCount = thinking tokens (charged at higher rate when thinking enabled)
  const meta           = (result.response as any).usageMetadata ?? {}
  const inputTokens    = meta.promptTokenCount     ?? 0
  const outputTokens   = meta.candidatesTokenCount ?? 0
  const thinkingTokens = meta.thoughtsTokenCount   ?? 0

  return { text, inputTokens, outputTokens, model, costUsd: calcCost(model, inputTokens, outputTokens, thinkingTokens) }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * aiComplete — provider-aware LLM call.
 *
 * @param db        Firestore admin instance (used to read provider config)
 * @param prompt    The prompt string
 * @param maxTokens Max output tokens (used by Claude; Gemini ignores this)
 */
export async function aiComplete(
  db:        Firestore,
  prompt:    string,
  maxTokens: number = 1024
): Promise<AICompleteResult> {
  const provider = await getActiveProvider(db)
  const model    = PROVIDER_MODEL[provider]

  if (provider === 'gemini-flash' || provider === 'gemini-pro') {
    return completeWithGemini(model, prompt)
  }

  return completeWithClaude(model, prompt, maxTokens)
}

/**
 * Export for use in cost tracking — get the currently active model name
 * so routes can log it to Firestore correctly.
 */
export { getActiveProvider, PROVIDER_MODEL, calcCost }
