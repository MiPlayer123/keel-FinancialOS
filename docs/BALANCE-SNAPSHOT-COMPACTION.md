# Balance snapshot write amplification: measurement and proposal

Status: proposal. Written 2026-08-31 after the user reported the app "takes
forever to load" and asked whether balance snapshots are needed at all.

## 1. The measurement

All figures from the live project (`pg_stat_statements`, `function_edge_logs`,
and direct counts), not from reasoning.

**Write amplification.** `public.balance_snapshots` holds **186,835 rows for 29
accounts** — 50 MB, **26% of the 189 MB database**. It grows by **4,320 rows per
day**, steady. `keel-drain-sync` runs every 3 minutes and each pass writes a
snapshot per account whether or not the balance moved.

Of the 8,631 snapshots written in the last two days, **8,619 (99.9%) carried
current and available balances identical to the previous snapshot for that same
account.** They are pure repetition.

At this rate: ~1.6M rows and ~450 MB per year, against a 500 MB Free-tier cap.

**Latency.** Production timings:

| Surface | Calls | avg | p95 | max |
|---|---|---|---|---|
| `worker/refresh-balances` | 480 | 9.4s | 13.6s | 39.5s |
| `worker/drain` | 576 | 4.1s | 13.7s | 32.9s |
| `api/queries` | 918 | 818ms | 2.35s | 40s |

| Function | Calls | mean | max |
|---|---|---|---|
| `keel_net_worth_daily` (long ranges) | 5 | **42–45s** | 45.7s |
| `keel_investments_overview` | 107 | 2,149ms | 7,885ms |
| `keel_latest_balances` | 28 | 964ms | 4,206ms |
| `keel_net_worth_as_of` | 5 | ~1,000ms | 2,890ms |
| `keel_list_transactions_rich` | 194 | 403ms | 3,327ms |

The dashboard fires **nine queries on mount** (`ledger.trial_balance`,
`dashboard.cash_flow_monthly`, `transactions.rich`, `recurring.list`, cash-flow
forecast, budgets, accounts, connections, schedules).

## 2. Are balance snapshots needed?

**Yes — the table is load-bearing.** It is read by `keel_net_worth_daily`,
`keel_net_worth_as_of`, `keel_latest_balances`, `keel_investments_overview` and
`keel_investments_value_daily`, and written by `keel_apply_account_balance`.
Dropping the table would destroy net-worth history and investment value trends;
those cannot be recomputed, because a provider balance at a past instant is not
derivable from the ledger.

What is *not* needed is the **repetition**. The distinction matters because it
is the difference between a lossless compaction and permanent data loss.

### Why removing consecutive duplicates is lossless

Every consumer reads snapshots as a **step function** — "the latest value at or
before this instant". From `keel_net_worth_daily`:

```sql
select b.current_minor from public.balance_snapshots b
 where b.household_id = ... and b.account_id = inv.account_id and b.source = 'plaid'
   and b.as_of < ((days.d + 1)::timestamp at time zone 'utc')
 order by b.as_of desc limit 1
```

and from `keel_latest_balances`:

```sql
select distinct on (bs.account_id) ...
  from public.balance_snapshots bs ... order by bs.account_id, bs.as_of desc
```

Given snapshots at `t1 < t2` for one account with identical values, and any
query instant `D`:

- `D < t1` — neither is selected. Unchanged.
- `t1 <= D < t2` — `t1` selected either way. Unchanged.
- `D >= t2` — with both rows present, `t2` is selected; with `t2` deleted, `t1`
  is selected. **Both carry the same value.** Unchanged.

So deleting a snapshot whose `(current_minor, available_minor, limit_minor,
currency)` equals its immediate predecessor's cannot change any answer any
consumer can produce. The only thing lost is the *timestamp of a
re-observation*, which nothing reads.

This is the entire correctness argument for phase 2 and is the thing the
adversarial audit should attack hardest.

## 3. Proposal

### Phase 1 — stop the bleeding (write side)

Make `keel_apply_account_balance` skip the insert when the newest existing
snapshot for that account already carries the same values.

- Removes ~99.9% of snapshot writes.
- Growth stops immediately; nothing existing is touched.
- Independently useful even if every later phase is rejected.
- Risk: low. It is a write-path guard with no read-model change.
- Must preserve: a snapshot whose value *did* change is always written; the
  first snapshot for an account is always written; a differing `source` is a
  different series and must not be collapsed across.

### Phase 2 — compact the existing 186,835 rows (lossless)

Delete only rows equal to their immediate predecessor per
`(household_id, account_id, source)` ordered by `as_of`, keeping:

- the first snapshot of every run of equal values (the transition), and
- the most recent snapshot per account unconditionally (belt and braces for
  `keel_latest_balances`).

Expected: ~186k rows to roughly the low thousands; ~50 MB to a few MB.

**This deletes production rows, which CLAUDE.md's soft-delete directive says to
stop and confirm.** Sequencing that respects it:

1. Materialise the survivor set into a real table (`balance_snapshots_archive`
   or equivalent) *first*, so the operation is reversible.
2. Verify equivalence BEFORE deleting: for a dense grid of dates across the
   full history, `keel_net_worth_daily` and `keel_latest_balances` must return
   byte-identical output computed against the compacted set vs the current set.
   If any date differs, abort.
3. Only then delete, in batches, inside a transaction per batch.
4. Keep the archive until the user says otherwise.

### Phase 3 — the 42-second `keel_net_worth_daily`

Phase 2 shrinks the table 30-fold, which should help. But **the 42 seconds is
not yet explained by row count alone**: the correlated probe is index-backed
(`household_id, account_id, as_of DESC`) and a 365-day range over a handful of
investment accounts is only a few thousand probes. Something else is likely
dominant — candidates: `keel_is_investment_subtype` (observed once at 1,397ms),
the `flows` CTE, or a planner choice that materialises badly at range size.

So phase 3 is **profile first, then fix** — `explain (analyze, buffers)` on the
real function at a 365-day range, before choosing between an index change, a
rewrite of the per-day probe into a single windowed pass, or a daily rollup
table. No design is committed here on purpose.

### Phase 4 — batch the dashboard's nine queries

Fold the nine mount-time reads into one composite call. This removes eight
round-trips' worth of function invocation and auth overhead per page load.

Worth doing, but sequenced last deliberately: it addresses **fixed overhead**,
not the multi-second queries. Batching nine calls where one takes 42s still
takes 42s. Phases 1–3 are the ones that move the number.

## 4. What this proposal explicitly does not claim

- That snapshots are unnecessary. They are necessary; only the repeats are not.
- That phase 2 alone fixes load times. It shrinks the table and stops growth;
  the latency fix is phase 3, and phase 3 is not yet diagnosed.
- That the 42s is caused by table size. That is a hypothesis, not a measurement.
- That pagination helps here. The ledger already paginates (`rich_page`); the
  slow reads are aggregates whose cost is in what they scan, not what they
  return.

## 5. Verification required before any of this ships

- Phase 1: pgTAP proving a repeated balance writes no row, a changed balance
  writes one, the first-ever snapshot writes one, and two different `source`
  values never collapse into each other.
- Phase 2: the equivalence check in §3 phase 2 step 2, run over the real data,
  as a gate rather than a report.
- Phase 3: before/after `explain (analyze, buffers)` on the same range.
- Phase 4: no behaviour change; the nine reads must return what they do today.
