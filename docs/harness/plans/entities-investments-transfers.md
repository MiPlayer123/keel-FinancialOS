# Plan — `entities-investments-transfers`

<!--
Not a census-fed plan: this is a direct spec-vs-built audit of three areas
(business entities, investment accounts, manual-transfer detection),
requested and read live in a Claude Code session on 2026-07-17. Evidence is
file:line citations against the running codebase, not screenshot census
records, so the Dispositions table below uses fix-now/fix-later/wontfix in
place of adopt/adapt/reject/already-have/defer. Same gate: nothing ships
until the ⚑ taste pass below is signed off, and slices still freeze tests
before implementation per the harness.
-->

- **Plan id:** `entities-investments-transfers` · **Date:** 2026-07-17
- **Input:** live code audit (schema, worker/sync code, UI, BC-v2.1 / build
  plan) — no evidence drop
- **KEEL baseline:** commit `cb99689`
- **Approved by (⚑):** _pending_

## Scope

Answers to a direct question: how does KEEL handle (1) multiple business
entities / LLCs alongside personal finances, (2) investment/retirement
accounts (Roth, 401k, brokerage), and (3) manual accounts with transfer
auto-detection. Ground truth gathered via two parallel Explore-agent audits
of `supabase/migrations/*.sql`, `supabase/functions/worker`,
`apps/web/src/components/keel/*`, `apps/web/src/app/dashboard/**`,
`docs/BC-v2.1.md`, and `docs/09-KEEL-BUILD-PLAN.md`.

## Findings

### ENTITY-1 — Plaid connections auto-attach to the first entity with no picker [P1]
- **Evidence:** `apps/web/src/components/keel/plaid-link-button.tsx:31-39`
  calls `fetchFirstEntityId(householdId)` and passes that straight into the
  link/connect command; no entity selector is shown even when the household
  has 2+ entities.
- **KEEL today:** The entity model itself is real and load-bearing —
  `entities` table (`supabase/migrations/20260710210100_identity_authz.sql:19-26`),
  `accounts.entity_id` is `not null` (line 65), reports already filter by
  entity once a second one exists (`apps/web/src/app/dashboard/reports/page.tsx:96,283-305`).
  Manual account creation already has a working inline entity picker
  (`add-account-dialog.tsx:85-143`). Only the Plaid path skips it.
