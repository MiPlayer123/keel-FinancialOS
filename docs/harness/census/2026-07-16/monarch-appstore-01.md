# Census — monarch-appstore-01

## Evidence
- `appstore-monarch-pad-01-2064x2752.jpg` → Hero slide: tagline + press-award laurels, over an iPad screenshot of the **Accounts** screen (Net Worth tab), no app sidebar visible (cropped/zoomed presentation).
- `appstore-monarch-pad-02-2064x2752.jpg` → "ACCOUNTS" feature slide: bank-logo strip + full iPad screenshot of **Accounts** screen with left sidebar visible (Accounts item selected).
- `appstore-monarch-pad-03-2064x2752.jpg` → "COLLABORATION" feature slide: two user avatars with two floating per-person account cards ("Jon", "Melanie") layered over a partially-visible Accounts screenshot.
- `appstore-monarch-pad-04-2064x2752.jpg` → "BUDGETING" feature slide: full iPad screenshot of the **Budget** screen for "December 2024" (sidebar, Budget selected).
- `appstore-monarch-pad-05-2064x2752.jpg` → "TRANSACTIONS" feature slide: iPad screenshot of a single-transaction **review/detail** card ("Verizon") with a large diagonal orange "Mark as Reviewed" swipe-gesture overlay.
- `appstore-monarch-pad-06-2064x2752.jpg` → "REPORTS" feature slide: full iPad screenshot of the **Cash Flow** screen (sidebar, Cash Flow selected) showing Income and Expenses category breakdown.
- `appstore-monarch-pad-07-2064x2752.jpg` → "RECURRING" feature slide: two floating cards, "Bills" and "Subscriptions," no device frame, over an illustrated blob background.
- `appstore-monarch-pad-08-2064x2752.jpg` → "GOALS" feature slide: 2×2 grid of photographic goal cards (no device frame) + full iPad screenshot of the **Goals** screen (sidebar, Goals selected).

## Information architecture
- Left sidebar (visible in images 02, 04, 05, 06, 08) is the primary nav on iPad/desktop-width layout. Top of sidebar: butterfly "Monarch" wordmark/logo + a gear/settings icon at top-right of the sidebar.
- Sidebar item order, consistently: **Dashboard** (home icon) → **Accounts** (stacked-layers icon) → **Transactions** (card icon) → **Cash Flow** (bar-chart icon) → **Budget** (map icon) → **Recurring** (calendar icon) → **Goals** (bullseye/target icon) → **Investments** (trend-line icon). This exact 8-item order repeats identically across every screenshot that shows the sidebar.
- No separate "Reports" nav item is visible — the "REPORTS" marketing slide (image 06) highlights **Cash Flow** in the sidebar, implying Cash Flow *is* the reports surface for spend-by-category breakdowns.
- Each content screen has a shared top-bar pattern: sidebar-toggle icon (leftmost, only when sidebar is present) + bell/notifications icon, then a centered page title ("Accounts", "December 2024" for Budget, "Cash Flow"), then a trailing "..." overflow menu and a context-specific icon (a "+" add icon on Accounts; a calendar icon on Budget and Cash Flow).
- Accounts screen is one click from a horizontal sub-nav of asset-class tabs: NET WORTH, CASH, INVESTMENTS, REAL ESTATE, VEHICLES, CREDIT CARDS, LOANS (image 01) — these tabs live directly under the page title, above the net-worth chart.
- The Transactions review flow (image 05) is reached from the sidebar's Transactions/Dashboard entry point and presents one transaction at a time in a queue ("4 remaining"), with a back arrow (`←`) at top-left to exit the queue.
- Per-person account views ("Jon", "Melanie" cards in image 03) are reachable via an "N accounts >" chevron link on each person card, implying a drilldown to a person-scoped account list, distinct from the type-grouped Accounts screen.
- Goals screen (image 08) groups goals as a vertical list of full-width photographic cards, each presumably one click from a goal detail (not shown in this unit).

