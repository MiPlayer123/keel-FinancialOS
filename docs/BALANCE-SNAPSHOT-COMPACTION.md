# Balance snapshot write amplification: measurement and proposal

Status: proposal, v2. Written 2026-08-31 after the user reported the app "takes
forever to load" and asked whether balance snapshots are needed at all.

v2 rewrites v1 after an adversarial audit found three P0 defects in it: the
reversibility step archived the wrong rows, the phase-1 guard as worded would
permanently break opening-balance anchoring, and the latency table that drove
the phase ordering was built from the author's own diagnostic probes rather
than user traffic. Findings and corrections are recorded inline, and §7 lists
what the audit confirmed as sound.

## 1. The measurement

From the live project. Every number below is either a direct count or a
PostgREST-attributed `pg_stat_statements` row (i.e. real application traffic).

**Write amplification.** `public.balance_snapshots` holds **186,889 rows**
(growing ~3/min) across **two households**; 29 accounts exist but only **16**
have ever had a snapshot. 50 MB total — **heap 24 MB, indexes 27 MB** — which
is **26% of the 189 MB database**. It grows **4,320 rows/day** because
`keel-drain-sync` runs every 3 minutes and writes a snapshot per account
whether or not the balance moved.

**99.94% of rows are exact repeats of their predecessor** — 186,754 of 186,871
under NULL-safe comparison. At this rate: ~1.6M rows and ~450 MB/year against a
500 MB Free-tier cap.

**Latency — real application traffic only:**

| Function | Calls | mean | max |
|---|---|---|---|
| `keel_investments_overview` | 109 | **2,151 ms** | 7,885 ms |
| `keel_latest_balances` | 29 | **983 ms** | 4,206 ms |
| `keel_net_worth_daily` | 58 | 299 ms | 1,356 ms |
| `keel_trial_balance` | 231 | 68 ms | 834 ms |

> **Correction (audit P0-3).** v1 of this document listed
> "`keel_net_worth_daily` 42–45s" in this table. Those five calls were the
> author's own ad-hoc psql probes, not user traffic, and sat unmarked beside
> genuine production timings. **No user has ever waited 42 seconds for it.**
> Real user-facing `keel_net_worth_daily` is 299 ms mean. The slowest thing a
> real user hits is `keel_investments_overview` at 2.15 s.

**Where that time actually goes.** `EXPLAIN (ANALYZE, BUFFERS)` on
`keel_latest_balances`' inner query against the live household:

```
Unique  (actual time=3.444..2059.823 rows=10 loops=1)
  Buffers: shared hit=87233
  ->  Index Scan using balance_snapshots_account_asof on balance_snapshots bs
        (actual time=0.740..1988.977 rows=186889 loops=1)
Execution Time: 2059.981 ms
```

**186,889 rows and 87,233 buffers scanned to return 10 rows.**
`distinct on (account_id) … order by account_id, as_of desc` has no index-skip
scan available, so its cost is **linear in snapshot count**.
`keel_investments_overview`'s `latest_bal` CTE has the identical shape, which
is why it is the slowest real surface.

By contrast `keel_net_worth_daily`'s probe is `… order by as_of desc limit 1`
against `(household_id, account_id, as_of DESC)` — **O(1) per probe and
insensitive to table size**. Compaction will not speed it up.

**So the causality is the opposite of what v1 claimed:** phases 1–2 are a ~30×
fix for the two surfaces users actually wait on, and phase 3 is not the
latency fix. The ordering below reflects that.

The dashboard also fires **nine queries on mount**, and `api/queries` has a
p95 of 2.35s.

## 2. Are balance snapshots needed?

**Yes — the table is load-bearing.** Verified consumers (audit P1-7 corrected
v1's list, which named `keel_investments_value_daily`, that in fact reads
`holdings_snapshots`, and omitted two):

| Consumer | How it reads |
|---|---|
| `keel_latest_balances` | latest per account (`distinct on`) |
| `keel_investments_overview` | latest per account (`latest_bal` CTE) |
| `keel_net_worth_daily` | step function per day, **plus an `exists` membership predicate** |
| `keel_net_worth_as_of` | step function, **plus an `exists` membership predicate** |
| `keel_cmd_reanchor_balance` | existence + latest, tiebreaker `as_of desc, id desc`; hard-fails `KEEL_INVALID_COMMAND` if none |
| `keel_export_household_pre_recurring` | full table, Law 6 export |
| `keel_apply_account_balance` | the writer |

