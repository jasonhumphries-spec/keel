# Design Document — The Relevance Brain
## Learning what matters to each user

**Status:** Stage 0 complete; Stage 1 in progress; Stage 3 backfill built (2026-09-02). Stages 2 & 4 proposed.
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
cannot tank a sender. Updated continuously, no LLM, cheap. The smoothing is
**hierarchical and per-user** — `sender ← domain ← user ← global` — see §5.1.

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

### 5.1 Prior parameters — measured, not chosen (2026-09-02)

The first implementation used one global beta prior with mean 0.25, picked before any
data existed. A 12-month walk over the personal account measured the real base rate at
**2.4%** — 333 replies across 13,916 inbound threads, 8 clean monthly slices, zero
dropped threads. The chosen prior was **~10× too high**, and wrong in the worst
direction: it inflated every unknown sender, for a system whose main job is suppressing
noise.

A single per-user rate is still too crude. The sender population is **bimodal**: roughly
1,250 bulk senders near 0% and ~150 human correspondents at 50–100%. A beta fitted to
that mixture describes neither, and applying the 2.4% mixture mean to a new human
correspondent under-scores them badly.

So each level is shrunk toward its parent. What that does to real senders:

| Unseen address at | Domain rate | New prior | Old flat prior |
|---|---|---|---|
| dorsethouseschool.com | 0.128 (22/164) | **0.102** | 0.200 |
| bedales.org.uk | 0.172 (2/3) | **0.138** | 0.200 |
| linkedin.com | 0.0002 (0/960) | **0.0002** | 0.200 |
| amazon.co.uk | 0.0004 (0/588) | **0.0003** | 0.200 |

A first email from an unseen school address starts ~500× above one from an unseen
LinkedIn address, on identical evidence. Under the flat prior both started at 0.200.
That discrimination on day one, before any feedback exists, is the entire point of a
cold-start prior.

**Parameters.** `globalBaseRate` is an estimate (0.03, from observation). The weights
are policy — how much evidence before a level is trusted over its parent: `userWeight`
200 (a user with 200 threads cannot yet characterise themselves), `domainWeight` 10,
`senderWeight` 4. Each level records the `priorMean` it was shrunk toward, so a score
can be explained rather than asserted — the same discipline as quiet provenance.

**Counts are durable; rates are derived.** `smoothedReplyRate` depends on the whole
hierarchy, so it cannot be merged pairwise across resumable runs. Store the counts and
recompute.

### 5.2 Wiring the priors into scoring (2026-09-03)

The backfill wrote 1,554 priors and nothing read them. They are now loaded once per
scan (a whole-collection read, consulted in memory — a per-thread lookup would be one
Firestore read per item on a 60s Pub/Sub path) and applied as a **bounded lift** to
`aiImportanceScore`, with `senderPriorRate`, `senderPriorSource` and `senderPriorLift`
stored on the item so a priority can be explained rather than asserted.

**Two guard rails, both from measurement.** The lift is capped at 0.08 and cannot move
an item across more than one band: sender engagement scored 32% recall / 50% precision
against the 371 labels (§10.2), and a weak signal must not behave like a strong one.
And it **lifts only, never suppresses** — a reply rate is blind to `noreply@` senders,
where the statutory obligations live, so pushing unengaged senders down would bury
exactly the class the labels showed matters most. Evidence is also damped below ~10
observed threads, and engagement near the 2.4% base rate earns nothing.

**Measured before shipping**, against the 371 labels:

| | mean lift | lifted at all |
|---|---|---|
| Should have stayed (86) | 0.0030 | 42% |
| Fine to bury (285) | 0.0006 | 8% |

A **4.6× ratio** in favour of the right class — the signal points the right way. But
**zero band changes across all 371 items**: as calibrated this reorders within a band
and changes nothing structural. That is the intended conservatism, and it is also the
honest limit of what it buys today.

