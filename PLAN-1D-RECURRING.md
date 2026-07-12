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