- **Fix:** Add the same entity picker `add-account-dialog.tsx` already has
  to the Plaid Link flow (show it whenever `entities.length > 1`, matching
  the existing "don't force a choice when there's nothing to decide
  between" rule), before the connection is finalized server-side.
- **Maps to:** BC-v2.1 §9.1 explicit ownership (an account's entity is a
  fact the user asserts, not inferred); no existing tier ticket — net-new.

### ENTITY-2 — No command to move an already-connected account to a different entity [P1]
- **Evidence:** Grep across `supabase/migrations/*.sql` and
  `apps/web/src/lib/keel-api.ts` for an account-reassign command found only
  category reassignment (`20260713090000_subcategories.sql:759-860`,
  `keel-api.ts:698-707`); no `keel_cmd_update_account` / entity-reassign
  proc exists.
- **KEEL today:** Combined with ENTITY-1, an account connected under the
  wrong entity (e.g. business Fidelity landing under personal because it
  was the first/only entity at connect time) is stuck there permanently.
- **Fix:** New command `accounts.reassign_entity` (household-scoped,
  entity-scoped authz check both sides), following the same
  audited/reversible shape as the category-reassign command it's modeled
  on. Journal postings and category overlays stay put; only `accounts.entity_id`
  and `ledger_accounts.entity_id` move, inside one transaction.
- **Maps to:** BC-v2.1 §9.1 explicit ownership + reversible correction.

### INVEST-1 — Investment/retirement accounts sync balance + cash transactions only; no holdings [P2]
- **Evidence:** `supabase/migrations/20260711140100_c3_link_disconnect_saga.sql:200-230`
  stores every Plaid account (any subtype, including `ira`/`brokerage`/`401k`)
  identically to a checking account — `kind` collapses to `'asset'`, no
  subtype branching. Zero `create table holdings|securities|lots` across all
  migrations (confirmed by full grep). No Plaid Investments product call
  found in `supabase/functions/worker`.
- **Spec says:** `docs/BC-v2.1.md` (Investments section) explicitly gates
  this: "Balances and holdings ship first. Investment transactions and
  brokerage cash must reconcile before performance. Lots/cost basis/
  corporate actions ship only after completeness gates." `docs/09-KEEL-BUILD-PLAN.md`
  T1.9 ("Investments v1: holdings, balances, allocation, performance") is
  scheduled but not built — no milestone currently claims it.
  **This is a known, already-planned gap, not a bug** — flagging it here so
  it's tracked alongside the other two rather than lost.
- **Fix (when prioritized):** Ship in the order BC-v2.1 already mandates:
  (a) `holdings` + `securities` tables, Plaid Investments `/holdings/get`
  sync, read-only positions + allocation view; (b) `investment_transactions`
  + portfolio cash reconciliation; (c) `lots`/cost basis only after (a)+(b)
  pass completeness gates. Do not build lots first.
- **Maps to:** `docs/BC-v2.1.md` Investments section; `docs/09-KEEL-BUILD-PLAN.md` T1.9.

### TRANSFER-1 — No manual "link these two as a transfer" override for near-misses [P3]
- **Evidence:** `supabase/migrations/20260713020000_transfers.sql:14-106`
  (`keel_detect_transfers`) requires exact opposite amount, same currency,
  ±3 day window. No UI or command found to manually pair two transactions
  the detector missed (e.g. a $100 transfer that arrives as $99.50 after a
  wire fee).
- **KEEL today:** Detection itself is solid and source-blind (manual ↔
  Plaid ↔ import all pair identically), suggest→approve is correctly wired,
  and the one-shot "Record transfer" dialog covers the common manual case.
  This is a real but minor gap, not a broken feature.
- **Fix:** Add a "mark as transfer" action on two selected transactions in
  the ledger/review UI that calls a new command creating a `transfer_links`
  row directly with `status = 'suggested'` (still goes through the same
  approve step — no bypass of Law 2).
- **Maps to:** net-new; no existing tier ticket.

### TRANSFER-2 — Recurring transfers (e.g. weekly checking→savings) aren't recognized as a series [P3]
- **Evidence:** `packages/detectors` recurring-detection logic operates on
  `canonical_transactions` only, not on `transfer_links`; a confirmed
  transfer repeated weekly shows as N independent confirmed pairs with no
  grouping.
- **Fix:** Extend recurring detection to run over confirmed transfer pairs
  the same way it runs over transactions, surfacing a "recurring transfer"
  card instead of N separate ones. Lower priority than TRANSFER-1.
- **Maps to:** net-new; depends on existing recurring-detector plumbing.

Disposition counts: fix-now `2` (ENTITY-1, ENTITY-2) · fix-later `1`
(INVEST-1, already spec-gated) · nice-to-have `2` (TRANSFER-1, TRANSFER-2) ·
**total `5` findings**.

## Slice backlog

| Slice | Title | Findings | Depends on | Size |
|-------|-------|----------|------------|------|
| S-entity-connect-binding | Entity picker on Plaid connect + account→entity reassign command | ENTITY-1, ENTITY-2 | — | S |
| S-investments-v1-holdings | Holdings/securities schema + Plaid Investments sync + read-only positions view | INVEST-1 | — | L |
| S-transfer-manual-link | Manual "mark as transfer" override for near-miss pairs | TRANSFER-1 | — | S |
| S-transfer-recurring | Recurring-transfer grouping | TRANSFER-2 | S-transfer-manual-link (shares review-UI surface) | S |

**Ordering rationale:** S-entity-connect-binding first — smallest, unblocks
the exact "connect business Fidelity" scenario that surfaced this audit,
and the entity model underneath it is already fully built (schema + reports
+ manual-account picker all exist; this slice only closes the Plaid-path
gap). S-investments-v1-holdings is the large lift and matches BC-v2.1's own
prescribed order (balances/holdings → transactions/reconciliation → lots);
do not start it until entity binding ships, since a newly-connected
brokerage should land under the correct entity from day one. The two
transfer slices are polish on an already-solid feature — safe to defer
indefinitely without user-visible breakage.

## Rejected / deferred log

- **Investment lots/cost-basis** — explicitly not sequenced in this plan;
  BC-v2.1 gates it behind INVEST-1's completeness checks. Building it first
  would violate the spec's own ordering.
- **Auto-creating a default "personal" entity on household signup** —
  considered, not included as a finding: the current empty-until-created
  behavior wasn't reported as broken (manual account creation already
  offers inline entity creation as a fallback), and the Plaid-connect fix
  in ENTITY-1 needs an entity to exist before it can show a picker either
  way. Revisit only if onboarding friction is reported.
