# Product Requirements Document
## Keel — AI-Powered Personal Admin Hub

**Version:** 1.5
**Status:** Active development — private alpha (production live, ~100 test users)
**Last Updated:** 2026-05-06 (Session 5)
**Product name:** Keel
**Tagline:** Keeping it even.

---

## 1. Vision & Problem Statement

Modern life generates a relentless stream of communication — bills, school updates, appointment confirmations, holiday bookings, contractor quotes, invitations, work threads, and more. Unlike the workplace, where tools like Slack, Jira, and Notion help people stay organised, the personal domain has no equivalent system. People rely on overloaded inboxes, forgotten calendar entries, and memory.

**Keel** is an AI-powered administration hub that sits on top of a person's Gmail, intelligently organises their email into meaningful categories, surfaces what needs attention, and helps them stay in control — for personal life, work life, or both.

The app acts as a **control tower, not a second inbox**. It tells you what needs attention and where, but Gmail always remains the source of truth. Users are linked back to the source email to take action, never asked to duplicate their workflow.

---

## 2. Target User

**Primary user:** An individual managing a full and complex life — likely with family, children, a home, health commitments, work or business commitments, and a range of hired help.

**Key characteristics:**
- Has significant email traffic spanning multiple domains of life
- Struggles to keep track of what needs a response, a payment, or a diary entry
- Categories vary by person and evolve over time
- May use Gmail for personal life, work, or both
- May have multiple email accounts
- Uses a mix of devices — primarily laptop/iPad, checking on mobile

**Target device split:**
- **Desktop/laptop** — primary power use, full dashboard
- **iPad** — frequent use, review and actioning
- **Mobile** — check-ins, quick actions, priority filter views

---

## 3. Core Problem Areas

| Problem | Example |
|---|---|
| **Bills & payments going unnoticed** | An invoice arrives, gets buried, and is missed |
| **Key dates not making it to the calendar** | A school play date sits in an email, never added |
| **Invitations left unanswered** | An RSVP deadline passes without a response |
| **Outgoing questions forgotten** | User emailed their plumber two weeks ago — did they ever reply? |
| **No holistic view** | Life across health, home, school, holidays, work is fragmented across an inbox |
| **Multiple inboxes, no unified view** | Personal Gmail + business email each need separate monitoring |

---

## 4. Categories

Users organise their email into domains that reflect their actual life. The system supports **fully customisable, user-defined categories**.

**Personal default set:** Finance & Bills, School & Education, Home & Property, Hired Help, Health, Holidays & Travel, Social & Events, IT & Tech, Job Search, Other

**Work default set:** Clients, Suppliers & Vendors, Finance & Invoices, HR & People, Legal & Compliance, Projects, Travel & Expenses, Marketing & PR, IT & Systems, Other

**Both (mixed) set:** Combines the most common from both sets.

**Email type selection:** During onboarding the user is asked whether they're connecting a personal, work, or mixed inbox. This pre-selects the appropriate default category set. All categories are fully customisable after onboarding.

**Key principles:**
- Categories are owned and defined by the user
- Built-in categories have AI prompt knowledge baked in — no description needed
- User-added custom categories prompt for a description during onboarding
- User descriptions are additive — they extend the built-in AI knowledge, not replace it
- The AI learns from user corrections via `categoryHints` collection
- `manualCategory: true` flag written when user assigns — scan never overwrites

**Category management — built:**
- Rename, delete (when empty), drag to reorder
- Per-category live item count badges in sidebar
- "Keel already knows:" panel on categories page showing built-in AI knowledge
- Smart placeholder hints for each built-in category
- "↺ Reclassify all" button — re-runs AI on all active items + recent ignored using stored AI metadata (no Gmail re-fetch)

---

## 5. Feature Requirements

### 5.1 Email Intelligence Layer

**Built — current implementation:**

