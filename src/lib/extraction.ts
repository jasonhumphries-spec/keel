/**
 * extraction.ts — Stage 2, layer L1. See docs/relevance-brain-design.md §3.
 *
 * The model's job, and only its job: read a thread and report what is objectively in
 * it. No score, no priority, no judgement about whether this user cares.
 *
 * WHY THE SPLIT. "This thread contains a £117.50 payment due 26 June" is identical for
 * every user and is genuinely a reading task. "This matters at 0.88" is a judgement
 * about one person's life that was being asked of the same call, in the same breath,
 * with ~900 tokens of scoring table attached. Separating them means the objective half
 * is cacheable and comparable across users, and the subjective half becomes code that
 * can be tested and, eventually, learned.
 *
 * The scoring table, the nine-tier importance ladder and most of the override prose
 * are all gone from this prompt: `scoring.ts` computes them from these facts.
 */

import type { ExtractedFacts, ObligationClass, ConsequenceFlag } from '@/lib/scoring'

export interface ExtractionResult extends ExtractedFacts {
  /** Free-text, still needed by the UI and by the expiry review. */
  summary:      string
  /** Who the next move belongs to. Objective; the status rules key off it. */
  ballWith:     'owner' | 'other_party' | 'nobody'
  /** Dated things found in the thread, unchanged in shape from the current signals. */
  signals: Array<{
    type:        'payment' | 'deadline' | 'event' | 'rsvp'
    description: string
    date:        string | null
    amountPence: number | null
  }>
}

/**
 * Build the extraction prompt.
 *
 * Note what is NOT here: any mention of importance, priority, urgency as a number,
 * or what the user tends to care about. Asking for those is what made the previous
 * prompt un-testable — the same call produced a fact and a judgement, and there was
 * no way to tell which one was wrong when the output looked off.
 */
export function buildExtractionPrompt(args: {
  subject: string
  from: string
  threadBody: string
  todayISO: string
  isUK?: boolean
}): string {
  const { subject, from, threadBody, todayISO, isUK = true } = args
  return `You are reading one email thread and reporting what is objectively in it.

Report facts only. Do NOT judge how important this is, do not assign a priority, and do not guess what the recipient cares about — that is decided elsewhere from the facts you return.

${isUK ? 'Write any text in British English.\n' : ''}TODAY IS: ${todayISO}

SUBJECT: ${subject}
FROM: ${from}

THREAD (oldest first; the last message is the current state):
${threadBody.slice(0, 3000)}

Return ONLY valid JSON:
{
  "obligation": "overdue" | "payment_due" | "action_required" | "response_due" | "scheduled" | "informational" | "receipt" | "resolved",
  "consequence": "legal" | "medical" | "financial_penalty" | "none",
  "ballWith": "owner" | "other_party" | "nobody",
  "isNoise": boolean,
  "summary": string,
  "signals": [
    { "type": "payment" | "deadline" | "event" | "rsvp", "description": string, "date": "YYYY-MM-DD" | null, "amountPence": number | null }
  ]
}

OBLIGATION — what state is this thread in, as of the LAST message?
  overdue          a payment or deadline has ALREADY PASSED unmet. Use this only when
                   the thread shows the date has gone or says so outright ("overdue",
                   "outstanding", "still unpaid", "you missed", a chaser for something
                   previously requested). An event that merely happened is NOT overdue
                   — nothing is owed. A reminder about a past party is informational.
  payment_due      money is owed and not yet late
  action_required  the recipient must do something; no money involved
  response_due     someone is waiting on a reply the recipient owes
  scheduled        a confirmed event or appointment; nothing to do but attend
  informational    nothing is being asked of anyone
  receipt          money already paid, or the thing already done
  resolved         explicitly closed, cancelled or superseded

  A payment that will be taken automatically (direct debit, standing order, card on
  file, "no action required") is a "receipt", not "payment_due" — nobody has to act.
  A statement or document merely being available to view is "informational".

CONSEQUENCE — only when missing this carries a hard penalty:
  legal              courts, regulators, statutory filings, contracts, company filings
  medical            health, prescriptions, test results, clinical appointments
  financial_penalty  interest, late fees, cancellation, service cut off. ALSO use this
                     whenever money is owed and unpaid — an outstanding invoice or a
                     chaser for fees carries a cost by its nature, even when no penalty
                     is spelled out.
  none               everything else, including most work and school admin

BALLWITH — whose move is it, judged from the LAST message only?
  owner        the recipient must act or reply next
  other_party  the recipient has done their part and is waiting
  nobody       nothing outstanding for anyone

ISNOISE — true for marketing, newsletters, promotions, review or feedback requests,
loyalty prompts, and automated notifications with nothing to do. An offer price is not
money owed; an "offer ends Friday" is not a deadline.

SIGNALS — dated things only, and only real ones:
  payment   money actually due or paid. Exact pence: £45.99 -> 4599.
  deadline  a point by which the recipient must DO something ("pay by", "return by")
  event     a time slot they attend
  rsvp      an invitation not yet answered
  Read the month explicitly; never assume the current one. Use the next future
  occurrence when no year is given. Omit dates that have no real obligation behind
  them, such as promotional expiry.

SUMMARY — one sentence, max 120 chars, stating the current position and what happens
next. Use real names from the thread, never "the user" or "you".`
}