A provider balance at a past instant is **not derivable from the ledger**, so
dropping the table would permanently destroy net-worth history and investment
value trends. Only the repetition is disposable.

### The correctness argument, restated

v1 claimed "every consumer reads them as a step function" and that "the only
thing lost is the timestamp of a re-observation, which nothing reads."
**Both sentences were wrong** (audit P2-8, and the verdict paragraph).

Compaction is safe only if it preserves **three** properties, not one:

1. **The step function** — for any instant `D`, the latest value at or before
   `D` is unchanged. Holds because deleting a row equal to its predecessor
   means `order by as_of desc limit 1` lands on a different row with the same
   value.
2. **Existence per `(household_id, account_id, source)`** — `keel_net_worth_daily`
   and `keel_net_worth_as_of` both open with `exists (select 1 from
   balance_snapshots …)` deciding whether an investment account's ledger flows
   are *excluded*. Drop an account's last row and its postings silently
   re-enter net worth. `keel_cmd_reanchor_balance` hard-fails without one.
3. **The first-observation instant of each value** — keep the *first* row of
   each equal run, not the last, so the instant a value first appeared is
   preserved.

These make the "keep first of each run, plus newest per series" rule
**load-bearing**, not belt-and-braces as v1 framed it.

**Preconditions the gate must assert, not assume** (audit P2-9): no `as_of`
ties within a series, and no out-of-order arrival. Both verified **0** across
all 186,871 rows today, but `as_of` is the edge function's own wall clock
(`p_as_of: new Date().toISOString()`, `supabase/functions/worker/index.ts:1018`)
with no unique constraint, and four consumers order by `as_of desc` with **no
tiebreaker**, so a tie makes the returned row planner-dependent. Adding
`, id desc` to those four is cheap independent hardening.

**Keep-newest must be per `(household_id, account_id, source)`, not per
account** (audit P2-8). Only `source='plaid'` exists today, and
`keel_latest_balances` filters on no source at all, so an account-level rule
plus a second source arriving later would drop the newest row of one series.

**Dedupe key.** Full columns: `id, household_id, account_id, as_of,
available_minor, current_minor, currency, source, snapshot_metadata,
created_at, limit_minor`. The key is `(current_minor, available_minor,
limit_minor, currency)` compared with **`is not distinct from`**, and the guard
must additionally assert `snapshot_metadata = '{}'` (audit P2-10) — it is
hardcoded `'{}'` on 100% of rows today, is exported, and a future writer could
populate it.

> **NULL comparison is not a detail (audit P1-4).** 149,481 of 186,871 rows
> have `limit_minor IS NULL`; 43,609 have `available_minor IS NULL`. Measured
> over the real table: `is not distinct from` finds **186,754 duplicates
> (99.94%)**; plain `=` finds **37,345 (20.0%)**. Written the obvious way,
> phase 1 keeps four-fifths of the amplification and phase 2 leaves 149k rows
> behind.

## 3. Proposal

### Phase 1 — stop the bleeding (write side)

In `keel_apply_account_balance`, skip **only the `INSERT` statement** when the
newest existing snapshot for that `(household_id, account_id, source)` is
NULL-safe-equal on the dedupe key.

> **This must not be an early `return` (audit P0-2).** The function is ordered:
> mask backfill → snapshot insert → `last_successful_sync_at` gate →
> opening-balance-exists check → book the anchor. An early return skips the
> anchor. Concrete failure: an account is linked while its balance is static;
> cycle 1 inserts and returns early because `last_successful_sync_at` is still
> null, and every later cycle sees an identical value and returns early — so
> **the opening balance is never booked and the account's ledger balance stays
> wrong forever.** Not hypothetical: account `ea9402fd…` has gone 43d 23h
> without a value change, `602c52e0…` likewise.

Must preserve: the mask backfill, the `last_successful_sync_at` update, the
opening-balance anchor, the first snapshot per series, every changed value,
and no collapsing across different `source` values.

Effect: removes ~99.94% of snapshot writes; growth stops; nothing existing is
touched. Independently useful even if every later phase is rejected.

### Phase 2 — compact the existing rows (lossless)

Survivor predicate: per `(household_id, account_id, source)` ordered by
`as_of`, keep the **first** row of every run of NULL-safe-equal dedupe keys,
plus the **newest** row of each series unconditionally.

