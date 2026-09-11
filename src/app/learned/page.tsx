'use client'

/**
 * What keel has learned — see docs/relevance-brain-design.md §15.
 *
 * Three sections, each answering a different question:
 *   1. What keel believes about you   — the draft and approved profile, with review.
 *   2. The weightings it has learned  — reply rates per person and organisation, and
 *                                       exactly what each adds to a score.
 *   3. What that is actually changing — how many scores the learning has moved.
 *
 * Every number comes from /api/brain/learned, which computes it with the functions the
 * scan path itself uses. Nothing on this page re-derives a weighting: a view of learned
 * behaviour that disagreed with the behaviour would be worse than no view.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { PageShell } from '@/components/layout/PageShell'
import type { Weightings, WeightRow, Effects } from '@/lib/server/learned'

// ── Response shape ────────────────────────────────────────────────────────────

interface PendingDraft {
  id:          string
  generatedAt: string | null
  markdown:    string
  events:      number
  budget:      number
  bullets:     number
  overBudget:  boolean
}

interface ActiveProfile {
  markdown:    string
  candidateId: string | null
  promotedAt:  string | null
  edited:      boolean
}

interface HistoryEntry {
  id:          string
  status:      'pending' | 'promoted' | 'rejected' | 'superseded'
  generatedAt: string | null
  reviewedAt:  string | null
}

interface LearnedData {
  evidence:   { events: number; budget: number; minEvents: number; gateOpen: boolean }
  profile:    { active: ActiveProfile | null; pending: PendingDraft | null; history: HistoryEntry[]; usedInScoring: boolean }
  generation: { allowed: boolean; reason: string | null; nextAt: string | null }
  weightings: Weightings
  effects:    Effects
}

type Payload =
  | { action: 'generate' }
  | { action: 'promote'; candidateId: string; markdown?: string }
  | { action: 'reject'; candidateId: string }

type ActionError = { action: Payload['action']; message: string } | null

// ── Formatting ────────────────────────────────────────────────────────────────

const pct       = (x: number | null | undefined) => x == null ? '—' : `${(x * 100).toFixed(1)}%`
const pctWhole  = (x: number) => `${Math.round(x * 100)}%`
const liftText  = (x: number) => x > 0 ? `+${x.toFixed(3)}` : '—'
const count     = (n: number) => n.toLocaleString('en-GB')
const plural    = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`
const hours     = (h: number | null) => h == null ? '—' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'
const timeOf    = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/**
 * A live hint while editing. The server applies the real limit (checkReview) and is the
 * authority; this only saves someone a round trip to find out they wrote one too many.
 */
const countBullets = (s: string) => s.split('\n').filter(l => l.trim().startsWith('- ')).length

function explainGeneration(out: { generated?: boolean; reason?: string }): string | null {
  if (out.generated !== false) return null
  const r = out.reason ?? ''
  if (r.startsWith('candidate rejected')) {
    return 'The model’s draft claimed more than your actions support, so it was discarded. Try again.'
  }
  if (r.startsWith('only ')) return `Not enough to learn from yet — ${r}.`
  return r || 'No draft was written.'
}

// ── Styles (app tokens only) ──────────────────────────────────────────────────

const sans = 'var(--font-dm-sans)'
const mono = 'var(--font-dm-mono)'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)', padding: '16px 18px',
}
const cardEyebrow: CSSProperties = {
  fontFamily: mono, fontSize: 11, color: 'var(--color-text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10,
}
const meta: CSSProperties = { fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }
const th: CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 500, fontFamily: mono,
  color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-border)',
  whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
}
const thNum: CSSProperties = { ...th, textAlign: 'right' }
const td: CSSProperties = {
  padding: '6px 10px', fontSize: 13, color: 'var(--color-text-primary)',
  borderBottom: '1px solid var(--color-border)', verticalAlign: 'middle',
}
const tdNum: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function Button({ children, onClick, disabled, primary }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: sans, fontSize: 13, fontWeight: primary ? 600 : 500, padding: '7px 14px',
        borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        background: primary ? 'var(--color-accent)' : 'var(--color-surface)',
        color: primary ? '#fff' : 'var(--color-text-primary)',
        border: primary ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
      }}
    >
      {children}
    </button>
  )
}

