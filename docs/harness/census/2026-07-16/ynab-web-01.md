# Census — ynab-web-01

## Evidence
- `design/references/ynab/web-01.png` → Marketing hero image (no browser chrome): a single stylized phone mockup showing the YNAB mobile "Home" screen, overlaid with ad copy "Never worry about money again" / "Try YNAB free for 34 days" and the YNAB wordmark logo. Decorative green blob shapes, sparkle/burst glyphs, circle outlines, and "+" glyphs surround the phone — pure marketing chrome, not app UI.
- `design/references/ynab/web-02.png` → Composite marketing render (small/low-res crop): a browser-window mockup of the YNAB web "Plan" (budget table) screen at `app.ynab.com`, with two phone mockups (a dark-mode "Reflect" screen and a light-gradient "Home" screen) layered over its lower-right corner. Phones are partially cropped in this file.
- `design/references/ynab/web-03.png` → Same composite as web-02, larger canvas; both phone mockups now fully visible.
- `design/references/ynab/web-04.png` → Same composite as web-03, larger/higher-resolution render. Content identical.
- `design/references/ynab/web-05.png` → Same composite again, larger canvas. Content identical to web-03/04.
- `design/references/ynab/web-06.png` → Same composite again, larger canvas. Content identical to web-03/04/05.
- `design/references/ynab/web-07.png` → Same composite again, largest canvas (3200×2174 native). Content identical to web-03 through web-06.

Note: web-03 through web-07 are the same source composition re-exported at increasing resolution/crop size — they do not show additional screens or states beyond what web-03 shows. web-02 is a smaller/cropped export of the same composition. Only two genuinely distinct screens are evidenced across all 7 files: (1) the web-01 marketing hero ("Home" mobile screen fragment), and (2) the web-02..07 composite (web "Plan" screen + mobile "Reflect" screen + mobile "Home" screen, all three visible in one image).

## Information architecture
- Web sidebar (left rail, dark navy background) top-to-bottom: a "Plan Name" header block (budget/plan icon at left, "Plan Name" bold text, "email@address.com" muted subtext, dropdown chevron at far right — implies a plan/budget switcher) → nav items "Plan" (budget icon), "Reflect" (bar-chart icon), "All Accounts" (bank/building icon) → an account list grouped under collapsible headers: "CASH", "CREDIT", "LOANS", "TRACKING", "CLOSED" (collapsed, chevron only) → "+ Add Account" button → footer "Share YNAB. Get YNAB Free." with a gift icon and a sidebar-collapse icon.
- Each account group header shows a rollup total; each account below it is a clickable row with a checkmark icon (reconciled/verified indicator) next to some accounts (Checking, Visa) and not others.
- The web "Plan" screen (budget table) is one click from "All Accounts" and "Reflect" via the persistent left nav — no deeper nesting visible.
- Mobile app bottom nav (light/gradient "Home" phone) shows 5 destinations: Home, Plan, Spending, Accounts, Reflect (Home is active/highlighted, with a red numeric badge "2" on it). The dark "Reflect" phone's bottom nav shows only Home, Plan, Spend visible (may be cropped/scrolled, evidence does not settle whether more items exist off-screen).
- Within the web budget table, category rows are grouped under expandable/collapsible category-group headers ("Bills", "Loan Payments", "Just for Fun"), each with its own chevron and its own checkbox (implying group-level bulk selection).

## Layout & content
- Browser mockup top bar: three window-control dots (left), a URL pill reading "app.ynab.com" (center).
- Sidebar account balances (top-level group rollups): CASH $16,315.91; CREDIT -$375.00 (rendered in a reddish/orange pill-style treatment, distinct from other balances); LOANS -$25,577.70 (plain dark text, not red-styled despite being negative); TRACKING $31,758.00; CLOSED (no total shown, collapsed).
  - Child account balances: Checking $8,749.91 (checkmark), Savings $7,500.00 (no checkmark), Cash $66.00 (no checkmark); Visa -$375.00 (checkmark); Student Loan -$15,072.69, Toyota Loan -$10,505.01 (no checkmarks); 401k $19,329.00, IRA $12,429.00 (no checkmarks).
  - Every balance is right-aligned, `$` prefixed, two decimal places, comma thousands separators; negative values use a leading minus sign (e.g., "-$375.00", "-$25,577.70") rather than parentheses.
