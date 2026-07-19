# Backend-vs-UI Surfacing Audit + Validation Sweep

Read-only audit, 2026-07-19. Grounded in end-to-end code reading + live-DB SELECTs (no browser
session — /dashboard requires auth). No code changed. Complements docs/PERSONA-FEEDBACK.md.

**Live ground truth (production, single household):** 1 household · 1 entity (`personal`) ·
1 membership · 0 entity_memberships · 10 accounts (10 owners, all 1 user) · 8 connections ·
1,354 canonical txns (1,351 categorized) · 29 confirmed transfers · 302 accepted category suggestions ·
42 recurring_series (1 confirmed / 22 suggested / 19 rejected) but only 1 recurring_occurrence.
**Zero rows** in: holdings, paychecks, reimbursements, statements, reconciliation, budgets, tags, goals,
scheduled_transactions, documents/receipts.

## Deliverable 1 — Surfacing plan (highest-ROI first)

### Tier 1 — thin UI over already-wired backend
1. **Entity switcher / "LLC lens"** — `entities.list` + `entity_id` on accounts + reports scope-bar all exist; no nav-level lens. (Medium; **in progress**.)
2. **Household switcher in nav** — `household-context.tsx` fully fetches households + `setHouseholdId`; nothing renders a picker. (Quick; very low risk.)
3. **P&L + Balance Sheet reports** — `keel_trial_balance` read model exists and is already consumed by the sidebar; `ledger_accounts.kind` gives asset/liability/income/expense/equity. No statement-by-name yet. (Medium.)
4. **Extend report drill-down** — `ledgerDrillHref` helper exists; donut slices + month cells already clickable. Extend to tax rows, payees, tags, matrix rows. (Quick.)
5. **Per-entity / tax-year export** — export is household-wide only; add an entity + tax-year filter for accountant hand-off. (Medium.)
6. **Surface data-ownership export** — CSV/JSON/QIF/beancount export buried in settings. (Quick.)

### Tier 2 — mostly thin, small backend delta
7. **Investments cost basis + unrealized gain/loss** — `holdings.cost_basis_minor` is captured/stored but never displayed; gain/loss is client math over an existing column. (Medium.)
8. **Per-transaction cleared/reconciled toggle** — currently set only by closing a reconciliation session; needs a write command. (Medium.)
9. **Member invites + roles UI** — membership tables + role enum exist; no invite-by-email/management flow. (Big; needs new invite backend.)
10. **Owner-draw / capital / distribution categories** — categories are income/expense only. (Medium.)

### Tier 3 — needs new backend / larger
11. Investment lots / dividends / realized / XIRR. 12. OFX/QFX import (confirmed absent). 13. Deeper category nesting. 14. Receipt line-item split + business-deductible flag. 15. Invoicing/AR/AP/mileage (scope decision). 16. Onboarding wizard + actionable empty states.

## Deliverable 2 — Validation report

**BROKEN / would-crash: none found.** The codebase is uniformly defensive (null-coalescing, empty-array-safe reduces, gated rendering). Every one of the 15 nav routes maps to a real page — no dead links.

**Confirmed working (traced + live data):** connect/sync (8 connections, pipeline flowing), categorization (302 accepted, 1351/1354 categorized), transfers/counterparty-booking (29 confirmed), dashboard (all cards null-safe), accounts/detail, reports (matrix excludes transfers, drill-down live on donut+months), perf/search (server keyset pagination + search), and all zero-data empty states (paychecks/reimbursements/receipts/statements/budgets/goals/investments) render clean, not crashes.

**Suspect — logic looks right but unexercised by live data (needs a seeded/authenticated pass):**
- **Recurring occurrence generation looks near-dormant** — 42 series, 248 candidate_versions, but only 1 occurrence row. Detection runs; "upcoming recurring" projection value is unproven live. (See also docs/RECURRING-RESEARCH.md.)
- **Investments depth** — current value only; cost basis stored but not shown; 0 holdings live.
- **Paychecks / reimbursements / statements / reconciliation / budgets / goals / receipts** — all 0 live rows; the populated create→list→edit→close paths are untested against production.
- **Multi-user / multi-entity** — 1 user, 1 entity, 0 entity_memberships; entity-filter, per-owner attribution, and roles are untested against real multi-party data.

## Bottom line
Model is well ahead of UI. Highest-ROI next work = thin UI over already-wired read models:
household switcher, entity lens, P&L/balance sheet, drill-down extension. Nothing shipped crashes;
the real risk is large **unvalidated** surfaces (paychecks, statements, reconciliation, receipts, multi-user)
sitting at zero live rows — those need a seeded manual pass (requires an authenticated session / test account) before they can be called proven.
