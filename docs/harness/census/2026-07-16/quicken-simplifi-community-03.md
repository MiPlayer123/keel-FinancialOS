# Census — quicken-simplifi-community-03

## Evidence
- `design/references/quicken-simplifi/community-x08-bills-income-cashflow-tab.png` → Simplifi "Bills & Income" page, "Cash Flow" tab active: projected balance/cash-flow timeline chart, an open date-range dropdown, an account-filter panel ("Select Accounts"), and the top of a "Reminders" list below the fold.
- `design/references/quicken-simplifi/community-x09-bills-income-reminder-series-detail.png` → A reminder-series detail modal ("Farmers Insurance", recurring monthly) opened on top of the "Bills & Income → Overview" tab, showing a per-month amount-history bar chart, a "Coming Up" single next-charge card, a "History" list of past charges, and a "Connect biller" upsell banner. The dimmed background reveals the Overview tab's Summary card, Reminders list, and a mini calendar.

## Information architecture
- Top-level page title "Bills & Income" sits above a horizontal tab bar with three tabs: "Overview", "Cash Flow", "All Recurring". In image 1, "Cash Flow" is the active tab (purple text, underlined). In image 2 (background), "Overview" is active.
- Global left rail is a narrow icon-only column (dark), present unchanged behind both screens — same set of ~13 stacked icons plus a bottom-pinned group of ~6 icons (settings/profile-like) below a divider. No labels are legible; this is icon-only chrome, consistent across the app's sections, implying Bills & Income is one destination among several reached from this rail.
- Within "Cash Flow": one click away is the date-range selector (dropdown), an "Add" action (top right, presumably to add a new bill/income reminder), an account-scoping panel ("Select Accounts"), and a "Reminders" module beneath the chart.
- Within "Overview" (seen dimmed behind the modal): a "Summary" card (Income/Expenses/Net for the selected range), a "Reminders" list, and a mini calendar widget with dot indicators on days that have reminders — this calendar is co-located with Reminders, implying date-based cross-reference between list and calendar views.
- Clicking a Reminders list row (e.g., "Farmers Insurance") opens the reminder-series detail as a modal/overlay rather than navigating to a new page — the Overview tab remains visible, dimmed, behind it.
- Inside the reminder detail modal: a "Coming Up" section (next single occurrence) and a "History" section (past occurrences) are both one scroll away in the same modal — no separate drill-down screens shown for history.
- An "Options" link inside the modal header suggests further reminder-management actions (edit/delete/skip) live one click deeper, but the resulting menu is not shown in the evidence.

## Layout & content
### Cash Flow tab (image 1)
- Header row: page title "Bills & Income" (left), no visible right-aligned controls at that level.
- Tab bar directly under header.
- Control row: date-range dropdown button "Next 1 month" (with caret, open state shown) to the left of a static text range "Jan 31, 2025 - Feb 28, 2025"; far right, a purple pill button "+ Add".
- Open dropdown list (below the "Next 1 month" button) offers: "Next 2 weeks", "Next 1 month" (highlighted as current selection), "Next 2 months", "Next 3 months", "Next 6 months", "Next 12 months".
- Main chart area (left ~80% width): a line/area cash-flow chart.
  - Y-axis labeled in whole dollars: "$200,000" (partially clipped at top), "$100,000", "$0", "-$100,000" — no cents, comma thousands separator, no currency symbol repeated per gridline label prefix beyond the "$".
  - X-axis labeled by date, every 2 days: "Jan 25, Jan 27, Jan 29, Jan 31, Feb 2, Feb 4, ... Mar 2".
  - A solid vertical line crosses the chart at "Jan 31" — presumably marking "today"/current date boundary between actual and projected.
  - Two dashed horizontal reference lines run across the plot area (one near the top, one lower, colors white-ish and purple respectively) — likely projected ending balances for two different scenarios or account groups; no legend visible to confirm which.
  - A dotted line runs along the very bottom of the plot near $0, threaded through a sequence of colored circular markers (blue, yellow-green, purple/teal "$"-labeled) at points like Feb 2, Feb 6, Feb 8, Feb 12, Feb 14, Feb 16, Feb 20, Feb 22, Feb 26, Feb 28, Mar 2 — these appear to be individual projected bill/income events plotted on the timeline, color-coded (matching the account-color chips in the right panel), with a "$" glyph marker style distinguishing at least one series (likely income/paycheck events) from plain dots (likely bills).
