# Recurring domain — post-build dual-review fixes (Stage 1D, gate 5)

Both reviewers (Claude + Codex) ran an adversarial pre-commit review of the recurring
detection domain. No CRITICALs. Load-bearing laws hold (no float in ledger math, no LLM
arithmetic, suggest→approve, primary tenant isolation, no SQL injection, balanced-posting
untouched). The findings below are correctness / trust-boundary / idempotency defects that
MUST be fixed before commit, plus lower items to fix or explicitly defer in NOTES.

Fix all F1–F9. Keep every existing green test green; add/adjust tests to prove each fix.
After changes: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`, `supabase test db`,
`bash scripts/dev/itest.sh` must all pass. Do not weaken any of the "clean areas" below.

---

## F1 (HIGH, trust boundary) — Confirm must DERIVE occurrences in the DB, never trust caller DTOs
Files: `supabase/migrations/20260712120000_recurring.sql` (`keel_recurring_confirm` /
`keel_recurring_transition_core` ~L477–517), `supabase/functions/api/index.ts` (~L617–640),
`supabase/tests/009_recurring.sql` (~L167).

`keel_recurring_confirm` is EXECUTE-able by `authenticated`, so any user can call
`/rest/v1/rpc/keel_recurring_confirm` DIRECTLY (bypassing the Edge `api` function) with a
hand-built `occurrences` array. Today the proc validates metadata (series/hash/versions/
evidence-count/status) but does NOT verify that each occurrence's `expected_date`,
`expected_amount_minor`, `currency`, `amount_kind`, `score_bps`, `occurrence_key`,
`input_fingerprint`, `as_of` is the deterministic projection of the LOCKED candidate. An
authorized caller can therefore persist arbitrary approved amounts/dates. `ON CONFLICT DO
NOTHING` also silently accepts a conflicting date.

Required fix (pick the cleaner path, prefer A):
- **A (preferred): derive occurrences inside the SQL command** from the locked candidate
  (`v_candidate.candidate`: cadence anchor, interval, amount, currency, evidence) + the
  confirm `effective_date` + bounded horizon. Implement a deterministic SQL cadence
  generator (reuse the civil-date rules already in `packages/detectors/src/civil-date.ts` /
  `cadence.ts`: integer epoch days, Gregorian leap rules, end-of-month clamp). Stop accepting
  an `occurrences` DTO from the caller entirely; the API should send only
  `{seriesId, effectiveDate, horizonDays}`. Update `projectOccurrences` usage in
  `api/index.ts` accordingly (it may still be used for preview/read, but not as the write source).
- **B (fallback if SQL cadence generation is too large this pass):** keep the proc as the
  authority by RE-COMPUTING the projection in SQL and rejecting any caller occurrence whose
  full derivation does not match; AND reject a conflicting existing row unless its complete
  derivation hash is identical (replace `ON CONFLICT DO NOTHING` with a hash-equality check).
  Do NOT ship a version that trusts caller-supplied economic fields.

Update the pgTAP test so it no longer asserts that a hand-built/forged occurrence is accepted;
instead assert the proc derives them and rejects forged/mismatched economic fields.

## F2 (HIGH, idempotency/reproducibility) — Bind run_key and candidate identity to the exact result
Files: `recurring.sql` (`keel_recurring_upsert_candidates` ~L292, candidate conflict ~L353),
`packages/detectors/src/detect.ts` (~L350 fingerprint), `fingerprint.ts`.

1. A repeated `run_key` is checked only against `as_of` + the three version strings; the
   candidate array is not hashed. A repeated run can append a DIFFERENT candidate set. Store a
   SHA-256 hash of the complete ordered candidate/input snapshot on `recurring_detector_runs`
   and compare on replay (raise a distinct error, e.g. `P0007`, on mismatch).
2. Candidate conflict resolves on `input_fingerprint` only and returns the stored candidate
   WITHOUT comparing `candidate_hash`; and `asOf` is excluded from the fingerprint even though
   it is part of the emitted material result. Include `asOf` in candidate identity and, on
   fingerprint conflict, compare the full candidate hash (or store candidates per detector run).

## F3 (HIGH, correctness) — Effective-date timeline must not contradict materialized status
Files: `recurring.sql` (transition guard ~L445–464), `packages/detectors/src/timeline.ts` (~L8).

Transition validity + `recurring_series.status` use command ARRIVAL order, while
projection/backtest sort by `effective_date, created_at, command_id`. So "pause effective Oct"
then "resume effective Sep" is accepted and flips the row to confirmed, while timeline replay
says paused-after-Oct. Under the series lock, replay existing events AT the proposed effective
date and validate the transition against that replayed state; then recompute the materialized
status from the ordered timeline after every append. (Requiring monotonic effective dates is an
acceptable stricter alternative — if chosen, enforce it and return `invalid_command` otherwise.)

## F4 (HIGH, correctness) — Cancel is terminal; resume must not revive a cancelled series
File: `recurring.sql` (~L447).

`resumed` is currently allowed from `('paused','cancelled')`. Cancel is series termination —
drop `'cancelled'` from the `resumed` allowed-from set (resume only from `paused`). Revival, if
ever wanted, goes through `confirmed` (already allowed from cancelled) so it re-locks a candidate
and re-audits as a confirm. Align `timeline.ts` so a `resumed` after `cancelled` cannot reactivate
expectations.

## F5 (HIGH, correctness) — Lifecycle transitions must not leave stale occurrences exposed
Files: `recurring.sql` (`keel_recurring_transition_core`, `keel_list_recurring` ~L633),
`api/index.ts` (~L617).

Occurrences are generated only on `confirm`; pause/resume/cancel append timeline events but
leave the original occurrences with stored `expected` status, and `keel_list_recurring` returns
ALL of them (across candidate versions) without replaying the timeline. Also a re-confirm bound
to a different `candidate_version_id` inserts a parallel occurrence set while the old set remains.
Fix both:
- Derive/filter the EFFECTIVE occurrence state from the status timeline in the read proc (paused/
  cancelled dates must not read as plain `expected`; resume must extend projection through a newly
  bound horizon), preserving immutability by appending superseding derivations rather than UPDATE.
- Constrain `keel_list_recurring` occurrences to `series_row.current_candidate_version_id` (or mark
  prior generations superseded on re-confirm) so two generations never mix.

## F6 (HIGH, reproducibility) — Validate evidence references are real and tenant-owned
Files: `recurring.sql` (`recurring.sql:69` evidence check, `:309` upsert), `009_recurring.sql:112`.

Candidate evidence is only checked to be a JSON array of ≥3 elements. Validate that every
`{txnId,batchId,postingId}` triplet EXISTS and belongs to `p_household_id` with the asserted
transaction→live-batch→posting relationship (join canonical rows before insert), or normalize
evidence into a tenant-scoped child table with composite FKs. Update the pgTAP fixture so it uses
real evidence rows, not arbitrary UUIDs.

## F7 (MEDIUM, concurrency) — Fix the new-series first-insert race
File: `recurring.sql` (~L332).

Two detector runs creating the same new `(household_id, series_key)` both see no row (`FOR
UPDATE` locks nothing when absent), both `INSERT`, one fails the unique constraint and aborts the
whole job. Use `INSERT ... ON CONFLICT (household_id, series_key) DO NOTHING` then
`SELECT ... FOR UPDATE` and verify scope (or an advisory lock keyed by household+series_key).

## F8 (LOW, authz correctness) — Recurring authorization must scan all permissions
File: `packages/authz/src/authorize.ts` (~L73).

Recurring authz uses `.find()` and inspects only the FIRST permission for an account; if `view`
precedes `edit`, a valid recurring write is denied. Use `.some()` with the required-permission
predicate. Add a test with multiple permissions in both orders.

## F9 (LOW, input validation) — Reject impossible civil dates at the contract, map to 400
Files: `packages/contracts/src/commands.ts` (~L35, L91 `IsoDateSchema`), `api/index.ts` (~L635).

`IsoDateSchema` accepts `2026-99-99` (shape only); it later throws in projection/SQL casting and
surfaces as 500. Add Gregorian civil-date validation to the schema and map any residual
projection/date failure to `invalid_command` (400).

---

## Also do
- Add a NOTES.md entry recording this review, the F1–F9 dispositions, and any explicitly
  DEFERRED item (with justification + spec line), per CLAUDE.md ("deviations without
  justification are bugs"). Candidate deferrals to call out rather than silently leave:
  occurrence status reconciliation (matched/skipped/unexpected only exist in the in-memory
  `backtest()` today — Claude M2), detection/scheduling pagination bounds (Codex M2 / Claude
  M3 — real data is bounded by the trusted read view, but add a defensive span/horizon cap and
  document), `recurring_detection_claims` retention/prune (Claude L1), candidate JSON passthrough
  in the list DTO (Claude L3, defense-in-depth).

## Do NOT regress these verified-clean areas
bigint-exact statistics (no float on minor units); proc ownership (worker vs api vs export) +
SECURITY DEFINER + fixed search_path + revoked public/anon EXECUTE + NOLOGIN definer asserts;
composite `(household_id, id)` FKs + account-scoped RLS + 404 (not 403) cross-tenant; data-tier
memo text inert (Law 5); export completeness with `::text` bigint; balanced-posting untouched.
