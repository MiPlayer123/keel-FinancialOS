# Goals, forecasting & planning

Scope note: KEEL ships four surfaces that touch this dimension — a `Goals` page (100% empty
state, no goal has ever been created: `goals-desktop.png`, keel-money-02), a Home "Free to
spend" safe-to-spend hero, a Home "Projected cash · next 30 days" chart that renders as a flat
degenerate band, and a `Budgets` page with no targets/progress (`budgets-desktop.png`). There is
no loan-payoff simulator, no what-if/scenario surface, no forecast tab, and no goal-funding
model anywhere in the captured product. KEEL does two things well and I do not re-file them as
gaps: the "Free to spend $8,803.00 · $586.86/day for the 15 days left" hero is a genuine
safe-to-spend number, and the projection carries an honest Class-C "PROJECTION" pill + "not a
statement of record" caption (Law 10 discipline). Everything else in this dimension is missing or
broken.

## Convergent patterns
(what ≥3 competitors ALL do that KEEL does not)

1. **A real goal object: current / target / progress bar / target date / time-to-target / funding
   source.** Monarch (goal card = photo + `$4,000.00` over `67% of $6,000.00`, "On track" pill,
   `Jul 2026` target date, filled progress bar with a boundary tick, plus 4 stat tiles Total
   saved / Total spent / Available to spend / Left to save, and a timeline chart projecting the
   savings line as a dashed segment out to the target-date marker — monarch-community-02
   community-12/14), Copilot (`$16,057 / $25,000`, green progress bar, "8 months left" +
   flag + "Dec 2025" target date — copilot-community-02 x02), Simplifi ("Goals" is one of five
   Spending-Plan buckets with a `-$300.00` monthly contribution — quicken-simplifi-community-01
   community-01), YNAB (per-category savings Targets: "Set Aside Another $50.00 Each Month / By
   the End of the Month", progress ring, "Assign $50.00 to meet your target" — ynab-community-02
   x05), Quicken ("Savings Goals" as a first-class account group in the sidebar —
   quicken-classic-community-01). **KEEL Goals is a dashed empty box with a piggy-bank icon and
   "No goals yet"; there is no evidenced goal-card design at all** (`goals-desktop.png`).

2. **A forward projected-balance curve driven by upcoming/recurring bills, with an actual→projected
   transition and a lowest-point read.** Simplifi ("Projected Cash Flow" — solid realized line
   crossing a vertical "today" marker into a dotted projected line, green `$` badge dots on each
   balance-changing event, hover tooltip stacking running balance + payee + signed amount + a
   "Projected" tag, "Next 1 month" range picker — quicken-simplifi-community-01 community-03),
   Monarch (cash-flow chart draws the current/incomplete period's trendline as a **dashed** segment
   distinct from settled history — monarch-community-02 community-09; plus a dedicated Budget →
   **Forecast** tab — community-15), Quicken ("Stay On Top of Monthly Bills / WHAT'S LEFT $54,338"
   + a "Bill and Income Reminders — Next 14 Days" list — quicken-classic-community-01 community-08),
   Copilot ("Next Two Weeks" upcoming-bills card — copilot-community-02 community-10). **KEEL's
   equivalent chart is a flat filled band whose four y-axis ticks all read "15.2K", with copy
   admitting "No confirmed recurring bills in the window yet"** (`dashboard-desktop.png`,
   keel-core-01).

3. **A forward-looking budget/target signal — projected month-end vs a target, or "on pace to
   overspend".** Simplifi (Spending Watchlist: a horizontal red **Target** threshold line at $150
   drawn across a 12-month bar chart, plus a stat row "Spent so far $224.55 / Projected $369.84 /
   Target $150.00" — quicken-simplifi-community-01 community-04), Copilot (Monthly Spending chart
   annotates the live trend point with "$97 under" in a green pill; Top Categories bars turn
   red when over budget — copilot-community-02 community-10), YNAB (inline "$X more needed by the
   1st" under each under-target category — ynab-community-02 community-09), Monarch (per-row
   spend-vs-budget progress bars + rollover pills — monarch-community-02 community-15). **KEEL
   Budgets shows only "$679.40 spent" per row with a "Set budget" button; no target, no bar, no
   projection, no total** (`budgets-desktop.png`, keel-money-02).

