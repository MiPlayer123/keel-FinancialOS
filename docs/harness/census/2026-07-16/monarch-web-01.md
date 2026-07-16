# Census — monarch-web-01

## Evidence
- `design/references/monarch/web-01.png` → A single composited marketing/promotional graphic showing a "budget summary" card (Income / Expenses / Goals progress rows under a "Left to budget" hero figure) with a floating dark popover ("Groceries" budget/actual/remaining detail) overlapping the card's upper-right corner. Not a full-window app screenshot — no browser chrome, no top nav, no sidebar; the card floats on a flat solid-green backdrop with a drop shadow and a decorative dashed navy border around the card edge.

## Information architecture
No navigation chrome (no top bar, sidebar, tabs, or breadcrumbs) is present in this image, so its place in Monarch's IA cannot be determined from this evidence alone. The card itself is internally organized as one vertically-stacked list of three labeled sections, in this fixed order, each separated by a thin horizontal rule:
1. Income
2. Expenses
3. Goals
Above all three sections sits a single highlighted hero metric ("$1,000 / Left to budget"), visually set apart in its own pale-green rounded panel at the top of the card — implying it is the primary/summary figure and the three sections below are its constituent breakdown, one level of detail down.
A secondary, category-level detail ("Groceries") is shown as a popover layered on top of/beside the Income and Expenses rows, implying that category-level detail is one interaction away from the row-level summary (see Open questions on what triggers it).

## Layout & content
Card (outer container):
- Rounded white card, dashed navy outline (decorative, likely a marketing-render artifact rather than product chrome), drop shadow, floating on solid green background.

Hero panel (top of card, pale mint-green rounded rectangle):
- "$1,000" — large, bold, dark green, no currency-adjacent status badge other than the label directly beneath it.
- "Left to budget" — bold green label directly under the figure, smaller than the number, with a circular "(i)" info icon immediately to its right (same green color). This is the only status/context adjacent to this figure: the label itself is the status ("left to budget" = surplus/remaining framing), colored green implying a positive/favorable state.

Row 1 — Income:
- Section label "Income" in plain dark (near-black) text, left-aligned, no icon.
- Horizontal progress bar below the label: green filled segment (~60% of width) on a light-gray track, no numeric labels on the bar itself, no percentage shown.
- Below the bar, two figures on one line: "$3,000 received" (dark/black text, left-aligned) and, right-aligned, a figure beginning "$2,0…" in green — the rest is cropped/occluded by the black "Groceries" popover, so the full number and its trailing label are not legible.

Row 2 — Expenses:
- Section label "Expenses," same styling as Income.
- Horizontal progress bar: green filled segment (~55% of width) on light-gray track, plus a distinct thin dark-navy vertical tick mark positioned partway along the bar (inside the filled portion, near its right edge) — a marker distinct from the fill itself, with no adjacent numeric or text label explaining what it denotes.
- Below the bar: "$2,000 spent" (dark text, left) and "$3,000 remaining" (right-aligned; "$3,000" in bold green, "remaining" in gray, smaller weight) — this is the one row where both bar-adjacent figures are fully legible.

