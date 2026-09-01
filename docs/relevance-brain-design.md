# Design Document — The Relevance Brain
## Learning what matters to each user

**Status:** Stage 0 complete, Stage 1 in progress (2026-09-01). Stages 2–4 proposed.
**Last Updated:** 2026-09-01
**Owner:** Jason Humphries
**Related:** [PRD.md](PRD.md) §Vision, [architecture.txt](architecture.txt) §Scan Architecture

---

## 1. Problem

`classifyThread()` in `src/lib/scanUtils.ts` is a single ~6,000-token zero-shot prompt
that performs extraction *and* valuation in one pass, followed by ten hardcoded
post-hoc overrides (proximity, promotional, auto-pay, resolved, owner-never-replied,
event→deadline reclassification, and others).

The recent commit history is diagnostic:

```
dc7b50b feat: cover overdue items + broader feedback patterns
fe7b00b fix: reorder overrides — self-consistency runs before payment-made
99c65eb fix: tighten feedback-request patterns + revert-and-reevaluate for stale over-fires
6f31f96 feat: feedback-request auto-quiet + hide promo/feedback from To Categorise
5c0428e fix: self-consistency override — high-precision only, no more org-name false-fires
```

Every one is the same shape: tighten a regex, reorder an override, revert a rule that
over-fired. The system has no memory, so each new piece of judgement must be encoded as
another global paragraph or another string match — a blunt instrument that fires for
every user on every email.

### 1.1 Three structural problems

**Extraction and valuation are fused.** *"This thread contains a £117.50 payment dated
26 June"* is objective and identical for every user. *"This matters to Jason at 0.88"*
is subjective and personal. They are produced by one call and stored as one number.

**`aiImportanceScore` conflates three independent quantities** — time proximity,
consequence-if-missed, and personal relevance. Two of these are computable; only the
third requires learning. The current design attempts to teach all three through prose.

**Every user label is discarded.** Recategorise, ignore-sender, mark-done, snooze,
`manualPriority`, expand-and-read, and above all *reply behaviour* are all ground truth
about what matters. Only `categoryHints` and `ignoredSenders` survive, and they feed
category choice alone — never priority.

---

## 2. Design principles

1. **Only one layer learns.** Extraction and deterministic scoring stay global and
   identical for all users. This is what stops the shared prompt growing forever.
2. **Prefer code to prose.** Anything computable from structured facts becomes a tested
   TypeScript function, not a paragraph of prompt.
3. **Never promote an unmeasured rule.** Learned changes are candidates until they beat
   a frozen evaluation set.
4. **Every score is explainable.** A priority carries the terms that produced it.
5. **One implementation.** No classification logic is ever duplicated across codebases.

---

## 3. Architecture

Five layers. Only **L3** is per-user.

### L1 — Extraction (global, cacheable)

The model reads the thread and emits objective facts only: correspondence type,
obligations present, who is on the hook, dates, amounts, entities, resolution state.
**No score.**

The prompt shrinks by more than half — every *"score 0.72–0.78 if…"* table moves out.
Because it is identical for all users it is testable, cacheable, and safe to run on
cheap models.

### L2 — Deterministic scoring (global, code not prompt)

- **Urgency** — a pure function of `detectedDate - now` and signal type.
- **Consequence** — a small lookup over extraction facts
  (overdue payment > invoice > receipt).

Written as TypeScript with unit tests. Most current overrides — proximity, auto-pay,
resolved, receipt-vs-invoice — stop being *corrections applied after the AI got it
wrong* and become the primary computation. These are the parts that can be proven
correct.

### L3 — Relevance (per-user, learned)

The only layer that learns. A relevance multiplier derived from sender affinity, entity
salience (*Paxton*, *Bedales*, *Digby Fine English*), category weight, and thread
participation history.

```
priority = f(urgency, consequence, relevance)
```

Three inspectable inputs instead of one opaque number.

### L4 — Evidence log (append-only)

Every user action becomes a labelled event:

```ts
{ itemId, action, priorScore, extractionFacts, timestamp }
```

Actions already available and currently discarded:

| Action | Signal |
|---|---|
| Reply (and latency) | Strongest relevance signal available |
| Recategorise | Category correction |
| Ignore sender | Hard negative |
| Mark done | Was actionable, now resolved |
| Dismiss without opening | Right category, no value |
| **Snooze** | Right item, *wrong time* — distinct and valuable |
| `manualPriority` up-rank | Explicit under-scoring |
| Expand / read | Attention without action |
| Time-to-action | Urgency calibration |
| Calendar accept | Signal was real |
| Open feedback box | Explicit, rare, low-quality |

