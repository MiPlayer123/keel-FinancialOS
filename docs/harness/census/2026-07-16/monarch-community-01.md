# Census — monarch-community-01

## Evidence
- `community-01-transactions-list-filters-summary.webp` → Transactions list (main app), full-width transaction table with a right-hand "Summary" sidebar panel; several dollar figures are redacted (pink boxes) in this evidence copy.
- `community-02-transactions-bulk-edit-selected.jpg` → Transactions list, full app chrome (left nav + header), with 2 rows checkbox-selected and a bulk-edit action bar ("2 transactions selected / Close / Edit 2") pinned above the list. Dated rows are from July 2021 — an older screenshot than the others in this unit.
- `community-03-rules-editor-new-rule-modal.png` → "New rule" modal (automation/categorization rule builder), two-column if/then layout, opened over a dimmed background (Notifications page visible behind).
- `community-04-budget-view-desktop-full.png` → Full desktop Budget view inside a laptop-bezel mockup: left nav, month header with Budget/Forecast tabs, three-column Budget/Actual/Remaining table (Income + Expenses > Fixed groups), right-hand "Left to budget" summary card with Summary/Income/Expenses sub-tabs.
- `community-05-flex-budget-flexible-group-unallocated.png` → Cropped/annotated (orange-bordered) close-up of the Budget table's "Flexible" group, expanded, showing an "Unallocated Flexible Budget" row and a mix of budgeted vs. not-yet-budgeted flexible categories.
- `community-06-flex-budget-summary-card.png` → Cropped close-up of the right-hand budget summary card (Fixed / Flexible / Non-Monthly rows) in an over-budget scenario, isolated from surrounding chrome.
- `community-07-cashflow-sankey-report-full-app.png` → Full desktop Reports > Cash Flow tab: four KPI stat cards + a Sankey diagram of income-to-expense flows, inside the same left-nav app chrome.
- `community-08-cashflow-sankey-shared-chart.png` → A standalone "shared" Sankey chart card ("SHARED VIA MONARCHMONEY.COM" watermark), no app chrome, on a periwinkle background — evidently a public share-link/social image render of the same Cash Flow chart with different (larger) sample data.

## Information architecture
Left sidebar nav (dark navy, consistent across the two "full app" screenshots that show it, images 04 and 07, both apparently from the same/newer app version):
Dashboard → Accounts → Transactions → Cash Flow → Reports → Budget → Recurring → Goals → Investments → Advice, with a "Help & Support" link and a user-account row ("Melanie Smith" + chevron) pinned at the bottom of the sidebar.

Notably, "Cash Flow" exists as its own top-level nav item AND as one of three tabs inside Reports ("Cash Flow" / "Spending" / "Income", image 07) — i.e., there appear to be two distinct cash-flow surfaces (a standalone nav destination and a Reports sub-tab), which this evidence does not disambiguate (see Open questions).

Image 02 (bulk-edit, dated 2021) shows a visibly shorter/older nav: Dashboard → Accounts → Transactions → Cash Flow → Plan → Goals, with no separate Reports, Budget, Recurring, Investments, or Advice items and a small orange top-bar logo + bell/notification icon above the nav. This suggests the sidebar IA was expanded over time (Budget, Recurring, Investments, Advice, Reports added; "Plan" apparently retired or split).