- Main budget-table header: "This Month" (bold, with dropdown chevron) with left/right chevron arrows for month navigation, and an "Enter a note…" placeholder input directly beneath the month label.
- Top-right of header: a green pill reading "$300.00" (bold) / "Ready to Assign" (smaller, beneath) with an attached "Assign" button carrying its own dropdown affordance.
- Filter/status tab row directly below: "All" (active/selected, boxed), "Snoozed", "Overfunded", "Underfunded", "Money Available", plus a small funnel/filter icon at the far right of the row.
- Toolbar row: "+ Category Group" (blue text/icon, i.e., add action), "Undo" (with icon), "Redo" (with icon), "Recent Moves" (with icon) on the left; two view-mode toggle icons (grid view / list view) at the far right.
- Budget table columns, left to right: an unlabeled checkbox column, "CATEGORY", "ASSIGNED", "ACTIVITY", "AVAILABLE" (all column headers small-caps, right-aligned for the numeric columns).
- Category-group summary rows (bold) show group-level rollups for Assigned / Activity / Available, e.g.: "Bills" — $2,275.00 / -$1,825.00 / $450.00; "Loan Payments" — $450.34 / $0.00 / $450.34; "Just for Fun" — $470.00 / -$160.00 / $445.00.
- Individual category rows (each with a small emoji/icon glyph identifying the category, e.g. house for Rent, cart for Groceries, wifi icon for Internet Bill, car for Transportation/Car Payment, phone for Phone, sparkle for Sam's Fun Money, popcorn for TV, gift box for Gifts/Allie's Fun Money, game controller for Gaming):
  - Rent: status text "Fully Spent" (gray) · $1,600.00 / -$1,600.00 / $0.00 (Available shown with a gray circular check/done icon).
  - Groceries: status text "Funded. Spent $225.00 of $400.00" with a green progress bar segment (filled portion) directly under the row · $400.00 / -$225.00 / $175.00 (Available with a green filled check-circle icon).
  - Electric, Water Bill, Internet Bill, Transportation, Phone: status text "Funded" (no spend detail shown, full green underline bar) · each with matching Assigned = Available, Activity = $0.00, green check-circle icon on Available.
  - Student Loan, Car Payment: status "Funded" · $250.34/$0/$250.34 and $200.00/$0/$200.00 respectively.
  - Dining Out: status "Funded. Spent $120.00 of $200.00" with partial green progress bar · $200.00 / -$120.00 / $80.00 (green check-circle).
  - Sam's Fun Money: "Funded" · $75.00/$0/$75.00.
  - TV: "Fully Spent" · $40.00/-$40.00/$0.00 (gray circle icon, not green — visually distinguishing "fully spent, nothing left" from "funded, on track").
  - Allie's Fun Money: "Funded" · $75.00 assigned / $0.00 activity / $150.00 available — Available exceeds Assigned, implying carryover/rollover from a prior period.
  - Gifts: status text "$40.00 more needed by the 21st" rendered in amber/orange, paired with an amber clock icon on the $60.00 Available figure — a forward-looking underfunded warning tied to a date, distinct in color from the green "on track" rows.
  - Gaming: "Funded" · $20.00/$0.00/$80.00 (Available again exceeds Assigned — rollover pattern repeats).