**The larger win is not here.** A post-hoc nudge is the weakest possible use of this
data. Feeding engagement into the classification prompt — so the model weighs "you
answer this sender within the hour" while reading the thread — is where it should
earn its keep. That is Stage 2 work, and it is not measurable until the score is split
into extraction and valuation.

**Still open:** `FAST_REPLY_MS` is a hard-coded 4 hours. It should be a percentile of
the user's own latency distribution — close correspondents on the personal account sit
at 0.1–2h, where another user's "fast" might be a day.

**Measurement caveat.** 8 of 12 monthly slices completed; the local dev server died
during the other four. Monthly reply rate ranged 0.35%–3.93%, so the base rate may
shift with the remaining months. It will not shift by the order of magnitude that would
rehabilitate 0.25.

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
| **3** ◐ | Historical backfill → priors (L3) — *built, not yet run* | Bootstraps relevance from data already in Gmail. |
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

### 9.5 Stage 4 built — reflection, generation only (2026-09-03)

`src/lib/server/reflection.ts` and `/api/brain/reflect` turn the evidence log into a
candidate narrative profile.

**The input is the LOG, not the mail.** Reflection reads action counts, sender
addresses and rule-override tallies — never bodies, subjects or summaries. This is a
security decision before a design one: the profile is destined for a prompt, so
anything in it is effectively an instruction, and keeping mail content out closes the
path from a stranger's email to the classifier's behaviour. A regex guard rejects
instruction-like candidates as belt-and-braces; the first version of it allowed one
modifier word and missed *"ignore all previous instructions"*, which is worth
remembering — a guard that is too narrow reads as protection while providing none.

**Generation and promotion are separate, and only generation is built.** A candidate is
written, versioned and shown; nothing reads it. This is the one layer that regresses
silently — a wrong score is on screen, a buried item is countable, but a profile that
has drifted into a false belief produces fluent output that is quietly worse.

**The evidence threshold is 150 events and the log holds 25.** So on real data the
route correctly refuses:

```
{ generated: false, reason: "only 25 events; need 150" }
```

Forced for inspection, the candidate demonstrates exactly why the threshold exists:

> - This person opened 10 emails and marked 7 as done.
> - They restored 2 emails from quiet, specifically from donotreply@sbc.sage.com and
>   kmk1001@cam.ac.uk.
> - They dismissed 2 emails from temu@eu.temuemail.com.

Accurate, grounded, and useless — it is a transcript of a single afternoon, not a
profile. It reports *"marked emails from googledevelopers-noreply@google.com as done
twice"* as though that were a preference. **Stage 4 is built and cannot yet do its
job**; it needs months of ordinary use, not more code.

**Still to build:** promotion gated on a shadow score against the 371 labels, and
injection into the L1/L3 prompts. Neither is worth writing until a profile exists that
is worth promoting.

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

## 9.4 Stage 2 — the split, and what the shadow run showed (2026-09-03)

`src/lib/scoring.ts` (L2) and `src/lib/extraction.ts` (L1) split the single-pass
classifier in two: the model reports objective facts, code computes the score. Every
threshold was **ported, not redesigned** — making current behaviour testable and
changing it at once would be impossible to evaluate.

**Porting found a contradiction in the prompt.** One rule reads *"Event, appointment,
commitment, or deadline due TODAY or TOMORROW — proximity alone justifies Urgent"*
(0.88–0.92). Another reads *"Upcoming confirmed event within 7 days — even if no
action required … today/tomorrow = 0.78"* (High). Both use **"a match tomorrow"** as
their example and give different answers. Resolved toward the more specific rule: what
makes something Urgent is a required action, not a nearby date. That ambiguity has
presumably been producing inconsistent scores for months, and no test could catch it
while it lived in prose.

**Shadow run over all 371 labelled items** (`npm run eval:shadow`, nothing written,
nothing switched):

| | old prompt | split |
|---|---|---|
| mean score, should have stayed (86) | 0.754 | **0.788** |
| mean score, fine to bury (285) | 0.776 | **0.543** |
| **separation** | **−0.022** | **+0.245** |

