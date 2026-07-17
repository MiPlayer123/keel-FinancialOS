# Plan — `investments-v1`

<!--
Deep plan for the one large item left in
docs/harness/plans/entities-investments-transfers.md (INVEST-1 /
S-investments-v1-holdings). Spec-gated: BC-v2.1's Investments section
dictates the shipping order, so this plan follows that order rather than
T1.9's full scope. ⚑ HUMAN TASTE PASS + a Plaid-dashboard checkpoint are
required before the sync half builds — see Checkpoints.
-->

- **Plan id:** `investments-v1` · **Date:** 2026-07-17
- **Parent:** `entities-investments-transfers` (INVEST-1, disposition fix-later)
- **KEEL baseline:** commit `cf072a4`
- **Approved by (⚑):** _pending_

## What ships, and what deliberately does not

BC-v2.1 §3 (Investments) fixes the order and it is not negotiable:

> "Balances and holdings ship first. Investment transactions and brokerage
> cash must reconcile before performance. Lots/cost basis/corporate actions
> ship only after completeness gates. Descriptive analytics may precede
> advice; personalized trade directives do not."

So **v1 = balances + a read-only holdings snapshot, and nothing past it.**
T1.9 in the build plan lists "holdings, balances, allocation, performance
(TWR + IRR), benchmark vs index" — this plan intentionally trims that to
holdings + balances + allocation only. Performance (TWR/IRR), lots, cost
basis, and benchmarks are **out of scope** here: BC-v2.1 gates them behind
investment-transaction + brokerage-cash reconciliation that v1 does not
build. Trades / rebalancing / personalized directives are **Law 10 class D
(disabled), permanently** — not deferred, disabled.

Of the ten tables BC-v2.1 names (securities, security_aliases, holdings,
investment_transactions, portfolio_cash, lots, lot_allocations,
corporate_actions, valuation_snapshots, investment_completeness), v1
materializes exactly **one: `holdings`** — with symbol denormalized onto the
row per the doc-10 §2 sketch (`holdings (… symbol text, qty numeric,
price_minor bigint, value_minor bigint, cost_basis_minor bigint null)`). A
`securities` master table is the next layer, not this one.

## The load-bearing invariant

**Holdings never post to the journal.** Today a connected brokerage already
syncs a *balance*, and that balance already flows into net worth through the
ledger (keel_finalize_link → accounts.subtype carries 'brokerage'/'ira'/…,
balance refresh posts it). The account balance stays the single source of
truth for net worth. Holdings are a **descriptive breakdown of a balance
that already exists** — they explain "what's inside the $47,000," they do
not add $47,000 a second time. If holdings posted to the ledger, every
brokerage would double-count. This is the one thing a reviewer must check on
every slice below: holdings are a snapshot table read alongside the account,
never a journal_batch.

Corollary: the sum of a snapshot's holdings will *approximate* but not
exactly equal the account's cash balance (uninvested cash, price staleness,
pending trades). v1 shows the holdings breakdown and the authoritative
balance side by side; it does **not** assert they're equal or "reconcile"
them — that reconciliation is the gate BC-v2.1 puts before performance, and
it's explicitly later work.

## Representation (Law 4)

- **qty**: `numeric` — fractional shares are real (0.001 shares, crypto).
  This is the one place non-money decimals are allowed; doc-10 §2 already
  specifies it. No float ever touches money.
- **price_minor, value_minor, cost_basis_minor**: `bigint` minor units, same
  as everywhere else. `value_minor` is stored (qty × price), not recomputed
  in floats at read time.
- Quantities are display-only descriptive data (class C at most), never an
  input to a ledger posting, so `numeric` here can't leak into money math.

## Slice backlog

| Slice | Title | Depends on | Size | Checkpoint |
|-------|-------|------------|------|------------|
| S-inv-1a | Holdings schema + read model + manual entry + positions UI | — | M | none |
| S-inv-1b | Plaid Investments holdings sync (worker path) | S-inv-1a | M | ⚑ Plaid dashboard |
| S-inv-1c | Allocation view (by asset class / by holding) | S-inv-1a | S | none |

### S-inv-1a — holdings, manual-first (no Plaid dependency)

Ships the whole vertical without touching Plaid, so it's testable and
mergeable on its own and de-risks the sync half.

