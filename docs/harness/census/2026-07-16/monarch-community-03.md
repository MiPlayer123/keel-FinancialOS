# Census — monarch-community-03

## Evidence
- `design/references/monarch/community-x02-investments-performance-holdings-web.jpg` → Web "Investments" surface, "Performance" tab active, showing benchmark comparison cards, a portfolio-vs-index line chart, and the top of a "Holdings" table (cut off after the "ETF" group header, no data rows visible).
- `design/references/monarch/community-x03-investments-holdings-benchmark-web.jpg` → Web "Investments" surface, "Holdings" tab active, showing benchmark comparison cards, a portfolio-vs-index line chart with a third "Holding not included" series, and a populated "Holdings" table with two mutual-fund rows.
- `design/references/monarch/community-x04-recurring-calendar-web-and-mobile.jpg` → Composite image: web "Recurring" calendar (July 2022) with an open transaction-history popover, overlaid with a mobile "Recurring" screen (mini calendar + upcoming list) in the foreground.
- `design/references/monarch/community-x05-recurring-calendar-upcoming-list-web.jpg` → Web "Recurring" calendar (March 2023), no popover open, with the "Upcoming" list table visible below the calendar.

## Information architecture
- Left sidebar nav (consistent across both Investments screenshots, and both Recurring screenshots) reads, top to bottom: Dashboard, Accounts, Transactions, Cash Flow, Plan, [Recurring — only present in x03/x04/x05], Goals, Investments, [Advice — only present in x03/x04/x05]. The x02 screenshot's sidebar stops at Investments and omits both "Recurring" and "Advice", and its top bar lacks the search/bell icons that x03/x04/x05 show next to the "Monarch"/logo mark — evidence these two are different app versions/eras, not the same build.
- "Investments" is a top-level nav item, not nested under Accounts or Cash Flow. It has its own sub-tabs: x02 shows "Performance" (active) and "Allocation"; x03 shows "Holdings" (active) and "Type" — i.e., the sub-tab set itself differs between the two Investments screenshots (another version signal).
- "Recurring" is a top-level nav item (in the newer variant), not nested under Cash Flow or Transactions. It has sub-tabs "Upcoming" (active in both x04 and x05) and "All merchants".
- Within Recurring, drilling into a specific calendar day's chip opens an in-place popover (not a new screen) showing that merchant's cadence, next amount, and last 3 matched transactions, with a link to the full transaction list — one click from the calendar to transaction history for that merchant.
- The "Upcoming" list beneath the calendar is a flat table of the same recurring items shown on the calendar, re-rendered as rows (Due Date / Category / Account / Amount) — the calendar and the list are two views of one dataset, not separate features.
- Mobile "Recurring" (x04 foreground) mirrors the web IA: same "Upcoming" / "All merchants" segmented control, same mini-calendar + list-below pattern, condensed to a single column.
- Account context lives in a global-looking "All accounts" dropdown in the Investments top bar (x02, x03), suggesting portfolio performance can be scoped to a subset of accounts from the same screen (dropdown itself not opened in evidence, so scoping options are not shown).

## Layout & content
### Investments — Performance (x02)
- Top bar: page title "Investments", tab row ("Performance" active with red underline, "Allocation" inactive/gray), then right-aligned controls: "All accounts" dropdown, a date-range field showing two dates ("11/26/2020" — "2/24/2021"), and a "90 days" dropdown.
- Four comparison cards in a row, each with a colored top border strip: "Your Portfolio" (dark navy strip, plus a small gear/settings icon top-right of the card), "S&P 500" (light-blue strip), "NASDAQ" (no colored strip, grayed-out text), "US Stocks" (no colored strip, grayed-out text). Each card shows two labeled figures side by side: "90-DAY" and "1-DAY", each a percentage.
  - Your Portfolio: 90-DAY 10.01%, 1-DAY 0.75%
  - S&P 500: 90-DAY 4.99%, 1-DAY 0.62%
  - NASDAQ: 90-DAY 4.45%, 1-DAY 0.48% (grayed — not currently plotted)
  - US Stocks: 90-DAY 4.45%, 1-DAY 0.48% (grayed — identical figures to NASDAQ card, suggesting these unselected benchmark cards may not yet reflect a distinct computed value, or the two benchmarks happened to be equal in this fixture)
  - No plus/minus sign or color (red/green) applied to these percentage figures despite being gain figures — all rendered in the same dark navy/gray text regardless of sign.