- Gmail OAuth integration with read + send scopes, offline access for refresh tokens
- Smart active window scan: fetches threads with activity in the last **7 days** (default, adjustable 7–90 days in settings)
- Full thread history: for every thread found in the active window, the complete conversation history is fetched and included for AI context — however old
- Thread deduplication: one Firestore item per Gmail thread, updated on reply
- Skip unchanged: threads where Gmail `internalDate` <= stored `lastMessageInternalDate` are skipped (uses Gmail timestamp, not Keel write time — ensures replies are detected)
- `manualCategory: true` flag: scan never overwrites category assigned by user
- Terminal status guard: items with `done`, `archived`, or `paid` status never resurrected by scan
- Incremental fetch optimisation: uses `lastScanCompletedAt` timestamp to query only recently-changed items from Firestore
- Parallel processing: 5 concurrent AI classifications per batch
- Pagination: up to 2,000 messages per scan across multiple Gmail pages
- Locale-aware AI: detects `en-GB`, instructs AI to use British English
- Category learning: user corrections written to `categoryHints` collection, included in future prompts
- Live scan feed: during onboarding scan, writes `meta/scanFeed` every 5 threads
- Scan route reads Google OAuth token from Firestore server-side with auto-refresh (checks `tokenExpiresAt`, refreshes if within 2 minutes of expiry)

**AI provider abstraction:**
- `src/lib/aiComplete.ts` — provider-aware wrapper for all LLM calls
- Reads active provider from Firestore `/config/aiProvider` (cached 60s)
- Supports: Claude Haiku 4.5, Claude Sonnet 4.6, Gemini 2.5 Flash, Gemini 2.5 Pro
- Admin console can switch provider globally with no restart required
- Default/active: **Gemini 2.5 Flash** — best cost/quality ratio for structured classification tasks

**AI provider pricing table:**

| Provider | Model | Input $/M | Output $/M |
|---|---|---|---|
| Gemini Flash | gemini-2.5-flash | $0.15 | $0.60 |
| Gemini Pro | gemini-2.5-pro | $1.25 | $10.00 |
| Claude Haiku | claude-haiku-4-5-20251001 | $0.80 | $4.00 |
| Claude Sonnet | claude-sonnet-4-6 | $3.00 | $15.00 |

**AI classification pipeline (Stage 1):**

For each new or updated thread, the AI receives:
- Thread subject + sender
- Full thread body (recent messages ~600 chars, older messages ~200 chars)
- Available categories with descriptions (built-in + user-supplied, combined)
- User correction hints from `categoryHints`
- Locale instruction

AI returns structured JSON: `aiTitle`, `aiSummary`, `aiDetailedSummary`, `aiImportanceScore`, `signals[]`, `status`, `isRecurring`, `categoryId`.

**AI prompt quality rules (Session 5):**
- Never use "the user" — use real first names from the thread
- NEXT STEP bullet identifies who acts next by direction of the most recent message
- `event` signals: ONLY for confirmed, agreed, upcoming dates — not declined/contextual dates
- `awaiting` signals: ONLY for genuinely open questions in the most recent outbound message
- Payment classification: Receipt (done) vs Auto-pay bill (will be collected) vs Invoice (user must act)

**Re-analyse single item:**
- `/api/gmail/reanalyse` — re-fetches thread from Gmail, runs full S1 + signals, triggers calendar check
- Auto token refresh via `getValidAccessToken()`
- Returns `{skipped: true}` on 404 (thread deleted) — no error
- Accessible from `...` menu in ItemExpandedPanel

**Transient same-day items:**
Calendar reminders, delivery dispatch/out-for-delivery alerts → automatically `quietly_logged`.

**Stage 2 (deduplication pass):**
Optional post-scan pass. Reviews items within each category, archives duplicates, stores merged `threadIds`.

**Reclassify all:**
Re-runs AI classification on all active items using stored `aiTitle`/`aiSummary` — no Gmail re-fetch. Fast and low cost.

### 5.2 Onboarding

6-step flow:

1. **Welcome** — Keel chevron logo, name greeting
2. **How it works** — 4 numbered points explaining the approach
3. **Email type** — Personal / Work / Both — pre-selects category set
4. **Categories** — Pick and customise defaults; custom categories trigger describe step
5. **Calendar** — "Primary calendar only" vs "All connected calendars" — choice saved to account doc before first scan
6. **Scan** — Live feed terminal, rotating tips, elapsed timer, thread count

**Onboarding scan:** Uses Cloud Function URL to avoid Vercel 5-minute timeout. `lastScanCompletedAt` written on completion for incremental future scans.

### 5.3 Dashboard

**Dashboard 2.0 (default at `/dashboard`, original at `/dashboard1`):**

Step-based scrolling layout. Each section is a floating white card on a neutral grey `#eeeef0` background, with a 3px coloured top border identifying priority level. No background wash tints.

**Steps:**
1. **Urgent** — rust `#9C5E2B` — items with `aiImportanceScore >= 0.85`
2. **Awaiting Responses** — steel blue `#4A7FA5` — items with `status: awaiting_reply`
3. **High Priority** — brass `#B8964E` — items with importance score level 3
4. **Everything Else** — slate `#6B7A82` — FYI items, receipts, auto-pay bills