Band agreement with the current prompt is only **44%** — the split disagrees often.
That is the point, because **the current prompt's separation is negative**: across the
items a human labelled, it scores the ones that mattered *very slightly lower* than the
ones that did not. Its ranking within this set carries no information at all. The split
separates them by 0.245.

**Caveats that keep this honest.** Extraction ran over the old prompt's *summaries*,
not raw threads — a lossy paraphrase — so agreement here is a lower bound on what the
split would do with real text. And all 371 items are High/Urgent by construction, so
this measures ranking *within* a compressed band, not across the whole corpus. It is
strong evidence the split is better where it was measured, not proof it is better
everywhere.

**Obligation mix extracted:** `action_required` 168, `informational` 64, `overdue` 62,
`response_due` 32, `resolved` 16, `receipt` 14, `scheduled` 8, `payment_due` 7.

**Not switched.** The live classifier is unchanged. Switching needs a comparison over
raw threads across all bands, not just the buried High/Urgent ones.

## 10. The stale-expiry fix — measured, then specified (2026-09-02)

### 10.1 What the labels say

All 371 High/Urgent items silenced by `expire_on_scan_stale` were hand-labelled in a
review artifact. Not an estimate:

| Band | n | Should have stayed | Rate | 95% CI |
|---|---|---|---|---|
| Urgent | 103 | 13 | 12.6% | 8–20% |
| High | 268 | 73 | **27.2%** | 22–33% |
| **Total** | **371** | **86** | **23.2%** | 19–28% |

High items are wrongly buried at **more than twice** the rate of Urgent ones. Urgent
items are mostly either genuinely handled or genuinely noise; High is where real
obligations go to die.

### 10.2 Four predicates, all short of shippable

Every result below is on the same held-out third (`FNV-1a(itemId) % 3`, deterministic,
stable as labels accumulate). Definitions: **recall** = of the items that should have
stayed, how many the rule rescues — this is the expensive error, a missed statutory
filing. **Precision** = of the items the rule keeps, how many actually mattered — this
is the noise error, and it erodes trust in the dashboard.

| Rule | Recall | Precision | F1 |
|---|---|---|---|
| Sender reply prior ≥ 0.15 | 32% | 50% | 0.39 |
| Learned obligation keywords | 52% | 45% | 0.48 |
| Content OR sender | 60% | 42% | 0.49 |
| Ask the model — v1 "is a task open?" | **80%** | 26% | 0.40 |
| Ask the model — v2 "what does it cost to never act?" | 76% | 35% | 0.47 |

Each failure was informative:

- **The sender prior is blind to `noreply@`**, which is exactly where machine-generated
  obligations live. `irisopenspace` sent seven e-signature requests across 23 threads
  with zero replies; Companies House rejected a Resonant Grid filing. Replying is not
  the action, so no reply-rate threshold can ever reach them.
- **Learned keywords collapsed 69% → 52% recall** from train to test. The terms it
  learned were `openspace`, `iris`, `accountants`, `seymour` — it memorised *which
  institutions matter to this user* and presented it as content analysis. A sender rule
  in a content costume.
- **The model at v1 was technically correct and still wrong.** *"Respond to the Vinted
  offer"* is a genuine open task; the user buried it. The dividing line in the labels is
  **consequence**, not openness. v2 asks what it costs to never act, which cut wrongly-kept
  items 56 → 36 while holding recall. v2 shows no train/test gap, so the gain is real.

**The ceiling is in the framing, not the parameters.** Four attempts to find a predicate
that decides keep-vs-bury, best F1 0.49. The answer is to stop deciding.

### 10.3 Spec — a review queue, not a predicate

The bug was never "the exemption rule is miscalibrated". It is that **a timer silently
overrides a judgement the classifier already made**. The item was read, scored High, and
then deleted from view by a `Date.now()` comparison that consulted nothing.