- Below the cards: a line chart with legend "● Your Portfolio" (navy dot) and "● S&P 500" (light-blue dot). Y-axis labeled -10% to 10% in 5-point increments; x-axis labeled with four dates (Nov 26, Dec 26, Jan 26, Feb 24) spanning the ~90-day window. A download icon sits top-right of the chart card.
- "Holdings" section header below the chart, then a table with column headers: Symbol, Quantity, Cost Basis, Current Price, Total Value, Daily Change, Total Gain / Loss. Only a group header row "ETF" is visible before the image is cut off — no actual holding rows are legible in this image.

### Investments — Holdings (x03)
- Top bar: hamburger icon, "Investments" title, tabs "Holdings" (active) / "Type"; right-aligned a segmented time-range control "1W 1M 3M(active) 6M YTD 1Y 5Y" plus an "All accounts" dropdown.
- Four comparison cards, same two-metric pattern but different labels than x02: "PAST 92 DAYS" and "TODAY" (vs. x02's "90-DAY"/"1-DAY" — inconsistent labeling for what is presumably the same concept, another cross-screenshot version difference).
  - Your Portfolio (red/orange top strip, no gear icon visible here): PAST 92 DAYS 0.04%, TODAY -0.50%
  - S&P 500 (light-blue strip): PAST 92 DAYS 0.46%, TODAY 0.31%
  - US Stocks (grayed): PAST 92 DAYS 0.97%, TODAY 0.36%
  - US Bonds (grayed): PAST 92 DAYS -0.57%, TODAY 0.20%
  - Again, negative figures (-0.50%, -0.57%) are not color-coded red — same text color as positive figures on these summary cards.
- Chart legend has three entries here (one more than x02): "● Your Portfolio" (red/orange), "● S&P 500" (light blue), "○ Holding not included" (pale/hollow dot) — implying some holdings can be excluded from the performance calculation and the chart flags this explicitly in the legend. Y-axis -6% to 6%; x-axis a denser set of dates (Nov 28 through Feb 27, roughly weekly ticks). Download icon top-right of chart.
- "Holdings ⓘ" section header (info icon suggests a tooltip/definition on hover, not shown open) with, top-right of the section, a "Type" filter dropdown and an orange "Add Holding" button.
- Table columns: Security, Price, Quantity, Past 92 days, Value. Rows are grouped under a bold sub-header "Mutual Fund":
  - Row 1: gray circular icon placeholder, "VTSAX" (bold) / "Vanguard Total Stock Market Index Fund Admiral Shares" (gray subtext) — Price $97.14, Quantity 1,271, Past-92-days badge "↗ 0.67%" in a green pill, Value $123,464.94, trailing ">" chevron (row is clickable/drills into holding detail).
  - Row 2: "VBTLX" / "Vanguard Total Bond Market Index Fund Admiral Shares" — Price $9.47, Quantity 3,160, Past-92-days badge "↘ -0.73%" in a red pill, Value $29,925.20, trailing ">" chevron.
  - This is the one place in these four images where gain/loss sign is color- and icon-coded (green up-arrow pill vs. red down-arrow pill) — contrast with the uncolored percentage figures on the summary cards above.
- Left sidebar footer (only visible in x03/x04/x05, not x02): a promo ribbon "Get 1 Month Free", then "Help & Support", then user account row "Jane Smith" with a dropdown chevron.

### Recurring calendar (x04, x05)
- Top bar: "Recurring" title, tabs "Upcoming" (active, red underline) / "All merchants"; right side "View options" dropdown and a solid orange/red "+ Add recurring" button.
- Calendar block: month/year header ("July 2022" in x04, "March 2023" in x05), a "Today" button, and left/right chevron arrows for month navigation. Standard 7-column Sunday–Saturday grid, numbered day cells.
- Recurring items render as small colored "chip" rows stacked inside their due-date cell, each chip showing (checkmark icon, if present) merchant name, and a right-aligned dollar amount. Multiple chips stack vertically in cells with more than one occurrence that day (e.g., x05 Mar 3: Netflix $17.99 and Disney+ $7.99 stacked; Mar 13: State Farm, University of Ill..., and IBM stacked three deep).
- Long merchant names truncate with an ellipsis inside the chip (e.g., "Pampered Pet...", "University of Ill...", "Gardening Se...").
- "Today" is marked on the calendar with a solid red/orange circular badge over the date number itself (x04: "21"; x05: "13") — distinct from the chip styling.
- Below the calendar: a section header — "This month" in x04, "∨ Upcoming" (with a collapse/expand chevron, currently expanded) in x05 — over a table with columns Merchant / Due Date / Category / Account / Amount (x04 header shows "Merchant, Due Date, Category, Account, Amount"; x05's visible columns are Due Date, Category, Account, Amount, with merchant folded into the leading icon+name cell).
  - x04 row: Verizon icon, "Verizon" / "Monthly" cadence subtext, Due Date "Jul 1", Category "📱 Phone", Account "🔵 Joint Credit Card", Amount "$140.00" with a green checkmark badge, trailing "..." overflow-menu control.
  - x05 rows: Home Depot icon, "Home Depot" / "Every 2 weeks", Due Date "Mar 14", Category "🔨 Home Improvement", Account "🔵 Joint Credit Card", Amount "-$150.00", "..." menu. Unicef icon, "Unicef" / "Every month", Due Date "Mar 26", Category "💛 Charity", Account "🔵 Melanie's Checking", Amount "$50.00", "..." menu. IBM row cut off at image bottom (Due Date "Mar 27", Category "💳 Paychecks", Account "Melanie's Checking" visible; amount not fully legible).
- Money formatting throughout: all dollar amounts show two decimal places and a "$" prefix; negative/outflow amounts are prefixed with "-" (e.g., "-$150.00", "-$108.00", "-$90.91") rather than parenthesized; inflow amounts are prefixed with "+" (e.g., "+$2,000.00", "+$2,200.00"). No red/green text color is applied to these calendar-chip or list amounts based on sign — sign is conveyed only by the +/- character, unlike the Holdings table's colored pills.
- Density: each calendar cell can hold at least 2–3 stacked chips before the image runs out of visible room; the month grid always shows 5–6 full weeks. The "Upcoming" list below shows one row per line with no visible row-height compression (comfortable/roomy row height, generous icon + two-line merchant/cadence text per row).

### Mobile Recurring (x04 foreground phone mockup)
- Status bar reads "1:25" with signal/wifi/battery glyphs.
- Header: back arrow, "Recurring" title, a filter/sliders icon, and a "+" add icon.
- Segmented control: "UPCOMING" (filled/active pill) / "ALL MERCHANTS" (unfilled).
- "This month" header row with left/right chevrons for month paging.
- A compact mini-calendar (Mon–Sun columns, dates 1–31) with small colored dots under certain dates rather than full chips — implying the mobile calendar is a density-reduced summary view (dot = "something occurs this day") that must be paired with the list below for details. Today's date number (21) is rendered in orange/red text rather than a filled badge.
- Below the mini-calendar: a "This month" list header, then rows: "Verizon" (black circular icon with red checkmark glyph), "Monthly" cadence, green checkmark badge, "$140.00", "Jul 1"; "IBM", "Monthly", green checkmark badge, "+$2,000.00", "Jul 6" (row cut off at the bottom of the visible phone frame).

## Controls inventory
- Investments top bar: "All accounts" dropdown (scope filter, not opened in evidence); date-range text field (x02, showing two explicit dates); "90 days" dropdown (x02, a preset-range picker); segmented range buttons "1W 1M 3M 6M YTD 1Y 5Y" (x03, preset chart windows, 3M shown active); tab links "Performance"/"Allocation" (x02) and "Holdings"/"Type" (x03).
- Investments comparison cards: a small gear/settings icon on the "Your Portfolio" card (x02 only) — likely opens portfolio-composition or benchmark settings, not opened in evidence.
- Chart: a download icon top-right of the chart plot area in both x02 and x03 — apparent "export chart" action.
- Holdings table (x03): "Type" filter dropdown and "Add Holding" button (primary, orange) above the table; each holding row ends in a ">" chevron implying it is clickable to a holding-detail view; the "Holdings ⓘ" info icon suggests a hover tooltip.
- Recurring top bar: "View options" dropdown (display/sort settings for the calendar or list, not opened) and "+ Add recurring" primary button (orange).
- Recurring calendar: "Today" button (jump-to-current-month), left/right chevron arrows (prev/next month navigation).
- Recurring day-chip popover (x04): opens on clicking/hovering a chip; contains a "View all 12 transactions" link (drills into full transaction history for that merchant) and no visible close/dismiss control (dismiss mechanism not shown — likely click-away).
- Upcoming list rows: trailing "..." overflow-menu icon per row (x04, x05) — implies per-row actions (edit, skip, mark paid, etc.) exist but are not enumerated since the menu was never opened in evidence.
- Recurring list header (x05): "∨" chevron on "Upcoming" — a collapse/expand toggle for the list section.
- Mobile Recurring: filter/sliders icon and "+" icon in the header (add/filter recurring items); segmented "UPCOMING"/"ALL MERCHANTS" toggle; month-paging chevrons.
- Badges with meaning: green checkmark circle badge on list rows and calendar chips = matched/confirmed transaction; calendar chips without a checkmark and without colored background (e.g., "Home Depot -$150.00" on future dates in x05, "Unicef $50.00", "Netflix $17.99" in x04's July 11 cell) = projected/unconfirmed future occurrence — this is a status distinction encoded purely by chip styling, not by an explicit text label.

## Flow steps
1. User is on Investments → Performance/Holdings tab, viewing benchmark cards and chart (x02, x03) → user can switch tabs to "Allocation"/"Type" (destination screens not captured in this unit's evidence).
2. User clicks a chart-adjacent "Add Holding" button (x03) → presumed opens an add-holding flow (not captured — no resulting screen in evidence).
3. User is on Recurring → Upcoming calendar (x04) → clicks/hovers the "Comcast $115.00" chip on Jul 20 → sees a popover with merchant identity, cadence ("Monthly"), current amount, a "RECENT TRANSACTIONS" list of the 3 most recent matched charges (each dated, each with a small globe icon and amount) → can click "View all 12 transactions" to presumably navigate to the full transaction list filtered to that merchant (destination not captured).
4. No explicit confirmation dialogs, undo affordances, or multi-step wizards are visible in any of the four images — all four are single-screen snapshots (one with an overlaid popover).

## States
- No empty, loading, or error states are visible in any of the four images — all four show fully populated data. No literal empty-state, error, or loading copy is present anywhere in this unit's evidence.
- Implicit "unconfirmed/projected" state on Recurring calendar chips: rendered as plain text with no green checkmark and no colored chip background (e.g., x05 "Home Depot -$150.00" on Mar 14/28, "Unicef $50.00" on Mar 26, "University of Illin... +$2,200.00" and "IBM +$2,000.00" on Mar 27; x04 "Netflix $17.99" on Jul 11) — contrasted with confirmed occurrences that carry a green checkmark and a colored (green, or amber for at least one case — "ComEd -$108.00" on Mar 10) chip background.
- Implicit "excluded from performance calc" state on the x03 chart legend: "○ Holding not included" — a named state for holdings that exist in the portfolio but are deliberately left out of the performance line, though no example of such an excluded holding is visibly plotted/labeled on the chart itself in this image.
- Grayed-out (desaturated text, no colored top strip) state on non-primary benchmark cards (NASDAQ/US Stocks in x02; US Stocks/US Bonds in x03) — visually demoted relative to the two benchmarks actively plotted on the chart (Your Portfolio, S&P 500).

## Business rules implied
- A portfolio's performance is always shown against at least one benchmark (S&P 500) with matched time windows, and additional benchmarks (NASDAQ, US Stocks, US Bonds) are available but not simultaneously plotted by default — evidenced by the grayed, no-colored-strip treatment of the extra cards in both x02 and x03.
- Holdings can be individually flagged as excluded from the performance comparison ("Holding not included") — the chart legend in x03 names this as a first-class state, implying a per-holding include/exclude toggle exists somewhere in the product (not shown).
- Holdings are grouped by security type in the table (a bold "Mutual Fund" group header precedes VTSAX/VBTLX in x03; an "ETF" group header is visible at the cut-off of x02's Holdings table) — the Holdings table is organized as a grouped, not flat, list.
- Recurring items are tracked with a matched/confirmed vs. projected distinction at the individual-occurrence level, not just at the series level — the same merchant (e.g., "IBM +$2,000.00", "University of Illin... +$2,200.00") shows a checkmarked/colored chip for a past date and a plain/unchecked chip for a future date within the same month (x05, Mar 13 vs Mar 27), meaning confirmation status is computed per-occurrence against actual bank activity.
- Recurring items carry a cadence label distinct from the due date ("Monthly", "Every 2 weeks", per-row subtext in the Upcoming list) — cadence is stored/displayed independently of any single instance's date.
- Recurring items are categorized (Phone, Home Improvement, Charity, Paychecks, in the Upcoming list's Category column) and tied to a specific account (Joint Credit Card, Melanie's Checking) — implying recurring detection/definition includes both a category and an account scope per series.
- A merchant's popover on the calendar (x04) surfaces only its "recent" transactions (3 shown) with a link to the full set ("View all 12 transactions") — implying the underlying data model retains full transaction history per recurring series, with the calendar UI intentionally showing a truncated recent window.
- Amount sign (+/-) is treated as sufficient encoding for inflow vs. outflow throughout Recurring surfaces — no red/green text coloring is applied there, whereas the Holdings table does apply red/green coloring to gain/loss — implying different money-display conventions are used for "recurring cash flow amounts" vs. "investment performance deltas" within the same product.

## Standout details
- The chart legend explicitly naming a "Holding not included" state (x03) is a nice piece of transparency — it tells the user their performance number is scoped and why a chart line might not include everything, directly surfacing scope/exclusion at the point of the number (relevant to KEEL's "reproducible numbers" invariant).
- The recurring-item popover (x04) is a lightweight in-place drill-down (hover/click a calendar chip → see cadence, latest amount, last 3 charges, and a link to full history) rather than forcing navigation away from the calendar — preserves context while still offering a path to full detail.
- Truncating long merchant names with an ellipsis inside fixed-width calendar chips ("Pampered Pet...", "University of Ill...") keeps the calendar grid uncluttered at the cost of full legibility — a deliberate density trade-off worth noting for KEEL's own calendar-density decisions.
- The Upcoming list's "..." overflow menu on every row (unopened in evidence) suggests per-occurrence actions (e.g., skip, mark paid, edit) are kept out of the primary row to avoid clutter, consistent with progressive disclosure.
- Iconography-with-meaning: category-specific glyphs in the Upcoming list (📱 phone for Verizon, 🔨 wrench for Home Improvement, 💛 heart for Charity, 💳 card for Paychecks) and a small globe icon prefixing each transaction-history line item in the popover (possibly indicating "seen via bank feed"/online origin) — small but consistent iconographic vocabulary.
- Today's date is marked two different ways across the two calendar screenshots examined: a filled red/orange circular badge directly over the date number (both x04 desktop calendar and x05), versus plain orange/red text-only treatment on the mobile mini-calendar (x04) — a deliberate density reduction for the smaller mobile calendar surface.

## Open questions
- Whether x02 and x03 represent two different historical versions of Monarch's Investments UI (different tab sets — Performance/Allocation vs. Holdings/Type; different metric-window labels — 90-DAY/1-DAY vs. PAST 92 DAYS/TODAY; different card top-strip colors for "Your Portfolio" — navy vs. red/orange; different sidebar nav — x02 omits Recurring and Advice) or whether these tabs coexist simultaneously in one version's Investments area and I'm only seeing two of several tabs. Evidence does not settle this.
- What the "Type" filter dropdown next to "Add Holding" (x03) actually filters by, and what options it exposes — not opened in evidence.
- What "Add Holding" leads to (manual entry form vs. institution linking) — not captured.
- What the gear/settings icon on the "Your Portfolio" card (x02) opens — not captured.
- Why the NASDAQ and US Stocks cards in x02 show identical values (4.45%/0.48%) — could be coincidental fixture data, a display bug, or intentional (e.g., "US Stocks" defined as tracking NASDAQ in this fixture); cannot be determined from a single static image.
- What criteria mark a recurring occurrence as "confirmed" (green chip + checkmark) versus "projected" (plain chip, no checkmark) — presumably a bank-transaction match, but the matching logic itself is not evidenced.
- What determines the distinct amber/yellow chip color used for "ComEd -$108.00" in x05 (Mar 10) when other confirmed items in the same calendar are green — could denote a different status (e.g., "due today", "amount varies", "utility/variable bill") or could simply be a category color; not resolved by the evidence. Similarly, the pink/salmon-toned "Verizon $140.00" chip on Jul 1 in x04 differs in color from the green chips elsewhere in the same calendar, and the reason for that variation is not evidenced.
- Whether the "Holding not included" legend entry in x03 corresponds to any holding visibly plotted in that specific chart image — no faded/hollow line segment could be confidently identified as distinct from the two other series at the resolution provided.
- Full column/row detail for the x02 Holdings table is unknown — the image is cut off immediately after the "ETF" group header, before any actual holding rows appear, so cost-basis/current-price formatting conventions for that table variant are not observed.
- The exact dismiss mechanism for the transaction-history popover (x04) — no close button is visible in the popover; whether it closes on click-away, on a second click, or via some other control is not shown.
