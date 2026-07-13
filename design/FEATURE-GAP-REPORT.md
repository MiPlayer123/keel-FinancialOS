# KEEL — Feature Gap Report

**Date:** 2026-07-12
**Scope:** (A) internal audit of what is implemented in code as of Stage 1D; (B) external research on comparable products and the gaps they reveal.
**Method:** repo survey of `supabase/migrations/*.sql`, `packages/*`, `supabase/functions/*`, `apps/web/src/*`, plus docs (CLAUDE.md, BC-v2.1, docs 09/10/13/19, PROGRESS.md, NOTES.md). External research via web search/fetch of official docs and reputable reviews (sources at end).

Status legend: **Implemented** (backend + reachable) · **Partial** (some layer present, named gap) · **Missing** (no code) · **Planned-only** (specced, not built).

---

## Part A — Capability status (with evidence)

| # | Capability | Status | Evidence (path) | Gap / notes |
|---|---|---|---|---|
| 1 | Double-entry ledger (postings, balanced invariant, journal, revisions) | **Implemented** | `supabase/migrations/20260710210300_ledger.sql` (canonical_transactions, journal_batches, journal_postings, journal_revisions, deferred `keel_check_batch_balance`); `packages/ledger/` | Σ=0 invariant (Law 3), append-only, reversals via revisions, period locks. Solid. |
| 2 | Accounts (types, balances) | **Implemented** | `supabase/migrations/20260710210100_identity_authz.sql` (accounts, ledger_accounts with kind asset/liability/income/expense; `keel_trial_balance`); `balance_snapshots` in dashboard migration | Balances derived from postings; lineage tracked. |
| 3 | Entities (personal + LLC / multi-entity) | **Implemented** (backend) / **Partial** (UX) | `20260710210100_identity_authz.sql` (entities.entity_kind, entity_memberships, resource_permissions, households/household_memberships) | Ownership + membership model exists. No entity-switcher / consolidated multi-entity dashboard UI; no capital-account/owner-draw semantics (see #18). |
| 4 | Plaid connections / sync (link, item, cursor, reauth) | **Implemented** | `20260711130000_c5b_sync_pull.sql`, `20260711140100_c3_link_disconnect_saga.sql`, `20260711150000_c4_webhook_keys.sql`; `supabase/functions/_shared/plaid-*.ts`; `apps/web/.../connections/page.tsx` | Cursor sync, reauth lifecycle, disconnect+crypto-shred, metering. Live-proven against Sandbox. |
| 5 | Transactions ingestion (raw events, canonical, dedupe) | **Implemented** | `20260710210200_ingestion.sql` (raw_provider_events, normalized_source_records, `ingestion_skips`); `keel_cmd_promote_event`; `packages/ingest/` | Immutable raw→normalized→canonical spine; idempotent dedupe. |
| 6 | Recurring detection / subscriptions | **Implemented** (backend) / **Partial** (UX) | `20260712120000_recurring.sql` (recurring_series, recurring_candidate_versions, recurring_occurrences, status events); `packages/detectors/` | Suggest/confirm/pause/resume/cancel/reject; evidence + confidence bps. UI limited to the `review` page; no dedicated recurring calendar/list with paid/missed status. |
| 7 | Transfers between accounts (transfer_links) | **Partial** | Table only: `20260710210700_webhook_quarantine_transfers.sql` (transfer_links: txn_out, txn_in, status) | **Schema exists, no command procs** — cannot create/confirm/reject a transfer link; no auto-pairing detector; no exclusion wired into cash-flow/net-worth; no UI. This is the single most load-bearing gap (double-counting risk). |
| 8 | Reimbursements / bill-split / P2P | **Implemented** | `20260712140000_reimbursements.sql` (expense_shares, reimbursement_claims, settlements, settlement_matches, refund_expectations); `packages/reimbursements/`; `apps/web/.../reimbursements/page.tsx` | Create/settle/reverse; advisory-locked over-allocation guard; zero income impact. Gate 7 GREEN. |
| 9 | Paychecks / payroll | **Implemented** | `20260712130000_paychecks.sql` (paychecks, paycheck_components, paycheck_sources, transaction matches); `packages/paychecks/`; `apps/web/.../paychecks/page.tsx` | Gross/withholding/401k/HSA/FSA/RSU/garnishment/direct-deposit component kinds. Gate 6 GREEN. |
| 10 | Statement close / reconciliation | **Implemented** | `20260712150000_reconciliation.sql` (statements, statement_lines, reconciliation_sessions/items/adjustments, close_checklists, period_locks); `packages/reconciliation/`; `apps/web/.../statements/page.tsx` | Opening+lines=ending, per-line explanation, period lock + audited reopen. Gate 8 GREEN. Stronger than most competitors. |
| 11 | Categorization / categories | **Partial** | Categories = ledger_accounts with `is_category` in `20260710210100_identity_authz.sql` | Static chart of accounts only. **No transaction-categorization command, no category tree UI, no auto-categorize / ML / AI, no per-txn recategorize flow.** Categorization harness (≥85% target, CLAUDE.md) not built. |
| 12 | Budgets / envelopes | **Missing** | — | No tables, procs, package, or UI. |
| 13 | Goals | **Missing** | — | No tables, procs, or UI. |
| 14 | Net worth | **Implemented** (compute) / **Partial** (UX/history) | `20260712160000_dashboard_readmodel.sql` (`keel_net_worth_as_of`) | As-of value by currency. No trend-over-time series/chart surfaced in UI beyond dashboard card. |
| 15 | Cash flow | **Implemented** (compute) / **Partial** (UX) | `20260712160000_dashboard_readmodel.sql` (`keel_cash_flow`); `apps/web/.../cash-flow-card.tsx` | Inflow/outflow/net by period+currency. No Sankey, no category breakdown, no forecast. |
| 16 | Spending analysis | **Partial** | `keel_cash_flow` + `keel_trial_balance` | No period-over-period comparison, no category drilldown, no merchant/vendor rollup. |
| 17 | Investments / holdings / trades / lots / cost basis | **Missing** | — | No securities/holdings/lots/trades tables. Accounts can be modeled but no portfolio, cost basis, performance, or lot accounting. |
| 18 | Tax (Schedule C, reserves, packs, owner draws) | **Missing** / **Planned-only** | Referenced in BC-v2.1 / docs; no code | No tax-line mapping on categories, no Schedule C, no reserve computation, no owner-draw/distribution/capital-account model, no tax export pack. |
| 19 | Reports / exports (CSV/JSON/QIF/beancount) | **Implemented** (export) / **Missing** (reports) | `20260711180000_export.sql` (`keel_export_household`, `keel_export` role); `packages/exports/` (csv/json/qif/beancount); `/api/admin/export` | Full-fidelity export (Law 6, gate 13) GREEN. **No report views** (P&L, spend-by-category, trends, custom reports) beyond raw export. |
| 20 | Receipts / documents | **Missing** | resource_permissions has a `document` kind but no implementation | No storage wiring, OCR, or receipt-match. `packages/documents` and `packages/reports` from repo-shape spec **do not exist yet**. Receipt-match precision ≥90% target (CLAUDE.md) not started. |
| 21 | Rules / automations | **Missing** | — | No rules engine (condition→action), no auto-apply, no retroactive apply. |
| 22 | Autonomy policies (AI risk ladder) | **Partial** | `20260710210100_identity_authz.sql` (approval_policies: risk_class A–D, autonomy off/suggest/auto_with_log) | Policy **framework** present (Class D forced off). No AI actually routes through it yet. |
| 23 | Audit / undo / reversibility | **Implemented** (backend) / **Partial** (UX) | `20260710210400_events_audit_queues.sql` (audit_log, domain_events, command_executions); journal_revisions | Append-only audit + reversal commands + idempotency. No user-facing one-click undo; reversal is a manual command. |
| 24 | Multi-currency / FX | **Partial** | currency char(3) on all money tables; cash-flow/net-worth refuse cross-currency mixing | Schema is currency-aware but there are **no FX rate tables, no conversion, no cross-currency consolidation**. |
| 25 | Search | **Missing** | — | No transaction/account full-text or filtered search. |
| 26 | Notifications | **Missing** | — | connection_health_events exist but no notification/subscription/delivery layer. |
| 27 | AI layer (typed responses, categorize, narrate, agents) | **Partial** / **Planned-only** | `packages/contracts/src/ai.ts` type stubs; approval_policies | Typed-response **contract types** exist. `packages/ai`, `packages/authz`-driven scope compiler for AI, and any live LLM node (categorize/narrate/NL→params) are **not built**. |

**Extra capabilities found (not asked, worth noting as strengths):** provider budget metering + circuit breakers (`provider_call_budget`, `keel_meter_provider_call`), webhook quarantine/DLQ (`webhook_rejections`, `plaid_webhook_keys`), idempotency/command-dedup (`command_executions`, `economic_event_key`), balance snapshots, ingestion-skip tracking, household/membership/role model.

**Packages that the repo-shape spec lists but that do not yet exist:** `packages/documents`, `packages/reports`, `packages/ai`, `packages/imports` (only `packages/ingest` exists), `apps/mcp`.

---

## Part B — Prioritized gaps (missing / partial)

Each: why it matters · effort (S/M/L) · surface (BE = backend, FE = frontend).

### Tier 1 — correctness & core UX (do first)

1. **Transfers: command procs + auto-pair detector + exclusion + UI** — *Without this, every inter-account move (CC payment, savings sweep) double-counts in cash-flow and net-worth — a correctness bug, not a nicety. Competitors treat this as table stakes.* **M–L · BE+FE.** Table exists; needs `keel_cmd_link_transfer/decide`, a fuzzy amount+date+sign pairing detector (reuse `packages/detectors` patterns), wiring into `keel_cash_flow`/`keel_net_worth_as_of` to exclude confirmed transfers, and a suggest→approve UI (Law 10 Class B).

2. **Transaction categorization: recategorize command + category tree + review inbox** — *Categorization is the daily-driver interaction; today there is no way to categorize a transaction. Blocks spending analysis, budgets, tax, and the ≥85% harness gate.* **L · BE+FE.** Needs a category model beyond bare ledger accounts, a `keel_cmd_categorize` (suggest→approve), and a "To Review" inbox. Pair with #10.

3. **A real transactions list/detail screen with filters + search** — *There is no transactions list UI; users cannot see, filter, or edit their transactions.* **M · FE (BE search = S).** Add `apps/web/.../transactions` with virtualized list (CLAUDE.md perf bar), filters, and a `keel_search_transactions` query proc (covers #25).

4. **Budgets / envelopes** — *The most-requested consumer feature across YNAB/Monarch/Copilot/Simplifi; nothing exists.* **L · BE+FE.** Envelope table + per-period assignment + rollover (jar vs pool), category-balance carryover, "Left this month" compute. Depends on #2.

### Tier 2 — high-value depth

5. **Cash-flow forecasting (recurring-driven) + lowest-balance flag** — *Recurring detection already exists; projecting it forward is the natural, differentiating payoff. Quicken/Monarch lead here; YNAB/Copilot are weak.* **M · BE+FE.** Class-C preview-only (Law 10). Reuse `packages/detectors` projection.

6. **Reports: spend-by-category, trends, Sankey cash-flow, P&L** — *Export exists but there are no analytic views; the Sankey is the signature "where did money go" viz.* **M · FE (BE aggregation = S–M).** Period-over-period, relative date ranges.

7. **Investments: holdings + cost basis + lots + performance** — *Whole domain missing; needed for net-worth accuracy and for tax (Schedule D). Empower/Quicken-Premier set the bar.* **L · BE+FE.** securities/holdings/lots/trades tables, lot-allocation invariant (already named in CLAUDE.md quality bars), TWR/IRR compute, allocation view.

8. **Tax: category→tax-line mapping, Schedule C, owner draws/capital accounts, reserves** — *Core to KEEL's multi-entity/LLC thesis and a genuine whitespace — Mercury/Ramp/Brex all delegate capital accounts to an ERP.* **L · BE+FE.** Tax-line on categories, Schedule C report, owner-draw/distribution posting semantics, tax-reserve preview (Class C).

9. **Goals (savings + pay-down) with target-driven contributions** — *Complements budgets; YNAB "have a balance of X by date" is the pattern.* **M · BE+FE.** Depends on accounts/budgets.

### Tier 3 — enablers & polish

10. **AI categorization node with typed responses + confidence routing** — *Turns #2 from manual into KEEL's differentiator; the typed-response contract already exists in code.* **L · BE+FE.** Class-B suggest→approve; confidence routes within class (auto-apply above threshold with badge, surface top-2 below — Copilot pattern). Needs `packages/ai`.

11. **Receipts / documents (storage + match)** — *Enables receipt-match precision gate; Law 5 keeps ingested text data-tier.* **M–L · BE+FE.** Supabase Storage wiring, `packages/documents`, match against transactions.

12. **Rules / automations engine** — *Condition→action (rename, recategorize, tag, split), retroactive apply. Every competitor has it.* **M · BE+FE.**

13. **Net-worth trend + entity switcher / consolidated multi-entity view** — *Backend computes net worth; needs a time-series chart and an entity switcher to realize the multi-entity value.* **S–M · FE (BE snapshot series = S).**

14. **FX / multi-currency consolidation** — *Schema is currency-aware but cannot consolidate; needed once a second currency appears.* **M · BE (+FE toggle).** Rate table + as-of conversion with reproducibility metadata.

15. **Notifications** — *Recurring-due, reauth-needed, budget-overrun, statement-ready alerts.* **M · BE+FE.**

16. **User-facing undo** — *Reversibility exists as commands; expose it as one-click undo with the audit trail behind it.* **S–M · FE (BE mostly done).**

---

## Recommended next 5

1. **Transfers end-to-end (procs + auto-pair + exclusion + UI).** Fixes an active double-counting correctness bug; unblocks trustworthy cash-flow and net-worth. *(gap #1)*
2. **Transactions list/detail screen + search + categorize command.** The missing daily-driver surface; nothing else in the app is usable day-to-day without it. *(gaps #2, #3)*
3. **AI categorization node with typed responses + confidence routing.** Converts categorization from manual chore into KEEL's suggest→approve differentiator; the contract types already exist. *(gap #10, builds on #2)*
4. **Budgets / envelopes.** Highest-demand consumer feature; depends on categorization landing first. *(gap #4)*
5. **Cash-flow forecast (recurring-driven) + reports (Sankey + spend-by-category).** Turns the already-built recurring engine and dashboard read-model into the visible, differentiating payoff. *(gaps #5, #6)*

Rationale: 1 is correctness (must), 2–3 make the product usable and showcase the AI-first thesis, 4–5 deliver the features users actually shop for — all reuse infrastructure that already exists (detectors, dashboard read-model, typed-AI contract, approval policies).

---

## Sources

**Personal finance:**
- Monarch: help.monarch.com (Transfers/Credit-Card-Payments 360048393292; Investments 41855507661076; Gains & Losses 45946555058964; Rules 360048393372; Recurring 4890751141908; Reconcile/edit-balance 32368722344212; Budgets 32125337244052; Goals 44373110771860; Cash Flow/Sankey 21846787088916; What-if forecast 48344305092244; Schedule C 48344411171092)
- Copilot: help.copilot.money (transaction-types 3971267; Intelligence 8182433; recurring 9778259; budgets 6206293; goals 3790828; cash flow 9682232; reconcile 10682991; review 10310024)
- Quicken Classic: quicken.com/support (assigning-lots; capital-gains-estimator; reconciling-account); info.quicken.com (transfers; renaming-rules; tax-line-items; projected-balances; reports)
- Quicken Simplifi: support.simplifi (transfers 3352152; investments 4474538; recurring/amount-matching 9174873; spending-plan 4212702; projected-cash-flow; taxes 4592676)
- YNAB: support.ynab.com (transfer-transactions; tracking-investment-accounts; categorizing; approving-and-matching; scheduled-transactions; reconciling-accounts; balance-adjustments; targets; overspending; credit-cards; net-worth; assigning-future-income; tax-season); ynab.com/ynab-method
- Lunch Money: support.lunchmoney.app (transactions; categories/category-properties; rules; recurring; transaction-status; budget); lunchmoney.app/features (rules; net-worth; multicurrency; transactions)

**Business / entity / investments:**
- Mercury: mercury.com (accounting-automations; bill-pay; treasury; blog/using-multiple-business-checking-accounts-to-budget); support.mercury.com (account types 31277917784468; creating/managing accounts 28768280399124; auto-transfer-rules 30470734281620; QBO 28775977522068); nerdwallet.com/business/banking/reviews/mercury-banking
- Ramp: ramp.com (expense-management; products; reporting; spend-management; integrations; blog/receipt-scanning-expense-management); support.ramp.com (QBO overview 4435536594067; managing-accounting-rules)
- Brex: brex.com (product/spend-management; platform/spend-limits; platform/reporting; journal/live-budgets; journal/cash-flow-forecasting; spend-trends/expense-management/expense-approval-process; support/multi-entity-accounts; spend-trends/accounting/multi-entity-accounting; product/integrations/netsuite); netsuite.com/portal/resource/articles/accounting/brex-the-fintech-star-looks-back-on-its-switch-from-quickbooks-to-netsuite.shtml
- Empower: empower.com (tools/retirement-planner; tools/portfolio-analysis; investment-checkup; personal-investors/performance); support-personalwealth.empower.com (Retirement-Fee-Analyzer-Calculations 201169600); robberger.com/empower-review; choosefi.com/review/empower-review-the-ultimate-net-worth-tracker

*Caveat: several official help domains (Monarch, some Lunch Money pages) return HTTP 403 to automated fetches; a subset of claims draws on page text surfaced in search plus third-party reviews (NerdWallet, Motley Fool, The College Investor, Bogleheads). Plus/Premier-gated features flagged inline in research.*