/**
 * A note beside content. `tone="warning"` is reserved for a genuine problem the reader
 * should act on, and pairs the status colour with an icon and a written label — never
 * colour alone.
 */
function Notice({ children, tone }: { children: ReactNode; tone?: 'warning' }) {
  return (
    <div role="status" style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', marginTop: 10,
      background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)', fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-primary)',
    }}>
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke={tone === 'warning' ? 'var(--color-status-warning)' : 'var(--color-text-secondary)'}
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div>{children}</div>
    </div>
  )
}

function Spinner() {
  return (
    <>
      {/* Keyframes defined where used — an inherited copy inside another component's
          loading branch left earlier spinners frozen (docs §12.2). */}
      <style>{`@keyframes learned-spin { to { transform: rotate(360deg); } }`}</style>
      <span aria-hidden style={{
        display: 'inline-block', width: 12, height: 12, marginRight: 6, verticalAlign: '-2px',
        border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%',
        animation: 'learned-spin 0.8s linear infinite',
      }} />
    </>
  )
}

function Section({ number, title, subtitle, children }: {
  number: string; title: string; subtitle: string; children: ReactNode
}) {
  return (
    <section aria-labelledby={`learned-s${number}`}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: mono, fontSize: 12, color: 'var(--color-text-secondary)' }}>{number}</span>
        <h2 id={`learned-s${number}`} style={{ fontFamily: sans, fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--color-text-primary)' }}>
          {title}
        </h2>
      </div>
      <p style={{ ...meta, fontSize: 13, margin: '4px 0 14px', maxWidth: 720 }}>{subtitle}</p>
      {children}
    </section>
  )
}

function Bullets({ markdown }: { markdown: string }) {
  const lines = markdown.split('\n').map(l => l.trim()).filter(Boolean)
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {lines.map((l, i) => (
        <li key={i} style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--color-text-primary)' }}>
          {l.replace(/^-\s+/, '')}
        </li>
      ))}
    </ul>
  )
}

// ── 1. What keel believes about you ───────────────────────────────────────────

const STATUS_LABEL: Record<HistoryEntry['status'], string> = {
  promoted: 'Approved', rejected: 'Rejected', superseded: 'Replaced by a newer draft', pending: 'Awaiting review',
}