### L5 — Reflection (slow loop)

A weekly job reads the evidence log and updates two representations:

**Structured priors** — numeric, Bayesian-smoothed against a prior so a single dismissal
cannot tank a sender. Updated continuously, no LLM, cheap.

**Narrative profile** — markdown, LLM-generated, injected into L1/L3 prompts:

> Jason replies to Bedales within the hour. Anything mentioning Paxton or Ottilie is
> family-critical. He never acts on Trainline disruption alerts. He treats supplier
> invoices as auto-pay unless the amount exceeds £500.

---

## 4. Safety mechanisms

Without these, this is another whack-a-mole layer with more moving parts.

### 4.1 Golden set and eval harness — build first

Approximately 200 real threads with the user's judgement frozen against them. Every
prompt edit, new rule, and promoted profile line runs against it and reports
precision/recall on urgent-vs-quiet.

Without this it is impossible to distinguish *"this rule helped"* from *"this rule
helped the one email I happened to be looking at"*. Commit `99c65eb`
("revert-and-reevaluate for stale over-fires") is what happens in its absence.

**This is the highest-leverage single artefact in the design.**

Thread bodies must be stored frozen, not re-fetched from Gmail — tokens expire and
threads change. A few KB per thread against Firestore's 1 MB document limit.

### 4.2 Candidate rules, not applied rules

A proposed profile change does not take effect. It is shadow-scored against held-out
past items first and promoted only if it improves. This converts *"I noticed you
dismissed three Trainline emails"* from a risky global edit into a measured update.

### 4.3 Provenance

Every score carries its terms:

> Scored 0.88 — deadline in 2 days; sender affinity high; you replied to 4 of Bedales'
> last 4 emails.

This gives the feedback box something concrete to argue with and gives us a debugging
story. Today the `console.warn` lines are the only trace and they are not user-visible.

---

## 5. Cold start

Months of in-app feedback are not required to bootstrap. **Gmail already holds years of
reply behaviour.**

A one-off onboarding pass over 12 months of sent mail yields, before the user clicks
anything: which senders they reply to, how fast, at what length, which threads they
abandoned, which they escalated. Reply latency is the strongest available relevance
signal and it is free.

This alone should produce a better L3 on day one than the current global prompt achieves
after tuning.

**Cost profile:** metadata-only. Gmail `format: metadata` for from/to/date/threadId — no
body decoding, no LLM. Roughly 5,000 sent messages ≈ 25,000 quota units against a
250/user/second budget. Build it cursor-resumable across invocations and platform
timeouts stop mattering.

---

## 6. Data model

```
users/{uid}/brain/profile          — narrative markdown, version, promotedAt
users/{uid}/brain/priors           — denormalised summary (see §7.2)
users/{uid}/priors/{senderEmail}   — { replyRate, avgLatencyHrs, dismissRate, n }
users/{uid}/entities/{slug}        — { name, kind, salience, aliases }
users/{uid}/feedback/{eventId}     — append-only evidence log
users/{uid}/evals/goldenSet/{id}   — frozen thread bodies + user judgement
```

### 6.1 Security rules change required

Current rules grant blanket `read, write` on `users/{userId}/**`. This is wrong for the
brain — the user's own browser could rewrite their learned model, and a client bug could
silently corrupt it.

- `feedback/**` → `allow create` only. No update, no delete. Append-only is the point.
- `brain/**`, `priors/**` → client read, **no client write**. Admin SDK only.

---

## 7. Infrastructure impact

**No new services.** All five layers run on the existing stack.

### 7.1 Current stack

| Layer | Where | What |
|---|---|---|
| App + API routes | Vercel (Next 16, Hobby) | interactive scan, calendar, auth, `scanUtils.ts`, `aiComplete.ts` |
| Data | Firestore `eur3` | everything |
| Triggers + crons | Firebase Functions `europe-west1` | Pub/Sub Gmail notify, `renewGmailWatches` (6d), `nightlyItemExpiry` (nightly) |
| Models | Anthropic + Google | switchable via `/config/aiProvider` |

`functions/src/backgroundScan.ts` is a **thin trigger** — it receives the Pub/Sub message
and POSTs to `/api/gmail/background-scan` on Vercel, doing zero AI work itself. This is
the correct pattern and the brain follows it. Cloud Functions never need to grow.

### 7.2 Per-layer impact

