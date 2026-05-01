/**
 * GeminiAdapter.ts
 *
 * Drop-in replacement for ClaudeAdapter implementing the AIService interface.
 * Accepts an optional { model } constructor argument so the factory can
 * instantiate different Gemini model tiers without separate classes.
 *
 * Setup:
 *   1. Get an API key from https://aistudio.google.com
 *   2. Add GOOGLE_AI_API_KEY to your .env.local
 *   3. npm install @google/generative-ai
 */

import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClassifyEmailInput {
  subject: string
  sender: string
  senderEmail: string
  bodySnippet: string
  threadId: string
  existingCategories: Array<{ id: string; name: string }>
  userRules?: Array<{ pattern: string; categoryId: string }>
}

export interface ClassificationResult {
  aiTitle: string
  aiSummary: string
  aiDetailedSummary: string
  category: {
    id: string | null
    name: string
    confidence: number
    isNew: boolean
    ruleApplied: boolean
  }
  signals: Array<{
    type: 'payment_due' | 'date' | 'action_required' | 'awaiting_reply' | 'info_only'
    dueDate?: string
    amount?: number
    currency?: string
    description?: string
    importance: 'high' | 'medium' | 'low'
  }>
  aiImportanceScore: number
  shouldTrack: boolean
}

export interface OutboundAssessment {
  shouldTrack: boolean
  questionSummary: string
  expectedReplyBy?: string
  importance: 'high' | 'medium' | 'low'
}

export interface FullEmailMessage {
  messageId: string
  threadId: string
  subject: string
  from: { name: string; email: string }
  to: { name: string; email: string }
  bodyText: string
  sentAt: string
}

export interface CatProposalInput {
  aiTitle: string
  aiSummary: string
  existingCategories: Array<{ id: string; name: string }>
}

export interface CatProposal {
  suggestedCategoryName: string
  suggestedCategoryId: string | null
  rationale: string
}

export interface RescueInput {
  items: Array<{ itemId: string; aiTitle: string; aiSummary: string; ageDays: number }>
}

export interface RescueResult {
  flagged: Array<{ itemId: string; reason: string }>
}

export interface ItemSummary {
  itemId: string
  aiTitle: string
  categoryId: string
  signals: Array<{ type: string; dueDate?: string }>
}

export interface RecurringPatterns {
  patterns: Array<{
    description: string
    itemIds: string[]
    suggestedLabel: string
  }>
}

export interface AIService {
  classifyEmail(input: ClassifyEmailInput): Promise<ClassificationResult>
  assessOutboundEmail(message: FullEmailMessage): Promise<OutboundAssessment>
  getCategorisationProposal(input: CatProposalInput): Promise<CatProposal>
  rescueQuietLog(input: RescueInput): Promise<RescueResult>
  detectRecurringPatterns(items: ItemSummary[]): Promise<RecurringPatterns>
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function parseJSON<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(cleaned) as T
}

// ─── GeminiAdapter ────────────────────────────────────────────────────────────

export class GeminiAdapter implements AIService {
  private model: GenerativeModel
  private modelName: string

  constructor(options?: { model?: string }) {
    const apiKey = process.env.GOOGLE_AI_API_KEY
    if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not set in environment')

    this.modelName = options?.model ?? process.env.GEMINI_MODEL ?? 'gemini-1.5-flash'
    const genAI = new GoogleGenerativeAI(apiKey)
    this.model = genAI.getGenerativeModel({ model: this.modelName })

    console.log(`[GeminiAdapter] Initialised — model: ${this.modelName}`)
  }

  // ── classifyEmail ────────────────────────────────────────────────────────────

  async classifyEmail(input: ClassifyEmailInput): Promise<ClassificationResult> {
    const prompt = `
You are an AI assistant helping classify personal emails for a productivity app called Keel.
Analyse this email and return a JSON object. No preamble, no markdown fences, just raw JSON.

Email:
Subject: ${input.subject}
From: ${input.sender} <${input.senderEmail}>
Body snippet: ${input.bodySnippet}

Existing categories: ${JSON.stringify(input.existingCategories)}
${input.userRules?.length ? `User rules: ${JSON.stringify(input.userRules)}` : ''}

Return this exact JSON shape:
{
  "aiTitle": "short human-friendly title (max 8 words)",
  "aiSummary": "one sentence summary (max 20 words)",
  "aiDetailedSummary": "2-3 sentence detailed summary",
  "category": {
    "id": "existing category id or null if new",
    "name": "category name",
    "confidence": 0.0,
    "isNew": false,
    "ruleApplied": false
  },
  "signals": [
    {
      "type": "payment_due | date | action_required | awaiting_reply | info_only",
      "dueDate": "ISO 8601 or omit",
      "amount": 0,
      "currency": "GBP",
      "description": "brief description",
      "importance": "high | medium | low"
    }
  ],
  "aiImportanceScore": 5,
  "shouldTrack": true
}`.trim()

    const result = await this.model.generateContent(prompt)
    return parseJSON<ClassificationResult>(result.response.text())
  }

  // ── assessOutboundEmail ──────────────────────────────────────────────────────

  async assessOutboundEmail(message: FullEmailMessage): Promise<OutboundAssessment> {
    const prompt = `
You are helping track outbound emails that contain questions or requests requiring a reply.

Email:
Subject: ${message.subject}
To: ${message.to.name} <${message.to.email}>
Body: ${message.bodyText}
Sent: ${message.sentAt}

Return raw JSON only:
{
  "shouldTrack": true,
  "questionSummary": "one sentence describing what was asked",
  "expectedReplyBy": "ISO 8601 date or omit",
  "importance": "high | medium | low"
}`.trim()

    const result = await this.model.generateContent(prompt)
    return parseJSON<OutboundAssessment>(result.response.text())
  }

  // ── getCategorisationProposal ────────────────────────────────────────────────

  async getCategorisationProposal(input: CatProposalInput): Promise<CatProposal> {
    const prompt = `
You are helping a user categorise an email item in Keel.

Item: "${input.aiTitle}" — ${input.aiSummary}
Existing categories: ${JSON.stringify(input.existingCategories)}

Return raw JSON only:
{
  "suggestedCategoryName": "name",
  "suggestedCategoryId": null,
  "rationale": "one sentence explanation"
}`.trim()

    const result = await this.model.generateContent(prompt)
    return parseJSON<CatProposal>(result.response.text())
  }

  // ── rescueQuietLog ───────────────────────────────────────────────────────────

  async rescueQuietLog(input: RescueInput): Promise<RescueResult> {
    const prompt = `
You are reviewing items in a personal inbox manager that have gone quiet.
Flag any that seem overdue or forgotten.

Items: ${JSON.stringify(input.items)}

Return raw JSON only:
{
  "flagged": [
    { "itemId": "id", "reason": "brief reason" }
  ]
}`.trim()

    const result = await this.model.generateContent(prompt)
    return parseJSON<RescueResult>(result.response.text())
  }

  // ── detectRecurringPatterns ──────────────────────────────────────────────────

  async detectRecurringPatterns(items: ItemSummary[]): Promise<RecurringPatterns> {
    const prompt = `
Analyse these email items to detect recurring patterns (monthly bills, weekly school emails etc).

Items: ${JSON.stringify(items)}

Return raw JSON only:
{
  "patterns": [
    {
      "description": "what the pattern is",
      "itemIds": ["id1", "id2"],
      "suggestedLabel": "short label"
    }
  ]
}`.trim()

    const result = await this.model.generateContent(prompt)
    return parseJSON<RecurringPatterns>(result.response.text())
  }
}
