# Reports & cash flow

Scope note: KEEL's Reports page is already unusually deep for a v-early product — Month-in-review, spending donut with relative-range chips + explicit from/to inputs, a signature Sankey, income-vs-spending bars, a 6-month category matrix, and a this-month-vs-last delta list, every widget carrying an as-of/scope/exclusion footnote (`reports-desktop.png`, census `keel-money-02`). That footnote discipline (Law 9 reproducible-numbers) is a genuine strength competitors don't match and should be preserved. The findings below are where the depth stops, where the numbers are wrong, and where the interactions competitors treat as table stakes are missing.

## Convergent patterns
(≥3 competitors do these in this dimension; KEEL does not)

1. **One page-level scope that filters every widget at once — date range + account + category.** Monarch Reports (`monarch-community-01/02`: "This month" date button, "All Accounts", "21 Selected Categories"), YNAB Reports (`ynab-community-01`: date-range + "21 Selected Categories" + "All Accounts" on Spending/Net Worth/Income-v-Expense identically), and Simplifi Reports (`quicken-simplifi-community-01`: date-range dropdown + Filters + Category dropdown) all scope the whole report surface from one control row. KEEL has per-widget, unsynchronized date controls and **no account or category filter anywhere on Reports** (`reports-desktop.png`).

2. **Drill-through from any chart/segment/bar to the underlying transactions.** Monarch Sankey nodes and Income donut → transaction list (`monarch-community-01/02`); Copilot Spend chart hover → per-category breakdown and category-drilldown → that month's transactions (`copilot-community-01/02`); Simplifi report tables embed the transaction register and watchlist drills to transactions (`quicken-simplifi-community-01`); YNAB report rows carry expand carets to drill (`ynab-community-01`). KEEL exposes exactly one drill path — "Click a category to open it in the ledger" on the 6-month table — and nothing clickable on the donut, Sankey, bars, or month-in-review categories (census `keel-money-02` §Business rules; `reports-desktop.png`).