- Right panel: "Select Accounts" header with a vertical scrollbar (list is longer than viewport). Grouped, indented, checkbox-style list:
  - Group "Cash & Checking" (collapsible, chevron shown, expanded) — colored square/checkmark chips, all checked: "BOA Checking" (green), "Joint Checking" (blue), "P and R Collectables Checking" (green).
  - Group "Credit" (collapsible, expanded) — all checked: "Ally Credit Card" (orange/red), "Amazon Credit Card" (yellow), "BOA MasterCard" (yellow), "Travel Rewards Visa" (blue).
  - Group "Savings" (collapsible, chevron shown, list cut off) with one partially visible item "Long Term Savings" (red) at the very bottom edge, unchecked-appearing icon cut off — ambiguous state due to clipping.
  - Each account row has a colored square checkbox with a checkmark glyph — the color appears tied to that account's chart-series color (used again as the dot colors in the chart above it).
- Below the chart+panel row, a full-width "Reminders" card begins:
  - Header "Reminders" (bold) on the left; "By Due date" dropdown/sort control on the right (with caret), implying alternate sort option(s) not shown.
  - Sub-label "NEXT" in small caps/letter-spaced style, marking the start of the upcoming-items group.
  - First row: circular avatar with letter "R" (green fill), primary text "Rebecca's Paycheck", secondary text "today" (relative date), right-aligned account name "Joint Checking" with secondary label "Checking" beneath it, and far right a money figure "+$1,550.85" in green with a leading "+" — the "+" and green color together mark it explicitly as incoming money (income), distinguishing it from bill/expense rows. A kebab ("...") menu is at the very right edge, partially cropped.

### Reminder series detail modal (image 2)
- Modal header: square avatar "F" (purple), title "Farmers Insurance" (bold, large), subtitle directly under it "Every month" (recurrence cadence, plain text, no icon). Top-right of header: "Options" (purple link text) and an "X" close icon.
- Dismissable banner below header: bold "Connect biller", body copy "We'll keep Simplifi updated with your most recent bill information.", a pill button "Connect" (with a link/chain icon), and a small "X" dismiss control at the banner's top-right corner (separate from the modal's own close X).
- Bar chart section:
  - Label "Average" with the computed value "$24" directly under it, and a horizontal orange/red reference line drawn across the chart at that average height.
  - Six monthly bars, left to right: AUG "$24", SEP "$0" (no bar / zero-height), OCT "$48", NOV "$0", DEC "$48", JAN "$24" — each bar has its dollar total printed above it and the month abbreviation below the axis.
  - Caption beneath the chart: "Total in Last 6 months : $145" (colon preceded by a space — an exact-copy detail).
- "Coming Up" section: header, then one card:
  - Avatar "F", amount "$21.97" (bold, larger type, no explicit sign/color — neutral/white, unlike the green "+$1,550.85" seen in image 1, implying outgoing/bill amounts are NOT colored red by default here, only incoming ones get "+"/green treatment), account label "Joint Checking" beneath the amount, right-aligned date text "on Mar 1", and a kebab (⋮) menu at the far right.
