'use client'

import React from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SignalType =
  | 'event'
  | 'payment'
  | 'rsvp'
  | 'action'
  | 'info'
  | 'awaiting_reply'

export type PriorityLevel = 'urgent' | 'high' | 'med' | 'low'

// ─── Mappings ────────────────────────────────────────────────────────────────

const SIGNAL_LABELS: Record<SignalType, string> = {
  event:          'Event',
  payment:        'Payment',
  rsvp:           'RSVP',
  action:         'Action',
  info:           'Info',
  awaiting_reply: 'Awaiting reply',
}

/** Maps signal type → CSS var key suffix */
const SIGNAL_VAR: Record<SignalType, string> = {
  event:          'event',
  payment:        'payment',
  rsvp:           'rsvp',
  action:         'action',
  info:           'info',
  awaiting_reply: 'awaiting',
}

const PRIORITY_LABELS: Record<PriorityLevel, string> = {
  urgent: 'Urgent',
  high:   'High',
  med:    'Med',
  low:    'Low',
}

// ─── Shared base style ───────────────────────────────────────────────────────

const BASE: React.CSSProperties = {
  display:     'inline-flex',
  alignItems:  'center',
  gap:         '4px',
  padding:     '2px 8px',
  borderRadius:'100px',
  fontSize:    '11px',
  fontWeight:  500,
  lineHeight:  '1.4',
  whiteSpace:  'nowrap',
  userSelect:  'none',
}

// ─── SignalPill ───────────────────────────────────────────────────────────────
// Usage: <SignalPill type="payment" label="£240 due 20 May" />

interface SignalPillProps {
  type:       SignalType
  label?:     string       // overrides default label; pass date/amount here
  className?: string
  style?:     React.CSSProperties
}

export function SignalPill({ type, label, className, style }: SignalPillProps) {
  const v = SIGNAL_VAR[type] ?? 'info'
  return (
    <span
      className={className}
      style={{
        ...BASE,
        background: `var(--pill-${v}-bg)`,
        color:      `var(--pill-${v}-text)`,
        ...style,
      }}
    >
      {label ?? SIGNAL_LABELS[type]}
    </span>
  )
}

// ─── PriorityPill ─────────────────────────────────────────────────────────────
// Used in expanded panel picker and on card header.
// Dot colour is always the solid ramp value (--dot-{level}), independent of v1/v2.

interface PriorityPillProps {
  level:        PriorityLevel
  label?:       string
  showDot?:     boolean   // default true
  className?:   string
  style?:       React.CSSProperties
  onClick?:     () => void
  selected?:    boolean   // for the picker in expanded panel
}

export function PriorityPill({
  level,
  label,
  showDot = true,
  className,
  style,
  onClick,
  selected,
}: PriorityPillProps) {
  return (
    <span
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={className}
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
      style={{
        ...BASE,
        paddingLeft:  showDot ? '6px' : '8px',
        background:   `var(--pill-${level}-bg)`,
        color:        `var(--pill-${level}-text)`,
        cursor:       onClick ? 'pointer' : 'default',
        outline:      selected
          ? `2px solid var(--dot-${level})`
          : 'none',
        outlineOffset: selected ? '1px' : undefined,
        ...style,
      }}
    >
      {showDot && (
        <span
          aria-hidden
          style={{
            width:        '7px',
            height:       '7px',
            borderRadius: '50%',
            background:   `var(--dot-${level})`,
            flexShrink:   0,
          }}
        />
      )}
      {label ?? PRIORITY_LABELS[level]}
    </span>
  )
}

// ─── PriorityDot ──────────────────────────────────────────────────────────────
// The standalone dot used on item card headers (right-aligned, next to pill or alone)

interface PriorityDotProps {
  level:    PriorityLevel
  size?:    number   // default 9
  className?: string
}

export function PriorityDot({ level, size = 9, className }: PriorityDotProps) {
  return (
    <span
      aria-label={`Priority: ${PRIORITY_LABELS[level]}`}
      className={className}
      style={{
        display:      'inline-block',
        width:        `${size}px`,
        height:       `${size}px`,
        borderRadius: '50%',
        background:   `var(--dot-${level})`,
        flexShrink:   0,
      }}
    />
  )
}

// ─── CardLeftBorder helper ────────────────────────────────────────────────────
// Returns the inline style object to apply as border-left on an item card.
// The left border is always the solid ramp colour (same in v1 + v2).

export function priorityBorderStyle(level: PriorityLevel): React.CSSProperties {
  return {
    borderLeft: `3px solid var(--dot-${level})`,
  }
}

// ─── scoreToLevel ─────────────────────────────────────────────────────────────
// Converts aiImportanceScore (0–1) to a PriorityLevel.
// Mirrors the thresholds used in ItemExpandedPanel.

export function scoreToLevel(
  score: number,
  manualPriority?: number,
): PriorityLevel {
  const s = manualPriority !== undefined ? manualPriority : score
  if (s >= 0.85) return 'urgent'
  if (s >= 0.70) return 'high'
  if (s >= 0.45) return 'med'
  return 'low'
}
