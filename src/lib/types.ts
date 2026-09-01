// Keel — Firestore Types
// Matches the data model in firestore_data_model.md exactly

export type ItemStatus =
  | 'new'
  | 'awaiting_action'
  | 'awaiting_reply'
  | 'snoozed'
  | 'done'
  | 'paid'
  | 'archived'
  | 'quietly_logged'

export type SignalType = 'event' | 'deadline' | 'payment' | 'rsvp' | 'awaiting'

export type SignalCalendarStatus = 'on_cal' | 'not_on_cal' | 'ignored' | 'pending' | 'probable' | null

export interface KeelCategory {
  categoryId:   string
  name:         string
  description:  string
  icon:         string
  parentId:     string | null
  order:        number
  archived:     boolean
  archivedAt:   Date | null
  createdAt:    Date
  updatedAt:    Date
  itemCount:    number
}

export interface KeelItem {
  itemId:           string
  messageId:        string
  threadId:         string
  rfcMessageId?:    string  // RFC 2822 Message-ID header — used for Apple Mail deep links
  accountId:        string
  senderEmail:      string
  senderName:       string
  subject:          string
  receivedAt:       Date
  categoryId:       string
  categoryName:     string
  subcategoryId:    string | null
  subcategoryName:  string | null
  status:           ItemStatus
  importanceFlag:   boolean
  aiImportanceScore: number
  manualPriority:    boolean
  manuallyIgnored:   boolean
  userNote:          string | null
  snoozedUntil:      Date | null
  preSnoozePriority: number | null
  isOutbound:        boolean
  linkedOutboundId: string | null
  linkedItemId:     string | null
  isRecurring:      boolean
  fromTrackedReply: boolean
  trackedReplyId:   string | null
  mergedThreadIds:  string[]
  createdAt:        Date
  updatedAt:        Date
  resolvedAt:        Date | null
  participants:      string[]
  aiTitle:           string
  aiSummary:         string
  aiDetailedSummary: string
  autoQuietedReason?: 'on_calendar' | 'promotional' | 'sender_ignored' | 'feedback_request' | null

  /**
   * Why this item is quiet — the single field that answers "who silenced this?".
   *
   * Deliberately separate from `autoQuietedReason`, which only ever names an
   * override rule and is load-bearing for existing queries (useRecentPromotionalOffers,
   * restore-cal-quieted, reapply-overrides). `quietedBy` covers EVERY route to
   * quietly_logged, including the two that previously left no unified trace: the
   * model's own judgement, and lifecycle expiry.
   *
   * Without this, "the model judged it noise", "it expired normally" and "a rule
   * fired" are indistinguishable, and no quiet rule's precision can be measured.
   * See docs/relevance-brain-design.md §9.2.1.
   */
  quietedBy?: QuietedBy | null

  /**
   * The status the item held immediately before it was quieted, or null if it was
   * created quiet.
   *
   * `quietedBy` says who silenced it; this says what was silenced. The distinction
   * matters most for `expiry:stale`, the single largest quiet mechanism: burying a
   * stale `new` (informational, nobody cared) is healthy housekeeping, while burying
   * a stale `awaiting_action` means the system judged an item actionable, the user
   * never acted, and it was hidden on a timer — the exact failure Keel exists to
   * prevent. Without this field the two are indistinguishable.
   */
  quietedFromStatus?: ItemStatus | null
}

/** Cause of a quietly_logged transition. Prefix = who decided. */
export type QuietedBy =
  | 'ai'                        // the model classified it quiet; no rule fired
  | 'rule:resolved'
  | 'rule:promotional'
  | 'rule:feedback_request'
  | 'rule:on_calendar'
  | 'rule:sender_ignored'
  | 'expiry:stale'              // aged out without ever being actioned
  | 'expiry:past_event'         // the event it described has happened
  | 'expiry:past_deadline'
  | 'user:ignored_item'
  | 'user:ignored_sender'
  | 'user:categorise_skip'

export interface KeelSignal {
  signalId:        string
  itemId:          string
  accountId:       string
  type:            SignalType
  detectedDate:    Date | null
  detectedAmount:  number | null   // in pence
  currency:        string | null
  description:     string
  calendarStatus:      SignalCalendarStatus
  matchedCalendarName: string | null
  calendarEventId: string | null
  targetCalendarId: string | null
  status:          'active' | 'actioned' | 'ignored' | 'expired'
  createdAt:       Date
  updatedAt:       Date
}

export interface KeelOutbound {
  outboundId:     string
  messageId:      string
  threadId:       string
  accountId:      string
  recipientEmail: string
  recipientName:  string
  subject:        string
  aiSummary:      string
  categoryId:     string | null
  categoryName:   string | null
  status:         'open' | 'replied' | 'resolved' | 'snoozed'
  sentAt:         Date
  ageDays:        number
  snoozedUntil:   Date | null
  repliedAt:      Date | null
  replyMessageId: string | null
  linkedItemId:   string | null
  graceExpiresAt: Date | null
  followUpCount:  number
  lastFollowUpAt: Date | null
  createdAt:      Date
  updatedAt:      Date
}

export interface KeelPayment {
  paymentId: string
  itemId:    string
  payeeName: string
  amount:    number   // in pence
  currency:  string
  dueDate:   Date | null
  paidAt:    Date
  method:    string | null
  notes:     string | null
  createdAt: Date
}

// Dashboard-specific derived types
export interface CategoryWithItems {
  category: KeelCategory
  items:    KeelItem[]
}

export interface IgnoredSender {
  senderEmail:    string
  senderName?:    string
  sampleAiTitle?: string
  sampleSubject?: string
  addedAt:        Date
}