**Sort-inbox panel:** Appears above step 1 when uncategorised items exist (`categoryId: cat_other`). Disappears after classification. Step numbers always start at 1 for Urgent.

**Scan overlay:** Full-screen blur (`backdropFilter: blur(5px)`, z-index 500) shown on mount while initial scan check runs. Minimum 1.5 second display. Covers entire UI — no interaction possible during check. Disappears when scan completes.

**Calendar column:** Shows event signals for each section's date range. Three states: on-calendar (teal), not-on-calendar (priority colour + Add button), dismissed. Tapping event opens corresponding item card.

**Calendar auto-recheck:** When user opens Google Calendar via "+ Add to calendar" and returns to the tab, `visibilitychange` listener auto-triggers a calendar check and updates signal status.

**Built (Dashboard 1.0, preserved):**
- Category grid (2-column auto-fit) sorted by urgency then importance score
- Signal pills: Event, Deadline, Payment, RSVP, Awaiting — with dates and amounts
- Payment amount shown prominently when present

**Priority system (both dashboards):**
- Filled circle dot + coloured left card border — temperature ramp
- Low `#6B7A82` / Med `#C4A265` / High `#B8964E` / Urgent `#9C5E2B`
- Manual override sets `manualPriority: true` — AI won't overwrite on re-scan
- "Reset to AI" clears manual override

**Item expanded panel:**
- Slide-over from right
- AI title + detailed summary with bullets
- All participants shown in header (not just latest sender)
- From, received date, category, account
- Priority picker (Low/Med/High/Urgent)
- Calendar signal badges — show `on_cal`/`not_on_cal`/`ignored` state; tapping opens add/don't-add popover
- `matchedCalendarName` shown when event matched on non-Primary calendar ("In School Calendar")
- **Note to self** — private textarea, saves on blur, persists to Firestore `userNote` field
- Mark as Paid, Mark done, Undo
- Move to category
- **Re-analyse** in `...` menu — re-fetches thread, runs full classification + calendar check
- Ignore option in `...` menu

**Categorise modal:**
- 3-column compact grid; "Other" hidden from picker
- Step through uncategorised items; back/forward nav
- Ignore / Leave for now / Do the rest later
- `markItemClassified()` updates topbar count instantly via module-level Set
- `manualCategory: true` written on assign

**Sidebar:**
- Category list with live item count badges
- Views: Awaiting Reply, To categorise (amber badge), Ignored, Payment History
- Priority filter views: High & above, Urgent only
- Settings panel (theme, dark mode, font size, scan window, calendar preferences)
- Feedback + Privacy in footer

### 5.4 Calendar Integration

**Calendar check:**
- Runs after every scan and after every re-analyse
- Compares event/rsvp/deadline signals against Google Calendar events in a ±1 day window using fuzzy title matching
- **Check all calendars setting:** When enabled, fetches all writable calendars via `calendarList` API and checks each in parallel (not just Primary). Stored as `checkAllCalendars` on account doc. Configured in onboarding step 5 and in Settings → Calendar.
- `matchedCalendarName` stored on signal when matched on non-Primary calendar
- `SignalCalendarStatus`: `on_cal` | `not_on_cal` | `ignored` | `pending`
- Signal status syncs live from parent `onSnapshot` — no page refresh needed

### 5.5 Scan Architecture

**Two paths depending on scan type:**

**Incremental / manual (Vercel serverless, ~20s):**
Client → `triggerScan('manual'|'auto')` → `POST /api/gmail/scan` → reads OAuth token from Firestore (auto-refreshes if expired) → Gmail API → S1 classify → S2 signals → write to Firestore → calendar check → write `scanRun` doc → update `lastScanCompletedAt`

**Onboarding (Cloud Function, 60min timeout):**
`POST https://gmailscan-wel4wongwa-ew.a.run.app` — same logic, handles full 7–30 day window

**Dashboard 2.0 mount scan:**
On mount, reads `lastScanCompletedAt` from Firestore (survives page refresh). Triggers `triggerScan('auto')` only if > 10 minutes since last scan. Shows blur overlay during check with 1.5s minimum display.

### 5.6 Responsive Layout

- `>= 1024px` — full dashboard: sidebar + step sections + calendar column
- `768px–1023px` — hamburger sidebar as slide-over
- `< 768px` — bottom navigation bar, single-column cards