Within Transactions (images 01, 02): the page groups rows by calendar date (date acts as a section header, one line per day, with a per-day net total on the header's right edge). A "Summary" panel sits one pane to the right of the transaction list (image 01) — always visible, not a modal — surfacing aggregate stats without leaving the page. Editing multiple transactions happens in-place: selecting rows surfaces a persistent bar above the list ("N transactions selected / Close / Edit N") rather than navigating away (image 02). Rules ("Edit rules" button, image 01) open a modal ("New rule", image 03) rather than a separate page — rule creation is one click from the transaction list toolbar.

Within Budget (images 04–06): Budget is its own top-level nav item, one click away. The budget table nests three fixed groups — Income, Fixed (expenses), Flexible — each collapsible via a chevron; a "Show 2 unbudgeted" affordance further discloses categories with no budget line inline, without navigating away. The right-rail budget summary card is present on the main Budget page (image 04) and is reused, with different data, as an "over budget" example (image 06) — same component in two health states.

## Layout & content
**Transactions list (01, 02):**
- Primary region: a scrollable table, date-grouped, columns (left→right): merchant icon + name, category icon + name, account icon + truncated account name (e.g. "Checking (...52...", "Sapphire (...45..."), an optional inline marker (small calendar icon = scheduled/recurring; grey circular "P" badge = pending), the amount, and a trailing ">" chevron (row is clickable, presumably opens a detail view/drawer).
- Every date-group header carries the day's running total flush right (e.g. "March 28, 2025 … +$13,130.45"; "July 2, 2021 … +$3,419.98") — status/context for that number is simply "this calendar day," established by the header text to its left.
- Every transaction amount sits directly beside its account and category — no bare numbers; category (with a small emoji icon) and account (with a small circular provider icon) are the adjacent context for every figure. Income amounts render in green with a leading "+"; expense amounts render in plain dark text with no sign; in image 01 several amounts are replaced with solid pink redaction blocks in the source evidence (illegible — not a product state, a redaction artifact of the evidence set).
- Right "Summary" sidebar (image 01) is a plain label/value list, right-aligned values: Total transactions 9,110; Largest transaction (redacted); Largest expense $11,185.63; Average transaction +$1.27 (green); Total income (redacted); Total spending (redacted); First transaction Sep 15, 2019; Last transaction Mar 28, 2025; then a "Download CSV" text link (blue) below a divider.
- Density: roughly 10 transaction rows visible per screen in image 01 before scrolling; no visible pagination control — implies continuous/virtualized scroll.
- Number formatting: all figures are `$` + thousands-comma + 2 decimals (e.g. "$13,130.45", "$255.45", "$3.19"); negative/expense values in image 01 are NOT prefixed with "-" (plain amount, color/position implies "money out"), while explicit income is prefixed "+" and colored green — asymmetric sign convention (unsigned expense vs. signed-and-colored income).
- Selection state (image 02): checkbox column appears at far left only once at least the bulk-edit affordance is active/hovered; checked rows get a light-blue row background plus a coral/red checkmark, distinguishing selected rows visually beyond just the checkbox state.

**Budget view (04–06):**
- Table columns: category name | Budget (editable box) | Actual | Remaining. Every Budget cell for a leaf category is a bordered input box (editable inline), with a thin horizontal progress bar beneath it that fills proportionally to Actual/Budget.
- "Remaining" is always rendered as a pill/badge, not plain text, color-coded: green pill = under budget with room left (e.g. "$4,200", "$580", "$10"), grey pill = exactly on-budget / $0 remaining (e.g. "$0" for Garbage, Phone, Fitness, Loan Repayment), red text (no pill, plain red) = over budget / negative remaining (e.g. "-$5" for Mortgage, "-$116" for Fixed group total in image 06), amber/orange = remaining but trending toward the limit (e.g. "$1,244 remaining" for Flexible in image 06, "$839 remaining" for Flexible in image 04's side card).
- Rollover/non-monthly categories additionally prefix the remaining figure with a small circular-arrow (↻) icon before the dollar amount (e.g. "↻ $6,519", "↻ $1,215 remaining") — this icon is the only visible cue that a balance carries forward rather than resetting.
- Group-level rows (Income, Fixed, Total Income) are bold with no input box — only leaf categories are directly editable.
- Unbudgeted categories (image 05: Clothing, Gas, Pets, Restaurants & Bars, Entertainment & Recreation) show ONLY a plain black dollar figure in the Actual-equivalent position, with no Budget input box and no progress bar — visually distinct (lighter density of chrome) from budgeted rows, which have box+bar+colored-pill.
- The "Unallocated Flexible Budget" row (image 05) is styled uniquely: italic grey label, small 2×2 grid icon (not an emoji, unlike every other category), an info "ⓘ" tooltip icon, and a single plain figure ("$4,100") with no input/bar — marking it as a system-level rollup rather than a spendable category.
- Right summary card ("Left to budget"): a large green rounded banner with the headline number ("$3,210") and label "Left to budget" plus an info icon, followed by Summary/Income/Expenses sub-tabs, then three stacked mini-cards (Fixed/Flexible/Non-Monthly), each with: group name + "$X budget" (grey, right-aligned) on one line, a horizontal progress bar below, then "$X spent" (bold black, left) and "$X remaining" (color-coded per rules above, right) on the next line.
- Density: image 04 shows 2 income lines + 8 fixed-expense lines before the fold; each row is a single line (label + input + actual + remaining), no secondary detail row — this is a summary-density table, not itemized transactions.
- Number formatting: all whole-dollar in the budget table (no cents shown, e.g. "$8,410", "$1,380"), right-aligned in their columns; input boxes show the same formatting as static values.

**Cash Flow / Sankey reports (07, 08):**
- Four KPI stat cards at the top of image 07, each: large colored number on top (green for income, red/orange for expenses, black for net and for the percentage), a small-caps grey label directly beneath ("TOTAL INCOME", "TOTAL EXPENSES", "TOTAL NET INCOME", "SAVINGS RATE") — label always sits immediately under, never beside, its number.
- Sankey chart: left-to-right flow nodes, each node showing three lines of text — category name, dollar amount, percentage-of-total in parentheses (e.g. "Housing / $1,593.00 (37.93%)"). Ribbon width between nodes is proportional to the dollar amount (visual encoding, not labeled). Node/ribbon color is consistent per category group across both the app version (07) and the shared version (08).
- Panel header in image 07 reads "CASH FLOW" (small caps) with the exact selected date range printed beneath the page-level date filter ("Dec 1, 2024 - Dec 31, 2024" vs. the toolbar's "This month" button) — the same underlying range expressed twice at two levels of granularity.
- Image 08 (shared) strips all navigation/toolbar chrome and keeps only: a small watermark row ("✱ SHARED VIA MONARCHMONEY.COM"), then the same three-line-per-node Sankey, on a white rounded card over a solid periwinkle background — a purpose-built shareable/social rendering, distinct from the in-app view.
- Density: image 07 shows 5 first-level expense groups before scroll cutoff (Housing, Financial, Bills & Utilities, Food & Dining, Travel & Lifestyle-partial) plus their immediate children where visible (Mortgage, Home Improvement under Housing; Loan Repayment, Insurance, Cash & ATM under Financial; Garbage, Phone under Bills & Utilities). Image 08 shows 6 first-level groups (Savings, Housing, Financial, Auto & Transport, Bills & Utilities, Shopping) with no children expanded, cut off before further detail.

## Controls inventory
**Transactions (01, 02):**
- "Search" — button with magnifying-glass icon, opens search (top toolbar).
- "Date" — button with calendar icon, apparent date-range filter.
- "Filters" — button with a funnel/lines icon, apparent multi-filter opener.
- "Edit rules" — plain button, opens rules list/management (leads to the New Rule modal shown in image 03).
- "+ Add transaction" — solid orange/primary button, manual transaction entry.
- Panel-toggle icon (square with a vertical divider, far right of top toolbar) — apparent show/hide of the right Summary sidebar.
- "All transactions" — dropdown (chevron), likely a saved-view/account-scope selector.
- "Edit multiple" — button with a checkmark icon, toggles row-selection/checkbox mode.
- "Sort" — dropdown with chevron.
- Row-level checkboxes (image 02) — appear once selection mode is active; checked state = coral checkmark + light-blue row highlight.
- Bulk-edit bar (image 02): red/coral minus-in-square icon (likely "deselect all"), "Close" button (exits selection mode), "Edit 2" button (primary, coral) — count in the button label updates to the selection size ("Edit 2" for 2 selected transactions).
- "Download CSV" — text link in the Summary panel (image 01), exports the current transaction view.
- Inline markers on rows: small calendar-glyph icon (recurring/scheduled indicator) and a grey circular "P" badge (pending-transaction indicator) — both appear standalone with no visible legend in these crops.

**Rules modal (03):**
- Tabs: "Settings" (active, orange underline) / "Preview changes" with a numeric badge ("0") showing how many transactions the rule would currently touch.
- Left column "If transaction matches criteria…", four toggle rows: Merchants, Amount, Categories, Accounts. Toggling "Categories" ON expands an inline chip-editor showing the selected category as a removable pill ("🎂 Birthday shopping" with an "×") plus a dropdown affordance to add more.
- Right column "Then apply these updates…", six toggle rows: Rename merchant, Update category, Add tags, Hide transaction, Review status, Link to goal. "Hide transaction" is toggled ON in this example.
- "Save" button, bottom-right, rendered in a lighter/muted pink — visually reads as disabled or de-emphasized relative to a fully "ready" state (cannot confirm disabled vs. just unhovered styling from a static image).
- "×" close icon, top-right of modal.

**Budget (04–06):**
- Tabs: "Budget" (active) / "Forecast" — top of the main panel, beside the month label.
- Month navigation: "←" / "→" arrow buttons, "Today" button (jumps to current month), "⚙ Settings" button.
- Per-category chevrons (▾) to expand/collapse each group (Income, Expenses, Fixed, Flexible).
- "Show 2 unbudgeted" — expandable link with an eye icon, discloses categories with no active budget line.
- Editable Budget input boxes per leaf category (click-to-edit dollar figure).
- Right-card sub-tabs: "Summary" / "Income" / "Expenses" (Expenses shown active/selected in image 04).
- Info "ⓘ" icon next to "Left to budget" headline and next to "Unallocated Flexible Budget" — presumed tooltip/explainer affordance.
- Rollover indicator icon (↻, circular arrow) prefixing certain "remaining" figures.
- Category-row emoji icons throughout (🚗 Auto Payment, 🏠 Mortgage, 🗑 Garbage, ⚡ Gas & Electric, 🌐 Internet & Cable, 📱 Phone, 💪 Fitness, 💰 Loan Repayment, 🍎 Groceries, 🌴 Travel & Vacation, 🛍 Shopping, 🪑 Furniture & Housewares, 👕 Clothing, ⛽ Gas, 🐶 Pets, 🍽 Restaurants & Bars, 🎬 Entertainment & Recreation) — every category is icon-prefixed, no bare-text category rows observed.

**Reports / Cash Flow (07, 08):**
- Top toolbar: "This month" button (date-range picker) and "Filters" button.
- Report tabs: "Cash Flow" (active) / "Spending" / "Income".
- Chart-region controls: "By category & group" dropdown (grouping selector), a row of three small icon-toggle buttons (chart-type switcher — sankey/flow icon, plus two bar-chart-style icons, exact distinction not legible), and a "Share" button with an icon — produces the shareable card seen in image 08.
- No controls visible in image 08 (share output is a static, chrome-free card).

## Flow steps
1. User opens the Transactions list and clicks "Edit multiple" (or otherwise enters selection mode) → sees checkboxes appear on each row (02).
2. User checks two rows (Spotify, Hulu) → sees the row backgrounds turn light blue, checkmarks turn coral, and a persistent bar appears above the list reading "2 transactions selected" with "Close" and "Edit 2" actions (02).
3. From the Transactions toolbar, user clicks "Edit rules" → (not directly evidenced, but) arrives at a rule-creation surface, seen as the "New rule" modal (03).
4. In the New rule modal, user toggles ON a matching criterion (e.g. Categories) → sees an inline chip editor appear for selecting the category value ("🎂 Birthday shopping") (03).
5. User toggles ON an action (e.g. "Hide transaction") → the toggle switches to coral/filled state; user can check the "Preview changes" tab to see the count of affected transactions before saving (03) — no confirmation dialog or undo affordance is visible in this crop.
6. In Budget, user can expand "Show 2 unbudgeted" to reveal categories without an assigned budget, without leaving the page (04).
7. In Reports > Cash Flow, user clicks "Share" → (not directly evidenced as a click sequence, but) produces the standalone shared card with the "SHARED VIA MONARCHMONEY.COM" watermark (08), implying a share-link/image-export flow exists off the Cash Flow report.

No explicit confirmation dialogs, success toasts, or undo affordances are visible in any of the 8 images for this unit.

## States
- No empty, loading, or error states are captured in this unit's 8 images — all screens show populated data.
- Partial/placeholder state: image 01 shows several dollar figures replaced with solid pink rectangles (evidence-set redaction of presumably-sensitive real user amounts), not a genuine product state — flagged here so it is not mistaken for a design pattern (e.g., a skeleton loader or masked-amount privacy toggle). No copy is visible to confirm whether Monarch has an actual "hide amounts" privacy feature; this may coincidentally resemble one but cannot be confirmed from this evidence.
- "Success"-adjacent state: the New Rule modal's "Preview changes" tab shows a "0" badge, i.e., zero transactions currently match the draft rule — the only quantifiable state-like signal captured, and it updates live in the tab per the UI's own convention (badge = live match count).

## Business rules implied
- A transaction can carry a "pending" status distinct from posted, shown as a grey circular "P" badge inline with the row (image 01, rows for H-E-B $18.99 and Anayas Seafood $50.00).
- A transaction can be flagged as "scheduled/recurring" via a small calendar-glyph icon inline with the row, independent of the pending badge (image 01, Slalom Payments rows and Google One row).
- Budget "Remaining" can go negative and is rendered in red with no pill background, distinct from on-track (green pill) and exactly-zero (grey pill) states — implying three distinct budget-health tiers are modeled: under, exactly-at, and over budget (image 04: Mortgage -$5; image 06: Fixed group -$116).
- Some budget groups/categories carry forward unspent balance across months ("rollover"), signaled by a ↻ icon on the remaining figure, and this rolled-over remaining can exceed the stated period budget (image 05: "$8,000" budget input but "↻ $6,519" remaining — remaining greater than budget, only explainable by accumulated rollover; image 06: Non-Monthly shows the same ↻ pattern).
- Categories exist that have no assigned budget amount at all ("unbudgeted") and are visually demoted (no input box, no progress bar, plain figure only) rather than hidden — implying budgeting is opt-in per category, with actuals still tracked regardless (image 05: Clothing, Gas, Pets, Restaurants & Bars, Entertainment & Recreation all show only an actual-spend number).
- There is a system-level "Unallocated Flexible Budget" figure, separate from any named category, rendered non-editable and iconographically distinct (grid icon, italic) — implying the sum of a group's category budgets need not equal the group's total budget, with the difference tracked explicitly (image 05: $4,100 unallocated).
- Rule actions and match criteria are modeled as independent, individually-toggleable predicates/effects (Merchants/Amount/Categories/Accounts on the match side; Rename merchant/Update category/Add tags/Hide transaction/Review status/Link to goal on the action side) rather than a fixed single-field rule — implying the underlying rule schema supports multiple simultaneous conditions and multiple simultaneous actions per rule (image 03).
- A rule can be previewed for impact before being saved — the modal separates "Settings" from "Preview changes" with a live count badge, implying the system computes a dry-run match count against existing transactions prior to commit (image 03).
- Cash-flow reporting explicitly nets to a "Savings" bucket as a peer of expense categories (not just Income − Expenses arithmetic shown separately) — the Sankey treats "Savings" as one of the flow's destination nodes alongside Housing, Financial, etc. (images 07, 08), implying savings/net-income is modeled as an allocatable category in the same taxonomy as spending.
- Every reporting figure is paired with both an absolute amount and a percentage-of-total, computed relative to the top-level Income node, at every level of the Sankey hierarchy (e.g., "Mortgage $1,385.00 (37.24%)" — 37.24% of Housing, not of total income) — implying percentages are computed relative to each node's immediate parent, not a single global denominator (image 07: Housing is 37.93% of $4,200 total; Mortgage is 37.24%, which is of Housing's $1,593, not of $4,200).

## Standout details
- The "Remaining" pill's color (green/grey/red/amber) plus an optional rollover glyph (↻) together encode four+ distinct budget states in a single small badge, without any additional text label — a compact, reusable status-encoding pattern.
- Percentages in the Sankey are parent-relative at each level rather than always-relative-to-total, giving a "share of this bucket" reading at every depth without extra chrome.
- The "Preview changes" tab badge on the rule modal turns rule-authoring into a live, checkable dry run before commit — cheap confidence-building without a separate "test rule" button.
- Unbudgeted categories are demoted in visual weight (no box, no bar) rather than hidden entirely, keeping actual spend visible for planning even before a budget commitment is made.
- The shared Cash Flow card (image 08) is a fully de-chromed, watermark-only export — a deliberate "read-only, brandable" surface distinct from the in-app interactive report, suggesting a first-class share/export path off a report rather than a generic screenshot.
- Account names are truncated with an ellipsis mid-string in the transaction list ("Checking (...52...", "Sapphire (...45...") rather than at the end — preserving the last few digits of an account identifier (likely the last-4) even under truncation, which is a deliberate legibility choice for distinguishing same-type accounts.
- The KPI stat-card pattern (big colored number, small-caps grey label directly beneath) recurs with no adjacent icon or extra chrome — pure typographic hierarchy carries the "what is this number" context.

## Open questions
- Whether "Cash Flow" as a standalone left-nav item (images 04, 07) differs functionally from the "Cash Flow" tab inside "Reports" (image 07) — both are visible as separate destinations in the same nav, but no image shows the standalone Cash Flow nav destination's actual content.
- Whether the "Save" button in the New Rule modal (image 03) is genuinely disabled at that moment or just styled with lower emphasis — the muted pink fill is ambiguous from a static image, and no cursor/hover state is visible.
- Whether Monarch has a real amounts-privacy/masking feature — image 01's pink-redacted figures are confirmed evidence-collection redactions (per task framing), not a native product state, but their appearance is visually similar to what a masking feature might look like; this cannot be resolved from the given crops.
- What the small calendar-glyph and "P" badge icons are officially called/labeled in-product (their meaning is inferred from context — scheduled/recurring vs. pending — but no tooltip or legend text is visible in any image).
- The exact semantics of the "Edit rules" button relative to the "New rule" modal — whether "Edit rules" opens a rules list first (with New rule as a secondary action) or opens directly into rule creation, since no screenshot captures the intermediate list view.
- Whether the three small icon-toggle buttons beside "By category & group" in the Reports > Cash Flow toolbar (image 07) switch between Sankey/bar/other chart types, or control some other display dimension — icons are too small/ambiguous to confirm precisely.
- The relationship between the older nav (image 02: Dashboard/Accounts/Transactions/Cash Flow/Plan/Goals, dated 2021) and the newer nav (images 04/07: ...Reports/Budget/Recurring/.../Investments/Advice) — whether this reflects a real product IA change over time, an account-tier difference, or simply two different marketing-collateral vintages bundled into the same evidence unit.
- Exact numeric precision/rounding rule for Sankey percentages (e.g., whether "Mortgage 37.24%" is rounded from a more precise stored value) is not verifiable from a static image.