So: stop deleting. Surface instead, and use v2 to *rank* rather than to *decide* — at
76% recall it is more than good enough to order a list, and its 35% precision stops
mattering when a human is doing the final pass.

**Behaviour.** `expire_on_scan_stale` and `nightly_expiry_stale` keep quieting Low and
Medium items exactly as now. For High and Urgent they still set `quietly_logged` — no new
status, no migration — but additionally stamp a review score. The existing
`/quietly-logged` page gains a "Buried this month" section filtered to
`quietedBy == 'expiry:stale'` with a High/Urgent band, ordered by that score.

**Fields** (on `KeelItem`):

```
expiryReviewScore   0–1, the model's judgement at expiry time
expiryReviewReason  the six-word why, shown in the list
expiryReviewedAt    when it was asked
```

**Cost.** One Flash call per High/Urgent stale expiry. Measured rate: 371 over twelve
months on the personal account, ~31/month, ~500 input tokens each. Pennies per year, and
it runs once per item at expiry rather than on every scan. Low/Medium items are never
asked about — there is no evidence they matter.

**Expected effect on this corpus.** 371 items a year would surface for review instead of
vanishing. Ranked by v2, the ~86 that mattered cluster at the top. One glance a month
recovers what the timer currently costs.

**Where the labels live.** Two independent copies, because one is not a backup:
`users/{uid}/evals/goldenSet/entries` (verdict merged onto the frozen thread text, so
each entry is re-runnable on its own) and `snapshots/goldenset-labels-*.json`
(gitignored — real mail metadata — but survives both the database and the review
artifact being deleted). Restore either with `npm run eval:save-labels`.

**How it gets measured.** The 371 labels are the eval. A change to the ranking is
scored with `npm run eval:llm` against them before it ships — the first time this project
can answer "did that help?" with a number rather than an anecdote.

**Open.** Whether to notify at all, or leave it as a passive list. A monthly digest risks
becoming another ignored email; the passive list risks never being looked at. Worth
deciding from use rather than from argument.

## 11. Dependencies and open questions

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

## 11. Calendar matching — participants, not prose

Two defects, found by resetting an account and onboarding it fresh. Neither is visible
in steady-state use, which is why both had survived.

**The check was never running.** `runCalendarCheck` was dispatched fire-and-forget after
the scan response was built. On a serverless runtime that is a race with the freeze: the
handler returns, the instance can be reclaimed, and the in-flight check dies. Nothing is
logged, because the failure is the process going away. Every signal kept
`calendarStatus: null`, and the UI reads null as "not on the calendar" — so it offered
"Add to calendar" for meetings that were already there, which reads as a matching bug and
sends you looking in the wrong file. Now awaited, still non-fatal.

**Same-day title matching cannot find a proposed meeting.** The observed case: mail from
`Joseph1.Guo@landisgyr.com` proposing a meeting on 2 Sept; calendar entry
"Resonant Grid | L+G - Sync Up" on 9 Sept, organised by `joseph1.guo@landisgyr.com`. The
matcher required an event on the signal's date and compared it against the signal
description. Both fail, and they fail for the whole class: a "shall we meet Wednesday?"
thread carries the one date guaranteed to be wrong once the meeting is booked, under a
title chosen by whoever created it.

The unused evidence was the event's own attendee list — an exact address match, sitting
in a field the check never fetched.

### Why participants are evidence and not a gate

The obvious design is to require the sender to be on the event. That is wrong often
enough to matter: invitations come from assistants, booking systems, no-reply addresses
and colleagues forwarding someone else's thread, and in none of those cases does the
sender attend. Equally, one sender may have several meetings in the window, so an address
match alone cannot say *which*.

So each signal contributes weight, and confidence requires agreement:

| Signal | Weight | Independent? |
|---|---|---|
| Sender is organiser or attendee | 0.45 | yes |
| Sender's *domain* is on the event | 0.20 | yes |
| Graded title overlap (8+ char words count double) | ×0.35 | yes if > 0 |
| Sender's domain appears in the event title | 0.15 | yes |
| Date proximity, decaying across ±30 days | ×0.20 | only within 3 days |