function ProfileSection({ data, busy, error, onAction }: {
  data: LearnedData; busy: Payload['action'] | null; error: ActionError
  onAction: (p: Payload) => Promise<boolean>
}) {
  const { profile, evidence, generation } = data
  const pending = profile.pending
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => { setEditing(false) }, [pending?.id])

  const editBullets = countBullets(draft)
  const editOver = pending ? editBullets > pending.budget : false
  const reviewError = error && error.action !== 'generate' ? error.message : null
  const generateError = error?.action === 'generate' ? error.message : null

  return (
    <Section
      number="1"
      title="What keel believes about you"
      subtitle={`Written from what you’ve done in keel — never from the content of your mail. ${plural(evidence.events, 'action')} so far, which supports up to ${plural(evidence.budget, 'claim')}. Nothing here is used until you approve it.`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {profile.active && (
          <div style={card}>
            <div style={cardEyebrow}>Approved profile</div>
            <Bullets markdown={profile.active.markdown} />
            <div style={{ ...meta, marginTop: 10 }}>
              Approved {shortDate(profile.active.promotedAt)}{profile.active.edited ? ' · edited by you' : ''}
            </div>
            {!profile.usedInScoring && (
              <Notice>
                Recorded, but not yet used when scoring your mail. Approving confirms these beliefs are
                right; feeding them into scoring is the next step, and this page will say when it happens.
              </Notice>
            )}
          </div>
        )}

        {pending && (
          <div style={{ ...card, borderColor: 'var(--color-accent)' }}>
            <div style={cardEyebrow}>Draft awaiting your review</div>
            {editing ? (
              <>
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  rows={Math.max(4, draft.split('\n').length + 1)}
                  aria-label="Edit the draft profile"
                  style={{
                    width: '100%', boxSizing: 'border-box', fontFamily: sans, fontSize: 14, lineHeight: 1.5,
                    padding: '8px 10px', borderRadius: 6, resize: 'vertical', outline: 'none',
                    border: `1px solid ${editOver ? 'var(--color-status-urgent)' : 'var(--color-border)'}`,
                    background: 'var(--color-surface-recessed)', color: 'var(--color-text-primary)',
                  }}
                />
                <div style={{ ...meta, marginTop: 6 }}>
                  {editBullets} of {plural(pending.budget, 'claim')} allowed. One claim per line, each starting with “- ”.
                </div>
              </>
            ) : (
              <>
                <Bullets markdown={pending.markdown} />
                <div style={{ ...meta, marginTop: 10 }}>
                  Written {shortDate(pending.generatedAt)} from {plural(pending.events, 'action')} · supports up to {plural(pending.budget, 'claim')}
                </div>
              </>
            )}

            {pending.overBudget && !editing && (
              <Notice>
                This draft makes {pending.bullets} claims, but {plural(pending.events, 'action')} only
                support {pending.budget}. It was written before that limit existed. Edit it down to
                approve it, or reject it and generate a new one.
              </Notice>
            )}
            {reviewError && <Notice>{reviewError}</Notice>}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              {editing ? (
                <>
                  <Button
                    primary
                    disabled={busy !== null || editBullets === 0 || editOver}
                    onClick={async () => {
                      if (await onAction({ action: 'promote', candidateId: pending.id, markdown: draft })) setEditing(false)
                    }}
                  >
                    {busy === 'promote' ? <><Spinner />Approving…</> : 'Save and approve'}
                  </Button>
                  <Button disabled={busy !== null} onClick={() => setEditing(false)}>Cancel</Button>
                </>
              ) : (
                <>
                  <Button
                    primary
                    disabled={busy !== null || pending.overBudget}
                    onClick={() => void onAction({ action: 'promote', candidateId: pending.id })}
                  >
                    {busy === 'promote' ? <><Spinner />Approving…</> : 'Approve'}
                  </Button>
                  <Button disabled={busy !== null} onClick={() => { setDraft(pending.markdown); setEditing(true) }}>
                    Edit
                  </Button>
                  <Button disabled={busy !== null} onClick={() => void onAction({ action: 'reject', candidateId: pending.id })}>
                    {busy === 'reject' ? <><Spinner />Rejecting…</> : 'Reject'}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {!pending && !profile.active && (
          <div style={card}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-primary)' }}>No draft yet.</p>
            <p style={{ ...meta, margin: '4px 0 0' }}>
              A draft is written overnight once there are {plural(evidence.minEvents, 'action')} to learn from, or you can ask for one now.
            </p>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button disabled={!generation.allowed || busy !== null} onClick={() => void onAction({ action: 'generate' })}>
            {busy === 'generate' ? <><Spinner />Writing a draft…</> : pending ? 'Write a fresh draft' : 'Write a draft now'}
          </Button>
          <span style={meta}>
            {generation.allowed
              ? (pending ? 'Replaces the draft above.' : '')
              : generation.nextAt ? `Available again at ${timeOf(generation.nextAt)}.` : generation.reason}
          </span>
        </div>
        {generateError && <Notice>{generateError}</Notice>}

        {profile.history.length > 0 && (
          <details style={meta}>
            <summary style={{ cursor: 'pointer' }}>Earlier drafts ({profile.history.length})</summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {profile.history.map(h => (
                <li key={h.id}>
                  {STATUS_LABEL[h.status]} · written {shortDate(h.generatedAt)}
                  {h.reviewedAt ? `, reviewed ${shortDate(h.reviewedAt)}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Section>
  )
}

// ── 2. Weightings it has learned ──────────────────────────────────────────────

/**
 * One row's reply rate as a thin horizontal bar on a fixed 0–100% scale, with the
 * engagement threshold drawn as a solid hairline. Position against that line is the
 * primary encoding of whether the sender earns a raise; colour repeats it, and the
 * "Raises score by" column states it in text — so identity is never colour alone.
 *
 * On several themes the de-emphasis fill sits below 3:1 against the surface (measured,
 * docs §15). That is legal only because every value is also in the row as text.
 */
function RateBar({ row, threshold }: { row: WeightRow; threshold: number }) {
  const [active, setActive] = useState(false)
  const earns = row.lift > 0
  const width = Math.max(0, Math.min(1, row.rate)) * 100
  const description = `${row.key}: answered ${pct(row.rate)} of ${plural(row.threads, 'thread')}; ${earns ? `raises score by ${liftText(row.lift)}` : 'no raise'}`

  return (
    <div
      role="img"
      aria-label={description}
      tabIndex={0}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      style={{ position: 'relative', height: 24, display: 'flex', alignItems: 'center', outlineOffset: 2 }}
    >
      <div style={{ position: 'relative', width: '100%', height: 8 }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: `${width}%`,
          background: earns ? 'var(--color-accent)' : 'var(--color-text-muted)',
          borderRadius: '0 4px 4px 0', opacity: active ? 0.8 : 1, transition: 'opacity 0.12s',
        }} />
        <div aria-hidden style={{
          position: 'absolute', left: `${threshold * 100}%`, top: -4, bottom: -4, width: 1,
          background: 'var(--color-text-secondary)',
        }} />
      </div>
      {active && (
        <div role="tooltip" style={{
          position: 'absolute', bottom: '100%', left: `${Math.min(width, 70)}%`, marginBottom: 4, zIndex: 5,
          background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6,
          padding: '6px 9px', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.12)', pointerEvents: 'none',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            {earns ? `Raises score by ${liftText(row.lift)}` : 'No raise'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {pct(row.rate)} replied · {plural(row.threads, 'thread')} · {pctWhole(row.confidence)} trusted
          </div>
        </div>
      )}
    </div>
  )
}

function Legend({ threshold }: { threshold: number }) {
  const item: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 }
  const swatch: CSSProperties = { display: 'inline-block', width: 14, height: 8, borderRadius: '0 4px 4px 0' }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', ...meta }}>
      <span style={item}><span style={{ ...swatch, background: 'var(--color-accent)' }} />Raises score</span>
      <span style={item}><span style={{ ...swatch, background: 'var(--color-text-muted)' }} />No raise yet</span>
      <span style={item}>
        <span style={{ display: 'inline-block', width: 1, height: 14, background: 'var(--color-text-secondary)' }} />
        {pctWhole(threshold)} reply rate — the line a sender must pass
      </span>
      <span>Trusted: how much history stands behind the rate</span>
    </div>
  )
}

function WeightTable({ title, kind, rows, total, threshold, empty, note }: {
  title: string; kind: 'sender' | 'domain'; rows: WeightRow[]; total: number
  threshold: number; empty: string; note?: string
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <h3 style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--color-text-primary)' }}>{title}</h3>
        <span style={meta}>{total > rows.length ? `top ${rows.length} of ${count(total)}` : count(total)}</span>
      </div>
      {note && <p style={{ ...meta, margin: '0 0 8px' }}>{note}</p>}
      {rows.length === 0 ? (
        <p style={{ ...meta, margin: 0 }}>{empty}</p>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: sans }}>
            <thead>
              <tr>
                <th style={th}>{kind === 'sender' ? 'Sender' : 'Organisation'}</th>
                <th style={{ ...th, minWidth: 170 }}>Reply rate</th>
                <th style={thNum}>Rate</th>
                <th style={thNum}>Threads</th>
                <th style={thNum}>{kind === 'sender' ? 'Replied' : 'People'}</th>
                <th style={thNum}>Trusted</th>
                {kind === 'sender' && <th style={thNum}>Typical reply</th>}
                <th style={thNum}>Raises score by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key}>
                  <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.key}>
                    {row.key}
                  </td>
                  <td style={td}><RateBar row={row} threshold={threshold} /></td>
                  <td style={tdNum}>{pct(row.rate)}</td>
                  <td style={tdNum}>{count(row.threads)}</td>
                  <td style={tdNum}>{kind === 'sender' ? count(row.replied) : count(row.senders ?? 0)}</td>
                  <td style={tdNum}>{pctWhole(row.confidence)}</td>
                  {kind === 'sender' && <td style={tdNum}>{hours(row.medianLatencyHours)}</td>}
                  <td style={{
                    ...tdNum,
                    fontWeight: row.lift > 0 ? 600 : 400,
                    color: row.lift > 0 ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  }}>
                    {liftText(row.lift)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function WeightingsSection({ w }: { w: Weightings }) {
  const r = w.rules
  return (
    <Section
      number="2"
      title="Weightings it has learned"
      subtitle={`From your reply history: you answer ${pct(w.baseRate)} of the ${count(w.totalThreads)} threads people start with you. ${count(w.earningLift)} of ${count(w.totalSenders)} senders are answered often enough to raise their mail’s score.`}
    >
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={cardEyebrow}>How a weighting becomes a score change</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-primary)' }}>
          <li>A sender must be answered more than <strong>{pctWhole(r.threshold)}</strong> of the time before their mail is raised at all.</li>
          <li>Their rate is fully trusted after <strong>{plural(r.fullConfidenceThreads, 'thread')}</strong>; with less history, the raise is scaled down.</li>
          <li>The largest possible raise is <strong>+{r.maxLift.toFixed(2)}</strong> on a 0–1 importance score — enough to reorder mail within a band, never enough to make something urgent.</li>
          <li>It only ever raises. Not answering someone never lowers their mail, because many senders that matter can’t be replied to at all.</li>
        </ul>
      </div>
      <Legend threshold={r.threshold} />
      <WeightTable
        title="People"
        kind="sender"
        rows={w.senders}
        total={w.sendersShown}
        threshold={r.threshold}
        empty="Nobody you reply to has enough history to show yet."
        note="Senders with at least three threads and one reply. One-off addresses are left out."
      />
      <WeightTable
        title="Organisations"
        kind="domain"
        rows={w.domains}
        total={w.domainsShown}
        threshold={r.threshold}
        empty="No organisation has enough history to show yet."
        note="Used for someone new at that organisation, until they have history of their own."
      />
    </Section>
  )
}

// ── 3. What it's actually changing ────────────────────────────────────────────

function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={card}>
      <div style={{ ...meta, marginBottom: 6 }}>{label}</div>
      {/* Proportional figures on a standalone value; tabular only where numbers align. */}
      <div style={{ fontFamily: sans, fontSize: 26, fontWeight: 600, lineHeight: 1.1, color: 'var(--color-text-primary)' }}>{value}</div>
      {note && <div style={{ ...meta, marginTop: 4 }}>{note}</div>}
    </div>
  )
}

function EffectsSection({ e, usedInScoring, hasActive }: { e: Effects; usedInScoring: boolean; hasActive: boolean }) {
  const stale = e.daysSinceLastProcessed != null && e.daysSinceLastProcessed >= 3
  return (
    <Section
      number="3"
      title="What it’s actually changing"
      subtitle="Learning only matters if it changes what you see. These count the scores the weightings above have actually moved."
    >
      {stale && (
        <Notice tone="warning">
          <strong>Scanning looks stalled.</strong> No new mail has been processed for {plural(e.daysSinceLastProcessed ?? 0, 'day')} (last on {shortDate(e.lastProcessedAt)}).
          Nothing can be raised until scanning resumes, so these numbers will stay flat.
        </Notice>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 12 }}>
        <StatTile label={`Raised in the last ${e.windowDays} days`} value={count(e.liftedLastWindow)} />
        <StatTile label="Raised in total" value={`${count(e.liftedAllTime)}${e.allTimeIsLowerBound ? '+' : ''}`} />
        <StatTile label="Largest single raise" value={e.largestLift > 0 ? `+${e.largestLift.toFixed(3)}` : 'None yet'} />
        <StatTile label="Scores that checked a weighting" value={count(e.consulted)} />
        <StatTile
          label="Approved profile used in scoring"
          value={usedInScoring ? 'Yes' : 'Not yet'}
          note={usedInScoring ? undefined : hasActive ? 'Approved, not wired in yet' : 'Nothing approved yet'}
        />
      </div>

      {e.recent.length > 0 ? (
        <div style={{ marginTop: 16, overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: sans }}>
            <thead>
              <tr>
                <th style={th}>Recently raised</th>
                <th style={th}>From</th>
                <th style={thNum}>Raised by</th>
                <th style={thNum}>When</th>
              </tr>
            </thead>
            <tbody>
              {e.recent.map((r, i) => (
                <tr key={`${r.sender}-${i}`}>
                  <td style={{ ...td, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.title}>{r.title || '(no subject)'}</td>
                  <td style={{ ...td, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{r.sender}</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>{liftText(r.lift)}</td>
                  <td style={tdNum}>{shortDate(r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ ...meta, marginTop: 14 }}>
          No item has been raised yet.
          {e.consulted > 0 && ` ${plural(e.consulted, 'score')} checked a weighting, but none of those senders is answered often enough to earn a raise.`}
        </p>
      )}
    </Section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LearnedPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [data, setData] = useState<LearnedData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<Payload['action'] | null>(null)
  const [actionError, setActionError] = useState<ActionError>(null)

  useEffect(() => {
    if (!authLoading && !user) router.push('/')
  }, [authLoading, user, router])

  const load = useCallback(async () => {
    if (!user) return
    setRefreshing(true)
    try {
      const token = await user.getIdToken()
      const res = await fetch('/api/brain/learned', { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`the server returned ${res.status}`)
      setData(await res.json())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [user])

  useEffect(() => { void load() }, [load])

  const act = useCallback(async (payload: Payload): Promise<boolean> => {
    if (!user) return false
    setBusy(payload.action)
    setActionError(null)
    try {
      const token = await user.getIdToken()
      const res = await fetch('/api/brain/learned', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(out.error === 'cooldown'
          ? 'A draft was written a few minutes ago. Try again shortly.'
          : out.error ?? `the server returned ${res.status}`)
      }
      if (payload.action === 'generate') {
        const why = explainGeneration(out)
        if (why) setActionError({ action: 'generate', message: why })
      }
      await load()
      return true
    } catch (e) {
      setActionError({ action: payload.action, message: e instanceof Error ? e.message : String(e) })
      return false
    } finally {
      setBusy(null)
    }
  }, [user, load])

  return (
    <PageShell>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 24px 64px', fontFamily: sans }}>
        <header style={{ marginBottom: 26 }}>
          <h1 style={{ fontFamily: sans, fontSize: 24, fontWeight: 600, margin: 0, color: 'var(--color-text-primary)' }}>
            What keel has learned
          </h1>
          <p style={{ ...meta, fontSize: 13, margin: '6px 0 0', maxWidth: 680 }}>
            What it believes about how you handle mail, the weightings it has learned from your replies, and what those are actually changing.
          </p>
        </header>

        {!data && loadError && <Notice>Couldn’t load what keel has learned: {loadError}.</Notice>}
        {!data && !loadError && <p style={meta}>Loading…</p>}

        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32, opacity: refreshing ? 0.6 : 1, transition: 'opacity 0.2s' }}>
            <ProfileSection data={data} busy={busy} error={actionError} onAction={act} />
            <WeightingsSection w={data.weightings} />
            <EffectsSection e={data.effects} usedInScoring={data.profile.usedInScoring} hasActive={!!data.profile.active} />
          </div>
        )}
      </div>
    </PageShell>
  )
}
