# KEEL Plan Addendum v1.1 — Gap Closure, State Machines, Mobile-First
*Amends docs 09–10. Every item traces to the Gap Audit (doc 12).*

## §A New/updated tier items
**T0 additions**
- T0.4b **Member attribution**: every transaction carries `spent_by` (member) where derivable (card→member mapping table) or assignable; avatar chips in list; joint/individual filters.

**T1 additions**
- T1.1 (amended) Budget modes now **three**: category · flex · **envelope/zero-based** (assign-every-dollar with to-be-budgeted pool); **age-of-money** metric in insights.
- T1.3b **Calendar view**: month grid of projected inflows/outflows/bills (PocketSmith/Monarch calendar), tap-through to day.
- T1.8 (amended) **Alert catalog (enumerated)**: overdraft-forecast (from projection), unusual-charge, budget-hot, price-hike, payday, bill-due, connection-broken, goal-at-risk, reconciliation-drift, low-buffer. Each = deterministic detector + per-channel setting.
- T1.11 **Bill split with people**: mark a share of a transaction as owed by an external party; owed ledger; settle-up records (no payment rails v1).
- T1.12 **Split templates & recurring splits** (e.g., rent auto-splits 60/40 monthly).
- Mobile quick-add: FAB, cash entry, **voice entry** (on-device dictation → parse).

**T2 additions (the wedge, completed)**
- T2.2 (amended) Receipt channels: photo, share-sheet, email-inbox, **SMS-in (Twilio)**.
- T2.5b **A/P-lite**: vendor bill records, due calendar, aging report per entity.
- T2.6b **Privacy scopes**: per-member category/account hiding ("gift mode"), professional read-only scope refinement.
- T2.9 **Rental module**: properties (asset accounts w/ entity), tenants, leases (term, rent, deposit), rent-due recurring, per-property P&L, **Schedule E pack**.
- T2.10 **Portfolio Engine** (the Quicken-parity centerpiece):
  - Investment transaction ledger: buy/sell/dividend/interest/split/spinoff/transfer-in-kind (postings-backed).
  - **Lot engine**: FIFO / specific-ID cost basis; wash-sale flagging (informational); realized/unrealized gains.
  - **Capital Gains Estimator**: "if I sell X shares, ST/LT gain = ?" what-if.
  - **Tax-lot sale planner**: rank lots to sell for target cash vs minimal tax.
  - Allocation X-Ray: by asset class/sector/geography vs **target allocation**, drift alerts; **fee analyzer** (expense ratios vs holdings).
  - TWR/IRR (already specced) now computed on this ledger.
- T2.11 **Accountant handoff**: one-click export packs — QuickBooks-compatible CSV/IIF, Xero CSV, trial balance, GL detail per entity; direct QBO/Xero API sync = later flag.
- Tax packs now cover **Schedules A/B/C/E/F**.

**T3 additions (planning brain, all deterministic)**
- T3.7 **Scenario Studio**: clone current plan → adjust variables (income, rent, move, purchase, rate) → side-by-side projected cash flow/net worth. 
- T3.8 **Tax Position engine**: rolling estimate of year tax liability (W-2 withholding from paycheck engine + Sched C/E entity income + est. payments), **quarterly estimated-tax calendar with safe-harbor math**. Framed "estimate, not advice"; show-the-math.
- T3.9 **Retirement planner**: 15+ variable deterministic projection (contributions, returns, inflation, retirement age, spend) + optional Monte Carlo band. 
- T3.10 **Income Smoothing** (variable-income methodology, the whitespace): buffer pool concept, **months-ahead metric**, per-project/client income buckets, smoothed "salary" draw suggestion.
- T3.3b Assistant proposes **budget rebalances** (approve-gated) + T3.6 amended: interactive **Monthly Review** + **Year in Review** stories.

**T4 additions**
- T4.7 (amended) Vault + **emergency-access designee** (Kubera pattern) + estate-partner integration.
- T4.8 Personal **policy-as-code cards** exploration (Lithic/Stripe Issuing) — post-traction gate unchanged.
- T4.9 **Credit score** (VantageScore via Array/StitchCredit) w/ trend + change alerts.
- T4.10 **Crypto wallet-address tracking** (public chain reads).
- T4.5 (amended) Browser **extension** as ingestion channel (Amazon/Walmart/Target itemization).
- Pro option: **real-time quotes** toggle (cost-metered).

## §B Schema deltas (additive; conventions per spec-notes: enums everywhere, normalized, real FKs, no implicit defaults — seed data must supply every configurable field)
- `household_members(card_account_id → member_id)` mapping table `card_owners`; `transactions.spent_by uuid NULL FK users`.
- `budgets.mode` enum += `'envelope'`; new `budget_pools(to_be_budgeted)` per month.
- `external_parties(id, name, contact)` + `iou_entries(id, transaction_id, party_id, share_minor, status ENUM('owed','settled','written_off'))`.
- `split_templates(id, criteria jsonb, lines jsonb)`.
- `vendors(id, entity_id, name, tax_1099 boolean)` ; `bills(id, entity_id, vendor_id, due date, amount_minor, status ENUM('scheduled','due','paid','overdue'), transaction_id NULL)`.
- Rental: `properties(id, entity_id, account_id, address)` ; `tenants(id, property_id, name, contact)` ; `leases(id, property_id, tenant_id, start, end, rent_minor, deposit_minor, status ENUM('draft','active','ended'))`.
- Portfolio: `investment_txns(id, account_id, type ENUM('buy','sell','dividend','interest','split','spinoff','transfer'), symbol, qty, price_minor, fees_minor, trade_date, settle_date, lot_links jsonb)` ; `lots` gains `method ENUM('fifo','specific')`, `closed_qty`, `realized jsonb` ; `allocation_targets(household_id, class, pct)`.
- Tax: `tax_profiles(household_id, filing_status ENUM, state, year)` ; `est_tax_payments(id, entity_id NULL, due date, amount_minor, paid boolean)`.
- `scenarios(id, household_id, name, overrides jsonb, created_from timestamptz)`.
- `income_buckets(id, household_id, name, client_ref)`; `buffer_config(target_months numeric)`.
- `credit_scores(household_id, as_of, score int, provider)` (T4.9).
- `wallet_addresses(id, household_id, chain ENUM, address, label)` (T4.10).