## Layout & content
**Accounts screen (images 01, 02):**
- Big net-worth figure "$686,989.93" top-left, immediately followed on the next line by a signed delta: "↑ $22,292.97 (3.4%)" in green, plus a plain-text period qualifier "1 month" — status (up/down arrow + color) sits directly left of the dollar delta, period sits after the percentage, all on one line under the total.
- Below the number: a filled teal/blue area-line chart with a dashed baseline reference line, and below the chart a horizontal time-range selector: 1M (active/pill-highlighted), 3M, 6M, 1Y, ALL.
- Below the chart, account groups are rendered as white cards, each with a **group header row** (group name, bold; the group's aggregate balance, bold, right-aligned) and immediately below it a **secondary row**: colored up/down arrow + signed $ delta + (%) + period-in-plain-text on the left, and a right-aligned "N% of assets" (or "of liabilities") in muted gray text underlined with a short dotted rule — this dotted underline visually distinguishes the proportion metric from the dollar balance above it.
- Under each group header, individual account rows: circular institution-logo avatar (left) + account nickname (bold) + account type (muted, smaller, second line) on the left; on the right, the account balance (bold) stacked above a muted freshness timestamp ("11 hours ago", "1 minute ago").
- Groups observed, in order, with totals: Cash $65,819.70 (7% of assets), Investments $542,032.32 (58% of assets), Real Estate $300,054.83 (32% of assets), Vehicles $20,330.80 (2% of assets), Credit Cards $2,022.09 (1% of liabilities, shown with a red down-arrow delta since balance dropped), Loans $239,225.63 (99% of liabilities, red down-arrow delta). Assets and liabilities are visually separated only by group order/labeling, not by an explicit section divider caption.
- Density: roughly 2–4 account rows visible per group card before scrolling; the whole net-worth + ~6 groups requires scrolling past the visible viewport (bottom groups are cut off mid-row in both 01 and 02).
- Number formatting: all dollar figures use "$" prefix, comma thousands separators, and two decimal places for account/group balances (e.g., "$150,141.42"); percentage deltas use one decimal place in parentheses; goal target amounts (image 08) are whole dollars with no decimals (e.g., "$150,000").

**Collaboration (image 03):**
- Two person-cards side by side, each: name (bold, large) + "N accounts >" chevron-link line + "..." overflow menu top-right of the card.
- Each card lists 4 accounts using the identical row pattern as the Accounts screen (icon, name, type; balance, freshness) — freshness here reads "1 minute ago" for every row (uniform, likely denoting "just synced" demo state rather than real variation).
- Jon's accounts: Apple Card $1,000.00 (Credit Card), Sapphire $1,250.00 (Credit Card), Ally Savings $50,000 (Savings, no decimals shown for this one row), Amazon $100.00 (Credit Card).
- Melanie's accounts: Savings $10,000.00 (Savings), Stocks $25,000.00 (Brokerage), Coinbase $7,500.00 (Crypto), Our Home $250,000.00 (Real Estate).

**Budget screen (image 04):**
- Full-width green banner: "Left to budget ⓘ" (info-icon inline after the label) left-aligned, "$4,640" bold right-aligned — this is the single most prominent figure on the screen, color-coded green (implying positive/unallocated-income framing, not a warning).
- Two stacked summary rows below the banner:
  - "Income" (label) / "$8,410 budget" (muted, right-aligned) header line, then a green horizontal progress bar, then "$4,200 earned" (left) / "$4,210 remaining" (right, bold).
  - "Expenses" (label) / "$3,770 budget" header line, then an orange/red horizontal progress bar (near-full), then "$3,371 spent" (left) / "$399 remaining" (right, bold).
- Below that, a categorized ledger-style list under two section headers ("Income", "Expenses"), each section header row carries column labels "Budget" and "Remaining" right-aligned.
- Category-group rows (e.g., "Housing", "Auto & Transport") are collapsible (chevron toggle), bold, showing the group's total Budget and Remaining.
- Under each group, individual line-item rows: emoji icon + category name (left), an editable-looking bordered box showing the budget amount (center-right), and a colored pill showing the remaining amount (far right) — pill color: green when remaining ≥ $0 (e.g., "$580", "$50", "$12"), red when negative/overspent (Mortgage: "-$5"), gray when exactly "$0" (Garbage, with its progress bar rendered fully dark/filled).
- Each line item also has a thin progress bar directly under its row spanning full width, filled proportionally to amount spent (green fill = within budget, dark/black fill appears at 100% spent as with Garbage).
- Below fully-budgeted items, a muted disclosure row: "👁 Show N unbudgeted" (eye icon + count), collapsing additional categories with no budget set — seen after Paychecks/Interest ("Show 2 unbudgeted"), Charity ("Show 1 unbudgeted"), Auto Payment ("Show 5 unbudgeted"), Home Improvement ("Show 1 unbudgeted").
- Density: ~4 category groups with ~1-2 line items each visible before scroll cutoff (Bills & Utilities/Garbage row is cut off at the very bottom).

**Transaction review (image 05):**
- Top bar: back arrow, centered "4 remaining" (queue-position count, not a specific transaction number).
- Card: building/merchant icon placeholder, "Verizon" (bold, large), "12 transactions >" (link, implying this merchant has 12 total transactions and this links to a merchant-scoped list).
- Form-like detail fields below: "CATEGORY" (all-caps section label) with pill buttons — "Phone" pill shown selected/highlighted (orange fill), an "Other" pill also present.
- "TAGS" section label with pill buttons showing colored dots: "Tax" (blue dot), "Reimburse..." (blue dot, text truncated by overlay).
- "Date" field labeled "December 4, 2024".
- Three placeholder text inputs: "Add notes...", "Select goal...", "Assign to..." — all empty/placeholder state, gray placeholder text.
- "ACTIONS" section label with three blank action rows; the overlay (partially legible through transparency) reveals these are "Split transaction," "Add attachment," and "Delete transaction."
- Bottom bar: "Skip for now" (white/outline button) and "Mark as reviewed" (solid orange button), with a small horizontal drag-handle bar centered between/above them.
- A large orange card is shown rotated ~15° diagonally across the whole screen, containing a white circular checkmark badge and the text "Mark as Reviewed" in white — a static representation of an in-progress swipe gesture/animation.

**Cash Flow / Reports (image 06):**
- Page title "Cash Flow", calendar icon top-right (no date range shown/selected in this crop).
- "Income" section header, then a 3-way column toggle: "CATEGORY" (active/selected, pill-highlighted), "GROUP", "MERCHANT" — lets the same report be viewed grouped three different ways.
- Single income row: 💵 emoji + "Paychecks", entire row rendered as a green-filled bar (100% width, since it's the only income category) with "$4,200 (100.0%)" right-aligned inside/over the bar.
- "Expenses" section header with the same CATEGORY/GROUP/MERCHANT toggle repeated independently for expenses.
- Expense rows are each an emoji + category name on a horizontal bar whose fill length and color saturation (pink/red) is proportional to that category's share of total expense; amount and percentage right-aligned: Mortgage $1,385 (41.1%), Loan Repayment $500 (14.8%), Garbage $320 (9.5%), Home Improvement $208 (6.2%), Insurance $201 (6.0%), Pets $150 (4.4%), Phone $140 (4.2%), Internet & Cable $115 (3.4%), Gas & Electric $108 (3.2%), Electronics $100 (3.0%), Gas $43 (1.3%), Shopping $40 (1.2%), Fitness $40 (1.2%), Restaurants & Bars $20 (0.6%), Taxi & Ride Shares $5 (0.1%), Coffee Shops $5 (0.1%), Entertainment & Recreation -$10 (-0.3%) — this last row has no visible colored bar fill (a negative/credit category renders as a plain, unfilled row).
- Density: 17 expense category rows visible without scrolling in this crop (very high density, single-line rows, no separator lines between rows other than implicit background-color contrast).

**Recurring (image 07):**
- Two overlapping floating cards, no browser/device chrome, laid over an abstract illustrated background (blue and yellow blob shapes).
- "Bills" card: header "Bills" (bold) + "$5,100.00 remaining due >" (muted link) + "..." overflow menu. Rows: icon + merchant/payee name (bold) + cadence ("Every month," muted, second line) on the left; amount (bold) + due countdown ("in 5 days," muted) on the right. Visible: Apple Card $1,250.00 (in 5 days), Sapphire $1,250.00 (partially obscured), Mortgage and Amazon rows present but obscured by the front card.
- "Subscriptions" card (foreground, overlapping the Bills card): header "Subscriptions" + "$59.42 remaining due >" + "..." menu. Rows use the identical layout: Walmart+ $12.95 (in 3 days), Flighty $7.49 (in 6 days), Netflix $22.99 (in 10 days), Disney+ $15.99 (in 15 days).
- Bills and Subscriptions are visually and structurally the same list component, differentiated only by card heading and which merchants populate them — implying "bill" vs "subscription" is a category/classification on a recurring-item record, not a different feature.

**Goals (image 08):**
- Marketing grid (2×2, no device frame): each card is a full-bleed photo with an all-caps label top-left ("BUY A CAR", "BUY A HOME", "COLLEGE FUND", "RETIREMENT"), a bold dollar target below the label ("$10,000", "$150,000", "$25,000", "$1,500,000" respectively), a thin horizontal progress bar near the bottom of the photo, and a small circular institution-logo badge in the bottom-right corner (funding-account indicator). Progress-bar fill is very small on all four (roughly 5–15% filled), consistent with early-stage goals.
- In-app Goals screen: title "Goals", "..." menu, then a vertical list of full-width photographic goal cards using the same label/target/progress-bar/badge layout as the marketing grid: "EMERGENCY FUND" $50,225 (progress bar nearly 100% filled, Chase badge), "DOWN PAYMENT" $15,595 (progress bar ~10% filled, Citi badge), and a third card cut off at the very bottom of the frame (beach-chair photo visible, presumably a Retirement goal).
- Number formatting on goal cards uses whole dollars, no cents (target and current amounts alike).

## Controls inventory
- Sidebar toggle icon (top-left of content area) — collapses/expands the left nav.
- Bell icon — notifications.
- "..." overflow menu — appears on nearly every card and page header (Accounts page, group cards, person cards, Bills card, Subscriptions card, Budget page via calendar icon area, Goals page) — exact menu contents not shown.
- "+" icon (Accounts page header) — presumed "add account."
- Asset-class tab bar: NET WORTH / CASH / INVESTMENTS / REAL ESTATE / VEHICLES / CREDIT CARDS / LOANS — single-select segmented control, "NET WORTH" shown active with pill background.
- Chart time-range selector: 1M / 3M / 6M / 1Y / ALL — single-select, "1M" active with pill background.
- "N accounts >" chevron link on each person card (Collaboration slide) — drilldown affordance.
- Calendar icon (Budget page, Cash Flow page headers) — date/period picker, not shown expanded.
- Budget: chevron/caret toggles on each category-group row — expand/collapse.
- Budget: bordered numeric input box per line item showing the budget amount — implies inline-editable budget values.
- Budget: colored remaining-amount pill per line item (green/red/gray) — status-coded, not directly interactive-looking (no visible chevron/affordance beyond color).
- Budget: "Show N unbudgeted" — eye-icon toggle link, progressive disclosure for zero-budget categories.
- Cash Flow: CATEGORY / GROUP / MERCHANT — three-way segmented toggle controlling report grouping, per Income and Expenses section independently.
- Transaction review: CATEGORY pills (e.g., "Phone" selected, "Other" available) — single-select category chooser.
- Transaction review: TAGS pills with colored dots ("Tax", "Reimburse...") — multi-select tag chooser (colored dot appears to encode tag-type/color).
- Transaction review: "Add notes...", "Select goal...", "Assign to..." — three free-text/picker input fields.
- Transaction review: "Split transaction," "Add attachment," "Delete transaction" — three action rows (icons obscured by overlay).
- Transaction review: "Skip for now" (secondary/outline button) and "Mark as reviewed" (primary/solid orange button) — bulk/queue navigation controls; also achievable via the swipe gesture depicted by the overlay.
- Transaction review: swipe gesture (implied) to mark reviewed, visualized as the diagonal orange overlay card with a checkmark.
- Recurring: "$X remaining due >" links on both Bills and Subscriptions cards — drilldown to full list.
- Goals: progress bar on every goal card (visual only, no obvious edit control shown); circular institution badge (indicates linked/funding account, not clearly interactive here).

## Flow steps
1. Do: open the transaction queue (entry point not shown, reached from Transactions or Dashboard) → See: single-transaction card with merchant name, "N transactions" link, category/tag pickers, and a top "N remaining" counter (image 05 shows "4 remaining").
2. Do: review/edit category, tags, date, notes, goal, assignee for the shown transaction → See: fields populate inline (e.g., "Phone" category pre-selected, "Tax"/"Reimburse..." tags pre-applied, date "December 4, 2024").
3. Do: swipe the transaction card (gesture) OR tap "Mark as reviewed" → See: an orange card with a checkmark icon and "Mark as Reviewed" label sweeps/overlays the transaction card (depicted statically at a diagonal tilt to imply motion).
4. Do (alternative branch): tap "Skip for now" → See: (not shown) presumably advances the queue without marking reviewed — the "N remaining" counter is the only visible undo/state affordance; no explicit undo button is shown in this unit.

## States
- No empty, loading, or error states are visible anywhere in this unit — all 8 images are populated marketing screenshots with realistic-looking sample data (fictional users "Jon" and "Melanie").
- Closest thing to a state indicator: the Budget line-item remaining-pill coloring (green = under/at budget, red = over budget e.g. "-$5" on Mortgage, gray = exactly "$0" e.g. Garbage) and the Accounts group delta arrows (green up-arrow for gains, red down-arrow for the Credit Cards and Loans groups whose balances decreased).
- Placeholder/empty-field copy is visible on the transaction review card: "Add notes...", "Select goal...", "Assign to..." (all unfilled, gray placeholder text) — this is the closest evidence of an "unset field" micro-state.

## Business rules implied
- Net worth is decomposed into asset groups (Cash, Investments, Real Estate, Vehicles) and liability groups (Credit Cards, Loans), each independently showing "N% of assets" or "N% of liabilities" rather than "% of net worth" — implying assets and liabilities are normalized against separate 100% bases (image 01, 02).
- Every linked account carries a last-sync/freshness timestamp shown per row ("11 hours ago", "1 minute ago"), implying sync recency is tracked and surfaced per account, not just per institution (images 01, 02, 03).
- Budget "remaining" is computed as budget minus actual (spent or earned) and can go negative for expense categories (Mortgage "-$5"), meaning overspending is representable and visually flagged in red rather than clamped at zero (image 04).
- Categories with no budget assigned are suppressed from the default view and require an explicit "Show N unbudgeted" disclosure — implying budgeted vs. unbudgeted categories are a distinct, filterable state (image 04).
- Cash Flow expense percentages are computed against total expenses and can be negative when a category nets to a credit/refund for the period (Entertainment & Recreation "-$10 (-0.3%)"), implying refunds reduce a category's net spend below zero rather than being excluded (image 06).
- Recurring items are split into two first-class classifications — "Bills" and "Subscriptions" — each with its own independent "remaining due" total, rather than one unified recurring total (image 07).
- Accounts can be viewed grouped by ownership/person ("Jon", "Melanie" — 4 accounts each) as an alternative to the type-based grouping on the main Accounts screen, implying multi-user/shared-household account scoping is a first-class view (image 03).
- Goals are each backed by a single funding/linked account, shown via one institution-logo badge per goal card, and track progress toward one fixed target dollar amount via a linear progress bar (image 08).
- The transaction review workflow is queue-based with a finite, decrementing count ("4 remaining") rather than an open-ended list, implying a distinct "needs review" backlog concept separate from the general transaction list (image 05).

## Standout details
- The swipe-to-review gesture is communicated in a static marketing image via a large, diagonally-rotated card overlay (checkmark + "Mark as Reviewed") — a clever way to depict motion/gesture in a still screenshot.
- Each feature slide uses a consistent two-line masthead pattern: a short all-caps orange "eyebrow" category label (ACCOUNTS, COLLABORATION, BUDGETING, TRANSACTIONS, REPORTS, RECURRING, GOALS) followed by a larger serif/italic-mixed headline (e.g., "All of your accounts in one *clear* view") — the italic word is always the emotionally-loaded one (clear, team, flexibility, swipe, automatically, together, progress).
- The "% of assets" / "% of liabilities" secondary metric is set off from the primary dollar figure with a short dotted underline — a subtle typographic device that de-emphasizes the proportion metric relative to the bolded dollar amounts.
- Cash Flow category rows double as an inline bar chart: the row background itself is the proportional bar (color-coded pink/red, saturation/length tied to share of spend), merging list and chart into one visual element rather than separate row + separate chart (image 06).
- Category iconography throughout Budget and Cash Flow uses plain emoji (💵, 🏠, 🐾, ☂️, 🔨, 🗑️, 📱, 🌐, ⚡, 🖥️, ⛽, 🛍️, 🧘, 🍽️, 🚕, ☕, 🎭) rather than a custom icon set — likely lower design lift, but also user-recognizable/personalizable at a glance.
- The awards/laurels hero slide (image 01) attributes each accolade to a named, dated source (Wall Street Journal 2024, Forbes 2024, Motley Fool 2024, Business Insider 2024) rather than a generic "Award Winning" claim — specific and checkable social proof.
- The "Show N unbudgeted" disclosure uses an eye icon specifically (rather than a generic chevron), reinforcing a "reveal hidden/unwatched items" metaphor distinct from the expand/collapse chevrons used for category groups.
- Bills and Subscriptions are given separate, symmetrical card components with independent "remaining due" totals even though they are structurally identical, suggesting a semantic (not just visual) split between debt-like recurring obligations and elective recurring services.

## Open questions
- Whether "Skip for now" and the swipe gesture map to the same underlying action or two different queue-advance semantics (e.g., "skip" might requeue later while swipe/"Mark as reviewed" permanently dismisses) — not settled by the image.
- Exact contents of every "..." overflow menu (Accounts page, group cards, person cards, Bills/Subscriptions cards, Goals page) are never shown open/expanded.
- What the "+" icon on the Accounts page header adds (new account vs. new group vs. manual transaction) is not shown.
- Whether the green "Left to budget" banner changes color/copy when the amount is negative (over-allocated) — only the positive/green state is shown (image 04).
- The institution-logo badge on the "BUY A CAR" goal card is a red circle with white letters that could read "WF" (possibly Wells Fargo) but is small and low-contrast in this crop — not confidently legible.
- Dollar figures for the same fictional account are inconsistent across slides (e.g., "Apple Card" shows a $1,000.00 balance in the Collaboration slide (image 03) but a $1,250.00 monthly bill amount in the Recurring slide (image 07)) — almost certainly separate unrelated demo datasets assembled for different marketing slides rather than a real product behavior; flagged so no rule is inferred from it.
- Whether "Cash Flow" is formally the same feature as "Reports," or whether a distinct Reports destination exists elsewhere in the product, is inferred but not directly confirmed — the "REPORTS" slide heading pairs with the sidebar's "Cash Flow" item being highlighted, with no separate "Reports" nav entry visible in any screenshot in this unit.
- Full sidebar/nav might contain more items below "Investments" that scroll out of frame; no screenshot shows the sidebar's lower edge or a scroll affordance on it.
- Precise iconography/labels behind the "ACTIONS" section on the transaction review card ("Split transaction," "Add attachment," "Delete transaction") are only legible through a semi-transparent overlay, not directly — copy is probably accurate but rendering (icons, exact order) is uncertain.
