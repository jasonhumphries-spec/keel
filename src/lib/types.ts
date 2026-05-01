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

export type SignalCalendarStatus = 'on_cal' | 'not_on_cal' | 'ignored' | 'pending' | null

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
  snoozedUntil:     Date | null
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
}

export interface KeelSignal {
  signalId:        string
  itemId:          string
  accountId:       string
  type:            SignalType
  detectedDate:    Date | null
  detectedAmount:  number | null   // in pence
  currency:        string | null
  description:     string
  calendarStatus:  SignalCalendarStatus
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