| Layer | Infrastructure needed |
|---|---|
| L1/L2 split | None. Prompt shrinks; scoring becomes TypeScript. *Reduces* per-scan token cost. |
| L3 priors | None. One extra Firestore read per scan — see below. |
| L4 evidence log | None. New collection + rules change. |
| L5 reflection | One new weekly cron. |
| Backfill | Reuse existing long-scan Cloud Function (`NEXT_PUBLIC_SCAN_FUNCTION_URL`, 60 min timeout). |

**Prior read cost.** Do not read N sender-prior documents per scan. The reflection job
denormalises into a single `brain/priors` summary document so scan-time cost is one extra
read. This matters because background-scan runs per Pub/Sub message under a 60s timeout
at 256 MiB.

### 7.3 Decision — reflection cron on Vercel, not Firebase

`functions/src/scan.ts` carries its own inlined copy of `classifyThread`,
`BUILTIN_DESCRIPTIONS` and the full prompt. It has **zero of the ten overrides** present
in `scanUtils.ts` and an older six-argument signature missing `isOutbound` /
`ownerHasReplied`. The onboarding path — where a new user forms their entire first
impression — runs a classifier months behind the tuned one. The header comment on
`scanUtils.ts:8` claiming all scan routes share identical prompts is no longer true.

*(Being addressed separately — see §10.)*

The reflection job needs `aiComplete`, the extraction types, and the scoring functions.
Duplicating those into `functions/` is precisely the mistake that produced that drift.
Keep one implementation in `src/lib/`, on Vercel:

```json
{ "crons": [{ "path": "/api/brain/reflect", "schedule": "0 4 * * 1" }] }
```

There is no `vercel.json` or `vercel.ts` today — this would be the first. Use `vercel.ts`
(typed, and needed later regardless). Guard the route with `ADMIN_SECRET`, matching the
existing admin route pattern.

The Firestore co-location argument loses here: reflection reads one summary document and
makes one LLM call. It is not chatty.

**Hobby plan caveat.** Vercel Hobby permits 2 cron jobs at at-most-daily frequency, and
invocation may be delayed by up to an hour. A weekly reflection fits comfortably. If the
cron budget becomes tight, fall back to a third Firebase `onSchedule` that POSTs to the
same guarded Vercel route — preserving the thin-trigger pattern and the single
implementation.

### 7.4 What not to build

- **No vector database.** Keel needs a preference model, not corpus retrieval. gbrain
  needs embeddings because it does semantic search over hundreds of pages; Keel's brain
  is a profile small enough to sit in a prompt. This is the most tempting wrong turn.
- **No warehouse or analytics service.** The feedback log is queried by one weekly job.
- **No queue.** Pub/Sub already covers the event path; reflection is a cron.
- **No Postgres or Redis.** Firestore covers priors, profile, evidence, and golden set.

### 7.5 Missing prerequisite — test framework

There is no test framework in the repository. Extracting L2 into TypeScript is only
worthwhile if it is tested; otherwise the whack-a-mole simply moves from prose into code.
Add `vitest`. A dev dependency rather than a service, but load-bearing for the plan.

### 7.6 Cost

Approximately nothing. Tens of extra Firestore writes per user per day; one LLM call per
user per week; a one-off metadata backfill at onboarding. The L1/L2 prompt split likely
nets *negative* against current per-scan spend.

---

## 8. Relationship to gbrain

Borrow the pattern; do not share the instance.

gbrain is a retrieval-oriented knowledge graph serving a single principal's company
world. Keel needs a preference model and a scoring function — a different problem.
Coupling a consumer multi-tenant app to a personal RG brain is wrong on both privacy and
shape.

**What transfers:**

- **Markdown pages with a `## Facts` fence** as the profile storage format — readable,
  hand-editable, diffable, and deterministically ingestable without an LLM.
- **Entity pages.** Keel scores far better knowing Paxton is a child and Bedales is his
  school. That is exactly gbrain's page model, scoped per household.
- **Write-it-down-same-turn** → log the evidence event in the same transaction as the
  user action.
- **Verify-before-claiming-done** → shadow-eval before promoting a rule.

**Possible future bridge:** a household brain per Keel user, same shape as gbrain's,
which Keel reads and writes. One-directional, separate instance. Not now.

---

## 9. Staged plan

| Stage | Work | Why this order |
|---|---|---|
| **0** ✅ | Evidence log (L4) — *shipped* | Changes no behaviour, costs nothing, but **you cannot learn from data you never recorded**. Every week of delay is a week of labels lost. A few lines at each existing `updateDoc` site in `ItemExpandedPanel.tsx` and `CategoryGrid.tsx`. |
| **1** ◐ | Golden set + eval harness + vitest — *vitest + override suite done; golden set next* | Nothing after this is safe to ship without it. Run as a local script in `src/scripts/` — it is a dev tool, not a product feature. |
| **2** | Split the score (L1/L2) | Makes relevance separable, shrinks the prompt, converts overrides into tested functions. |
| **3** | Historical backfill → priors (L3) | Bootstraps relevance from data already in Gmail. |
| **4** | Narrative profile + reflection (L5) | The slow loop. Last, because it is the only part that can regress silently. |