Sequence, in this order:

1. **Assert the preconditions** — zero `as_of` ties per series, zero
   out-of-order arrivals. Abort if either is non-zero.
2. **Archive the rows to be DELETED** — or simply the whole 50 MB table.
   > **v1 said to archive the survivor set. That is backwards (audit P0-1):
   > the survivors are precisely the rows that are *not* deleted, so the 186k
   > rows being destroyed would have had no copy anywhere.** That is the
   > `connection_credentials` shape again — Free tier, no PITR, and `relacl`
   > shows only `postgres`/`service_role` hold DELETE, so this runs as a raw
   > psql `DELETE` with no trigger and no policy in the way. Verify
   > `count(archive) + count(survivors) = count(original)` and a row-hash
   > match before proceeding.
3. **Run the equivalence gate** (§4) and abort on any difference.
4. **Delete in batches**, each in its own transaction, writing an `audit_log`
   row in the same transaction (audit P1-5: there is no trigger and no audit
   coverage on this table, so a raw DELETE leaves zero trace anywhere — Law 2
   requires the actor, row counts, archive table name and survivor predicate
   be recorded).
5. **Reclaim space deliberately** — a plain `DELETE` returns **none** of the
   50 MB, and the index half (27 MB) bloats worst. `VACUUM FULL` + `REINDEX`
   take an ACCESS EXCLUSIVE lock and transient ~2× space; and step 2 *grows*
   the database to ~239 MB before it shrinks (audit P2-11). Fine against a
   500 MB cap, but the lock window must be planned, not discovered.
6. Keep the archive until the user says otherwise.

### Phase 3 — `keel_investments_overview` and `keel_latest_balances`

These are the real user-facing slow surfaces (2.15 s and 0.98 s), and their
cost is linear in snapshot count, so phase 2 should take roughly 30× off them
directly. Re-measure after phase 2 before designing anything further; if
`distinct on` is still hot, the fix is a partial index or a
latest-per-account materialisation, not a rewrite of net worth.

### Phase 4 — the dashboard's nine mount-time queries

Fold into one composite call. Removes eight round-trips of invocation and auth
overhead. Genuinely worth doing, and now correctly last: it addresses fixed
overhead, and phases 1–2 address the multi-second reads.

## 4. The equivalence gate

> v1's gate — "compare compacted vs current output through the real functions"
> — **is not executable** (audit P2-12). The read models are `SECURITY DEFINER`
> and raise `KEEL_NOT_AUTHENTICATED` without a JWT subject, and Free tier has
> no branch or PITR, so there is no second database to compare against. As
> written you would be comparing a hand-copied duplicate of each function's
> SQL, which tests the copy, not the function.

Executable gate, runnable today against the live table with no deletion:

For each `(household_id, account_id, source)`, compute the step-function value
at **every distinct `as_of` instant in the entire history** twice in one query
— once over the full table, once over the table filtered by the survivor
predicate as a CTE — and assert **zero** differing rows. Exhaustive rather
than a "dense grid", needs no second database.

Plus: existence preserved per series; survivor row-hash matches the export
projection; and explicit coverage of `keel_net_worth_as_of`,
`keel_investments_overview` and `keel_cmd_reanchor_balance`, which v1's gate
omitted.

## 5. Law 6, and a pre-existing export defect found en route

`balance_snapshots` is in `packages/exports/src/manifest.ts:54` with all 11
columns and is emitted by the export chain. **Compaction changes what a user's
full export contains for that table** (audit P1-6). That is probably
acceptable — the surviving rows still reconstruct every value at every instant
— but it is a Law 6 change and needs an explicit ruling, which v1 did not give.

**Ruling (2026-08-31, taken when phase 2 shipped).** Compaction is permitted,
on these terms:

1. The export continues to contain every *distinct observation* of every
   account, with the instant each value first appeared. The removed rows carry
   no value, no instant, and no field that a surviving row does not already
   carry; the migration proves this before it commits, exhaustively, against
   the before-image rather than against its own predicate.
2. `accounts.balance_last_observed_at` is exported (phase 1 added it to the
   manifest and to the `008_export.sql` mirror), so "when did the provider last
   confirm this" leaves with the export too. Nothing that was exportable before
   phase 1 stops being exportable after phase 2.