const OBLIGATIONS = new Set<ObligationClass>([
  'overdue', 'payment_due', 'action_required', 'response_due',
  'scheduled', 'informational', 'receipt', 'resolved',
])
const CONSEQUENCES = new Set<ConsequenceFlag>(['legal', 'medical', 'financial_penalty', 'none'])

/**
 * Parse and validate the model's JSON.
 *
 * Unknown enum values fall back to the safest neutral rather than throwing: a garbled
 * extraction should produce a middling item to look at, never a crash and never a
 * confident "nothing here" that hides a real obligation.
 */
export function parseExtraction(text: string, todayISO: string): ExtractionResult | null {
  const json = text?.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null

  let raw: Record<string, unknown>
  try { raw = JSON.parse(json) } catch { return null }

  const obligation = OBLIGATIONS.has(raw.obligation as ObligationClass)
    ? raw.obligation as ObligationClass : 'informational'
  const consequence = CONSEQUENCES.has(raw.consequence as ConsequenceFlag)
    ? raw.consequence as ConsequenceFlag : 'none'
  const ballWith = ['owner', 'other_party', 'nobody'].includes(raw.ballWith as string)
    ? raw.ballWith as ExtractionResult['ballWith'] : 'nobody'

  const signals = (Array.isArray(raw.signals) ? raw.signals : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .filter(s => ['payment', 'deadline', 'event', 'rsvp'].includes(s.type as string))
    .map(s => ({
      type:        s.type as ExtractionResult['signals'][number]['type'],
      description: String(s.description ?? '').slice(0, 200),
      date:        typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : null,
      amountPence: Number.isFinite(Number(s.amountPence)) ? Number(s.amountPence) : null,
    }))

  return {
    obligation, consequence, ballWith,
    isNoise: raw.isNoise === true,
    summary: String(raw.summary ?? '').slice(0, 200),
    signals,
    ...deriveDue(signals, todayISO),
  }
}

/**
 * Nearest future dated signal, in whole days.
 *
 * Computed here rather than asked for, because it is arithmetic and the model has a
 * measured history of getting date proximity wrong — the hardcoded proximity override
 * exists for exactly this reason. Past dates are excluded UNLESS the thread is
 * overdue, where the elapsed time is the whole point.
 */
export function deriveDue(
  signals: ExtractionResult['signals'],
  todayISO: string,
): Pick<ExtractedFacts, 'daysToDue' | 'dueType'> {
  const today = Date.parse(`${todayISO}T00:00:00Z`)
  if (!Number.isFinite(today)) return { daysToDue: null, dueType: null }

  let best: { days: number; type: ExtractedFacts['dueType'] } | null = null
  for (const s of signals) {
    if (!s.date) continue
    const d = Date.parse(`${s.date}T00:00:00Z`)
    if (!Number.isFinite(d)) continue
    const days = Math.round((d - today) / 86400000)
    if (days < 0) continue
    if (!best || days < best.days) best = { days, type: s.type }
  }
  return best ? { daysToDue: best.days, dueType: best.type } : { daysToDue: null, dueType: null }
}