`on_cal` needs score ≥ 0.55, **at least two independent signals**, and a ≥ 0.12 margin
over the best differently-titled rival. Anything weaker that still clears 0.35 is
`probable` — which shows the user the possibility without asserting it. Instances of one
recurring series are exempt from the margin test: `singleEvents=true` expands a weekly
sync into a dozen identical entries, and without the exemption a genuinely unambiguous
match could never satisfy it.

The weights are judgement, not measurement. There is no labelled set of signal-to-event
pairs to fit them against, and they are written out so they can be argued with.

Freemail domains are excluded from domain evidence. Without that, every Gmail sender
matches every event with a Gmail attendee, and the false positives would be silent.

The new matching runs only where same-day title matching found nothing, so it can add
matches but never remove one.

### On the tests

All 17 passed on first run, which is when a test deserves least trust. Mutation testing
found two of them blind: "an address match alone is never enough" was being caught by the
score floor rather than the signal-count rule, and the ambiguity case never reached the
margin test at all — both rules the tests claimed to cover were untested. Rewritten with
dates and scores chosen so each rule is the only thing that can refuse the match. Six
mutations now caught, none surviving.

### 11.1 Distinctiveness — the first real run got it wrong

Deployed, the participant matcher found three matches where there had been none. One was
right and one was a confident false positive, which is the worse failure: an email from a
COLLEAGUE about an Itron conference on 1 Oct was attached to an "L+G Sync Up" on 9 Sept,
on three agreeing signals. All three were worthless. The colleague attends nearly every
event in the calendar; the item title carried the company's own name; and that name
appears in many of the user's events. Three signals agreed because all three match
almost anything.

The principle that was missing: **evidence is worth what it discriminates.**

Every signal is now scaled by its rarity in the user's own calendar — an address seen on
one event is strong, one seen on fifty is nearly meaningless; a title word unique to one
event is strong, the user's own company name is not. Below a rarity floor a signal may
still nudge the ranking but may not count towards the two-independent-signals rule. This
is inverse-document-frequency reasoning over a corpus of one calendar, which is the only
corpus that matters: distinctiveness is a property of *that* calendar, not of English.

It also subsumes three special cases that would otherwise need hand-coding — internal
senders, freemail domains, and company names in titles are all just low-rarity signals.

On the real data: Itron drops out entirely, and the correct Joseph Guo match survives at
0.654.

**A pre-existing bug surfaced alongside it.** `titlesMatch`'s "short title rule" took the
*shorter* of the two titles, which does not say what its comment says: any two-word
calendar entry matched a title of any length on one shared word. "Resonant Grid intro and
meeting proposal" — a VC introduction — was asserted to be "ResonantGrid/CHK/EXA meeting"
on the strength of the word "meeting". Both sides must now be short.

**On the fixture.** The first version of the busy-calendar fixture put the company name in
every event, driving its distinctiveness to zero and failing the *correct* match. That is
a property of the fixture, not of any real calendar; the fix was to make the fixture
realistic rather than to loosen the thresholds. Separately, mutation testing showed the
participant rarity floor was never actually exercised — every end-to-end case was refused
by the score floor first — so it is now asserted directly on the signals array.

## 12. Onboarding categories from the mail itself

Onboarding asks people to pick categories before keel has read anything, from a fixed
list that cannot know what the account is for. A freshly onboarded work account got
Clients / Finance / HR / Legal / Projects / Suppliers — none of which name the things it
actually deals with: grid hardware partners, investor pipeline, cloud infrastructure
spend.

The evidence to do better is already in hand. One page of message **headers** — sender
domains, counts and subject lines — says plainly who this person corresponds with. That
is one cheap Gmail call and one LLM call, which is what makes it affordable inside the
onboarding flow rather than after it.