3. The complete before-image is retained in
   `keel_archive.balance_snapshots_20260831` — every original row, verified by
   count and by an order-independent hash of every column, *before* anything is
   removed — and is discarded only on an explicit human instruction. So the
   change is reversible in the sense Law 2 means, not merely logged.
4. The removal writes an `audit_log` row per household in the same transaction,
   naming the actor, both row counts, the archive relation and the survivor
   predicate. `balance_snapshots` has no trigger and no audit coverage, so
   without this the change would leave no trace anywhere (audit P1-5).

What a user loses is the count of times a provider repeated a value it had
already reported. That is a property of our polling interval, not of their
money, and after phase 1 it is not recorded for new observations either.

This is also the point where CLAUDE.md's "prefer soft delete over hard delete"
directive is deliberately not followed, so the reason belongs on the record: a
status flag cannot serve here. The entire cost being removed is that
`order by as_of desc` walks 186k rows, and a soft-deleted row is still a row
the index walks — a flag would keep 100% of the latency and 100% of the
storage while adding a filter to every consumer. The archive is what supplies
the recoverability the directive exists to protect, which is why the sequence
is archive → verify → gate → remove, and why every check is an abort rather
than a warning. Applying phase 2 to the live project is a human checkpoint (⚑)
in its own right, per that same directive.

**Separately, and worth fixing regardless of this proposal:** the live export
**omits `limit_minor`**. No `keel_export_household*` function body contains the
string, yet the manifest and `supabase/tests/008_export.sql:35` both list it.
`packages/exports/src/canonical.ts` skips absent keys
(`if (!Object.hasOwn(row, column)) continue;`) and `csv.ts` writes an empty
cell, so it fails silently. **37,345 rows carry a real credit limit that never
reaches the user's export.** `008_export.sql` cannot catch it: its column
assertions compare `allowed_columns` against `information_schema.columns`,
never against the keys the DTO actually emits. This is a real Law 6 hole and
its own change.

## 6. The semantic change phase 1 makes

`as_of` is the observation instant. After phase 1 the newest row's `as_of`
becomes *the instant the value last changed*, so "unchanged since 18 July" and
"not checked since 18 July" become indistinguishable (audit P2-13). Two
accounts are already 44 days into that gap while being reconfirmed every 3
minutes. `keel_apply_account_balance`'s own comment says snapshots exist as
"history for trend + future reconciliation + re-anchor", and reconciliation
wants "the provider asserted X at time T".

Nothing renders that timestamp today — the dashboard's "As of" comes from the
`trial_balance` envelope — but two read models return it as payload
(`keel_latest_balances` emits `asOf`, `keel_investments_overview` emits
`balanceAsOf`) and `apps/web` reads `balanceAsOf` in two places
(`app-shell.tsx:371`, `dashboard/investments/page.tsx:121`) as a
has-a-provider-snapshot sentinel.

**Recommended alongside phase 1:** keep `accounts.balance_last_observed_at`
updated in place each cycle, so "when we last confirmed this" survives at O(1)
storage. Without it, phase 1 forecloses any future freshness or reconciliation
surface.

## 7. What the audit confirmed as sound

- **No FK anywhere references `balance_snapshots.id`** (only `fk_snapshot_account`
  pointing outward at `accounts`); no views, no matviews, no triggers.
  Deletion breaks no referential integrity.
- Zero `as_of` ties and zero out-of-order arrivals across all 186,871 rows.
- The size and write-amplification measurements (50 MB, 26%, 99.94% repeats).
- Value-level losslessness, given all three preserved properties in §2.
- `keel_is_investment_subtype` is **not** a plausible suspect for anything: it
  is `IMMUTABLE` SQL over a constant array and inlinable. v1 named it on the
  strength of a single 1,397 ms observation that was almost certainly cold
  cache.

## 8. Verification required before any of this ships

- **Phase 1:** pgTAP proving a repeated balance writes no row; a changed
  balance writes one; the first-ever snapshot writes one; two different
  `source` values never collapse; a null-`limit_minor` / null-`available_minor`
  repeat is caught (the `=` vs `is not distinct from` trap); and — the one that
  matters most — **the opening-balance anchor still books on a cycle where the
  snapshot was suppressed.**
- **Phase 2:** the §4 gate, run over real data, as an abort condition rather
  than a report. Plus archive completeness before any delete.
- **Phase 3:** before/after `explain (analyze, buffers)` on the same query.
- **Phase 4:** no behaviour change; the nine reads must return what they do today.