### 9.1 Stage 0 as built

`src/lib/feedbackLog.ts` — 21 actions across 7 surfaces, 30 instrumented call sites.

Decisions made during implementation, worth carrying forward:

- **Fire-and-forget.** `logFeedback` never throws and is called as `void logFeedback(...)`
  beside the write it accompanies. A failed label is a lost label, never a broken
  user action.
- **Events are self-contained.** Each event snapshots `prior` (score, status,
  category, `manualPriority`, `autoQuietedReason`) and `facts` (sender, domain,
  `ageHours`, signal types, days to nearest future signal). Reflection runs weeks
  later, by which time the item may be re-classified, merged or gone.
- **`prior.score` + action is the training label.** Without the score we held at the
  moment of the action, an event says only "something happened".
- **Direction, not just occurrence.** A priority change is recorded as
  `priority_raised` / `priority_lowered` / `priority_reset`, never "priority touched".
- **Cascades are flagged.** Cluster mark-done and auto-classify siblings carry
  `detail.cascaded` and `detail.leadItemId` — the user judged the lead item, not each
  follower, and reflection must down-weight them.
- **`opened` is deduped per item per session.** Highest-volume action by far;
  re-expanding the same item in one sitting carries no new information.
- **`restored_from_quiet` is the highest-value event in the log.** It says an auto-quiet
  rule mis-fired, and `prior.autoQuietedReason` names which one.
- **`dismissed_unopened` is derived, not emitted.** The client only knows about opens
  in the current session; reflection joins a resolve against the absence of any prior
  `opened` event.

The security-rules restructure (§6.1) was the substantive part. The previous blanket
`users/{userId}/{document=**}` grant had to be replaced with eleven enumerated
collection rules, because Firestore ORs matching rules together — a blanket allow-write
silently defeats any append-only rule beneath it. **Adding a new client-written
collection now requires adding a line to `firestore.rules`.**

That footgun is guarded by `src/scripts/rules-check.mjs` (`npm run test:rules`), which
runs 44 assertions against the Firestore emulator: all eleven existing collections still
readable and writable by their owner; the evidence log accepting creates but rejecting
updates, deletes and malformed events; `brain`/`priors`/`entities` client-readable but
never client-writable; `evals` invisible to the client; and cross-user and anonymous
access denied throughout. Run it after any rules change and before deploying.

This is the first automated test in the repository. Stage 1's harness should build on it
rather than beside it.

### 9.2 Stage 1 progress — the override suite

`vitest` is in (`npm test`), and `src/lib/__tests__/scanUtils.overrides.test.ts` pins
`applyPostClassificationOverrides` with 53 tests. That function was the right first
target: it is pure, it needs no AI call, and it is where every regression in the recent
commit history happened.

Tests marked REGRESSION cite the commit whose bug they lock down — `7903287`
(accounting language wrongly read as a discount), `fe7b00b` (self-consistency must run
before payment-made), `99c65eb` and `dc7b50b` (feedback-request precision).

**The suite was mutation-tested**, because a green suite proves nothing on its own.
Five bugs were reintroduced one at a time; every one was caught:

| Reintroduced bug | Tests failed |
|---|---|
| `7903287` promo regex accepting `back\|credit` | 3 |
| proximity losing its past-date guard | 1 |
| feedback-request weakened to the bare verb "review" | 3 |
| event→deadline reclassification disabled | 3 |
| payment-made allowed to clobber self-consistency | 1 (the `fe7b00b` test) |

**One finding, deliberately not fixed.** The actor-detection heuristic stands in "two
capitalised words" for "is a person". `5c0428e` stopped it firing on single-word org
names (LinkedIn), but two-word ones still read as human: *"Companies House needs to
process the filing"* flips the item to `awaiting_reply`. Same class for "Royal Mail",
"Land Registry", "Student Finance". Related: `_passiveOwnerRe` offers
`([A-Z][a-z]+|[a-z]+)` but is tested against a lowercased string, so the capitalised
alternative is unreachable and any noun after "waiting for" matches.

Both are characterised in tests rather than corrected. Changing them alters live
classification, and there is no golden set yet to show the change is an improvement —
which is the whole argument of §4.1. Fix them once they can be measured.

