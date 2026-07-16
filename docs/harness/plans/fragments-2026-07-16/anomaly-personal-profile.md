# Anomaly diagnosis — "Personal Profile · Checking" −$1,711.04 under ASSETS

Finding: COMPETITIVE-TEARDOWN-2026-07-16 P1 data-trust item
("Personal Profile · Checking −$1,711.04 sits under Assets unflagged"),
Wave 0 Cluster D. Evidence surface: `accounts-desktop.png`, dashboard net worth.

## TL;DR

A checking **asset** shows deeply negative because its displayed balance is the
raw sum of postings on its ledger account (`keel_trial_balance`), and the
account was **never anchored with an opening-balance entry**. Un-anchored, the
ledger sum equals only the ~30-day window of synced Plaid transactions, whose
net for the Plaid **Sandbox** default checking account is −$1,711.04 (a large
`AUTOMATIC PAYMENT` outflow dominates the window). The code that computes and
displays the number is arithmetically correct; the sign is not flipped. This is
a **DATA / ops state exposed by a display gap**, not a mis-signed-balance code
bug. No safe ≤10-line code fix exists — the real fix is design-level and is
deferred (see Recommended fix).

## How the displayed balance is computed

- Accounts list, account detail, dashboard, and recurring all read
  `ledger.trial_balance` and render `Σ amount_minor` per ledger account as the
  account balance:
  - `apps/web/src/app/dashboard/accounts/page.tsx:40` (`useKeelQuery<TrialBalanceRow>('ledger.trial_balance', …)`),
    then `balanceByLedger.get(a.ledgerAccountId)` at `:76-82` feeds `<Money>`.
  - `apps/web/src/app/dashboard/page.tsx:408`, `apps/web/src/app/dashboard/accounts/[id]/page.tsx:49`,
    `apps/web/src/app/dashboard/recurring/page.tsx:84` — same source.
- `keel_trial_balance` = `sum(p.amount_minor)` grouped by `ledger_account_id`
  over every batch in the household — `supabase/migrations/20260710210600_command_procs.sql:680-724`.
- Net worth uses the same debit-positive ledger sum over asset+liability
  accounts — `supabase/migrations/20260712160000_dashboard_readmodel.sql:11-66`.
- Grouping into ASSETS vs LIABILITIES is by `ledger_accounts.kind`
  (`accounts/page.tsx:101-103`); it does not affect the number's sign.

Sign convention is debit-positive: asset balance is positive when the account
holds money. The Plaid→KEEL boundary negates Plaid's amount correctly
(`packages/providers/plaid/src/sign.ts:8-20` — Plaid positive = outflow →
negative KEEL minor), and sign-based offset routing is deterministic
(`supabase/functions/worker/index.ts:143-144`). So the sign path is sound.

## Why the account is not anchored

The system knows a synced ledger total is meaningless until anchored to the
provider's reported balance, and books a one-time "Opening Balances" equity
entry so `Σ postings == provider current balance`
(`supabase/migrations/20260712190000_account_balances.sql`, header + body). But:

- **The only caller of `keel_apply_account_balance` is the worker
  `/refresh-balances` endpoint** — `supabase/functions/worker/index.ts:922`
  (grep across `supabase/functions` returns exactly one non-test call site).
- `/refresh-balances` is driven only by the pg_cron bridge
  `keel_cron_drain_sync`, which no-ops unless the vault secrets
  `keel_automations_key` and `keel_functions_base` are present
  (`supabase/migrations/20260712190000_account_balances.sql`, `keel_cron_drain_sync`).
- **There is no anchor at link / first-sync time.** Initial Plaid sync
  (`supabase/migrations/20260711130000_c5b_sync_pull.sql`) posts transactions
  but never calls the anchor.
- `/refresh-balances` also only processes connections with `status = 'active'`
  (`worker/index.ts:861-863`).

So an account synced before the balance-refresh cron fires (local dev, or any
environment where the automations vault secrets are unset / cron not yet run,
or the connection was not `active` at refresh time) shows its raw window sum.
`keel_latest_balances` (the provider's real reported current balance from
`balance_snapshots`, `account_balances.sql`) **is never read by the web UI** —
grep for `latest_balances`/`balanceSnapshot` in `apps/web/src` returns nothing.
So there is no fallback to the true balance and no "unanchored" signal.

## Ranked hypotheses

1. **[HIGH — DATA/ops + display gap] Un-anchored account: opening balance never
   booked, UI shows raw ~30-day ledger window.** The −$1,711.04 is the net of
   the Plaid Sandbox default checking transaction set. Evidence: single anchor
   call site behind a cron/vault gate with no link-time anchor
   (`worker/index.ts:922`, `account_balances.sql keel_cron_drain_sync`); UI
   reads only `ledger.trial_balance` and never `keel_latest_balances`
   (`accounts/page.tsx:40`, `command_procs.sql:680`). This is the root cause.

2. **[LOW — historical, self-healing] Legacy auto-anchor suppression.** The
   original marker in `20260712190000_account_balances.sql`
   ("`canonical_transaction_id is null and reverses_batch_id is null` touching
   this ledger account") also matched any manually recorded transfer, wrongly
   suppressing the one-time anchor forever on any account with a manual
   transfer. Fixed in `20260714120000_account_opening_balance.sql` (marker now
   requires a leg on BOTH the account AND the entity "Opening Balances" equity
   account). The fix self-heals on the next `/refresh-balances` cycle, so it
   only explains a stale negative if that cycle has not run since the fix.

3. **[LOW — DATA] Mis-signed manual opening balance.** A user entering a
   negative `balance_minor` for an asset via `accounts.set_opening_balance`
   would legitimately book a negative asset (`keel_cmd_set_opening_balance`,
   `20260714120000_account_opening_balance.sql`). Requires deliberate misuse;
   the proc's convention is correct (`v_target = +balance for asset`).

**Ruled out:**
- **(b) Transfer legs double-counted.** Transfers are a classification overlay;
  `transfer_links` never touch the ledger (`20260713020000_transfers.sql`
  header: "the ledger itself is never touched"). They cannot produce a negative
  asset sum.
- **(c) Entity/account misfile.** Group membership is by `ledger_accounts.kind`
  and only changes which section the row appears under, not the sign of
  `Σ amount_minor`.

## CODE bug or DATA state?

**DATA / ops state**, surfaced by a **display trust gap** in product code. The
number is computed correctly from the postings that exist; the postings are
just incomplete (no opening anchor). No sign is inverted, no leg is
double-counted. There is **no unambiguous ≤10-line code fix**, so per the
diagnosis-first mandate no code change was committed with this diagnosis.

## Recommended fix (design-level, defer to a Wave slice / next ⚑)

Any one of, roughly in order of correctness:

1. **Anchor at link / first successful sync**, not only via the periodic cron —
   call the balance-refresh path once on connection activation so every synced
   account is anchored to its provider current balance before it is ever
   displayed. (Touches `worker`/link saga; > 10 lines; needs test coverage.)
2. **Display the provider snapshot as the account balance.** Have the account +
   net-worth read models surface `keel_latest_balances` (real reported current)
   as the headline number, with the ledger sum reserved for the register /
   running-balance detail. (Read-model + UI change; semantic.)
3. **Badge un-anchored accounts.** If no opening anchor exists for an account,
   flag the balance as "pending first balance sync" rather than presenting the
   window sum as fact (Seven invariants: explicit ownership — never present an
   inference as settled fact). Minimal but still a new UI state.

Recommend (1)+(3) together: anchor eagerly, and never render an un-anchored
window sum as an authoritative balance.