Row 3 — Goals:
- Section label "Goals," same styling as the two rows above.
- Horizontal progress bar: blue/teal filled segment, notably short (~15% of width) on light-gray track — no tick mark.
- Below the bar: "$50 contributed" (dark text, left) and "$750 remaining" (right-aligned; "$750" in bold blue/teal — matching the bar's fill color — "remaining" in gray).

Floating popover ("Groceries" detail), overlapping the card's upper-right, spanning from mid-Income row to mid-Expenses row:
- Dark/near-black rounded rectangle, drop shadow, sits visually "in front of" the base card.
- Top-left: "Groceries" — bold white, large (comparable in weight/size to the hero card's numeric label style).
- Top-right: a circular ring/gauge icon — ring is mostly green with one gray/unfilled arc segment (implying a percentage-of-budget-used gauge), with an orange carrot icon centered inside the ring (category icon).
- Three-column mini-table beneath the title, small gray column headers: "Budget," "Actual," "Remaining."
- Values beneath each header, bold and larger than the headers: "$200" (white, under Budget), "$100" (white, under Actual), "$100" (green, under Remaining).

Density: this is a compact, summary-level card only — three rows plus one hero figure plus one category popover. No transaction-level or line-item detail is shown; no scrollable list, no pagination. Alignment throughout is consistent: labels/left figures left-aligned, secondary/remaining figures right-aligned on the same text baseline as their row's left figure. Number formatting is consistently `$X,XXX` with comma thousands separators, no decimals/cents shown anywhere, and no negative numbers or minus signs appear (all figures here are framed as positive quantities — "received," "spent," "contributed," "remaining" — rather than signed deltas).

## Controls inventory
- "(i)" info icon next to "Left to budget" — circular outline icon, apparent action: reveal an explanatory tooltip/definition for the metric (not shown expanded in this image).
- Three horizontal progress bars (Income, Expenses, Goals) — visually read as non-interactive progress/status indicators (no visible hover state, handle, or draggable affordance), though the presence of the "Groceries" popover suggests at least the Expenses bar (or its underlying categories) is interactive/hoverable to reveal category detail.
- Vertical tick mark on the Expenses bar — appears to be a static marker/indicator rather than a control (no label confirms this).
- Circular gauge icon on the "Groceries" popover — appears purely informational (visual percentage-used indicator), not a clickable control in this frame.
- No visible buttons, menus, filters, sort controls, checkboxes, tabs, or bulk-action affordances anywhere in this image.

## Flow steps
N/A — this is a single static image. It appears to composite two states (the base Income/Expenses/Goals card, plus a "Groceries" category popover shown as if triggered/hovering over part of the Income/Expenses area) into one marketing graphic, but no sequence of distinct screens or a do→see progression is actually captured; the trigger for the popover is not observable.

## States
Only one data state is visible: a fully populated "success" state with non-zero figures in every row (Income, Expenses, Goals) and in the "Groceries" popover. No empty, loading, error, or zero-progress state is present in this evidence. No exact error/empty copy exists to quote.

## Business rules implied
- Remaining = Budget − Actual: the "Groceries" popover shows Budget $200, Actual $100, Remaining $100, which is internally consistent (200 − 100 = 100). (`design/references/monarch/web-01.png`)
- The Expenses row similarly implies Remaining = (something) − Spent: "$2,000 spent" and "$3,000 remaining" are shown side by side as complementary figures within the same row. (`design/references/monarch/web-01.png`)
- Distinct colors are used to separately encode "money coming in / on-track spending" (green: Income bar, Expenses bar fill, Expenses remaining figure, Groceries remaining figure) versus "goal savings progress" (blue/teal: Goals bar fill and Goals remaining figure) — implying goals are tracked as a visually distinct category of money movement from ordinary income/expense budgeting. (`design/references/monarch/web-01.png`)
- A budget category (here, "Groceries") is tracked with three co-equal figures — Budget, Actual, Remaining — surfaced together as a unit, suggesting this triple is the atomic data model for category-level budget tracking. (`design/references/monarch/web-01.png`)

## Standout details
- The category popover pairs a small circular progress "gauge" ring with a food-emoji-style icon (carrot) inside it — a compact way to convey both "which category" and "how much of its budget is used" in one glyph, without needing text for the percentage.
- The "remaining" figure in each row is color-matched to that row's progress-bar fill color (green Expenses bar → green "$3,000 remaining"; blue Goals bar → blue "$750 remaining"), reinforcing the bar's color coding through the adjacent text rather than introducing a new color per status.
- The hero metric ("$1,000 / Left to budget") is set off in its own tinted panel distinct from the plain-white list below it, visually promoting it above the three supporting rows despite using a smaller total area.
- The info "(i)" icon is placed inline right next to the hero label rather than as a separate help section, keeping supplemental explanation reachable without leaving the summary view (progressive disclosure).
- The Expenses bar carries an extra vertical tick mark not present on the Income or Goals bars — a detail (target/pace marker) layered onto the same bar primitive rather than requiring a whole separate widget.

## Open questions
- Whether this image represents an actual in-app screenshot or a purely illustrative marketing composite: no browser/app chrome is visible, the card has a decorative dashed border and drop shadow, and it floats on a flat solid-green background — all consistent with a marketing asset rather than a captured product screen. This affects how much of the layout (e.g., card width, dashed border, shadow) should be treated as real product design versus promotional styling.
- The right-hand figure in the Income row is cropped by the overlapping "Groceries" popover ("$2,0…" is all that's legible) — its full value and trailing label (e.g., "left," "budgeted," "remaining") cannot be confirmed.
- What user action reveals the "Groceries" popover (hover over the Expenses bar, hover over a category row elsewhere not shown, or click) is not observable from a single static frame.
- The hero figure ("$1,000 Left to budget") does not arithmetically reconcile with the visible Income/Expenses/Goals figures at face value ($3,000 received − $2,000 spent − $50 contributed = $950, not $1,000); this may indicate rounding, additional unshown line items, illustrative/placeholder data not meant to be internally consistent, or a calculation this evidence doesn't fully expose.
- The exact meaning of the dark vertical tick mark on the Expenses progress bar (e.g., a pace-of-month marker, a projected/forecast point, or a separate target line) is not labeled anywhere in the image.
- Whether "Groceries" is a sub-category specifically of "Expenses," or a category that could equally appear under a different grouping, cannot be confirmed from the popover's ambiguous overlap position across both the Income and Expenses rows.
- No date range, account scope, or "as of" timestamp is visible anywhere on the card, so the reporting period and data scope for every figure shown is unknown.