### 9.2.1 Recon findings — 2026-09-01

Running the harvest against production (5,871 items, 3 accounts) invalidated two
assumptions in this document. Recorded here because they change what Stage 1 is for.

**1. The overrides reach roughly a third of the corpus.**

`overridesVersion` stamp coverage: **0/283, 0/2042, 1569/3546**.

`classifyThread` in `src/lib/scanUtils.ts` applies the overrides internally, so the
Vercel scan routes get them. `functions/src/scan.ts` — the Cloud Function behind
onboarding and long scans — carries its own inlined `classifyThread` with **none** of
them. Two of the three accounts have therefore never had a single override applied.
The distribution matches exactly: only the account that also receives incremental
Vercel scans has meaningful rule-attributed quiets.

Five commits of override tuning have never reached two thirds of the data.

**2. Overrides account for ~3% of quieting.**

90% of all items (5,291 of 5,871) are `quietly_logged`. Of those, only **180** carry an
`autoQuietedReason` — 104 promotional, 33 feedback_request, 17 on_calendar,
7 sender_ignored, plus 19 on a second account. The other **5,111 have no recorded
reason at all**.

That is a provenance gap. **Correction to an earlier draft of this section:** the
expiry paths were never silent — `nightlyItemExpiry` and the expire-items route both
already stamp `expiredBy` (`nightly_expiry_stale`, `expire_on_scan_past_event`, …).
What was missing was a *unified* field and any marker at all on the model's own quiets,
so the recon's first pass read only `autoQuietedReason` and reported everything else as
unattributed. The real unattributed population is smaller than 5,111; re-running the
recon now that it reads all three fields will give the true figure.

The gap that remains is real: three partial markers, no single answer to *"who
silenced this?"*, and nothing at all when the model quiets an item at scan time.

**Fixed (2026-09-01):** a `quietedBy` field now stamps every route to
`quietly_logged` — `ai`, `rule:*`, `expiry:*`, `user:*`. It is deliberately separate
from `autoQuietedReason`, which only ever names an override rule and is load-bearing
for `useRecentPromotionalOffers`, `restore-cal-quieted` and `reapply-overrides`;
repurposing it would have broken those. The recon falls back to `autoQuietedReason` and
`expiredBy` so the pre-provenance corpus stays attributable.

**3. One account's scoring is uncalibrated.** uid Zwq… has 1,420 of 2,042 items in
band 3 (High) — 70%. A band that holds 70% of everything carries no information.

**4. The harvest yields 22 usable labels, not 200.** `marked_done` was 90% of the
original 227 and is non-discriminating (everything actionable is eventually done).
Excluded by default. §4.1's assumption — that a golden set can be harvested from
implicit judgement — does not survive contact with the data. The harvest is a *seed*;
the set has to be deliberately labelled.

### 9.2.2 Revised Stage 1 order

1. **Fix the duplicate classifier** so overrides reach every item (already in flight).
2. **Stamp provenance on every quiet transition** — expiry, AI, rule. Cheap, and
   nothing downstream is measurable without it.
3. **Then label.** The 180 rule-quieted items are small enough to review in full rather
   than sample, giving exact precision per rule; add a stratified sample of the
   no-reason quiets to test whether the model over-quiets.

Measuring the rules before (1) and (2) would measure a third of the corpus and call it
the whole.

### 9.3 On the feedback box

The open feedback box is the most obvious feature and the least valuable evidence source.
Users rarely complete it, and when they do they explain badly.

Its real job is **provenance** — showing *"scored 0.88 because: deadline in 2 days; you
replied to 4 of Bedales' last 4 emails"* and letting the user argue with a specific term.
That requires L2/L3 to be separable first. Another reason to split the score before
building the box.

---

## 10. Dependencies and open questions

**Prerequisite (in progress):** eliminate the duplicated classifier in
`functions/src/scan.ts`. The brain assumes exactly one classification implementation.

**Open:**

1. Does the narrative profile go into the L1 extraction prompt, the L3 relevance step, or
   both? Putting it in L1 risks contaminating objective extraction with preference.
   *Leaning: L3 only.*
2. How are entities extracted and de-duplicated? Household members, schools, and
   suppliers need stable identity across senders and spellings.
3. Snooze semantics — does a snooze decrease relevance, or only shift urgency? These
   pull in opposite directions and the evidence log must capture enough to tell them
   apart.
4. Multi-account users: one brain or one per connected account? The PRD anticipates
   multiple accounts; personal and work relevance models are plausibly distinct.
5. Golden set size and refresh policy. 200 threads is a guess; it should be sized from
   the variance observed on the first eval runs.