- **Migration**: `holdings` table (household_id, account_id FK,
  as_of date, symbol text, name text, qty numeric, price_minor bigint,
  value_minor bigint, currency, source text check in ('manual','plaid'),
  created_at). RLS member-read; SECURITY DEFINER write procs
  (`keel_holding_upsert`, `keel_holding_delete`) following the
  keel_rename_account / keel_manual_transaction auth shape
  (keel_assert_member_write + audit_log). **Shipped shape (revised from
  the original as_of-keyed design during build, after review caught that
  it silently hid older positions):** unique on `(account_id, symbol,
  source)` — one current row per position, upserted in place, not a
  dated snapshot history. `as_of` is a per-row "last touched" date, not a
  shared account-level snapshot date. That changes when S-inv-1b's Plaid
  sync actually needs real dated history for its own source.
- **Read model**: `keel_list_holdings(household_id, account_id)` returns
  every current row in scope, plus the account's authoritative balance
  passed through alongside so the UI can show both without asserting
  equality.
- **Edge route + client**: `/holdings/list` query, `/holdings/upsert` +
  `/holdings/delete` commands in api/index.ts + keel-api.ts.
- **UI**: on the account detail page (`accounts/[id]`), when
  `subtype ∈ {brokerage, ira, roth, 401k, investment, …}`, render a
  "Holdings" card: positions list (symbol · shares · price · value) and a
  total. A manual "Add / edit holding" dialog. Non-investment accounts
  never see it.
- **Frozen tests**: a pure `packages/…` or web-lib helper for
  value_minor = round(qty × price_minor) done in integer/decimal space (no
  float) with property tests (value never drifts on re-render); read-model
  contract test; the double-count guard (holdings produce zero
  journal_postings) as an integration assertion.
- **Net worth**: unchanged. Explicitly assert in a test that adding holdings
  to an account does not change `keel_trial_balance` / net worth.

### S-inv-1b — Plaid Investments holdings sync ⚑

Same worker pattern as the existing `/transactions/sync` path
(worker/index.ts → plaid-sync.ts: credential decrypt via decryptToken +
KEK, lease model, raw_provider_events immutable storage, deterministic
ingest), but against Plaid's **`/investments/holdings/get`** endpoint
(snapshot, not cursor — simpler than transactions/sync). Writes holdings
rows with source='plaid', as_of = fetch date, replacing the prior plaid
snapshot for that account atomically.

- **⚑ CHECKPOINT — human required**: the Plaid Investments product must be
  enabled on the item/link (Plaid dashboard) and in the link_token products
  list. This is the same class of ⚑ as the original Plaid production
  approval — STOP and request the human; never stub a Plaid product flag to
  bypass it. Sandbox Investments can be exercised first.
- Idempotent: re-sync replaces the plaid snapshot (same (account_id, as_of,
  symbol, source) key), never appends duplicates.
- Manual holdings (source='manual') and plaid holdings coexist; a plaid
  sync only ever touches source='plaid' rows.

### S-inv-1c — allocation view

Pure read/UI on top of 1a's data: group the latest snapshot by a coarse
asset class (equity / fixed income / cash / other, derived from symbol/type
where Plaid provides it, else "unclassified") and render a calm allocation
bar (reuse the existing CategoryBarList / spending-mix component — no new
chart library). Descriptive only. No performance, no benchmark.

## Checkpoints (⚑)

1. **Plan taste pass** — this doc, before any slice builds. Confirm the
   trim (holdings + balances + allocation only; no performance/lots/cost
   basis) matches intent, and that manual-first (1a before 1b) is the right
   sequencing.
2. **Plaid Investments product** — before S-inv-1b. Human enables the
   Investments product in the Plaid dashboard and confirms sandbox testing
   is acceptable before any production item is touched.

## Rejected / deferred log

- **Performance (TWR/IRR), benchmarks** — in T1.9's wording but gated by
  BC-v2.1 behind reconciliation this slice doesn't build. Deferred, not
  rejected. Reopen once investment_transactions + portfolio_cash exist and
  reconcile.
- **lots / cost_basis / corporate_actions** — BC-v2.1 puts these behind
  completeness gates explicitly. Not in v1. `holdings.cost_basis_minor`
  exists as a nullable column (per the doc-10 sketch) but is display-only
  passthrough when a provider happens to supply it; no lot engine.
- **securities / security_aliases master tables** — v1 denormalizes symbol
  onto the holding row (doc-10 sketch does the same). The master table is
  the clean next layer once a second consumer needs it.
- **Trades / rebalancing / personalized directives** — Law 10 class D,
  disabled permanently, enforced by the approval_policies class-D-off
  constraint. Not a deferral.
- **Reusing packages/detectors or the ledger for holdings** — holdings are a
  snapshot, not an economic event; they must not go through journal_batches
  (double-count invariant above).