- "History" section: header, then a reverse-chronological list of past charges, each row showing amount and account on the left, relative-or-absolute date on the right:
  - "$24.22 / Joint Checking" — "today"
  - "$24.22 / Joint Checking" — "on Dec 31 2024"
  - "$24.22 / Joint Checking" — "on Dec 2 2024"
  - "$24.22 / [Joint Checking, partly occluded by dimmed background]" — "on Oct 30 2024" (row is cut off at the modal's bottom scroll edge)
  - Date format is inconsistent by design: relative word "today" for the current occurrence, "on <Mon> <D> <YYYY>" for older ones.
  - Note the discrepancy between the bar chart (Oct = $48, Jan = $24, average $24) and the History list ($24.22 appearing repeatedly for Dec 31, Dec 2, Oct 30) — the two data sources do not obviously reconcile from the visible text alone (see Open questions).
- Dimmed background (Overview tab), partially legible:
  - Control row: "Next 30 Days" dropdown, static range "Jan 30, 2025 - Mar 1, 2025".
  - "Summary" card with an (i) info icon next to the header "Summary", three stacked labeled figures: "Income" "+$7,923.34" (green, signed), "Expenses" "$832.37" (plain/white, unsigned), "Net" "$7,090.97" (plain/white). Note asymmetry: only Income gets a "+" and green; Expenses and Net are unsigned plain text even though Expenses is presumably a subtraction.
  - "Reminders" list (same component pattern as image 1's list) with rows: "Farmers Insurance"/"today", "Rebecca's Paycheck"/"tomorrow", "Rent"/"In 3 days", "HBO Max"/"In 6 days", "Ymca"/"on Feb 6", "Paco's Paycheck"/"on Feb 7" — relative-day phrasing ("today", "tomorrow", "In N days") is used for near-term items, switching to an absolute "on <Mon> <D>" format for items more than ~6 days out. One row shows a value "+$1,640.00" and "Checking" partly visible at the very bottom edge (cut off by viewport).
  - A dark mini-calendar (month grid, days Jan 30 – Feb 1 row shown, then full weeks) in the top-right area with a "Today" button and "‹ ›" prev/next arrows above it; small dot indicators appear under specific day numbers (e.g., 3, 10, 17, 18, 24, 25) denoting reminder-bearing days; day "30" is visually highlighted/outlined (current day cursor).
- Both screens share a floating circular chat-bubble icon fixed at the bottom-right corner of the viewport (presumably an in-app assistant/support launcher).

## Controls inventory
- Tab control: "Overview" | "Cash Flow" | "All Recurring" — single-select, underline-indicated active state.
- Date-range dropdown ("Next 1 month" / "Next 30 Days"): opens a single-select list — observed options in the Cash Flow tab: "Next 2 weeks", "Next 1 month" (selected, highlighted row), "Next 2 months", "Next 3 months", "Next 6 months", "Next 12 months". Selected option is highlighted with a darker row background.
- "+ Add" button (pill, purple, plus-icon) — top right of Cash Flow tab; apparent action: add a new bill/income/reminder item.
- "Select Accounts" panel: collapsible group headers (chevron toggle) for "Cash & Checking", "Credit", "Savings"; each leaf row is a colored checkbox (checked state = solid color fill + checkmark glyph) toggling that account's inclusion in the chart. Scrollbar indicates more groups/accounts below "Savings".
- "By Due date" sort/filter control (dropdown with caret) on the Reminders card — implies alternate sort criteria exist, none enumerated in evidence.
- Reminder list row kebab menu ("⋮" / "...") — per-row overflow action, contents not shown.
- Modal "Options" link (purple text, top-right of reminder detail header) — apparent action: open a menu of series-level actions (edit/delete/skip/etc.), contents not shown.
- Modal close "X" (top-right of modal header).
- "Connect biller" banner: "Connect" pill button (with chain/link icon) — apparent action: link this bill to a live biller connection for auto-updates; banner also has its own small "X" dismiss control distinct from the modal-level close.
- "Coming Up" card kebab menu ("⋮") — per-occurrence overflow action.
- Mini-calendar controls: "Today" button, "‹" and "›" prev/next month arrows; dotted badges under day numbers indicate presence of reminders on that date (a badge-with-meaning, not a plain style choice).
- Floating chat-bubble button, bottom-right, persistent across screens.

## Flow steps
1. User is on Bills & Income → Overview tab (dimmed background state) → sees a Reminders list with rows like "Farmers Insurance / today".
2. User clicks/taps the "Farmers Insurance" row → sees a modal overlay open on top of the (dimmed) Overview tab, titled "Farmers Insurance / Every month", containing average/monthly history chart, "Coming Up" next charge, and "History" of past charges.
3. From the modal, user can click "Connect" in the "Connect biller" banner → (result screen not captured) presumably begins a biller-linking flow to keep amounts auto-updated.
4. From the modal, user can click "Options" → (menu contents not captured) presumably surfaces edit/skip/delete-series actions.
5. User closes the modal via the "X" in the header, returning to the undimmed Overview tab (return state not separately captured, inferred from standard modal pattern).
No undo affordance or confirmation dialog is visible in either captured image.

## States
- Dropdown open state (Cash Flow date-range selector): six options listed, currently-selected option "Next 1 month" shown in a visually distinct (darker) row.
- Zero-value bar-chart state: "SEP" and "NOV" months render as "$0" with no visible bar height, plotted plainly alongside nonzero months — no special empty-state icon or copy, just a "$0" label sitting at the baseline.
- Banner/upsell state: "Connect biller — We'll keep Simplifi updated with your most recent bill information." is shown for this reminder series, implying this particular bill is not yet connected to a live biller data source (an unconnected/manual-tracking state), with a clear call-to-action to resolve it.
- No loading, error, or empty-list state is present in either image — all lists and charts show populated data.

## Business rules implied
- A recurring bill/income item ("reminder") has a defined cadence, displayed as plain text under its name — e.g., "Every month" (`community-x09`).
- Reminders can exist in a "connected to biller" vs. "not connected" state, since the "Connect biller" banner is conditionally offered on this series (`community-x09`); connecting is framed as keeping "Simplifi ... updated with your most recent bill information," implying non-connected reminders may go stale/manual.
- The cash-flow chart plots future/projected dates on a per-account-selection basis — the "Select Accounts" panel with per-account checkboxes directly feeds which balances/lines appear on the Cash Flow chart (`community-x08`), i.e., cash flow projections are scoped to a user-chosen subset of linked accounts, grouped by account type (Cash & Checking / Credit / Savings).
- A "today" vertical marker divides historical/actual data from projected/future data on the timeline chart (`community-x08`), implying the system distinguishes actual past cash flow from forward projection within a single continuous chart.
- Income items are visually and lexically marked with a leading "+" and green color (e.g., "+$1,550.85", "+$7,923.34"), while expense/bill amounts are rendered unsigned/neutral-colored (e.g., "$832.37", "$21.97", "$24.22") — implying a business rule that only inflows get positive-sign/color treatment, not that outflows get negative-sign/red treatment by default in this list context (`community-x08`, `community-x09`).
- Reminder due-dates render as relative phrases when near ("today", "tomorrow", "In 3 days", "In 6 days") and switch to an absolute "on <Month> <Day>" format beyond roughly a week out (`community-x09` background Overview list) — implying a rule threshold for relative vs. absolute date display.
- A reminder-series detail retains historical instances ("History") individually dated and amounts individually recorded, rather than only an aggregate, e.g., three distinct past charges of "$24.22" each individually timestamped, alongside a separate aggregate stat "Total in Last 6 months : $145" and monthly "Average $24" — implying the system tracks both itemized occurrence history and rolled-up monthly/period aggregates for the same series (`community-x09`).

## Standout details
- Colored checkbox chips in "Select Accounts" appear to reuse the exact same color per account as the colored dot markers plotted along the cash-flow timeline — a color-coding thread linking the filter control directly to chart legend/series identity without a separate legend needing to be shown (`community-x08`).
- The vertical "today" line cutting through the projected cash-flow chart is a simple, wordless way to separate actual-vs-forecast without extra copy (`community-x08`).
- Small-caps section label "NEXT" as a lightweight sub-header inside the Reminders card, separating a "next occurrences" grouping from (presumably) other groupings further down, without needing a full second card (`community-x08`).
- The reminder detail modal keeps a small, non-blocking, dismissable "Connect biller" nudge banner with its own micro-copy ("We'll keep Simplifi updated with your most recent bill information.") directly contextualized to the specific vendor being viewed — an example of contextual, per-record progressive disclosure of a data-quality/connection upsell rather than a global app-wide banner (`community-x09`).
- Mini calendar dot-per-day badges give an at-a-glance density signal of which days have reminders, viewable without opening the list (`community-x09` background).
- The "$" glyph used as a marker style on some cash-flow chart points (vs. plain circles for others) appears to be a deliberate iconographic distinction between event types (e.g., paycheck/income markers vs. plain bill markers) placed directly on the timeline (`community-x08`).

## Open questions
- What do the two dashed horizontal reference lines in the Cash Flow chart represent (top light-colored line vs. lower purple line)? No legend is visible in the crop to confirm (projected balance floor/ceiling? two different account groups? a goal line?).
- What do the colored circular dots and "$"-marked dots along the bottom of the Cash Flow chart individually represent — are they clickable to reveal a specific bill/income event, and is there a tooltip on hover? Not shown.
- Is "Savings" group in "Select Accounts" fully expanded or collapsed, and what is the checked/unchecked state of "Long Term Savings" — the row is cut off by the image edge/scroll position, so the icon fill is not clearly legible.
- What does the reminder-row kebab ("⋮"/"...") menu contain (edit, skip this occurrence, delete series, mark as paid, etc.)? Not exposed in either image.
- What does the "Options" link in the reminder-series modal header open? Not captured.
- Why does the "History" list show repeated "$24.22" charges while the "Average"/bar chart above shows differing month totals ("$24," "$0," "$48")? It's possible some months include 0 or 2 occurrences (bar = sum per month, e.g., $48 = two $24.22 charges rounded), but the exact reconciliation logic (rounding display, multiple charges per month, etc.) is not evidenced by legible text alone — flagging as an inference risk rather than asserting it.
- What "By Due date" alternate sort options exist for the Reminders list (the dropdown is closed/unopened in the captured image)?
- Is the "Connect biller" flow a live-credential OAuth-style bank/biller-portal link (similar to Plaid Link) or something else? The button icon suggests a link/connection action, but no subsequent screen was captured in this unit.
- Full label and destination of each left-rail icon are not legible/captured in these two images (icon-only, no tooltips visible) — cannot map icon → section name with confidence.
