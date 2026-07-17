# Stage 1D — Recurring / expected occurrences build spec (BC-v2.1 gate 5)

The first 1D finance domain: **detect recurring transaction SERIES from the ledger and
project EXPECTED future occurrences**, backtesting across fixed/variable/skipped/paused/
cancelled. Deterministic (Law 1: cadence detection is math, not an LLM). Suggest→approve
(Law 2 / risk-ladder class B: detection is a SUGGESTION; the user confirms a series).

Read first: CLAUDE.md (Law 1 no-LLM-arithmetic, Law 2 suggest→approve + audit, Law 4 minor,
Law 9 scope), BC-v2.1 gate 5 (+ §9.1 reproducible: as_of, formula version, evidence rows),
the risk ladder (B suggest+approve for rules). This is the DETECTION + EXPECTED-OCCURRENCE
core; variable-amount forecasting models + calendar UI are later.

## Non-negotiable invariants
- **Law 1:** the cadence/period/amount math is pure deterministic code — NO LLM. (Merchant
  naming/category can be AI later; the SERIES math is not.)
- **Law 2 / risk ladder B:** a detected series is a SUGGESTION (`requires_approval`); it never
  auto-writes a rule or a forecast. Confirm/reject is an audited user action. Detection state
  (active/paused/cancelled) is user-owned; inference is never silently treated as fact (§9.1
  explicit-ownership invariant).
- **§9.1 reproducible:** every detected series + expected occurrence carries `as_of`, the
  formula/detector version, the evidence transaction ids it was derived from, and confidence.
- **Purity:** `packages/detectors` imports NO Supabase/Next/provider/model SDK (like ledger).
  It takes plain transaction rows and returns typed results.

