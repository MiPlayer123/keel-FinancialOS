# Budgets

Ground truth for "KEEL today": `design/current/2026-07-16/budgets-desktop.png` + census `docs/harness/census/2026-07-16/keel-money-02.md`. KEEL's Budgets page is a flat, alphabetical list of 16 categories; each row = category name (bold, left) + "$X.XX spent" (right) + a generic "Set budget" button. A month switcher (‹ July 2026 ›) and a "Copy last month" button sit at top; footer microcopy: "Categories without a budget still show what you spent — set an amount to start tracking them." There is **no budgeted amount shown on any row, no progress bar, no remaining figure, no totals/summary row, no over/under state, no color language, no grouping**. The screenshot is effectively a spend-per-category list mislabeled "Budgets" — it is missing nearly everything the four competitor budget models share. Most findings map to planned item **W2.2 (Budgets v1)** in `PLAN-FEATURE-PARITY.md`, whose spec (progress, remaining, totals, overspent-color) is not yet reflected in the shipped surface.

## Convergent patterns
(what ≥3 competitors ALL do that KEEL does not)

1. **Per-category budget-vs-actual-vs-remaining, shown together with a progress bar.** YNAB = Assigned / Activity / Available (`ynab-web-01`, `ynab-community-01/02`); Monarch = Budget / Actual / Remaining with an inline bar under each editable budget cell (`monarch-web-01`, `monarch-community-01`); Copilot = Spent / [bar] / Budget + "$X left" (`copilot-community-01` images 07/08, `copilot-iphone-01` image 03); Simplifi = spent + projected + a Target threshold line (`quicken-simplifi-community-01` image 04). **KEEL shows spent only** — not even the target amount appears on the row (`budgets-desktop.png`; census keel-money-02 line 22: "none show a budgeted target amount, a progress bar, or over/under-budget status").

2. **A prominent top-level summary/hero number.** "Left to budget $1,000" (Monarch, `monarch-web-01`, `monarch-iphone-01` image 03); "Ready to Assign $X" (YNAB, `ynab-web-01`); "Left this month $3,710.08 / $185.50 left per day" (Simplifi, `quicken-simplifi-community-01` image 01); "$477 left out of $4,120 budgeted" / "$629 under total budget" (Copilot, `copilot-iphone-01` images 02/03). **KEEL has no summary or total anywhere on the page** (keel-money-02 line 26: "No summary/total row … despite 16 rows of spend data").

3. **Explicit over/under budget state with color + status adjacent to the number.** Monarch remaining pills: green (under) / grey ($0) / red text (over) / amber (approaching), plus a ↻ rollover glyph (`monarch-community-01` images 04–06); Copilot bars green→amber→red and "$73 over" in red (`copilot-mac-01` mac-07, `copilot-community-01` image 08); YNAB "Funded" green vs. "$40 more needed by the 21st" amber (`ynab-web-01`). **KEEL renders no state and no color on any budget row.**

4. **Category grouping / sectioning of the budget list.** YNAB category groups (`ynab-community-02`); Monarch Income / Fixed / Flexible (`monarch-community-01` images 04–06); Simplifi's five fixed buckets Income/Bills/Planned Spend/Other Spend/Goals (`quicken-simplifi-community-01` image 01); Copilot parent→child with rollup badges (`copilot-community-01` image 07). **KEEL is one flat alphabetical list of 16 rows, no groups.**

(KEEL already matches on one convergent affordance — **copy-from-last-month** — which YNAB/Monarch/Simplifi all offer; keep it.)

## Findings

### BUDGETS-1 — Budget rows show only "spent"; no target, no remaining, no progress bar [P1]
- **Evidence:** `budgets-desktop.png`; census keel-money-02 lines 22, 65. vs. `ynab-web-01`, `monarch-web-01`, `copilot-community-01` (07/08), `quicken-simplifi-community-01` (04).
- **Competitors:** Every one renders three figures per category (budgeted, spent/actual, remaining) plus a proportional progress bar in the row — Monarch even makes the budget cell an inline editable box with the bar beneath it; Copilot's bar changes color by health; YNAB shows "Funded. Spent $225.00 of $400.00" as row microcopy.
- **KEEL today:** Row = name + "$679.40 spent" + "Set budget". The budgeted amount is not shown even where one could be set (the button is a generic label, not the amount). No bar, no "remaining/left". A "budget" screen that never shows budget-or-remaining is a spend list, not a budget.
- **Fix:** Ship the W2.2 row: `[emoji] Category | $spent of $budgeted | [progress bar] | $remaining`. Remaining right-aligned, `tabular-nums`. Where no budget is set, keep the current "spent-only" row but replace the button with an inline amount field (see BUDGETS-10).
- **Maps to:** W2.2 (Budgets v1 — "category rows with progress … totals").