---

## 6. Privacy & Data Architecture

Email content is **never stored**. Only metadata is persisted.

**Stored:** Email provider message ID, sender name and email address, subject line, date received, AI-extracted signals, item status and priority, payment records, user categorisation decisions, AI-generated title/summary/detailed summary, participant names, user notes (`userNote`)

**Not stored:** Email body content, attachments, full thread content, raw email data

**Encryption:** All Firestore data encrypted via Google Cloud AES-256 at rest. Firestore hosted in `eur3` region (EU data residency). Field-level encryption planned for V2.

---

## 7. Responsive Layout & Theming

**Themes:** 3 themes — Harbour (default, warm maritime), Slate (cool professional), Obsidian (dark premium). Reduced from 10 in Session 5.

**Harbour brand colours:**
- Sidebar navy: `#1e3a4a`
- Brass accent: `#B8964E`
- Harbour Mist: `#E7E9E6`
- Confirm teal: `#3D7A6B`

**Button roles:** Primary (brass filled), Secondary (brass outline), Neutral (mist), Destructive (rust outline), Confirm (teal — Mark Done/Payment Recorded only)

---

## 8. Phase 2: Automatic Scanning (Planned)

Gmail Pub/Sub webhooks for ~5 minute latency background scanning. Works at the unverified OAuth tier (≤100 users). Requires:
1. Pub/Sub topic `keel-gmail-push` in `keel-6921a`
2. Gmail `watch()` per user on sign-in (7-day expiry)
3. Cloud Function push handler using `history.list` to fetch changed threads
4. Cloud Scheduler: weekly `watch()` renewal

OAuth scope used: `gmail.readonly` (non-sensitive — no security audit required).

---

## 9. Monetisation

**Primary model: Subscription**

| Feature | Free trial | Pro (£9/mo) | Premium (£15/mo) |
|---|---|---|---|
| Email accounts | 1 | 3 | Unlimited |
| Scan window | 7 days | 30 days | 90 days |
| AI summary | 1 sentence | 1 sentence | Full bullet breakdown |
| Historical re-scan | ❌ | ❌ | ✅ |
| Payment history export | ❌ | ✅ | ✅ |
| Priority support | ❌ | ❌ | ✅ |

---

## 10. Admin Console

**Current capabilities:**
- Per-user stats: items, signals, AI calls, scan frequency, category count
- AI cost breakdown: S1 / S2 / Reclassify — separate columns
- Firebase cost tracking: reads/writes per scan
- Infrastructure cost projections (Today / 50 / 100 / 500 / 1K / 5K / 10K users)
- Per-user scan run drill-down: last 50 runs with full cost/token/duration breakdown
- AI provider switcher: global, takes effect within 60 seconds
- **Dev Operations card:** Trigger scan, Re-analyse all active, Calendar check, Flush items+signals, Full account reset, Ping keel app — per-user, with error detail capture
- Full account reset: wipes all subcollections including `accounts/account_primary` — user goes through onboarding on next sign-in

**Admin API routes (keel-admin):**
- `GET /api/stats` — aggregate usage + per-user table
- `GET /api/scan-runs?uid=xxx` — last 50 scan runs for a given user
- `GET/POST /api/ai-config` — read/write active AI provider
- `POST /api/dev-ops` — dev operations proxy (requires `KEEL_APP_URL` env var)

---

## 11. Non-Functional Requirements

| Requirement | Detail |
|---|---|
| **Privacy** | Email content processed ephemerally; raw content never stored |
| **Latency** | Phase 2: dashboard reflects new emails within 5 minutes via Pub/Sub |
| **Responsiveness** | Full functionality from 375px to 1440px+ |
| **Onboarding** | New user sees first organised view within 5 minutes |
| **Encryption at rest** | AES-256 via Google Cloud; EU data residency (eur3) |
| **Field-level encryption** | V2 roadmap |
| **Data retention** | Resolved items: 12 months. Ignored: 90 days. Account deletion: 30-day purge. |
| **GDPR** | Right to access, export, and delete all stored data |
| **Serverless timeout** | Vercel: 5 min. Onboarding uses Cloud Function (60 min). Incremental scans (~20s) fine on Vercel. |
| **Auth persistence** | `browserLocalPersistence` explicit; `prompt: 'consent'` ensures refresh token always returned |

---

## 12. Competitive Landscape

No existing product fully addresses this spec.