## 1. `packages/detectors` (pure, 100% unit-tested)
Input: a household's confirmed `canonical_transactions` view rows (per ledger account) —
`{id, accountId, ledgerAccountId, effectiveDate, amountMinor (string→bigint), currency,
description, counterpartyKey?}` (amounts BIGINT minor, no floats). Output typed series +
occurrences.
### 1a. Series detection (`detectRecurringSeries(txns, {asOf}): DetectedSeries[]`)
- Group candidate transactions by a stable KEY: normalized counterparty (merchant) + ledger
  account + sign (inflow/outflow). (Merchant normalization is a pure string normalizer here —
  lowercase, strip trailing digits/store#/dates; deterministic. NOT an LLM.)
- Within a group, find a CADENCE by the modal inter-arrival gap in days mapped to a cadence
  enum {weekly:7, biweekly:14, semimonthly:~15, monthly:~30 (calendar-aware: same day-of-month),
  quarterly, semiannual, annual}. Require ≥3 occurrences and low gap variance (tolerance per
  cadence, e.g. ±3 days monthly) to qualify. Calendar-aware monthly (day-of-month, not naive 30d).
- Classify amount: **fixed** (all amounts equal within a tiny tolerance) vs **variable**
  (amounts fluctuate — e.g. utility) → carry `amountKind`, and for variable a summary
  (min/max/median minor as strings) — NO average that introduces floats; median of an odd set
  or the lower-median (exact).
- Emit `DetectedSeries = {seriesKey, counterpartyKey, ledgerAccountId, cadence, amountKind,
  representativeAmountMinor (string), lastSeen, occurrenceCount, confidence (calibrated 0..1
  from count + variance), evidenceTxnIds[], detectorVersion, asOf}`.
### 1b. Expected occurrences (`projectOccurrences(series, {asOf, horizonDays}): ExpectedOccurrence[]`)
- For each ACTIVE series, project the next dates from `lastSeen + cadence` up to `asOf+horizon`
  (calendar-aware). `expectedAmountMinor` = the fixed amount, or for variable the series' median
  (string, exact) with a `variable` flag. Each occurrence: `{seriesKey, expectedDate,
  expectedAmountMinor, amountKind, status:'expected', confidence, asOf}`.
### 1c. Backtest / matching (`backtest(series, txns): {matched, skipped, unexpected}`)
- Replay a series against actual transactions: each expected date → a matching actual within
  the tolerance window = `matched` (link the txn id); a missing one = `skipped` (series
  continues); an actual with no expectation = `unexpected`. Handles **paused** (user-set: no
  expectations while paused) and **cancelled** (series terminates; later matches are unexpected).
- Property/fixture tests (gate 5): fixture series for fixed-monthly (rent), biweekly (paycheck),
  variable-monthly (utility), a **skipped** occurrence (missed one, series survives), a
  **paused** span (no expectations), and a **cancelled** series (terminates) — the detector +
  backtest reproduce the known series/occurrences exactly. Confidence is calibrated + monotone
  in occurrence count and inverse in variance.

## 2. Schema + surface (suggest→approve)
### 2a. Migration `..._recurring.sql`
- `recurring_series` (household_id, id, series_key unique per household, counterparty_key,
  ledger_account_id, cadence enum, amount_kind enum, representative_amount_minor bigint,
  currency, status enum {suggested, confirmed, paused, cancelled} default 'suggested',
  confidence numeric, detector_version text, evidence jsonb (txn ids), as_of, created_at,
  confirmed_by, confirmed_at). Tenant-scoped, RLS member-read, append/update via procs only.
- `expected_occurrences` (household_id, series_id, expected_date, expected_amount_minor bigint,
  amount_kind, status enum {expected, matched, skipped, cancelled}, matched_txn_id, confidence,
  as_of). Derived; regenerated on detection/confirm.
### 2b. Procs (SECURITY DEFINER, owner keel_api; the detector runs in Edge, writes via procs)
- `keel_recurring_upsert_suggestions(p_household_id, p_series jsonb)` — worker/edge writes the
  DETECTED series as status 'suggested' (idempotent by series_key); audits `recurring.suggested`.
  NEVER auto-confirms. (Law 2: suggestion only.)
- `keel_recurring_confirm(p_household_id, p_series_id, p_action)` — USER command (authenticated,
  member write): confirm/pause/cancel a series → status transition + audit `recurring.confirmed/
  paused/cancelled` + regenerate expected_occurrences for confirmed. This is the approve step.
- Query `keel_list_recurring(p_household_id)` → series + upcoming occurrences (member read).
### 2c. Edge: a detector runner — a `scheduled`/worker route (or reuse /scheduled/tick) that,
per active household, pulls confirmed canonical_transactions, runs `detectRecurringSeries` +
`projectOccurrences` (pure), and calls `keel_recurring_upsert_suggestions`. Metered like other
work (C6). A `POST /api/commands` `recurring.confirm` bespoke or via the command map → the
confirm proc. NO money movement, NO auto-write (risk ladder: detection=B suggest+approve).

## 3. Tests
- Unit (`packages/detectors` 100%): the fixture-series backtest matrix (§1c), calendar-aware
  monthly, biweekly, variable median exactness (bigint, no float), confidence calibration,
  merchant-normalization determinism, empty/insufficient-data → no series.
- pgTAP: recurring_series/expected_occurrences RLS + proc ACLs; suggest-then-confirm state
  machine; a suggestion never auto-confirms.
- Integration (`tests/integration/12-recurring.test.ts`): seed/produce a household with a
  recurring pattern (e.g. inject a monthly rent series via the ledger), run the detector,
  assert a 'suggested' series appears with evidence + confidence; confirm it → 'confirmed' +
  expected_occurrences generated; a different household sees none (Law 9); NO auto-write before
  confirm; audit rows present.

## 4. Gate
`pnpm -w typecheck && lint && test` (detectors 100%), `supabase test db`, `itest.sh`
(12-recurring + no regression). Update NOTES + PROGRESS.

## 5. Out of scope (later 1D/AI): variable-amount forecasting models (class C preview),
merchant naming/category via AI (class B, separate), the calendar/subscriptions UI (1E),
cross-account transfer-aware recurring, paycheck/statements domains (their own specs).

---
## v2 (dual-audit rework — both NEEDS REWORK; fold before building)
Recurring is a real finance domain, not a quick slice. v2 makes it buildable against the
DEPLOYED schema and pins every deterministic rule the gate-5 matrix needs.

### BLOCKERS
- **B1 Schema/read-path (both):** `canonical_transactions` has NO amount/currency/ledger_account_id;
  statuses are pending/posted/reviewed/voided (no 'confirmed'); amount truth is in journal_postings.
  Fix: a `keel_worker`-owned service-only READ proc `keel_recurring_read_txns(household)` that joins
  each `posted|reviewed`, `voided_at is null` canonical txn to its CURRENT unreversed/unsuperseded
  journal_batch + the ASSET-side posting → `{txnId, accountId, ledgerAccountId, effectiveDate,
  amountMinor::text, currency, description}`. Exclude pending/voided + multi-real-account batches
  for this slice. The detector reads THIS, not a nonexistent view.
- **B4 Suggest-only, no forecast persisted (Codex):** background detection persists CANDIDATES ONLY.
  `projectOccurrences` runs only AFTER approval (confirm). Variable series persist NO predicted
  amount at detection — only observed min/max/lower-median as evidence. (Forecasting = class C, later.)
- **B6 Calendar-grid detection, not modal-gap (both):** a skipped month makes a ~60-day gap that
  modal-gap/low-variance detection rejects. Fix: fit observations to candidate CALENDAR GRIDS
  (weekly/biweekly by 7/14-day epoch-day grid; monthly/quarterly/annual by day-of-month/Gregorian
  month addition; semimonthly by two anchor days), scoring residuals + coverage; gaps near integer
  cadence multiples are MISSING SLOTS (skipped), not disqualifiers.
- **B7 Status-event timeline (both):** a single status can't reproduce paused SPANS or the effective
  cancel date. Fix: append-only `recurring_status_events(series_id, effective_date, transition
  {suggested→confirmed|paused|resumed|cancelled|rejected}, actor, command_id, created_at)`; backtest
  + projection REPLAY this timeline (suppress expectations within [paused, resumed); terminate at
  cancelled effective_date).
- **B10 Immutable, evidence-bearing projections (Codex):** every candidate/occurrence carries
  evidence ids (canonical txn + live batch + posting ids), input fingerprint, detector_version,
  confidence_version, and run-wide `as_of`. Detection writes a NEW immutable detector-run/candidate
  version; it never destructively regenerates prior derivations.

### MAJORS (pin the determinism + integrity)
- Exactness (Law 1/4): all comparisons/median/variance on BIGINT — lower-median of the sorted bigint
  multiset (stable), integer squared residuals for variance, NO `Number()`/float/`Number(a-b)` sort.
  Confidence = a versioned integer basis-points SCORE (rename from "confidence" unless calibrated
  against held-out hit-rate); document as a score.
- Calendar math: operate on validated civil `YYYY-MM-DD` / integer epoch-days; define end-of-month
  anchoring (clamp DoM to last valid day) + Gregorian month addition; test leap years, month ends,
  DST-immune (no ms division). 
- Grouping/cadence: key includes currency + normalizer_version; allow MULTIPLE amount/calendar
  clusters per merchant/account (don't collapse duplicate subscriptions); semimonthly = explicit
  anchor-pair vs a strict 14-day biweekly grid, deterministic ties.
- Matching: deterministic ONE-TO-ONE assignment constrained by series key/currency/sign + a bigint
  amount policy; rank by date residual, amount residual, effective_date, txnId; unmatched
  expectations = skipped, unmatched actuals = unexpected.
- Approval state machine: explicit status on insert (NO implicit default — Law 4); every transition
  + inverse defined (incl. rejected, resume); detector upsert NEVER resets confirmed/paused/cancelled;
  approval binds to a locked candidate version/hash.
- Schema integrity: explicit PK/unique on occurrences; COMPOSITE tenant FKs (series, ledger_account,
  occurrence, matched_txn all household-scoped); household derived server-side; cross-tenant-reference
  test.
- Authz: add typed `recurring.*` actions + resources to `packages/contracts` + `packages/authz`
  (not just member-read); filter reads by AUTHORIZED account/entity scope (hidden-account safe);
  recheck household + series ownership in every proc.
- Runtime boundaries: cron enqueues idempotent `recurring_detection` jobs → bounded `keel_worker`
  batches run detection via a `keel_worker`-owned service-only suggestion proc; `recurring.confirm/
  pause/cancel/reject` are `keel_api`-owned authenticated commands (command_id/economic key, JWT
  actor, audit before/after, domain events). `/scheduled/tick` stays orchestration-only. A
  non-provider `recurring_detection` meter kind.
- Occurrence enum: include the states the backtest emits (expected/matched/skipped/unexpected/
  paused/cancelled) or persist unexpected explicitly; name the table `recurring_occurrences`
  (canonical) not `expected_occurrences`.

### Verdict: recurring is a proper domain build (a full loop). v2 above is execution-ready.