## §C State machines (per spec-notes format: states → transitions(trigger)[guards])
- **Transaction**: `pending →(provider posts) posted →(user/agent-approved edit reviewed) reviewed`; any →(reconciliation lock)[period locked] **immutable** (edits require unlock event, logged). Split-child lifecycle bound to parent (delete parent → children void).
- **Connection/Item**: `linking → active →(webhook error) reauth_required →(user relinks) active`; `active →(user) disconnected` [export prompt]. Guard: no sync writes while `reauth_required`.
- **TransferLink**: `suggested →(user confirm) confirmed | →(user reject) rejected`; confirmed excludes pair from cash-flow aggregates (cross-entity ⇒ auto due-to/from postings).
- **Document(receipt/paystub)**: `uploaded → extracted →(match found ≥ threshold) match_suggested →(approve) matched | →(reject) unmatched(exception queue)`. matched ⇒ may spawn splits (itemization) [Σ items = txn amount].
- **Bill (A/P)**: `scheduled → due →(txn matched) paid`; `due →(date passed) overdue`. 
- **Lease**: `draft → active →(end date / early-termination event) ended`; active generates rent recurring_series; ended stops it.
- **Goal**: `active ↔ paused → completed | archived`; paydown completes when linked liability = 0 [postings-verified].
- **Reconciliation**: `open →(Σ postings = statement) balanced →(user lock) locked`; locked blocks mutations in period (see Transaction guard).
- **AgentAction**: `proposed →(user) approved → executed | rejected`; `auto_executed` only when autonomy policy grants that action class [always audit-logged].
- **Lot**: `open →(sell allocations) partially_closed → closed`; guard: Σ allocations ≤ lot qty; realized gain computed at close from postings.
- **Cross-entity lifecycle example**: confirming a cross-entity TransferLink ⇒ creates due_to/due_from postings in both entities ⇒ entity balance sheets update ⇒ consolidated view eliminates the pair.

## §D Platform design principles — desktop-first, mobile-capable (governing doc 11 and all UI work)
1. **Desktop web is the primary surface** (power features, keyboard-first, dense ledger views); the same PWA must work well on the phone — responsive down to 390px, installable, offline read cache. Mobile is a companion for the daily loop, not a port.
2. Desktop: Entity Spine rail, ⌘K command palette, bulk operations, multi-pane reports. Mobile adaptation: **bottom tab bar** (Home · Ledger · Review · Plan · More) with Review as a first-class tab — the Copilot swipe loop is the mobile habit.
3. Mobile thumb-reach law: primary actions in bottom 60%; FAB = quick-add (cash/voice/receipt camera). Desktop equivalent: ⌘K and inline edit everywhere.
4. Entity Spine on mobile = compact horizontal chip strip under the header (signature preserved), full rail on ≥1020px.
5. Safe-to-Spend stays the hero at every size; one glance = one number.
6. Cards stack single-column; tables become row-cards with amount right-aligned mono, red-ink negatives unchanged.
7. 60fps lists (virtualized), optimistic writes, skeletons not spinners; reduced-motion respected; touch targets ≥44px.
8. Notifications deep-link to the exact approve/review surface.

## §E Milestone deltas
- M3 gains: attribution, split templates, IOU/bill-split.
- M5 gains: envelope mode, calendar view, alert catalog, age-of-money.
- **M6 splits into M6a (entities/receipts/Sched C/paycheck/invoicing+A/P) and M6b (Rental + Portfolio Engine + accountant export + tax packs A–F)** — +3 agent-days.
- **New M7.5 Planning Brain** (Scenario Studio, Tax Position, Retirement, Income Smoothing) — +3 agent-days; tests = worked examples incl. safe-harbor quarterly calc and lot-sale plan fixture, all CI-executable.
- M8 governed by §D; acceptance adds Lighthouse mobile ≥ 90 and swipe-loop usability pass.
- Revised total: ~27 agent-days + human lanes unchanged. Free/Plus/Pro packaging unchanged; Portfolio Engine + Planning Brain land in Plus, entities/rental/accountant-handoff in Pro.

## §F Spec conventions adopted (from your notes — now law for the repo spec)
Plural first-class entities (accounts, entities, properties, tenants, goals, scenarios — anything a pro creates many of); aggressive normalization, no A→C shortcuts; enums over strings everywhere feasible; every field must drive behavior; no implicit defaults — seeds supply everything; no backward-compat baggage; field names aligned to the vertical's conventions (Plaid/OFX names where concepts match: `posted_at`, `iso_currency_code`, `mask`). If any module later extends OSS (e.g., importer parsers), spec marks each entity/endpoint **Existing / Modify / New** with full field inventory before build.
