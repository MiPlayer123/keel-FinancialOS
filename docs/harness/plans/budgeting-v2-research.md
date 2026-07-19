# KEEL Budgeting v2 — Research + Direction

> Produced 2026-07-19 by a research agent (platform survey + codebase read); direction document, not an implementation spec. Build order/approval pending founder review. Status: awaiting adversarial review.

## 0. Current state (what "shows everything" means today)

- **Schema** (`supabase/migrations/20260713050000_budgets.sql`, `20260713110000_budget_rollover.sql`): `budgets` table = one row per (household, expense-category ledger account, month) with `amount_minor BIGINT`, `currency`, `rollover boolean`. No total-budget concept, no percent targets, per-month rows propagated by `keel_copy_budgets`.
- **Read model**: `keel_list_budgets` returns **every** live expense category (budgeted or not) with a pinned spent formula (`budget-v3-split-aware-rollover`: overlay-first category, live batch only, confirmed transfers excluded, refunds net) plus rollover carry = Σ prior rollover months' (budget − spent), which may be negative.
- **UI** (`apps/web/src/app/dashboard/budgets/page.tsx`): flat month view of all categories (money-movement buckets suppressed unless budgeted), inline dollar edit, per-row progress bar + "left/Over by", rollover pill, "Budgeted so far" summary card (sum of category budgets — not a target), copy-last-month, and a `RebalanceBudgetsDialog` that proposes budgets from 3-month actuals (deterministic, suggest→approve).

Founder asks map to real gaps: no opt-in filter, no percent targets, no editable overall target, month-row copy-forward instead of persistent targets.

## 1. Platform comparison

| App | Model | Which categories get budgets | % vs fixed | Total ↔ category interplay | Rollover | Income treatment | Signature UI | Praise / gripes |
|---|---|---|---|---|---|---|---|---|
| **Monarch** | Category targets **or** Flex (Fixed / Non-monthly / Flex buckets, one flex number) | Budget screen lists all categories; amounts optional; can budget at group level instead of per category | Fixed $; % methods (50/30/20) only via buckets, no per-category % | "Expected income − budgeted = Left to budget" header reconciles top-down vs bottom-up | Opt-in per category; carry can go negative; in Flex mode carry affects the category line but **not** the flex bucket total | Expected income set explicitly, compared to actual | Left-to-budget number, bucket bars, forecast row | Praised: two modes, flexibility. Gripes: flex rollover quirk, category sprawl |
| **YNAB** | Strict zero-based envelope — assign every real dollar | Every dollar must be assigned; categories are user-created envelopes | Fixed $ targets only (weekly/monthly/by-date); no % | "Ready to Assign" must hit 0 — total is *derived from cash*, not a chosen number | Inherent: available balances carry; overspend must be covered | Only money you *have*; future income doesn't exist yet | Ready-to-Assign banner, colored available pills | Praised: the method genuinely changes behavior. Hated: steep learning curve, price hikes, hostile to "just track it" users |
| **Copilot** | Category limits (envelope-ish tracking) | Opt-in-feeling: you set budgets on the categories you care about; Budgets 2.0 = one standing budget per category with per-month overrides | Fixed $ | Total = Σ category budgets; no independent total target | Opt-in per category, partial-amount rollovers allowed | Income tracked, not allocated | Very polished bars/rings; AI categorization learns corrections | Praised: design + auto-categorization. Gripes: Apple-only history, no real total steering |
| **Simplifi** | "Spending Plan": Income − Bills − Goals = **Available to spend** (one number) | Only *Planned Spending* items are explicit; everything else falls into the available pool | Fixed $ | Pure top-down: the plan derives the total; per-category detail is optional watchlist | Planned-spending items can roll over | Recurring income series drives the plan — income-first | "Available to spend" hero number updating in real time | Praised: near-zero effort, accommodates any method. Gripes: less granular control than envelope apps |
| **Actual Budget** | Local-first envelope zero-based (+ separate "tracking budget" mode) | All income assigned to categories (envelope mode); tracking mode is target-per-category, opt-in | Fixed $; templates/schedules via config | "To Budget" pool carries forward; category balances are the truth | Inherent — balances and overspend both roll | Budget only real income | Spreadsheet-dense grid, To-Budget header | Praised: control, privacy, free/OSS. Gripes: manual effort, sync/self-host friction |
| **Lunch Money** | Category targets, flexible periods (monthly/weekly/custom) | **Opt-in**: categories can be excluded from budget/totals; suggestions offered as you type | Fixed $ | Shows available income for the month so you can zero-base if you want; not enforced | Per category: roll leftover to same category **or to a general pool** | Income shown as budgetable amount, not enforced | Suggestion chips on the budget input, dense web table | Praised: web-first, API, flexibility. Gripes: weaker mobile |
| **Rocket Money** | Simple spending limits + alerts | Opt-in limits on chosen categories, seeded from history | Fixed $ | Overall "left to spend" summary; limits are independent | None meaningful | Income detected, informational | Progress bars, threshold alerts | Praised: effortless, subscriptions killer-feature. Gripes: shallow budgeting, miscategorization, upsells |