### BUDGETS-2 — No summary / hero number and no totals row [P1]
- **Evidence:** `budgets-desktop.png`; census keel-money-02 line 26. vs. `monarch-web-01` ("$1,000 Left to budget" hero panel), `quicken-simplifi-community-01` (01) ("Left this month $3,710.08"), `copilot-iphone-01` (02/03), `ynab-web-01` ("Ready to Assign").
- **Competitors:** All four lead the budget surface with one dominant figure (left-to-budget / ready-to-assign / left-this-month) set apart in its own tinted panel, plus per-group subtotals. It is the "one glance = one number" anchor.
- **KEEL today:** 16 rows of spend data with no total spent, no total budgeted, no "left this month" — the user cannot answer "am I over or under this month?" without summing by eye.
- **Fix:** Add a hero strip above the list: total budgeted, total spent, and "Left this month" (budgeted − spent, expense scope, confirmed-transfers excluded, per the W2.2 pinned formula). Follows KEEL's own DESIGN-NOTES "one glance = one number" rule; red only if Left goes negative (Law 8). Add a bold totals row at the list foot.
- **Maps to:** W2.2 (totals) — hero framing is an extension worth calling out explicitly.

### BUDGETS-3 — No overspend/under state and no color language; status-adjacency law unmet [P1]
- **Evidence:** `budgets-desktop.png`. vs. `monarch-community-01` (04–06), `copilot-community-01` (08), `copilot-mac-01` (mac-07), `ynab-web-01`.
- **Competitors:** Monarch encodes four states in one small remaining pill (green under / grey exactly-zero / red over / amber approaching) + rollover glyph; Copilot bars go green→amber→red and surface "$73 over" / projected "$619 over"; YNAB flips between green "Funded" and amber "$X more needed by [date]".
- **KEEL today:** Zero state signal. Nothing tells the user a category is over, at, or near its limit. CLAUDE.md Law 8 requires "status adjacent to the number it qualifies" — the budget rows carry no status at all.
- **Fix:** Color the remaining figure only when negative (Law 8: red = negative money — an overspent envelope's remaining IS negative money, so red is legitimate here). For the "approaching limit" case KEEL **cannot** use red (reserved) — introduce a distinct calm signal (e.g., a filled-toward-full bar in emerald that thins/desaturates near 100%, or a small "$X left" that switches weight), decided deliberately since every competitor's amber is off-limits to KEEL. Put the status token immediately beside/under the remaining number.
- **Maps to:** W2.2 ("overspent number wears negative-money color only (Law 8)") — extend with the non-red near-limit treatment.

### BUDGETS-4 — "Transfers" appears as a budgeted category while the page says "transfers excluded" [P1]
- **Evidence:** `budgets-desktop.png` (a "Transfers — $36.23 spent" row) directly under the subtitle "A monthly amount per category — spending tracked against it, **transfers excluded**"; census keel-money-02 lines 19, 21, 86.
- **Competitors:** Copilot exempts inter-account transfers from the category system entirely — transfer rows show no category pill (`copilot-community-01` line 25/64). Monarch/YNAB likewise exclude confirmed transfers from budget spend.
- **KEEL today:** The list shows a "Transfers" category row with $36.23 "spent" sitting immediately below a subtitle promising transfers are excluded. A user reasonably reads this as a contradiction (is my $36.23 transfer counted or not?), damaging trust in every other number on the page. (The "Transfers" here is the Plaid PFC category, not KEEL's confirmed-transfer exclusion — but nothing on-screen disambiguates that.)
- **Fix:** Either suppress the "Transfers" PFC category from the budget list, or rename/clarify it (e.g., "P2P & Transfers") and add a one-line note distinguishing "confirmed inter-account transfers (excluded)" from "the Transfers spending category". Reconcile the subtitle with what's actually rendered.
- **Maps to:** W2.2 (spent formula excludes confirmed transfers) — the UI contradiction is NEW; must be resolved before budgets ship.

### BUDGETS-5 — Flat, ungrouped, alphabetical category list [P2]
- **Evidence:** `budgets-desktop.png`; census keel-money-02 line 21 ("flat list of 16 category rows (no grouping/sectioning) … alphabetical"). vs. `ynab-community-02`, `monarch-community-01` (04–06), `quicken-simplifi-community-01` (01), `copilot-community-01` (07).
- **Competitors:** All group categories — by cash-flow role (Monarch Income/Fixed/Flexible; Simplifi Bills/Planned/Other), by user groups (YNAB), or parent→child with rollup subtotals (Copilot). Groups give collapsible sections and a subtotal per section, which is how a 16+ category budget stays scannable.
- **KEEL today:** 16 peers alphabetized, "Uncategorized Expense" trailing — no sections, no subtotals, no parent/child. As categories grow this becomes an undifferentiated wall.
- **Fix:** Add category groups (fixed/flexible or Income/Expense at minimum) with collapsible headers and per-group budgeted/spent/remaining subtotals; land alongside subcategory support.
- **Maps to:** W2.3 (Category management + subcategories, parent roll-up) — surface the grouping in Budgets, not only in Settings.

### BUDGETS-6 — No drill from a budget category into its transactions [P2]
- **Evidence:** `budgets-desktop.png`; census keel-money-02 line 14 ("no visible drill-down affordance from Budgets into a category detail page"). vs. `copilot-community-01` (07: category → month transaction list), `ynab-community-02` (drilldown → Groceries transaction modal), `quicken-simplifi-community-01` (04: watchlist → transaction activity), Monarch category rows.
- **Competitors:** Tapping a budget/category row opens that category's underlying transactions (Copilot right-pane list; YNAB modal; Simplifi embedded Transaction Activity). The budget number is always one click from the evidence behind it — supports KEEL Law 9 "reproducible numbers / source rows".
- **KEEL today:** Budget rows are not stated to be clickable; Reports already ships "click a category → open it in the ledger" (keel-money-02 line 60), but Budgets does not reuse it. To verify "why is Food & Drink $679.40?" the user must leave Budgets, go to Ledger, and filter manually.
- **Fix:** Make each budget row's spent figure open the Ledger filtered to that category + month (reuse the Reports→Ledger link that already exists). This is the "proof on demand" half of TLDR-first.
- **Maps to:** NEW (reuse W1.2 Ledger filters + the Reports→Ledger deep-link).

### BUDGETS-7 — No rollover / envelope carryover (deliberate, but a named differentiator gap) [P2]
- **Evidence:** census keel-money-02 lines 19, 87 (monthly per-category, "Copy last month" implies no auto-carryforward). vs. `ynab-web-01` (Available > Assigned = carryover; Allie's Fun Money $150 avail on $75 assigned), `monarch-community-01` (↻ rollover glyph, "↻ $6,519" remaining > budget).
- **Competitors:** YNAB's whole model is envelope rollover; Monarch flags rollover categories with a ↻ icon and lets remaining exceed the period budget. Rollover is what makes sinking-fund categories (travel, gifts, annual insurance) work.
- **KEEL today:** Pure reset-each-month category mode ("A monthly amount per category"); W2.2 explicitly scopes "Envelope/flex modes = later tiers, out of scope."
- **Fix:** Plan the rollover data model now (carry unspent remaining forward per category, opt-in per category, ↻ affordance) so the month-reset formula in W2.2 doesn't have to be reworked later. Ship in a later tier but reserve the column/semantics.
- **Maps to:** W2.2 successor tier (envelope/flex) — flag as the primary depth differentiator vs. category-only budgeting.

### BUDGETS-8 — No pacing / "on track this far into the month" indicator [P2]
- **Evidence:** `budgets-desktop.png`. vs. `copilot-iphone-01` (02: dashed pace line + "$268 under"; mac-07: projected "$619 over"), `monarch-iphone-01` (03: vertical "today" tick on each budget bar), `quicken-simplifi-community-01` (04: "$369.84 projected" beside "$224.55 spent so far").
- **Competitors:** Because the current month is partial, competitors show whether you're ahead of or behind pace — a today-marker on the bar, a projected month-end figure, or "$X under/over" vs. an expected-by-now line. Answers "is $679 of $800 fine on the 16th?".
- **KEEL today:** No pace, no projection, no today-marker; a half-spent budget on day 16 looks identical to one on day 30. Reports already discloses "the current month is still in progress" (keel-money-02 line 61) — Budgets doesn't apply that awareness.
- **Fix:** Add a today-position tick on each budget bar and/or a projected-spend figure (linear or recurring-driven) as a Class-C preview (Law 10). Recurring engine already exists to drive a better-than-linear projection.
- **Maps to:** W2.5 (cash-flow forecast, Class C) — extend the projection into per-category budget pacing (NEW).

### BUDGETS-9 — No income budgeting / allocation model (income treated as out of scope) [P2]
- **Evidence:** `budgets-desktop.png` (expense categories only). vs. `quicken-simplifi-community-01` (01: Income is one of five budget buckets, +$8,256.94), `monarch-iphone-01` (03: Income / Expenses / Goals are three budgeted bands), `ynab-web-01` (Ready-to-Assign is the income-allocation engine).
- **Competitors:** Three of four budget income too — Simplifi and Monarch show Income as a top budget line; YNAB's entire flow is allocating income to categories ("every dollar assigned"). This is what makes "Left to budget" meaningful.
- **KEEL today:** Budgets is expense-categories-only; there's no income line and no allocate-income concept, so a summary like "left to budget" (BUDGETS-2) has no funding source to net against.
- **Fix:** Decide KEEL's stance: if targeting the Monarch/Simplifi "plan" model, add an Income budget line and compute Left = budgeted income − assigned expenses. If envelope (YNAB), add Ready-to-Assign. Either way income must enter the budget math.
- **Maps to:** NEW (envelope/plan tier decision; blocks a meaningful BUDGETS-2 hero).

### BUDGETS-10 — Set/edit is a generic button, not an inline amount field; extra click-depth [P2]
- **Evidence:** `budgets-desktop.png` (16× "Set budget" buttons; census keel-money-02 line 106 "What does clicking 'Set budget' actually produce … not evidenced"). vs. `monarch-community-01` (Budget cell is a bordered inline input, click-to-edit), `ynab-community-02` (Assigned cell edits in place with per-cell undo), `copilot` "Edit Budget" pencil.
- **Competitors:** Budget amounts are edited in the row itself — click the number, type, done — often with a per-cell undo/history affordance (YNAB clock icon). No modal, no navigation.
- **KEEL today:** A generic "Set budget" button per row with no visible amount and unknown target (modal? inline?). Best case it's an extra click and the set amount still isn't shown on the row afterward (BUDGETS-1).
- **Fix:** Replace the button with an inline editable amount cell showing the current budget (or a subtle "— set" placeholder when unset); commit on blur/Enter; keep the value visible on the row thereafter.
- **Maps to:** W2.2 (procs: set/upsert/clear) — bind the set proc to an inline cell, not a button.

### BUDGETS-11 — Only "Copy last month"; no smart auto-assign presets [P3]
- **Evidence:** `budgets-desktop.png` ("Copy last month" only). vs. `ynab-community-02` (Auto-Assign presets: Assigned Last Month, Spent Last Month, Average Assigned, Average Spent, Underfunded, Reduce Overfunding — each with the computed $ shown before you click).
- **Competitors:** YNAB computes several one-click funding suggestions from the account's own history and shows the resulting dollar figure on the preset before acting.
- **KEEL today:** Copy-last-month is present and good, but it's the only assist; no "budget = last-3-month average" or "match what you actually spent."
- **Fix:** Add a small "Set from…" menu next to Copy-last-month: last month's spend, 3-month average spend, last month's budget. Deterministic (Law 1), amounts previewed before apply.
- **Maps to:** NEW (extends W2.2 copy-from-previous-month).

### BUDGETS-12 — Zero/empty conventions inconsistent + noisy "spent" suffix [P3]
- **Evidence:** `budgets-desktop.png` (every unbudgeted/zero row reads "$0.00 spent"); census keel-money-02 lines 24, 60, 81 (Budgets uses "$0.00 spent" while Reports uses "—" for no-data). 
- **Competitors:** Copilot leaves a $0-spent category bar simply empty/grey (`copilot-community-01` line 57); nobody repeats a "spent" word on every row.
- **KEEL today:** "$X.XX spent" is suffixed on all 16 rows including nine "$0.00 spent" rows — visually noisy and inconsistent with Reports' em-dash convention for the same "no activity" concept.
- **Fix:** Move "spent" into the single column header (once) rather than every row; and unify the zero/no-data convention across Budgets and Reports (pick one of "$0.00" vs "—").
- **Maps to:** W2.2 (polish) — align with Reports typography.

### BUDGETS-13 — Mobile / 390px budgets surface unverified; competitors ship rich mobile budgets [P3]
- **Evidence:** `design/current/2026-07-16/` contains `budgets-desktop.png` only — **no `budgets-mobile-390.png`** (verified by directory listing); census keel-money-02 line 113 flags 390px usability cannot be assessed. vs. `copilot-iphone-01` (02/03: category rings + bar-vs-target review), `monarch-iphone-01` (03), `quicken-simplifi-iphone-01` (02), `ynab-iphone-01` (05: per-category progress bars + status captions).
- **Competitors:** Every competitor has a first-class mobile budget — Copilot uses compact progress rings for the multi-category glance and switches to bars-against-a-shared-target line for detailed review; YNAB shows progress bar + plain-English caption per row.
- **KEEL today:** No mobile budget evidence at all; CLAUDE.md Law 8 requires 390px usability. A desktop row of name + spent + button + (future) bar + remaining will not fit cleanly at 390px without a deliberate mobile layout.
- **Fix:** Design the 390px budget row explicitly (stack: name + emoji on line 1; bar + "$spent of $budgeted" + remaining on line 2), and capture a mobile screenshot into the evidence set. Consider Copilot's ring-glance for a mobile budgets summary.
- **Maps to:** W2.2 (must be built 390px-first per plan's Laws checklist).