- Density: the visible table shows roughly 17 category rows across 3 groups without scrolling in the largest crop (web-07); rows are compact (single-line each, with the status microcopy and progress bar occupying a second visual layer under the category name rather than a new row) — a summary (group rollup) + detail (row-level) split is used throughout.
- Right-hand panel next to the table: a standalone "Auto-Assign" control with a dropdown chevron, in its own bordered card, offset to the right of the main table (not part of the table itself).
- Dark "Reflect" phone screen: header "Reflect" · card "Spending Breakdown" (pie-chart icon) → "This Month" label → large figure "$2,777.66" → a single segmented horizontal bar (blue, green, yellow, red segments, proportion by category) → "Top Categories" list with colored square swatches: Mortgage (blue), Groceries (green), Hawaii Vacation (yellow), Date Nights (red, heart icon), Household Items (blue), "All Others" (gray, no swatch color distinct from list). Second card: "Net Worth" (bank icon) → "$8,957.34".
- Light "Home" phone screen: header "Home" (large bold) with a circular "•••" overflow-menu button top-right. Card 1: "2" (badge/number) "New transactions" with a "Review" pill button. Card 2: "$1,000.00" (bold) "Ready to assign" with an "Assign" pill button. Section header "Top Priorities" (expanded, chevron-down) with an "Edit" pill button. List rows, each icon + label + right-aligned dollar amount in a green pill: Mortgage (house) $1,500.00; Dining Out (bowl/plate icon) $200.00; Hawaii Vacation (palm tree) $3,970.00; Date Nights (heart) $0.00; Ice Skating Lessons (ice skate icon) $66.67. Section header "August Summary" (collapsed, chevron). Bottom row: "Edit" (with target/bullseye icon) and a floating "+ Transaction" button (pill, white, plus-icon prefixed).

## Controls inventory
- Sidebar: plan/budget switcher (dropdown chevron next to "Plan Name"), "Plan" nav item, "Reflect" nav item, "All Accounts" nav item, per-group collapse/expand chevrons (CASH, CREDIT, LOANS, TRACKING, CLOSED), "+ Add Account" button, sidebar-collapse icon (footer).
- Budget header: month back/forward chevrons (`<` `>`), "This Month" dropdown, "Enter a note..." free-text field, "Assign" button+dropdown attached to the Ready-to-Assign pill.
- Filter/status bar: five filter chips — "All", "Snoozed", "Overfunded", "Underfunded", "Money Available" — plus an additional filter/sort icon button.
- Table toolbar: "+ Category Group" (add), "Undo", "Redo", "Recent Moves" (history/audit-trail affordance), two display-mode toggle icons (compact/expanded or grid/list).
- Table: master checkbox per category group (bulk-select), individual row checkboxes per category (bulk-select), implying multi-select bulk actions on categories (not otherwise shown/labeled in this evidence).
- Right panel: "Auto-Assign" button with dropdown chevron.
- Mobile "Home": overflow menu ("•••"), "Review" button (on new-transactions card), "Assign" button (on ready-to-assign card), "Edit" button (Top Priorities section), expand/collapse chevrons on "Top Priorities" and "August Summary" section headers, "Edit" link+icon and "+ Transaction" button at bottom, 5-item bottom tab bar (Home/Plan/Spending/Accounts/Reflect) with a red numeric badge "2" on Home.
- Mobile "Reflect": no interactive controls are legible beyond what appear to be static summary cards; bottom nav shows Home/Plan/Spend tabs.
- web-01 marketing-only controls: none are real app controls — "Review" and "Assign" buttons are visible but are part of the same Home-screen mockup as above, not new controls.

## Flow steps
N/A — no multi-step task sequence is evidenced; these are static marketing/product screenshots, not a captured user flow.

## States
- "Fully Spent" (Rent, TV): Available = $0.00, gray/neutral check-circle icon — a category that used its full assignment with nothing remaining.
- "Funded" (Electric, Water Bill, Internet Bill, Transportation, Phone, Student Loan, Car Payment, Sam's Fun Money, Allie's Fun Money, Gaming): green check-circle icon, Available intact or carried over.
- "Funded. Spent $X of $Y" (Groceries: "Funded. Spent $225.00 of $400.00"; Dining Out: "Funded. Spent $120.00 of $200.00"): a partial-spend state with an inline progress bar showing spent-vs-assigned proportion, still marked with a green check (implying "funded" and "on pace" are compatible even mid-spend).
- Underfunded/warning state (Gifts): exact copy "$40.00 more needed by the 21st" rendered in amber/orange with an amber clock icon on the Available figure — a date-driven shortfall warning distinct from the green "funded" states.
- "Ready to Assign" state: green pill styling used specifically for unassigned money available to budget (both web "$300.00 Ready to Assign" and mobile "$1,000.00 Ready to assign"), paired with an "Assign" call-to-action button in both surfaces.
- No empty, loading, or error states are evidenced in any of the 7 images — all show populated, steady-state data.

