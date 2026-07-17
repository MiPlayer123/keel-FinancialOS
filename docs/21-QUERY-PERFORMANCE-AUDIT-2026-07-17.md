# KEEL query/performance audit — 2026-07-17

This is the first pass of Workstream 4 from the full-app audit. It is intentionally measurement-first: the goal is to find the slow paths and duplicate request patterns before adding indexes, read models, or caches.

## What changed in this pass

- Added `pnpm audit:queries`, a local static inventory command that scans `apps/web/src` and `supabase/functions` for `useKeelQuery*` hooks, direct Supabase `.rpc(...)` calls, and direct `.from(...)` table access.
- Added lightweight read-query diagnostics: `/api/queries` now returns `rpcMs` + `edgeMs`, while the web client records `clientMs`, dispatches a `keel:query-timing` event, and can log timings when `localStorage.setItem('keel:perf', '1')` is enabled.
- Ran the inventory against the current tree to establish a repeatable baseline for future performance PRs.
- Captured the most important suspected hot paths below, with the validation required before any database optimization ships.

## Baseline inventory

Generated with:

```bash
pnpm audit:queries
```

Current counts:

| Surface | Count | Notes |
| --- | ---: | --- |
| `useKeelQuery*` hooks | 23 | User-facing query fan-out from React pages/components. |
| Direct `.rpc(...)` calls | 99 | Includes API read/write RPCs, worker RPCs, webhook helpers, and AI context reads. |
| Direct `.from(...)` calls | 28 | Mostly authz/context loading, provider sync state, and a small number of web helpers. |
| Direct `fetch(...)` calls | 0 | External/provider fetches are currently hidden behind helper abstractions or template calls that the static scanner intentionally does not treat as app query surfaces. |

Top repeated UI queries:

| Query | Hits | Current consumers |
| --- | ---: | --- |
| `transactions.rich` | 7 | Home, Ledger, Reports, account detail, paychecks, reimbursements, rebalance dialog. |
| `ledger.trial_balance` | 4 | Home, Accounts, account detail, recurring. |
| `recurring.list` | 4 | Home, Recurring, Review, Paychecks. |
| `dashboard.cash_flow_monthly` | 2 | Home, Reports. |

## Highest-priority findings

### P0 — Home dashboard query fan-out needs timing before adding more widgets

Home currently starts with four `useKeelQuery*` calls: trial balance, monthly cash flow, rich transactions, and recurring series. The page also performs additional imperative fetches for accounts, schedules, connections/sync state, and forecast data in child/effect paths.

Why this matters:

- The Home route is the first perceived-performance surface.
- `transactions.rich` is a broad ledger read and is reused by many pages.
- Adding Notes & Tasks was intentionally lightweight, but each new dashboard widget increases the chance that latency comes from request fan-out rather than a single slow SQL plan.

Validation required before optimization:

1. Enable browser timing logs with `localStorage.setItem('keel:perf', '1')`, reload `/dashboard`, and capture the console output / `keel:query-timing` events.
2. Capture network waterfall for `/dashboard` in staging with a realistic household.
3. Compare `clientMs`, `edgeMs`, and `rpcMs` for each query key: `ledger.trial_balance`, `dashboard.cash_flow_monthly`, `transactions.rich`, `recurring.list`, `notes_tasks.list`, accounts, schedules, connections, and forecast.
4. If time is mostly request overhead/edge round trips, prototype one `dashboard.home_snapshot` RPC/read envelope that returns the minimal first-screen data.
5. If time is mostly SQL, run `EXPLAIN (ANALYZE, BUFFERS)` on the specific slow RPCs before adding indexes.

Do **not** add a dashboard read model yet without proving whether the bottleneck is network fan-out or SQL execution.

### P0 — `transactions.rich` is the broadest repeated read and likely needs pagination/filtering review

The static inventory found `transactions.rich` in seven UI locations. This makes `keel_list_transactions_rich` the first RPC to measure.

Validation required before optimization:

1. Run `EXPLAIN (ANALYZE, BUFFERS)` for `keel_list_transactions_rich(p_household_id := ...)` on a seeded or production-like household.
2. Confirm whether the RPC already applies a sane date/limit window for every consumer.
3. If Ledger/account detail need deep history, prefer keyset pagination with `(effective_date, id)` or equivalent stable ordering rather than offset scans.
4. If Home/Reports only need recent rows, split those consumers to a narrower summary/recent-transactions RPC instead of forcing every page through the same rich read.

### P1 — Mutation invalidation is intentionally broad but may over-refetch on heavy pages

`useKeelQuery` currently invalidates the whole `keel-query` namespace after a mutation. That is correct for data integrity, but it can be expensive on pages with several mounted query consumers.

Validation required before optimization:

1. Instrument which query keys refetch after common mutations: categorize transaction, settle reimbursement, save note/task, complete task, rename account.
2. Keep broad invalidation for ledger-impacting mutations.
3. Consider scoped invalidation for clearly isolated mutations, especially notes/tasks, only if the refetch waterfall is measurable.

### P1 — Assistant context snapshot performs a six-way read

The assistant context path reads entities, trial balance, rich transactions, categories, budgets, and accounts in parallel. This is defensible for answer quality, but it means assistant latency will track the slowest of those reads.

Validation required before optimization:

1. Time each promise in the assistant context snapshot separately.
2. Measure `keel_list_transactions_rich`, `keel_trial_balance`, and `keel_list_budgets` first.
3. If the assistant only needs recent transactions for most questions, introduce a narrower assistant-context RPC rather than reusing the broad UI ledger read.

### P2 — Command authz preloads are parallel, but direct table access should stay indexed

The API authz context loads household memberships, entity memberships, account ownerships, and resource permissions in parallel. This path gates commands and recurring command authorization.

Validation required before optimization:

1. Confirm indexes exist for `user_id`, `resource_kind + user_id`, and account/entity join keys.
2. Use `pg_stat_statements` to confirm whether authz loads are material compared with command RPC time.
3. Avoid denormalizing authz unless those reads become a measured bottleneck.

## Measurement checklist for the next implementation PR

Use this checklist before shipping a performance optimization:

- [ ] Paste the exact route/action being measured.
- [ ] Paste before timings from `clientMs`, `edgeMs`, `rpcMs`, the browser waterfall, or server logs.
- [ ] Paste `EXPLAIN (ANALYZE, BUFFERS)` for each slow SQL path.
- [ ] Note current indexes used by the plan.
- [ ] If adding an index, explain its write cost and why an existing index cannot satisfy the query.
- [ ] Paste after timings and after query plans.
- [ ] Confirm no duplicate/overlapping index was added.

## Recommended next PR after this audit

Start with one measured target:

1. Measure `/dashboard` request fan-out.
2. Measure `keel_list_transactions_rich` because it is the most reused query.
3. If Home latency is network-bound, add a minimal `dashboard.home_snapshot` RPC.
4. If `transactions.rich` is SQL-bound, add pagination/narrower query paths or an index only with before/after plans.