Sources: [Monarch Flex Budgeting](https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting) · [Monarch Rollover Budgets](https://help.monarch.com/hc/en-us/articles/4411119762196-Rollover-Budgets) · [Monarch flex vs category](https://www.monarch.com/blog/flex-vs-category-budgeting-how-to-choose-whats-right-for-you) · [YNAB zero-based](https://www.ynab.com/blog/what-is-a-zero-based-budget) · [YNAB review (Experian)](https://www.experian.com/blogs/ask-experian/you-need-a-budget-app-review/) · [Copilot monthly budgets](https://help.copilot.money/en/articles/6206293-editing-budgets-by-month) · [Copilot rollovers](https://help.copilot.money/en/articles/3790828-budget-rollovers) · [Copilot review (Money with Katie)](https://moneywithkatie.com/copilot-review-a-budgeting-app-that-finally-gets-it-right/) · [Simplifi Spending Plan](https://support.simplifi.quicken.com/en/articles/4212702-understanding-your-spending-plan) · [Simplifi any-budget](https://www.quicken.com/blog/simplifi-with-any-budget/) · [Actual envelope docs](https://actualbudget.org/docs/getting-started/envelope-budgeting/) · [Actual budgeting docs](https://actualbudget.org/docs/budgeting/) · [Lunch Money budgeting](https://lunchmoney.app/features/budgeting/) · [Lunch Money setup guide](https://support.lunchmoney.app/guides/budgeting/step-2-setting-up-your-budget) · [Rocket Money budgets](https://www.rocketmoney.com/feature/create-a-budget) · [Rocket Money review](https://thecollegeinvestor.com/22660/rocket-money-review/) · [NerdWallet best budget apps](https://www.nerdwallet.com/finance/learn/best-budget-apps) · [Monarch vs YNAB (Rob Berger)](https://robberger.com/ynab-vs-monarch-money/)

**Key market observation:** *none* of the seven offers first-class per-category percent targets — percent methods (50/30/20) are faked with buckets or manual math. That's both an opening for KEEL and a warning: percent belongs at the plan/total altitude, not sprinkled per category as the default.

## 2. Recommended model for KEEL

**"Planned total + opt-in category targets + residual bucket"** — a hybrid of Monarch's Left-to-budget reconciliation, Simplifi's top-down total, Lunch Money's opt-in, and Copilot's standing-budget-with-overrides. Not YNAB envelopes: envelope budgeting requires assigning actual cash, which fights KEEL's ledger (spent is *measured*, not pre-allocated) and its calm, low-ceremony ethos.

1. **Opt-in (ask a)**: only categories/subcategories with a target row appear. Everything else's spend rolls into one read-only **"Everything else"** line (Monarch-flex-like), so the total picture never lies by omission. Adding a budget = picker over live expense categories.
2. **Percent basis (ask b) — recommend percent *of total budget* at category level, percent *of expected income* only at the plan level.** Rationale: percent-of-income per category makes every category target drift as paychecks land mid-month — retroactively shifting bars violates the spirit of reproducible numbers (invariant 7) and "financial calm." With percent-of-total: the total is the one steering wheel; category %s are stable within a month; changing the total rescales percent categories automatically and deterministically. The income link the founder wants still exists — as `total = X% of expected income`, one hop up.
3. **Total ↔ breakdown reconciliation (ask c)**: an editable **plan total** plus a Monarch-style header: `Left to budget = total − Σ resolved category targets` (can be negative = over-allocated, flagged). Editing the total never silently rewrites dollar-amount categories (no hidden mutation — Law 2 spirit); percent categories rescale by definition; the existing rebalance dialog becomes the explicit "redistribute to fit the total" action (deterministic, suggest→approve).
4. **Standing targets, not per-month copies (ask d)**: effective-dated targets (Copilot Budgets 2.0 pattern) replace `keel_copy_budgets`. A target persists until changed; a month-specific override is just a new row starting that month. This also satisfies the soft-delete directive (end-date rows instead of DELETE).

## 3. Feature plan sketch

### Schema (new migration; backfill `budgets` rows as amount targets, keep old table until cutover)

```sql
create type budget_target_kind as enum ('amount', 'percent_of_total');
create type budget_total_basis as enum ('amount', 'percent_of_income');

create table budget_targets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  category_ledger_account_id uuid references ledger_accounts(id), -- NULL = the plan total row
  effective_month date not null check (effective_month = date_trunc('month', effective_month)::date),
  end_month date,                        -- soft removal / override boundary; NULL = open-ended
  target_kind budget_target_kind not null,       -- category rows
  total_basis budget_total_basis,                -- total row only
  amount_minor bigint check (amount_minor >= 0), -- Law 4: BIGINT minor units
  percent_bp integer check (percent_bp between 0 and 10000), -- basis points, no floats
  rollover boolean not null,
  currency char(3) not null,
  created_at timestamptz not null default now()
  -- exactly one value per kind (amount XOR percent), enforced by CHECK;
  -- one live row per (household, category, month) enforced by exclusion/partial unique index
);

create table budget_expected_income (      -- user-confirmed number; recurring-detector may *suggest* it (class B)
  household_id uuid not null,
  effective_month date not null,
  end_month date,
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null
);
```

### Domain commands (all audited, suggest→approve where AI-proposed)

- `budgets.set_total(month, basis: amount|percent_of_income, amount_minor?|percent_bp?)` — closes prior row (`end_month`), inserts new.
- `budgets.set_target(category, month, kind: amount|percent_of_total, value, rollover, scope: from_now|this_month_only)` — this-month-only = row with `end_month = month + 1`.
- `budgets.remove_target(category, month)` — sets `end_month` (soft; no DELETE).
- `budgets.set_expected_income(month, amount_minor)` — user confirmation of a detector suggestion or manual.
- `budgets.rebalance(month, proposals[])` — existing dialog upgraded: allocate to fit the total; approval token binds the exact payload (Law 11).

### Read model — `keel_budget_month(household, month)`, `formulaVersion: 'budget-v4-plan'`

Deterministic resolution, integer arithmetic only: (1) resolve total: `amount` as-is, or `expected_income × bp / 10000` (floor); (2) resolve each category: amount as-is, or `total × bp / 10000` (floor — remainder stays in Left-to-budget, documented in the formula version); (3) spent per category via the **unchanged** pinned v3 spent formula; (4) carry via existing rollover logic against *resolved* targets; (5) emit `{scope, asOf, formulaVersion, total: {basis, resolvedMinor}, expectedIncomeMinor, actualIncomeMinor, leftToBudgetMinor, rows: [{category, kind, declared, resolvedMinor, spentMinor, carryMinor, availableMinor}], everythingElseSpentMinor}`. Percent categories don't need to sum to 100% — the residual is the visible Left-to-budget.

### UI slices (order = independent shippability)

- **B1 (UI-only, ships now):** opt-in view on the existing backend — budgeted rows only + collapsed "Everything else" (spend of all unbudgeted categories) + add-category picker. Kills "shows everything" immediately.
- **B2:** schema + commands + `budget-v4-plan` read model; backfill; retire copy-forward (standing targets make it moot).
- **B3:** plan header — editable total (dollar or % of expected income), Left-to-budget line, over-allocation state; rebalance dialog rewired to the total.
- **B4:** per-category kind toggle ($ ⇄ % of total) with live resolved preview; month-only vs from-now-on override control.
- **B5 (richer):** expected-income suggestion from the recurring detector (class B, approve to accept), actual-vs-expected income strip, 3-month-average hint chip on the target input (Lunch Money pattern — the rebalance dialog already computes this).

Tests to freeze first: percent resolution rounding invariants (Σ resolved ≤ total when %s ≤ 100%), effective-dating (one live row per category-month), backfill equivalence (v4 with only amount targets reproduces v3 numbers exactly), rollover-against-resolved-target property tests.