3. **Export the report you're looking at.** Monarch ("Download CSV" in Summary, "Export" on reports, share-Sankey `monarch-community-01/02`), YNAB ("Export" link on every report tab `ynab-community-01`), Simplifi (download icon + column settings per report `quicken-simplifi-community-01`), Copilot (download icon on charts `copilot-mac-01`). KEEL's only export is `admin.export_all` (bulk household dump, FEATURE-GAP #19) — there is no per-report/per-scope export button.

4. **A dedicated Net Worth report** with change-over-period, a month-by-month history table, and asset/liability allocation. Monarch (`monarch-community-01/02`: net-worth hero + Assets/Liabilities stacked breakdown + Reports→Net Worth), YNAB (`ynab-community-01`: Net Worth combo bar+line + "Change in Net Worth $19,042.25 / 251.1%" + month table with trend arrows), Simplifi (Reports→Net Worth tab), Rocket Money (Net Worth nav item `rocket-money-community-01`). KEEL's Reports page has **no net-worth report at all** — only a 90-day line on Home (`dashboard-desktop.png`), despite "net-worth report" being core to this dimension.

5. **User-selectable comparison basis + a Totals/Change (or Totals/Trends) toggle.** Copilot cash flow: "compared to [Previous period ▾]" dropdown and inline "vs $2,114.83 in previous period" (`copilot-community-02`, `copilot-mac-01`). Monarch: "Totals / Change" toggle on reports (`monarch-community-02`). YNAB: Income-v-Expense with per-month + Average + Total columns, Spending "Totals/Trends" toggle (`ynab-community-01`). KEEL hard-codes a single comparison ("vs May 26", "this month vs last month") with no way to choose previous-period vs. same-period-last-year, and no totals/change view switch.

6. **Saved / tabbed report views.** Simplifi (saved report tabs incl. "2026 YTD Income" with bookmark, "Save"/"Reset report" `quicken-simplifi-community-01`), Monarch ("Saved" button `monarch-community-02`), YNAB (5 report tabs `ynab-community-01`). KEEL is a single fixed vertical scroll of six widgets — no report picker, no saved scopes.

7. **Credit-card payments and account transfers are excluded from spending totals.** Monarch, Copilot, YNAB, Simplifi all strip inter-account/CC-payment rows from category spend (transfer rows carry no category pill in Copilot `copilot-community-01`; Monarch/Simplifi exclude confirmed transfers). KEEL's footnotes claim "confirmed transfers excluded" but CC bill payments are categorized "Loan Payments" and counted as spend — see REPORTSCASHFLOW-1.

## Findings

### REPORTSCASHFLOW-1 — Credit-card payments & debt transfers are counted as spending, corrupting every report [P0]
- **Evidence:** `reports-desktop.png` (Month in review, Spending-by-category, Sankey, 6-month table); `dashboard-desktop.png`; census `keel-core-01` §Business rules, `keel-money-02`, `keel-mobile-04`.
- **Competitors:** Monarch/Copilot/YNAB/Simplifi all treat a credit-card payment or savings sweep as a transfer with zero category-spend impact (Copilot transfer rows have no category pill, `copilot-community-01`; Monarch/Simplifi "confirmed transfers excluded").
- **KEEL today:** "Loan Payments" is the #1 spending category everywhere — $5,104.22 in June (Month in review), $895.33 in July (donut, 51.5%), $15,156.15 six-month total (6-month table). "Biggest single purchase" is literally a credit-card bill: "Online Payment 297564346872 To CITIBANK CREDIT CARD 06/25 $4,518.33". The Transfers category shows $30,447.59 in May and $30,645.49 total in the same table that footnotes "confirmed transfers excluded" — i.e. these are *unconfirmed* transfers leaking through. The knock-on: "Spending $6,913.01", "Savings rate: -124%", and a Net of -$3,831.82 for June are all arithmetically driven by miscounting debt movement as consumption. Every downstream widget inherits the distortion.
- **Fix:** Auto-pair and exclude CC-payment/inter-account transfers before any report aggregation (the amount+date+sign detector already planned). Until confidence-confirmed, still suppress obvious CC-payoff patterns ("PAYMENT TO … CARD", "ONLINE PAYMENT TO … CREDIT CARD") from spend/biggest-purchase/top-merchant/savings-rate math, and surface a "N unreviewed transfers may affect these numbers →" banner linking to Review, so the footnote's promise ("confirmed transfers excluded") is actually true.
- **Maps to:** FEATURE-GAP #1/#7 (transfers end-to-end); PLAN closed-item "transfers end-to-end" — but the reports-specific manifestation (spend, savings rate, biggest purchase) is not yet wired to the exclusion. Extend that work; NEW for the report-side wiring + banner.

### REPORTSCASHFLOW-2 — Charts are dead-ends: no drill-through from donut, Sankey, bars, or month-in-review to transactions [P1]
- **Evidence:** `reports-desktop.png`; census `keel-money-02` (only the 6-month table row is documented clickable → ledger).
- **Competitors:** Every competitor makes the visualization a navigation surface — Monarch Sankey node → transactions, Copilot hover-tooltip category breakdown → drilldown → that category's transactions (`copilot-community-01/02`), Simplifi embeds a transaction table under each report and watchlist (`quicken-simplifi-community-01`), YNAB report rows expand in place (`ynab-community-01`).
- **KEEL today:** The donut slices, its legend rows, the Sankey nodes, the income-vs-spending bars, and the Month-in-review "top spending categories" are all static. The single working path is the 6-month table's category name. A user who sees "Food & Drink 39% $679.40" in the donut or a fat Sankey ribbon cannot click it to see the transactions behind it.
- **Fix:** Make donut slices/legend rows, Sankey nodes/ribbons, bar segments, and month-in-review category rows all route to the ledger pre-filtered by that category + the widget's active date scope (reuse the existing category→ledger deep link). Add hover tooltips on the donut and Sankey showing amount + % + txn count.
- **Maps to:** FEATURE-GAP #6 (reports depth); NEW.

### REPORTSCASHFLOW-3 — Four unsynchronized date paradigms on one page; no account/entity/category scope [P1]
- **Evidence:** `reports-desktop.png` — Month-in-review month chips (Feb–Jul, showing **Jun 26**), Spending-by-category relative chips + from/to inputs (showing **Jul 1–16**), fixed "last 6 months" table, fixed "this month vs last month" list; census `keel-money-02` §IA.
- **Competitors:** Monarch/YNAB/Simplifi drive the entire report page from one date range + account filter + category filter (convergent #1). Simplifi additionally scopes reports by account tree and business/personal entity (`quicken-simplifi-community-01`).
- **KEEL today:** The top card describes June while the three cards under it describe July — the same page shows two different months simultaneously, with no single control to align them. There is **no account filter and no entity filter** — impossible to ask "spending on the Chase account" or "the LLC's P&L", which directly undercuts KEEL's multi-entity thesis. No category filter to isolate a subset.
- **Fix:** Add a page-level scope bar (date range — keep the good relative chips This month / Last month / L3M / YTD / L12M + custom from/to — plus Account multi-select and Entity selector, plus optional Category multi-select) that drives every widget. Keep per-widget overrides only where deliberate (e.g. the 6-month matrix's fixed window), but default them to inherit the page scope so June/July can't disagree by accident.
- **Maps to:** FEATURE-GAP #16 (period-over-period, category drilldown); NEW (account/entity scope on reports).

### REPORTSCASHFLOW-4 — Red on non-negative-money deltas violates Law 8; delta color = raw arithmetic sign, not favorability or negative-money [P1]
- **Evidence:** `reports-desktop.png` Month-in-review; census `keel-money-02` §Layout (flagged as a possible Law-8 deviation), §Open questions.
- **Competitors:** Copilot deliberately binds color to *favorability* — a spend increase is red even with an up-arrow, debt decreasing is green with a down-arrow (`copilot-community-02`, `copilot-mac-01`). Simplifi uses red almost nowhere (`quicken-simplifi-community-01`). Both are internally consistent; KEEL's is neither.
- **KEEL today:** Income $3,081.19 shows delta "−$18,824.74 vs May 26" in **red**, and Spending $6,913.01 shows "−$38,803.08 vs May 26" in **red** — but a $38k *drop in spending* is good news, and neither figure is negative money. Red here means "the delta number has a minus sign," which is exactly what Law 8 ("red = negative money ONLY") forbids. Meanwhile "Savings rate: −124%" — genuinely alarming — is plain black narrative text, unflagged (census §Open questions). So the page is simultaneously over-red (favorable decreases) and under-red (a true crisis figure).
- **Fix:** Pick one rule and apply it everywhere. Given Law 8, deltas should not be red for being negative — use a neutral up/down glyph + muted tone for direction, reserving red strictly for figures that are themselves negative money (Net −$3,831.82 stays red, correctly). If the founder wants favorability semantics instead, that is an explicit Law-8 amendment to log in NOTES.md — do not leave it as an accidental third convention.
- **Maps to:** NEW (design-language correctness).

### REPORTSCASHFLOW-5 — No export from a report; export is bulk-admin only [P1]
- **Evidence:** `reports-desktop.png` (no export/download control on any widget); FEATURE-GAP #19 (`keel_export_household` / `admin.export` only).
- **Competitors:** Convergent #3 — Monarch, YNAB, Simplifi, Copilot all put a download/export affordance on the report itself, scoped to the current view/filters.
- **KEEL today:** To get "my Q2 spend-by-category as CSV" a user must run the whole-household `admin.export_all` and slice it themselves. The Data Access Guarantee exists (Law 6) but is not reachable from where the user is looking at the number.
- **Fix:** Add an "Export" control per report widget (and one page-level) that emits the currently-scoped rows as CSV/JSON, reusing `packages/exports`. Copy Simplifi's column-settings nicety later (show/hide cents, expenses-as-negative) but ship the plain CSV first.
- **Maps to:** FEATURE-GAP #19; NEW (report-scoped export wrapper).

### REPORTSCASHFLOW-6 — No Net Worth report (change, drivers, allocation, history table) [P2]
- **Evidence:** `reports-desktop.png` (Reports has zero net-worth content); `dashboard-desktop.png` (only a 90-day line on Home); census `keel-core-01`.
- **Competitors:** Convergent #4 — YNAB Net Worth report shows a combo chart + "Change in Net Worth $19,042.25 / 251.1%" + a Dec→Jun month table with per-row trend arrows (`ynab-community-01`); Monarch shows Assets/Liabilities stacked allocation with per-category dollars and a net-worth hero with 1-month change (`monarch-community-02`); Simplifi and Rocket Money each have a Net Worth destination.
- **KEEL today:** The dimension explicitly includes "net-worth report" and KEEL has none in Reports. The backend already computes `keel_net_worth_as_of` and stores `balance_snapshots` (FEATURE-GAP #14), so the data exists.
- **Fix:** Add a Net Worth report: net-worth trend over the page date range, a change figure ($ and %), a month-by-month history table with trend arrows, and an Assets-vs-Liabilities allocation breakdown (per account-type subtotal). Reuse the snapshot series.
- **Maps to:** FEATURE-GAP #14; PLAN W1.9-adjacent; NEW report view.

### REPORTSCASHFLOW-7 — No merchant/payee rollup report [P2]
- **Evidence:** `reports-desktop.png` (all rollups are by category); `dashboard-desktop.png` ("Top merchant this month" is a single, and buggy, stat surfacing a CC payment); FEATURE-GAP #16 ("no merchant/vendor rollup").
- **Competitors:** Rocket Money "Frequent Spend" ("You've spent at Stop & Shop 5 times this month vs. 1 time last month … $179.62", `rocket-money-community-01`); Copilot top-merchant + per-merchant recurring detail; Monarch merchant grouping.
- **KEEL today:** The dimension names "category/merchant rollups"; KEEL delivers category only. There is no "who did I pay the most / how often" view, and the one merchant stat on Home is polluted by the transfer bug (REPORTSCASHFLOW-1).
- **Fix:** Add a merchant/payee rollup (by normalized merchant, with count + total + avg + prior-period delta), drill-through to that merchant's transactions. Depends on merchant normalization being consistent (census `keel-core-01` flags raw ACH memos rendered verbatim — normalize before rolling up).
- **Maps to:** FEATURE-GAP #16; NEW.

### REPORTSCASHFLOW-8 — No selectable comparison basis and no Totals/Change|Trends view toggle [P2]
- **Evidence:** `reports-desktop.png` (comparisons hard-coded to "vs May 26" / "this month vs last month").
- **Competitors:** Convergent #5 — Copilot "compared to [Previous period ▾]" (`copilot-community-02`), Monarch "Totals / Change" (`monarch-community-02`), YNAB Average/Total columns + Totals/Trends toggle (`ynab-community-01`).
- **KEEL today:** A user cannot compare against the same month last year (seasonality), against a trailing average, or against a custom prior window; and cannot switch a widget between absolute totals and period-over-period change.
- **Fix:** Add a comparison-basis selector (Previous period / Same period last year / None) that drives the deltas across widgets, and a Totals⇄Change toggle on the donut and 6-month matrix. The 6-month matrix is the natural home for a Trends (small multiples / sparkline-per-row) mode.
- **Maps to:** FEATURE-GAP #16; NEW.

### REPORTSCASHFLOW-9 — No category drill-down/trend view (history + monthly average + target line + its transactions) [P2]
- **Evidence:** `reports-desktop.png` (6-month table is numbers only; clicking a category jumps to the ledger, not a category analysis view).
- **Competitors:** Copilot category drilldown = trend bar chart across ~3 years + budget-ceiling callout line + Key Metrics (total/year, avg monthly) + that month's transactions, all in one pane (`copilot-community-01`, `copilot-mac-01`). Simplifi "Spending Watchlist" for a category = 12-month bar chart with a red **target threshold line**, 12-mo average / YTD total / spent / projected / target in one stat row, breakdown ring, and transactions (`quicken-simplifi-community-01`).
- **KEEL today:** KEEL already stores per-category budget targets (`budgets-desktop.png`), yet the Reports side never overlays a target line on a category's history or shows a per-category trend + monthly average — the richest single-category analysis is a flat row in a matrix.
- **Fix:** Add a category detail view (reachable from the drill-through of REPORTSCASHFLOW-2): trend bars over the scope window, monthly-average and YTD stats, the budget target as a horizontal reference line, and the contributing transactions inline.
- **Maps to:** FEATURE-GAP #6/#16; ties to W2.2 budgets; NEW.

### REPORTSCASHFLOW-10 — No exclude-from-reports control; anomalies can't be isolated [P2]
- **Evidence:** `reports-desktop.png` (widgets exclude only "confirmed transfers" and "net of refunds", globally); census `keel-core-01` §Business rules (the −$25,000 "FID BKG SVC LLC MONEYLINE" transfer moves net worth for a month yet has no special treatment).
- **Competitors:** Simplifi has a per-transaction "Exclude from Reports" checkbox (separate from "Exclude from Spending Plan"), each with its named blast radius (`quicken-simplifi-community-02`, `flows-flow-02`); Copilot excludes categories/legs; Monarch hides transactions via rules.
- **KEEL today:** No user control to exclude a one-off from analytics (a reimbursed expense, a moving lump sum, the $25k transfer). A single anomaly silently skews the bars, the savings rate, and the net-worth chart with no override.
- **Fix:** Add a per-transaction "Exclude from reports" flag (distinct from any budget-exclude), honored by all report aggregations, with the exclusion count surfaced in the footnote (Simplifi's "1 Reminders are excluded" pattern) so reproducibility stays honest.
- **Maps to:** FEATURE-GAP #16; NEW (aligns with the rules/overlay layer, W2.1).

### REPORTSCASHFLOW-11 — Reports page 390px usability is unproven and structurally at risk [P2]
- **Evidence:** No `reports-mobile-390.png` exists in `design/current/2026-07-16/` (mobile census `keel-mobile-04` covers only Accounts/Dashboard/Ledger/Review); `reports-desktop.png` shows a 7-column 6-month matrix, a donut with a side-by-side legend, and a wide Sankey.
- **Competitors:** Rocket Money, Monarch, Copilot, Simplifi, YNAB all ship reports on phone (Monarch Reflect spending breakdown `ynab-web-01`; Copilot mobile cash-flow/spend cards; Rocket Money mobile Spending `rocket-money-community-01`).
- **KEEL today:** Law 8 requires 390px usability, and the dashboard's charts do reflow (`dashboard-mobile-390.png`), but the Reports page's widest components — the 6-month × 7-column matrix and the donut-plus-legend row — are exactly the layouts that overflow horizontally, and there is no evidence they've been handled. This is an unverified risk, not a confirmed break.
- **Fix:** Capture and audit the Reports page at 390px; make the 6-month matrix horizontally scroll within its own container (never the page body), stack the donut above its legend, and let the Sankey scroll or collapse to a ranked list on narrow widths.
- **Maps to:** NEW (verification + responsive slice).

### REPORTSCASHFLOW-12 — No saved or tabbed report views; one fixed scroll [P2]
- **Evidence:** `reports-desktop.png` (six widgets, single continuous scroll, no report picker); census `keel-money-02` §IA ("No tabs to switch report views — everything renders at once, requiring a long scroll").
- **Competitors:** Convergent #6 — Simplifi saved report tabs + "Save"/"Reset report" with a modified-state dot (`quicken-simplifi-community-01`), Monarch "Saved", YNAB 5 report tabs.
- **KEEL today:** Once account/entity/date scoping exists (REPORTSCASHFLOW-3), users will want to save "LLC P&L, YTD" or "Household spend, last 3 months" — there's nowhere to persist a configured report, and everything renders at once making any single report a scroll-hunt.
- **Fix:** Introduce report tabs/saved views persisting scope + comparison + which widgets are shown; ship after the scope bar lands.
- **Maps to:** NEW.

### REPORTSCASHFLOW-13 — Donut silently truncates the category tail; no "all other" remainder [P3]
- **Evidence:** `reports-desktop.png` (donut legend: Loan Payments 51.5% / Food&Drink 39% / Entertainment 3.1% / Shopping 2.3% / Transfers 2% / Government&Nonprofit 1.8% = 99.7%); census `keel-money-02` §Open questions.
- **Competitors:** Copilot's spend breakdown ends in an explicit "All other categories… $244.66" catch-all rather than dropping the long tail (`copilot-community-02`).
- **KEEL today:** Six categories shown, percentages sum to 99.7%, and any remaining categories vanish with no remainder row — the donut and its center total ($1,738.01) don't visibly reconcile with the legend.
- **Fix:** Add an "All other (N categories) $X" remainder row so the legend sums to the center total and 100%; make it drill-through to the tail.
- **Maps to:** NEW (polish on shipped report).

### REPORTSCASHFLOW-14 — Signature Sankey is static: no hover, no percentages, no share [P3]
- **Evidence:** `reports-desktop.png` "Where this month's money went"; census `keel-money-02` (nodes carry "Name · $amount" but no percentage, no interaction).
- **Competitors:** Monarch's Sankey labels each node with amount **and** parent-relative % at every depth, expands, and has a first-class de-chromed "Share" render (`monarch-community-01`).
- **KEEL today:** The Sankey is the "where did the money go" showpiece but is inert — no hover, no % of income per node, subcategories flattened into parents, and no way to drill or share.
- **Fix:** Add hover tooltips (amount + % of income + txn count), node/ribbon click → transactions (part of REPORTSCASHFLOW-2), optional one-level subcategory expansion, and a shareable/exportable static render.
- **Maps to:** FEATURE-GAP #6; NEW.

### REPORTSCASHFLOW-15 — "Income vs spending by month" duplicates Home's "Cash flow by month" and adds no net line [P3]
- **Evidence:** `reports-desktop.png` (Income vs spending by month: green in / purple out, Apr–Jul, May spike) vs `dashboard-desktop.png` (Cash flow by month: identical green/purple bars, same months, same spike).
- **Competitors:** Monarch and Copilot overlay a **net cash-flow line** on the in/out bars and mark the current/in-progress period distinctly (`monarch-community-02` dashed current-period line; `copilot-community-02` "Now" marker) — the chart earns its space by showing net, not just the two bars again.
- **KEEL today:** The Reports version is a verbatim repeat of the Home version with no added dimension; purple-for-outflow (chosen to avoid red per Law 8) is also unlabeled as to why it's not the intuitive expense color.
- **Fix:** Differentiate the Reports version — overlay a net line, mark the in-progress month (KEEL already knows "current month still in progress"), and let bars drill to that month's transactions. Add a one-line legend note that purple = money out (red reserved for negative money).
- **Maps to:** NEW.