## Business rules implied
- Category rows track three numbers per period — Assigned, Activity (spend/income against the category), Available (remaining) — and group headers roll these up (`design/references/ynab/web-07.png`, table columns and group summary rows for "Bills"/"Loan Payments"/"Just for Fun").
- Available can exceed Assigned within a period (Allie's Fun Money: $75 assigned but $150 available; Gaming: $20 assigned but $80 available), implying unspent category balances roll forward rather than resetting to zero each period (`design/references/ynab/web-07.png`).
- Underfunded categories with a due date get an explicit, date-specific shortfall message rather than a generic "underfunded" label — e.g. "$40.00 more needed by the 21st" for Gifts (`design/references/ynab/web-07.png`).
- "Ready to Assign" money is tracked separately from category-assigned money and surfaced prominently near the top of both the web budget screen and the mobile Home screen, each with a same-labeled "Assign" action (`design/references/ynab/web-07.png`).
- New transactions requiring user attention are counted and surfaced as a distinct actionable card ("2 New transactions" / "Review") separate from the budget-assignment card, on the mobile Home screen (`design/references/ynab/web-07.png`).
- Accounts are organized into fixed top-level groups — Cash, Credit, Loans, Tracking, Closed — each with its own signed rollup total, and a checkmark affordance exists per-account (shown on Checking and Visa but not Savings/Cash/loans/tracking accounts in this snapshot), implying a per-account reconciled/verified marker that is not universally set (`design/references/ynab/web-07.png`).
- Negative-money color treatment is not applied uniformly: the Credit group's -$375.00 gets a reddish/orange pill treatment while the Loans group's -$25,577.70 (also negative) is rendered in plain dark text — the evidence shows this distinction but not its rule (`design/references/ynab/web-07.png`).

## Standout details
- Category-row micro-copy doubles as a mini progress narrative ("Funded. Spent $225.00 of $400.00") rather than just a number — this puts spend-vs-plan context directly adjacent to the money, satisfying at-a-glance status without opening a detail view.
- The underfunded-with-deadline copy ("$40.00 more needed by the 21st") names a concrete date rather than a vague "underfunded" badge — turns a status into an actionable, time-bound nudge.
- "Recent Moves" as a labeled, iconed toolbar item alongside Undo/Redo suggests a lightweight, always-visible audit/history affordance scoped to budget-assignment actions specifically (distinct from a general activity log).
- Rollover categories are not called out with special copy — the system communicates "money carried over" purely through Available > Assigned, letting users infer the mechanism from the numbers rather than an explicit banner.
- The mobile Home screen groups a "New transactions" review queue and a "Ready to Assign" prompt as the first two cards — surfacing the two most action-required items before any content the user would passively read (Top Priorities, August Summary).
- Category icons are per-category custom emoji/glyphs (house, palm tree, popcorn, ice skate, etc.) rather than a fixed icon set mapped to a category type — implies user-choosable iconography for personalization/scannability.
- The green progress bar under partially-spent categories acts as its own compact data-viz element embedded in a table row, avoiding a separate chart for something this granular.

## Open questions
- Whether the "Recent Moves" toolbar control expands into a discrete revision list or just re-runs an undo/redo affordance is not shown — no click-through or expanded state is evidenced.
- Whether the per-account checkmark (seen on Checking and Visa only) denotes "reconciled," "verified this period," or something else is not stated anywhere in the visible copy.
- The exact meaning/behavior of the "Auto-Assign" dropdown (rules-based auto-budgeting vs. a one-off action) is not evidenced beyond its label and chevron — no expanded menu is shown.
- Whether the dark "Reflect" phone's bottom nav (Home/Plan/Spend) is simply cropped versus genuinely different from the 5-item nav on the light "Home" phone (Home/Plan/Spending/Accounts/Reflect) is unresolved — both are the same app in principle, so the discrepancy could be a crop artifact rather than a real IA difference.
- No settings, category-edit, add-transaction, or account-detail screens are present in this unit's evidence, so controls/flows for those areas cannot be described from this unit alone.
- Image resolution is sufficient to read all quoted copy confidently in web-04 through web-07; web-02 is small enough that some icon glyphs (not text) are harder to distinguish precisely, though no claims above depend on an unreadable element.