**Closest competitors:** Gether (family calendar from forwarded emails), Fyxer (workplace email AI), 24me (traditional personal organiser), Google Gemini (platform risk).

**Key differentiators:**
- Gmail API native — no forwarding required
- Works for personal life, work life, or both in one inbox
- User-defined categories with AI learning
- Control tower philosophy — not a second inbox
- Awaiting reply tracker (no competitor equivalent)
- Payment tracking with history and CSV export
- Same-day transient items auto-suppressed
- Privacy positioning — email content never stored; EU data residency
- Note-to-self on any item
- All-calendars checking (family/shared calendars)

---

## 13. Build Status

### Completed ✅

**Sessions 1–4 (foundations, onboarding, deployment):**
- Firebase Auth + Google OAuth, Firestore data model, Gmail scan pipeline
- AI provider abstraction (Gemini 2.5 Flash default, ~$0.0008–0.002/scan)
- Onboarding flow (email type, categories, live scan feed)
- Dashboard 1.0 with category grid, signal pills, priority system
- Item expanded panel, payment tracking, awaiting reply tracker
- Admin console: costs, drill-down, provider switcher
- Production live: www.jaison.app + keel-admin.vercel.app + Cloud Function
- Full TypeScript cleanup

**Session 5 (2026-05-06):**
- **Dashboard 2.0** as default: step-based layout, floating white cards, coloured top borders
- **Scan blur overlay**: full-screen lock during initial check, 1.5s minimum, covers all UI
- **Step numbering**: Urgent=1, Awaiting Responses=2, High=3, Everything Else=4
- **Awaiting Responses section**: dedicated step 2 with steel blue accent
- **Categorise modal**: 3-col grid, Other hidden, instant count via `markItemClassified()`
- **manualCategory flag**: scan never overwrites user-assigned categories
- **Terminal status guard**: done/archived/paid never resurrected by scan
- **lastMessageInternalDate**: skip logic uses Gmail timestamp — replies always detected
- **Re-analyse single item**: full S1 + cal check + token refresh + 404 skip
- **Note to self**: `userNote` on KeelItem, textarea in expanded panel
- **All connected calendars**: setting + onboarding step 5
- **matchedCalendarName**: shown in expanded panel when matched on non-Primary calendar
- **Calendar auto-recheck**: `visibilitychange` listener — updates on return from GCal tab
- **Signal calStatus live sync**: onSnapshot propagates without page refresh
- **Admin Dev Operations**: 6 operations, user picker, error detail, full account reset
- **AI prompt quality**: real names, signal accuracy, NEXT STEP direction
- **Payment amount fix**: `detectedAmountPence` field mismatch resolved
- **All participants** shown in expanded panel header
- **Auth persistence fix**: `consent` prompt + explicit `browserLocalPersistence`
- **Dashboard 1.0** preserved at `/dashboard1`
- **Themes reduced** to 3 (Harbour, Slate, Obsidian)

### Backlog 📋

See `backlog.txt` for full list. Key items:

**Critical / pre-beta:**
1. Google OAuth app verification (≤100 users currently)
2. Security/GDPR doc
3. Replace privacy@keel.app placeholder
4. Firestore indexes (scanRuns, items)
5. `KEEL_APP_URL` env var in keel-admin Vercel

**Next major feature:**
- Phase 2: Gmail Pub/Sub webhooks for background scanning (~2–3 sessions)

---

## 14. Success Metrics

| Metric | Target |
|---|---|
| Time to first value (sign-in → first organised view) | < 5 minutes |
| % emails correctly auto-categorised (after 2 weeks) | > 85% |
| % date-relevant items correctly in calendar strip | > 90% |
| Categorisation prompt frequency (week 1 vs month 2) | > 60% reduction |
| Daily active return rate | > 3x per week |
| Free trial to paid conversion | > 25% |
| AI cost per user per month (Gemini Flash) | < £0.10 at typical usage |
| Infrastructure cost per user per month | < £0.10 at 1,000 users |

---

*Version 1.5 — Updated 2026-05-06 (Session 5). Key changes from v1.4: Dashboard 2.0 as default with step-based layout and scan blur overlay; Awaiting Responses as dedicated step; calendar checking across all connected calendars with onboarding step; re-analyse single item with auto token refresh; note-to-self feature; manualCategory and terminal status guards fix classification persistence; AI prompt quality improvements; admin Dev Operations card; auth persistence fix; themes reduced to 3; all participants in expanded panel.*