**Suggested, never applied.** Categories chosen at onboarding are baked into every item
classified afterwards, so a wrong one is expensive to unwind. The model proposes with its
evidence shown ("landisgyr.com (12)"), and the user ticks what they want — the same shape
as the Stage 4 profile candidate, for the same reason: this is a layer that can be
confidently wrong in a way that reads as competent.

**Why not web search or a LinkedIn scrape.** It was considered and rejected. It adds an
external dependency and a new failure mode at the most fragile moment in the product, it
widens the privacy story from "reads your mail" to "researches you", and it is strictly
worse evidence than what is already held: a few hundred threads of real correspondence
say more about what an account is *for* than a company page does. If a first pass over
the mail proves insufficient, that is the point to reach outside.

### The injection path this opens, and what closes it

Reflection (§3, L5) sees only counts, which is what lets it guarantee that no stranger's
words reach a prompt. This cannot — you cannot infer topics from domains alone, so
subject lines must be read. Four things contain it:

- Subjects are sanitised (control characters, code fences) and truncated to 120 chars.
- The prompt states the block is untrusted data and must not be followed as instructions.
- Output is constrained to short names and validated against the same instruction-like
  patterns as the profile candidate.
- Nothing is written until the user ticks it.

The threshold is 25 messages. Below that a model asked to categorise a mailbox will
invent a life, exactly as it will invent a personality from 22 evidence events.

An empty suggestion list is an explicitly good answer, stated in the prompt. Without
that, the model is pushed into inventing a category to look useful.

### 12.1 Run-to-run variance, measured

The first live run produced one suggestion where an earlier run on the same account had
produced three. Temperature is already 0 for both providers, so the obvious explanation
was wrong.

Measured directly — identical headers, identical prompt, five runs:

| | counts | naming |
|---|---|---|
| Original prompt | 5, 5, 3 | changed entirely between runs |
| Revised prompt | 4, 4, 4, 4, 4 | 3 of 4 identical every run |

Two findings. Gemini is **not deterministic at temperature 0** — batched serving varies —
so some variance is inherent and cannot be prompted away. But most of the instability was
mine: "Suggest at most 5" combined with "an empty array is a good answer" biases hard
toward minimising. Having written those guards to prevent over-suggesting, I got
under-suggesting. The prompt now asks for every category the evidence supports up to five
and says explicitly not to stop early, keeping the empty-array escape for a genuinely
adequate list.

Worth noting for anything else built on this model: a guard against one failure mode is
itself a bias, and needs measuring in both directions.

## 12.2 The same logic at sort time

The suggestion pipeline is reused in the categorise-and-sort flow, with a different
evidence source: the items currently sitting uncategorised, rather than a sample of raw
Gmail headers.

That is the sharper signal of the two. Onboarding has to guess from the inbox as a whole
before anything has been filed. A pile of uncategorised mail is the clearest possible
statement that the existing categories do not fit, and it says exactly *which* mail had
nowhere to go. It is also cheaper: senders and titles are already in Firestore, so there
is no Gmail call at all — one LLM call, no new data leaving the system.

Suggestions **prefill** the create-category form rather than creating anything. The user
still names it and confirms, which is the same posture as everywhere else in this design:
the model proposes, the person decides.

On the real personal account (400 uncategorised items, 17 existing categories) it
proposed Shopping & Deliveries (amazon.co.uk 42, vinted.co.uk 20), Entertainment & Media,
Hobbies & Interests, Food & Drink and Art & Culture — each citing the domains behind it.
On an account with no uncategorised items it correctly proposed nothing.

### A spinner that did not spin

Both busy indicators were initially broken in the same way, and it is worth recording
because it is invisible in code review. `@keyframes spin` was defined in each page, but
inside a *loading-only* branch — the dashboard's copy is unmounted by the time the modal
can open, and onboarding's lives in `ScanStep`, which has not rendered when
`CategoriesStep` needs it. Both rings were therefore static. A spinner that does not spin
is worse than no spinner: it reads as a hang, which is precisely the impression the busy
state exists to prevent. The keyframes are now defined where they are used.
