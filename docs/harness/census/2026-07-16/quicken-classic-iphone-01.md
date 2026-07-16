# Census — quicken-classic-iphone-01

## Evidence
- `iphone-01-logo_admin_2020q4_color-0-1x_U007emarket.png` → not a UI screen; a standalone app-icon/logo asset (blue hexagon with a white hexagon cut out of the center, on transparent/white background). No screen chrome, no text.
- `iphone-02-4.png` (iPhone frame, 1290×2796 native) → account register / transaction list for a single account, "Family Checking," with a balance summary card and search bar above a date-grouped transaction list; a floating add ("+") button is visible mid-list.
- `iphone-03-QC_2048×2732_5.png` (iPad frame, 2048×2732 native, despite unit's "iphone" group) → "November Budget" screen: overall "Personal Expenses" progress bar plus a scrollable list of budget categories, each with its own progress bar.
- `iphone-04-QC_2048×2732_2.png` (iPad frame) → "Spending Over Time" report: time-range pill filter row, a bar chart by month, a large total-spending callout, and a sortable month-by-month list.
- `iphone-05-6.png` (iPhone frame) → "Spending By Payee" report: time-range pills, a donut chart with a center total, a horizontally scrollable row of per-payee summary cards, and a sortable payee list with colored legend dots.
- `iphone-06-QC_2048×2732_4.png` (iPad frame) → same "Spending By Payee" report as iphone-05, larger canvas, "Last Month" range selected, showing more rows and more of the pill row and summary-card rail.
- `iphone-07-7.png` (iPhone frame) → "December Budget" screen, same layout pattern as iphone-03 but a different month and iPhone-sized frame.
- `iphone-08-QC_2048×2732_7.png` (iPad frame) → single-security detail screen for ticker "NVDA": price/change header, share count/market value, and a two-column key-stats table (Open, Market Cap, P/E, Div Yield, High/Low, 52-week High/Low, Previous Close, Volume, Avg Volume), with a data-freshness disclaimer footer.

## Information architecture
- No top-level navigation (tab bar, hamburger, sidebar) appears in any of the 8 images — every screen shown is a drilled-in destination reached via a blue header bar with a back chevron ("<") at top-left. The parent hub/list screens that link to these destinations are not present in this unit's evidence.
- Screens observed fall into three families, each with its own back-chevron header:
  1. Account register ("Family Checking") — one screen per account, entered from (presumably) an accounts list.
  2. Budget ("November Budget," "December Budget") — one screen per month, with in-screen month-stepper navigation (`<` / `Nov 2024` / `>`), so month-to-month movement does not require leaving the screen.
  3. Reports ("Spending Over Time," "Spending By Payee") — each report is its own screen, entered from what is presumably a reports list; within a report, a horizontal pill row switches the time range without navigating away.
  4. Investment holding detail ("NVDA") — reached from what is presumably a portfolio/holdings list; single scrolling stat table, no in-screen sub-navigation.
- Budget category rows that are themselves parents (e.g. "Bills & Utilities," "Food & Dining," "Home," "Kids") carry a trailing chevron (">"), implying one more level of drill-down (a subcategory breakdown) is "one click away" from the budget screen. Categories without a chevron (e.g. "Cash & ATM," "Education," "Entertainment," "Personal Care," "Auto & Transport:Gas & Fuel") are leaves.
- The "Auto & Transport:Gas & Fuel" row expresses a two-level category hierarchy inline via a colon-separated label instead of a chevron drill-down — a different IA treatment for hierarchy than the chevron rows in the same list (iphone-03, iphone-07).
- Reports share one navigational shell: pill-style time-range switcher → chart → total callout → sorted list, reused verbatim across "Spending Over Time" and "Spending By Payee" (iphone-04, iphone-05, iphone-06).

## Layout & content
- **Register (iphone-02):**
  - Blue header band: back chevron, centered title "Family Checking," right-aligned "Edit" link.
  - Balance card: small caps label "TODAY'S BALANCE" with a circled-"i" info icon beside it, then a large balance figure "$21,352.16"; a 3-dot page indicator below (first dot solid/blue, other two light gray) implies this balance card is one of several swipeable summary cards.
  - Search row: magnifying-glass icon + placeholder "Search Transactions" pill, with a clock/history icon and a filter/sliders icon to its right.
  - Scope banner: circled-"i" icon + "Showing transactions since 2022" with "since 2022" rendered as a tappable blue link.
  - List is grouped two levels deep: month divider ("NOV", "OCT" — all-caps, gray strip) then date sub-header ("Nov 20, 2024," "Nov 16, 2024," etc., lighter gray strip).
  - Each transaction row: a small blue dot bullet + merchant name (bold black, e.g. "Netflix") with its category directly beneath in smaller gray text (e.g. "Entertainment"); right side has the signed amount on top (e.g. "-$12.50," dark/near-black text, not colored red) and the running account balance beneath it in smaller gray text (e.g. "$21,352.16"). Both right-column figures are right-aligned to the same edge.
  - Density: 6 full transaction rows plus 3 date/month dividers are visible in the frame before the cut-off; a floating circular "+" (add transaction) button overlaps the list near its vertical center.
  - Amount formatting: comma thousands separators, two decimal places, dollar sign, leading minus for outflows; no parentheses used for negatives.

- **Budget (iphone-03, iphone-07):**
  - Blue header: back chevron, centered title "November Budget" / "December Budget".
  - Month stepper: "<  Nov 2024  >" / "<  Dec 2024  >" directly under the header.
  - Section heading "Personal Expenses" (bold, centered) followed by one full-width progress bar (green fill over gray track) summarizing overall spend.
  - Directly under that bar: left-aligned "$2,539  out of  $6,244" (Nov) / "$4,990  out of  $6,073" (Dec) and right-aligned "$3,705 Left" / "$1,083 Left" — the pairing of spent/budgeted amount with remaining amount recurs at both the top summary and every category row.
  - Category rows repeat the same pattern: category name (black) on its own line, optionally with trailing ">" chevron; second line has "$X  out of  $Y" (both dollar figures rendered blue/underlined, i.e., apparently tappable) left-aligned and "$Z Left" (gray) or "$Z Over" (red) right-aligned; a thin progress bar beneath (green fill for on/under-budget, full red fill for over-budget).
  - Observed rows (Nov, iphone-03): Auto & Transport:Gas & Fuel ($100/$183, $83 Left), Bills & Utilities> ($802/$1,090, $288 Left), Cash & ATM ($0/$120, $120 Left), Education ($0/$100, $100 Left), Entertainment ($13/$106, $93 Left), Food & Dining> ($193/$1,263, $1,070 Left), Health & Fitness ($243/$100, "$143 Over" — bar entirely red), Home> ($0/$2,400, $2,400 Left), Kids> ($0/$432, $432 Left), Personal Care ($45/$200, $155 Left).
  - Observed rows (Dec, iphone-07, partial before cutoff): Auto & Transport:Gas & Fuel ($59/$183, $124 Left), Bills & Utilities> ($358/$925, $567 Left), Cash & ATM ($0/$120, $120 Left), Education ($10/$100, $90 Left), Entertainment ($0/$100, $100 Left), Food & Dining> ($238/$1,263, $1,025 Left).
  - Density: iPad frame (iphone-03) fits 10 category rows plus the summary block before scroll cutoff; iPhone frame (iphone-07) fits 6 rows in the same relative vertical space — same content density scaled by screen size rather than re-laid-out.

- **Spending Over Time report (iphone-04):**
  - Header: back chevron, centered title "Spending Over Time," right-aligned sliders/filter icon.
  - Pill row (8 options, horizontally arranged, one active/filled): "Last 30 Days," "This Month," "Last Month," "Last 3 Months," "Last 6 Months" (active — solid blue fill, white text), "Month to Date," "Year to Date," "Custom."
  - Bar chart: y-axis gridlines/labels at $0, $4.6k, $9.2k, $13.8k, $18.4k, $23.0k (abbreviated with "k"); x-axis months Aug 2024 through Jan 2025; all bars a single coral/salmon color, heights varying (tallest at Dec 2024).
  - Large centered total callout beneath chart: "$76,189.85" with subtitle "Overall Spending" (full precision, unlike the abbreviated chart axis).
  - List section header row: "LAST 6 MONTHS" (small caps, left) and "SORT" (right, with an accompanying sort-lines icon).
  - List rows: month name left, full-precision dollar amount right — Aug 2024 $17,041.78; Sep 2024 $17,319.19; Oct 2024 $8,566.46; Nov 2024 $7,995.99; Dec 2024 $22,945.43; Jan 2025 $2,321.00.

- **Spending By Payee report (iphone-05, iphone-06):**
  - Header: back chevron, centered title "Spending By Payee," right-aligned sliders icon.
  - Pill row identical style to the Over-Time report; "Last Month" is the active pill in both captures.
  - Donut chart: one large brown/tan segment ("Other Payees"), then decreasing-size colored segments (cyan, coral, green, purple, orange, yellow, blue, pink, red/crimson) matching the list rows below by color.
  - Donut center: large total ("$7,996" iPhone/Last Month, "$22,945" iPad/Last Month) with two-line subtitle "Total spending" / "Last Month" — note the center figure is rounded to whole dollars while the equivalent list/report total elsewhere (iphone-04) is shown to the cent ($22,945.43 vs $22,945), an inconsistency in rounding between summary and detail figures.
  - A single purple dot sits below the donut, unlabeled — apparent selection/legend marker, function not confirmed by visible text.
  - Horizontally scrollable row of stat cards, each showing a bold dollar amount and a "Total for [Payee]" caption beneath — e.g. "$329.20 / Total for Best Buy," "$1,159.48 / Total for United - 9136."
  - List header row "LAST MONTH" / "SORT," then rows of colored dot + payee name (left) + amount (right):
    - iPhone (iphone-05): Other Payees $3,173.78; Sp Heath Ceramics - 9136 $1,608.16; Airbnb $1,448.08; Capital One Member Fee - 91… $395.00 (name truncated with ellipsis); Best Buy $329.20 (row cut off at frame edge).
    - iPad (iphone-06, fuller list): Other Payees $11,106.29; Southwest Airlines $2,789.70; Airbnb $2,724.00; Snow.com/vail Resorts Ski - 9136 $1,219.95; United - 9136 $1,159.48; Berkeley Bob's - 6998 $1,065.28; Sports Basement Berkeley - 9136 $991.07; Sports Basement U107 - 6998 $813.00; Care Usa - 6998 $540.75; Target $535.91.
  - Several payee names carry a trailing masked-account suffix ("- 9136," "- 6998"), implying the same merchant can appear as separate payee rows keyed by which card/account paid it.

- **Security detail (iphone-08, "NVDA"):**
  - Header: back chevron, centered title "NVDA".
  - Sub-header band: "NVDA" label again (small, centered), then large price "$136.01" in green (gain color), beside a green filled pill badge "↑ +$1.72 | +1.28%" (up-arrow icon + absolute change + percent change, both inside one pill).
  - Below that: "80 Shares | Market Value: 10,881.20" in gray, single line, pipe-separated.
  - Divider line, then a two-column key/value stat table, label left (gray) / value right (black), each row divided by a thin rule: Today's Open $136.00; Market Cap 3.3B; P/E Ratio 53.02; Div Yield 0.03%; Today's High $138.88; Today's Low $134.63; 52 Week High $152.89; 52 Week Low $47.32; Previous Close $134.29; Volume 109M; Avg. Volume (10 Day) 176M.
  - Bottom-pinned gray footer band, small centered text: "Option quotes report the previous day's close. Updated 1 minute ago."

## Controls inventory
- Back chevron ("<"), top-left of every screen — returns to prior screen.
- "Edit" text link, top-right of register header (iphone-02) — apparent action not shown beyond the label.
- Circled-"i" info icon beside "TODAY'S BALANCE" (iphone-02) — apparent tooltip/explainer trigger.
- 3-dot page indicator under the balance card (iphone-02) — swipe/carousel control between balance-card views.
- Search field "Search Transactions" with leading magnifying-glass icon (iphone-02).
- Clock/history icon, right of search field (iphone-02) — likely recent-searches or scheduled/recurring shortcut.
- Filter/sliders icon, right of search field (iphone-02, and reused as a header-right icon on both report screens iphone-04/05/06) — opens filter options.
- Tappable blue text "since 2022" inside the "Showing transactions since 2022" banner (iphone-02) — apparent date-scope control.
- Floating circular "+" button overlapping the register list (iphone-02) — add transaction.
- Month-stepper "<" / ">" arrows flanking "Nov 2024" / "Dec 2024" (iphone-03, iphone-07).
- Blue, underlined "$X out of $Y" text within each budget row (iphone-03, iphone-07) — visually styled as a link/tappable target (edit or drill into the amount), exact action not confirmed.
- Trailing chevron ">" on parent budget categories (Bills & Utilities, Food & Dining, Home, Kids in iphone-03; same in iphone-07) — drill-down into subcategory detail.
- Horizontal pill/segmented-control row for time range: "Last 30 Days," "This Month," "Last Month," "Last 3 Months," "Last 6 Months," "Month to Date," "Year to Date," "Custom" (iphone-04, iphone-05, iphone-06) — single-select, active pill shown filled solid blue with white text, inactive pills light-gray fill with dark text.
- "SORT" control with a sort-lines icon, right-aligned above each report's list (iphone-04, iphone-05, iphone-06).
- Horizontally scrollable row of per-payee stat cards (iphone-05, iphone-06) — swipe control, no visible page indicator.
- Colored legend dot preceding each list row in "Spending By Payee" (iphone-05, iphone-06) — ties row to a donut-chart segment; also present as a small blue dot preceding each register transaction (iphone-02) though its meaning there is not confirmed.
- Badges: green filled "↑ +$1.72 | +1.28%" pill on the NVDA detail screen (iphone-08) — status badge combining direction icon, absolute, and percent change.
- Red progress bar (full width, "Health & Fitness" row, iphone-03) functions as an implicit over-budget badge/status, paired with the explicit text "$143 Over".

## Flow steps
N/A — each image is an independent, already-navigated-to destination screen; no multi-step sequence (e.g., an add-transaction or edit-budget flow) is captured across this unit's 8 images.

## States
- Empty/zero-progress budget categories rendered with fully gray (unfilled) progress bar and "$0 out of $X" plus "$X Left" — e.g. "Cash & ATM: $0 out of $120 / $120 Left" (iphone-03, iphone-07). No distinct "empty state" copy beyond the $0 figure itself; no illustration or placeholder message shown.
- Over-budget state: bar fill turns fully red and the trailing label switches from "Left" to "Over" — "Health & Fitness: $243 out of $100 / $143 Over" (iphone-03). This is the only non-nominal/error-adjacent state directly evidenced in this unit.
- No loading, error, or true empty-state (zero-data) screens are present among the 8 images — all screens show populated data.
- Data-freshness disclosure state on the investment detail screen: "Option quotes report the previous day's close. Updated 1 minute ago." (iphone-08) — a persistent caveat rather than a transient state, but it is the only place in this unit where the UI directly qualifies how current a figure is.

## Business rules implied
- The account register explicitly states the visible transaction window is scoped and communicates that scope in-line: "Showing transactions since 2022" with "since 2022" as an editable/tappable element (iphone-02) — implies transactions before a cutoff exist but are not shown by default and the cutoff is user-adjustable.
- A running balance is carried on every transaction row, immediately under that transaction's own signed amount (iphone-02) — implies balance is computed and displayed per-line, not only at the account-summary level.
- Budget categories can have one more level of hierarchy either via drill-down chevron (Bills & Utilities, Food & Dining, Home, Kids) or via inline colon notation on a single leaf-looking row ("Auto & Transport:Gas & Fuel") — two different hierarchy affordances coexist in the same list (iphone-03, iphone-07).
- Exceeding a category's budget changes both the progress-bar color (to full red) and the trailing label text (from "$Z Left" to "$Z Over") — a paired visual+textual signal for the same threshold-crossing event (iphone-03, "Health & Fitness").
- Per-payee spend rollups can further split by which underlying account/card was used, since the same merchant type appears as multiple rows differentiated only by a trailing masked account suffix — e.g. "Sports Basement Berkeley - 9136" vs "Sports Basement U107 - 6998" (iphone-06).
- The "Spending By Payee" donut always reserves its largest, distinctly colored ("brown/tan") segment for an aggregated "Other Payees" bucket rather than exhaustively coloring every individual payee (iphone-05, iphone-06).
- Reports summarize with a rounded whole-dollar figure inside a visual (donut/chart-adjacent) callout while the itemized/report totals elsewhere carry full cent precision — e.g., "$22,945" (donut center, iphone-06) vs "$22,945.43" (Dec 2024 row total, iphone-04) — implying the app treats headline/decorative totals and ledger-precision totals as different display classes even when they reference the same underlying figure.
- Time-range selection is scoped per-report (a pill row local to that screen) rather than a single global date filter shared across register/budget/reports — the register uses a distinct "since [year]" scope banner while the reports use the pill row (iphone-02 vs iphone-04/05/06).

## Standout details
- The donut chart's center callout doubles as the report's headline metric ("$7,996 / Total spending / Last Month"), so the chart itself needs no separate legend — segment colors are simply reused as the leading dot on each corresponding list row below it (iphone-05, iphone-06).
- A horizontally scrollable rail of single-payee/single-category "Total for X" stat cards sits between the chart and the full list, giving a swipeable, at-a-glance middle tier of detail between the aggregate total and the exhaustive list (iphone-05, iphone-06) — a three-tier progressive-disclosure structure (headline total → scrollable highlights → full sortable list).
- The over-budget state is communicated redundantly through three channels at once — bar fill switches fully red, the numeric label swaps word from "Left" to "Over," and the "Over" text itself likely inherits the red color treatment — reinforcing the same signal without relying on color alone (iphone-03).
- The investment detail screen pins a data-provenance/freshness disclaimer ("Option quotes report the previous day's close. Updated 1 minute ago.") in a dedicated footer band separated from the stat table, rather than mixing it into the table rows (iphone-08).
- The register's scope banner turns a system fact ("data starts in 2022") into an inline, tappable micro-affordance ("since 2022" as a link) rather than a static disclosure, hinting at adjustable history depth without leaving the register (iphone-02).
- Budget category "$X out of $Y" text is rendered as blue/underlined link-styled text even though it looks like read-only progress data, suggesting tap-to-edit or tap-to-drill is available directly on the number rather than requiring a separate edit button (iphone-03, iphone-07).

## Open questions
- The meaning of the small blue dot preceding each transaction row in the register (iphone-02) is not settled by the evidence — it could indicate cleared/reconciled status, a bullet-style list marker, or something else; no legend or tap-state is shown.
- File `iphone-01` is an app-icon/logo asset, not a screen, and contributes no IA/layout/control evidence.
- Four of the eight files in this "iphone" unit (`iphone-03`, `iphone-04`, `iphone-06`, `iphone-08`) are iPad-dimensioned captures (2048×2732, matching the QC iPad naming convention) rather than iPhone captures; whether this is a manifest grouping artifact or intentional cross-device inclusion is not resolved by the evidence, and it means budget/report/investment-detail density claims above may not hold at true iPhone width (see iphone-03 vs iphone-07 for the one pair where both sizes of the same screen type exist).
- The exact behavior of the "SORT" control (opens a menu vs. toggles ascending/descending vs. cycles fields) is not shown.
- Whether the single unlabeled purple dot below the donut chart (iphone-05, iphone-06) is a selection indicator, a legend key for "Other," or decorative is not resolved.
- What the circled-"i" info icon next to "TODAY'S BALANCE" reveals when tapped (iphone-02) is not shown.
- No top-level navigation shell (tab bar, hub/list screens for accounts, budgets, reports, or holdings) appears anywhere in this unit, so this record cannot speak to how these destinations are reached or what else lives alongside them in the IA.
- Whether the blue/underlined "$X out of $Y" budget text opens an edit-budget dialog, a transaction drill-down, or both is not confirmed.