## Findings

### GOALSFORECAST-1 — Goals is an empty, undesigned nav destination while every competitor ships a rich goal object [P1]
- **Evidence:** `design/current/2026-07-16/goals-desktop.png`; keel-money-02 (goals section, "No goals yet" empty state only). Competitors: monarch-community-02 (community-12/13/14), monarch-appstore-01 (pad-08), copilot-community-02 (x01/x02/x03), quicken-simplifi-community-01 (community-01), ynab-community-02 (x05).
- **Competitors:** A goal is a real card with (a) current vs target amount, (b) a proportional progress bar, (c) a target **date** and a computed **time-to-target** ("8 months left", "17 years, 4 months left" — Copilot), (d) a status pill ("On track" — Monarch), (e) one or more **funding-account badges**, and (f) a detail view with a savings-trajectory chart projected as a dashed line to the target-date marker and stat tiles (Total saved / Total spent / Available to spend / Left to save — Monarch community-14). Copilot adds a monthly "did I contribute" check-in streak (rings per month) and lifecycle sections (Active / Ready to spend / Archived).
- **KEEL today:** Header + subtitle "Earmark money toward what's next — nothing moves, it's just spoken for", a "+ New goal" button, and a single dashed placeholder: "No goals yet / An emergency fund, a trip, a down payment — set the target and KEEL tracks how much of your money is spoken for." No goal card, no progress, no target-date field, no funding model has ever been rendered (`goals-desktop.png`).
- **Fix:** Build the goal object + card. Card = name, current/target (mono tabular, right-aligned), a single progress bar (green = money only), target date, and a computed "N months left" adjacency. Add a status pill computed from pace vs target date ("On track" / "Behind"), rendered adjacent to the number (Law 8). Goal detail = the same figure-over-context header + a savings-line chart whose projected tail is a dashed segment to a target-date marker (mirror Monarch community-14; keep the target line a distinct non-green color reserved for "target"). Stat tiles: Saved / Spent-from / Available / Left-to-save. Every material readout is a Class-C preview (progress is fact; "on track" is projection).
- **Maps to:** NEW (FEATURE-GAP #13 "Goals: Missing" / Tier-2 #9; not in PLAN-FEATURE-PARITY waves — add a goals slice).

### GOALSFORECAST-2 — "Free to spend" overstates spendable cash: it nets income − spent-so-far only, ignoring upcoming bills and goal earmarks [P1]
- **Evidence:** `dashboard-desktop.png`, `dashboard-mobile-390.png`, keel-core-01 (hero: "In so far $10,541.01", "Spent so far −$1,738.01", "Free to spend $8,803.00", "$586.86 / day for the 15 days left"). Competitors: quicken-simplifi-community-01 (community-01), copilot-community-02 (community-10), quicken-classic-community-01 (community-08).
- **Competitors:** Safe-to-spend is computed **after** reserving known obligations. Simplifi's "Left this month $3,710.08 / $185.50 left per day" is what remains after the Bills, Planned Spend, Other Spend, and Goals buckets are subtracted from Income (community-01). Copilot frames it as "$147 left out of $3,560 budgeted" — spend against an allocation, not against raw income. Quicken surfaces "WHAT'S LEFT $54,338" beside a next-14-days bill-reminder list so the two are read together (community-08).
- **KEEL today:** The hero math is transparently income-so-far minus spent-so-far ($10,541.01 − $1,738.01 = $8,803.00), then divided by remaining days. With "Loan Payments $5,999.55" sitting as the #1 spending category and rent/bills implied, this tells the user they can spend $586/day when large recurring obligations for the month are unreserved. KEEL's own Goals subtitle promises to track "how much of your money is spoken for," but with zero goals and no bill reservation the hero reserves nothing.
- **Fix:** Once recurring bills are confirmable (see GOALSFORECAST-3) and goals earmark real money (GOALSFORECAST-7), subtract (a) still-due confirmed recurring occurrences in the current month and (b) active goal earmarks from the "Free to spend" figure, and show the reservation as an adjacent line ("after $X in bills due, $Y spoken for by goals"). Until then, relabel or add a caveat so the number is not read as fully discretionary. Keep the "$X/day" derivation but base it on the reserved figure.
- **Maps to:** W2.5 (cash-flow forecast supplies the still-due-bills input); goal-earmark input is NEW.

### GOALSFORECAST-3 — Projected-cash chart is non-functional and looks broken: flat band, four identical "15.2K" axis ticks, no actual→projected transition, no lowest-point flag, no bills list [P1]
- **Evidence:** `dashboard-desktop.png`, `dashboard-mobile-390.png`, keel-core-01 (chart renders a flat band; all four y-axis gridline labels read "15.2K"; captions "No confirmed recurring bills in the window yet — confirm suggestions on the Recurring page to project them here" and "A preview from your confirmed recurring bills — not a statement of record"). Competitors: quicken-simplifi-community-01 (community-03), monarch-community-02 (community-09), monarch-iphone-02 (iphone-09), quicken-classic-community-01 (community-08), copilot-community-02 (community-10).
- **Competitors:** A working projection shows a realized balance line up to a "today" marker, then a **dotted/dashed projected** continuation; Simplifi marks each balance-changing event with a badge dot and a hover tooltip (running total + payee + signed amount + "Projected"), and offers a range picker ("Next 1 month"). Every projection is anchored to confirmed recurring bills + current cash and implicitly answers "will I dip low / when". None render a flat degenerate band.
- **KEEL today:** The projection is empty because it depends on confirmed recurring bills, and the Recurring page is itself empty ("No recurring activity detected yet", keel-money-02) — so the chart can never populate in this state and instead draws a flat fill with duplicate axis labels that reads as a chart-library scaling bug (keel-core-01 flags the duplicate ticks as ambiguous-but-buggy-looking).
- **Fix:** (1) Fix the degenerate render: when the data range collapses, don't emit 4 identical ticks — render an explicit empty/skeleton state with a single "no projection yet" illustration instead of a fake flat line. (2) Ship the real projection (W2.5): current cash-subtype balance + confirmed recurring occurrences → daily projected balance, with a "today" divider, a dashed projected segment, per-event markers, and a **lowest-projected-balance** callout (adjacent, red only if it goes negative). (3) Add an "upcoming bills in window" list beside the chart (Quicken/Copilot pattern). Keep the "PROJECTION"/"not a statement of record" labeling — that part is correct.
- **Maps to:** W2.5 (Cash-flow forecast, Class-C preview; lowest-point already named in the W2.5 spec).

### GOALSFORECAST-4 — No loan/debt payoff simulator, despite Loan Payments being the #1 spending category [P2]
- **Evidence:** `dashboard-desktop.png` (Spending: "Loan Payments $5,999.55" #1), keel-money-02 (no payoff surface anywhere). Competitor: ynab-community-01 (community-07/08 "Loan Payoff Simulator").
- **Competitors:** YNAB's Loan Payoff Simulator is a modal with a Required-Minimum-Payment reference, an editable Monthly Payment (with helper "$365.00 is your current monthly target"), a Payoff Date field, and a "One time extra in [Month]" input. Editing recomputes live: the chart adds a second dashed "Simulation" line vs "Current Track", the payoff date reframes ("Nov 2026 / Your original payoff date is Nov 2028"), and the stat tiles relabel from "Interest Remaining / Time Remaining" to **"Interest Savings / Time Savings"** ($1,738.19 saved, 2 years). A "Copy and go to my budget" link appears only once a field changes, and "Reset all changes" undoes the scratch edits. Nothing touches the ledger until explicitly committed — a clean Class-C preview.
- **KEEL today:** KEEL tracks liabilities (Credit Card account, Loan Payments category) and even charts net worth underwater, but offers zero payoff tooling — no "how fast if I pay $X more", no interest-saved, no payoff-date.
- **Fix:** Add a debt-payoff simulator per liability account (or per detected loan recurring series): inputs = extra monthly / one-time extra; outputs = payoff date delta, interest saved, time saved, dual-line current-vs-simulation chart. Strictly Class-C preview-only (Law 10 C — no money movement, no ledger write); commit path is a suggested budget/recurring change, not an automatic action. Reuse the "relabel Remaining→Savings" framing.
- **Maps to:** NEW.

### GOALSFORECAST-5 — Budgets are backward-looking only: no target, no progress bar, no projected month-end, no total [P2]
- **Evidence:** `budgets-desktop.png`, keel-money-02 (16 rows, each "$X spent" + "Set budget" button; footer "Categories without a budget still show what you spent"; no summary/total row). Competitors: quicken-simplifi-community-01 (community-04 watchlist target line + "Projected $369.84 vs Target $150.00"), copilot-community-02 (community-10 "$97 under" + red over-budget bars), ynab-community-02 (community-09 "$X more needed by the 1st" + progress ring), monarch-community-02 (community-15 progress bars + rollover pills).
- **Competitors:** Budget/target rows carry a target amount, a progress bar, and a **forward** signal: Simplifi projects month-end spend and draws the target as a threshold line so "will I blow the target" is answerable mid-month; Copilot annotates pace ("$97 under"); YNAB tells you the shortfall and its deadline inline. Over-target is a first-class visual state (red pill / red bar), and every product shows a period total ("Left to budget", "Ready to Assign").
- **KEEL today:** Each row reports only actuals ("$679.40 spent"), no target even after "Set budget" is available, no progress bar, no on-pace projection, and no total-spent / total-budgeted rollup at all — you cannot tell at a glance whether you are on track for the month.
- **Fix:** Land W2.2 (category rows with target + progress + overspent-in-negative-money-color + totals). Then extend forward: a projected month-end figure per category (linear or recurring-aware run-rate) and an adjacent "on pace / over by $X" status, plus an optional per-category target threshold line on a trend (Simplifi watchlist pattern). Add the missing total row.
- **Maps to:** W2.2 (targets/progress/totals — currently unshipped per screenshot), extended with a projection column (NEW / ties to W2.5 run-rate).

### GOALSFORECAST-6 — No what-if / scenario surface: the projection has no user levers [P2]
- **Evidence:** `dashboard-desktop.png` (single fixed "PROJECTION" band, no controls), keel-core-01 (Controls inventory: no date-range picker, no adjustable inputs on the dashboard). Competitors: monarch-community-02 (community-15 Budget/**Forecast** tab), ynab-community-01 (community-07/08 simulator inputs), quicken-simplifi-community-01 (community-03 "Next 1 month" range).
- **Competitors:** Forecasting is interactive — Monarch splits Budget from a **Forecast** tab; YNAB's simulator lets you drag payment/extra inputs and watch the outcome; Simplifi lets you re-scope the projection window. The user can ask "what if I save $X more / pay $Y toward debt / cut category Z" and see the curve move.
- **KEEL today:** The projection is a static, read-only 30-day band with no range control, no adjustable assumptions, and no scenario compare.
- **Fix:** Once W2.5 lands, add (a) a window selector (30/60/90d), and (b) at least one adjustable lever (e.g., "add a one-time expense/income on date D", or an extra-savings slider) that redraws the projected curve as a second dashed "scenario" line vs the base projection. Class-C preview-only; nothing writes to the ledger. This is the natural home for the GOALSFORECAST-4 payoff and GOALSFORECAST-1 goal simulations.
- **Maps to:** NEW (builds on W2.5).

### GOALSFORECAST-7 — Goals don't earmark real money against accounts: no "Available for goals", no per-account allocation, no free-to-spend deduction [P2]
- **Evidence:** keel-money-02 (Goals subtitle "nothing moves, it's just spoken for" — a soft-earmark model is intended but nothing implements it); `goals-desktop.png` (empty). Competitor: monarch-community-02 (community-13 goal-account allocation panel).
- **Competitors:** Monarch's allocation panel shows "$14,000.00 Available for goals", then per source account expands to reveal which goals draw from it ("Jon's Savings $30,000 → Vacation $5,000 + Emergency Fund $20,000 → Available +$5,000"), with the four accounts' availables summing exactly to the header — a soft allocation layer over real balances where one account funds many goals, and uncommitted balance is computed. A "Create goal transfer" action is offered separately.
- **KEEL today:** The concept is written into the subtitle ("how much of your money is spoken for") but there is no allocation UI, no "available for goals" figure, no wiring from goal earmarks into the "Free to spend" hero (GOALSFORECAST-2). The promise is unbacked.
- **Fix:** Implement goals as a deterministic soft-allocation layer: goal earmarks reference real asset-account balances; compute an "Available (unspoken-for)" figure per account and in aggregate; render Monarch's expand-account-to-see-goals panel; feed the total earmark into the Free-to-spend reservation. No money moves (consistent with Law 1 and the subtitle) — this is accounting, not a transfer.
- **Maps to:** NEW (pairs with the goals slice from GOALSFORECAST-1 and the hero from GOALSFORECAST-2).

### GOALSFORECAST-8 — Missing goal lifecycle, status, and contribution-cadence affordances [P3]
- **Evidence:** `goals-desktop.png` (empty). Competitors: copilot-community-02 (x02 lifecycle sections Active / Ready to spend / Archived; monthly check-in rings), monarch-community-02 (community-14 "On track" pill; Timeline vs Contributions toggle).
- **Competitors:** Copilot files goals under Active / Ready to spend / Archived, and shows a per-goal monthly check-in strip (green ring + check for months you contributed) as an engagement/streak mechanic. Monarch shows an "On track" computed status pill and a Timeline/Contributions view toggle.
- **KEEL today:** None of these exist (no goals rendered).
- **Fix:** When building the goals slice, include a lifecycle status (Active / Ready-to-spend when current ≥ target / Archived), a computed on-track pill placed adjacent to the number, and a per-month contribution indicator. Low lift once the goal object exists; high daily-engagement value.
- **Maps to:** NEW (extends the goals slice).

### GOALSFORECAST-9 — No bills/upcoming calendar or upcoming-bill list to anchor the forecast [P3]
- **Evidence:** keel-money-02 (Recurring page empty; recurring copy claims it "projects it into your balance curve" but no calendar/list surface exists); `dashboard-desktop.png` (no upcoming-bills list). Competitors: monarch-community-03 (community-x04/x05 recurring calendar with projected-vs-confirmed chips + Upcoming list), quicken-simplifi-community-02 (community-x07 Bills & Income Overview: Summary Income/Expenses/Net + Reminders list + dot-marked calendar), rocket-money-community-01 (recurring calendar + Upcoming tab), copilot-community-02 (community-10 "Next Two Weeks").
- **Competitors:** A calendar or ranked upcoming-bills list makes the projection legible — Monarch renders each due occurrence as a calendar chip (confirmed = green check/colored, projected = plain), with an Upcoming list mirroring it; Simplifi shows a next-30-days Summary (Income − Expenses = Net) over a dot-marked calendar with per-item "Paid" status; both let the forecast be inspected item-by-item.
- **KEEL today:** No calendar, no upcoming-due list; the only forward artifact is the (empty) projection band. The user cannot see which bills drive the curve.
- **Fix:** Add an "upcoming (next 30/60d)" list beside the projection — due date, payee, amount, account, confirmed-vs-projected status — sourced from confirmed recurring occurrences (reuse the recurring detector). A calendar view is optional depth; the ranked list is the minimum to make the forecast inspectable and ties directly into GOALSFORECAST-2/3.
- **Maps to:** W2.5 (upcoming-bills list is named in the W2.5 spec); calendar view NEW.
