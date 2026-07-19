# Persona-based product feedback (for later discussion)

Generated 2026-07-18 by a read-only product-critique agent, grounded in the live codebase
(migrations through 20260718…, the dashboard pages, and the domain model). This is a
discussion input, not a committed backlog — nothing here is scheduled. Referenced from
[FEEDBACK.md](../FEEDBACK.md).

> Accuracy note from the agent: an internal `design/FEATURE-GAP-REPORT.md` is stale — it
> claims transfer-confirmation and recategorization are missing, but both are implemented.
> The feedback below reflects live code, not that doc.

---

## 1. The multi-entity small-business owner (personal + LLC + investing)

The entity backend is strong (`entity_kind` enum covers sole_prop/llc_single/llc_multi/s_corp/trust; accounts scoped `entity_id NOT NULL`; create/reassign flows exist). The gaps are at the surface.

1. **No entity switcher / "LLC books only" lens.** *(big)* Entities exist in the model and in `entity-picker.tsx` (only inside add-account/link dialogs); nav, dashboard, and ledger commingle every entity's accounts. Reports have an entity filter but the default everywhere is "all entities blended." No persistent "I'm working in the LLC now" mode. Highest-leverage business fix.
2. **No P&L or balance sheet.** *(big)* Reports have category×month matrix, Sankey, donut, payees, month-in-review, tax rollup, net-worth trend — but no formatted Profit & Loss or Balance Sheet by name, per entity. The `ledger.trial_balance` data to build them exists.
3. **No owner-draw / capital-account / distribution semantics.** *(medium)* Categories are income/expense only; an LLC owner can't record a member draw or capital contribution except as a transfer or miscategorized expense.
4. **Tax plumbing stops short of a deliverable.** *(medium)* `tax_lines.sql` maps categories to 17 IRS lines incl. Schedule C, and reports roll them up — but no Schedule-C view, no per-entity tax export, no 1099-vendor tracking. Export is household-wide (can't hand the accountant "just the LLC"). A per-entity tax-year export is a quick high-value add.
5. **Receipts extract totals, not line items.** *(medium)* Good AI merchant/amount/date extraction + suggest→confirm matching, but one total per receipt — a mixed Costco run can't be split business/personal, no "business-deductible" flag, no "which transactions have receipts" browse.
6. **No invoicing / AR / AP / mileage.** *(big; maybe out of scope)* Worth an explicit in/out-of-scope decision rather than a silent gap; mileage + a lightweight bill/invoice tracker matter for a sole-prop system of record.

## 2. The Quicken migrant with 10+ years of history

Better positioned than expected — import is real and thoughtful.

1. **Import is capable but QIF/CSV only.** *(medium)* `import-csv-dialog.tsx` handles QIF+CSV with split parsing, memo→note, category matching, day-first dates, content-hash dedupe. Gap: **no OFX/QFX**, what most banks and Quicken export natively.
2. **One-level category tree vs. Quicken's arbitrary nesting.** *(medium)* Exactly parent→child, no grandchildren. `Auto:Repairs:Transmission` must flatten. Either deeper nesting or an explicit import-mapping step.
3. **Reconciliation is strong — surface it better.** *(quick)* More rigorous than Quicken (statement lines, resolution types, adjustments, period locks), but no per-transaction cleared (C/R) flag and no fuzzy auto-match of statement lines. Auto-match by amount+date closes most of the gap.
4. **Reports lack drill-down, YoY, saved reports.** *(medium)* Every chart is a dead-end — clicking a slice/cell doesn't open the register. No year-over-year, no saved custom reports. Register drill-down from any figure is the "feel at home" feature.
5. **Investments are the real blocker.** *(big)* Holdings store a current snapshot only — no gain/loss, cost-basis column, lots, dividends, realized-vs-unrealized, XIRR. A migrant with taxable brokerage lots can't reproduce their picture.
6. **Data-ownership is a strength — lead with it.** *(quick)* Full CSV/JSON/QIF/Beancount export + append-only audit is exactly the "not locked in" pitch, and it's barely surfaced.

## 3. The couple / household sharing finances

Widest gap between schema and product — the tables exist, the product does not.

1. **Multi-user sharing modeled but zero surface.** *(big)* `household_memberships`, `entity_memberships`, `account_owners` exist (seed builds a 2-person household), but **no invite-by-email, no member-management UI, no way to grant access** in-app. Make-or-break for the "household views" positioning.
2. **No household switcher in the UI.** *(medium)* `household-context.tsx` fetches households + exposes `setHouseholdId`, but nothing renders a picker. Context is wired; needs a switcher in app-shell.
3. **Per-person attribution invisible.** *(medium)* `account_owners` never read in UI; no shared-vs-personal flag, no per-person split, no "you owe / they owe" beyond the expense-report-framed reimbursements feature.
4. **No visible roles/permissions.** *(medium)* Roles (owner/partner/professional/viewer) exist in the enum but aren't editable/enforced in any visible flow.

Cheapest credible v1: invite-by-email + household switcher. Per-person attribution is the deeper follow-on.

## 4. The less-technical friend on the free tier

1. **No onboarding — signup drops you at a blank dashboard.** *(big)* Landing → login → `/dashboard`; a new user hits the "No household yet" empty state with no button that starts setup. No wizard, no "connect your first account" CTA, no sample data.
2. **Manual-account escape hatch hidden.** *(quick)* `createManualAccount` works but Connections leads with Plaid; no visible "add manually instead" for a novice wary of bank login.
3. **Language written for accountants.** *(medium)* Landing sells "double-entry / append-only / reversals / reconciliation"; no tooltips, glossary, or "why link my bank?" reassurance.
4. **Empty states describe, don't act.** *(quick)* Recurring/Budgets/Transactions/Home empty states are sentences with no action control — each a dead end for a novice.
5. **"Free tier" doesn't exist in code.** *(medium)* No billing/plan/metering/paywall anywhere. Decide what "free" actually is before optimizing this funnel.
6. **Assistant could be the novice's front door but is preview-only.** *(medium)* Read-only class-C narrator (correct per Law 10) buried under a "Preview" badge; a plain-language "where did my money go" chat is arguably the most approachable entry point — consider promoting it (writes still gated).

## Top 5 cross-cutting themes

1. **The model is years ahead of the UI.** Entities, memberships, ownership, tax lines, reconciliation, holdings all exist in migrations but lack the surface (switchers, invites, statements, drill-downs). Highest ROI now = *expose what's built*, not new domains.
2. **Two missing "lenses" block three personas at once.** An **entity switcher** (business owner) and a **household switcher + invites** (couple) are small UI layers over finished backends, both currently absent.
3. **Financial statements + drill-down are the credibility gap.** No P&L, no balance sheet, no clickable path from a report figure to its transactions. Aggregation data already exists.
4. **Investments are shallow vs. positioning.** Snapshot holdings, no cost basis/gain-loss/lots/dividends — stalls a serious Quicken migrant and undercuts the "investing" leg of the core persona.
5. **Onboarding, empty states, plain-language help are effectively unbuilt.** Guided first-run, actionable empty states, and promoting the read-only Assistant would broaden reach without compromising any invariant.
