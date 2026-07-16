# Census — monarch-iphone-02

## Evidence
- `design/references/monarch/iphone-09-Frame_1400002680.png` → App Store marketing slide, "CASH FLOW" theme, genuine iPhone-frame screenshot of the Cash Flow screen (bar/line chart + June 2025 Income/Expenses/Savings summary rows).
- `design/references/monarch/iphone-10-8-goals.png` → App Store marketing slide, "GOALS" theme: top half is a 2×2 grid of photo goal cards (not device chrome); bottom half is an iPad-frame screenshot of the Goals list (sidebar nav + Emergency Fund / Down Payment goal rows).
- `design/references/monarch/iphone-11-4-budgeting.png` → App Store marketing slide, "BUDGETING" theme, iPad-frame screenshot of the Budget screen for December 2024 (Left to budget banner, Income/Expenses summary bars, category groups with sub-rows).
- `design/references/monarch/iphone-12-3-collaboration.png` → App Store marketing slide, "COLLABORATION" theme (headline "Manage your money as a team"): top is a non-device graphic of two linked per-person account cards (Jon / Melanie); bottom is a partial iPad-frame screenshot of the Accounts/Net Worth screen (Net Worth chart, Cash section).
- `design/references/monarch/iphone-13-Frame_1400002682.png` → App Store marketing slide, "COLLABORATION" theme (headline "Manage money together. No drama.", Motley Fool "Best App for Couples" 2024 award badge): lifestyle photo with a floating "Shared / Melanie / Jon" scope-toggle card and a floating Net Worth summary card (Joint Checking, Davis Savings). No device chrome.
- `design/references/monarch/iphone-14-10-security.png` → App Store marketing slide, "PRIVACY" theme, headline "Bank-level security": pure copy/iconography, no app screenshot at all.
- `design/references/monarch/iphone-15-5-transactions.png` → App Store marketing slide, "TRANSACTIONS" theme, headline "Review transactions with a swipe": iPad-frame screenshot of a transaction-review detail pane (Verizon, category/tags/date/notes/goal/assign fields, Actions list) with a large diagonal "Mark as Reviewed" swipe-gesture graphic overlaid, and "Skip for now" / "Mark as reviewed" buttons at the bottom.
- `design/references/monarch/iphone-16-9-dark-mode.png` → App Store marketing slide, "CUSTOMIZE" theme, headline "Light & dark mode": iPad-frame screenshot of the Accounts screen in dark theme (Net Worth chart, Cash/Investments/Real Estate/Vehicles sections).

Note on framing: despite the manifest grouping this unit under "iphone", only iphone-09 is an actual iPhone-chrome screenshot; iphone-10, -11, -15, -16 are iPad-chrome screenshots, and iphone-12, -13, -14 use no device chrome at all (lifestyle photography / floating cards / plain copy). This is itself worth flagging to downstream analysts (see Open questions).

## Information architecture
Every device screenshot in this unit that shows a sidebar (iphone-10, -11, -15, -16) shows the identical left-rail nav, in this fixed order, each with an icon:
1. Monarch logo + wordmark (top, with a settings gear icon at top-right of the rail)
2. Dashboard (house icon)
3. Accounts (stacked-layers icon)
4. Transactions (card icon)
5. Cash Flow (bar-chart icon)
6. Budget (map/folded-map icon)
7. Recurring (calendar icon)
8. Goals (circular target icon)
9. Investments (trending-up arrow icon)

The active section is shown with a light-gray (light theme) or dark-highlighted (dark theme) row background — e.g. "Budget" highlighted in iphone-11, "Dashboard" highlighted in iphone-15 (even though the visible content pane shows a transaction-review flow, implying transaction review is reachable from/nested under Dashboard), "Accounts" highlighted in iphone-12 and iphone-16.

The one true iPhone screenshot (iphone-09) shows a bottom tab bar with only 5 icons, in the same left-to-right order as the first 5 sidebar items: home (Dashboard), layers (Accounts), card (Transactions), bar-chart (Cash Flow, shown bolded/selected — consistent with the visible screen being Cash Flow), map (Budget). Recurring, Goals, and Investments are not present in this 5-icon bar, implying they live behind an additional affordance on phone (a "More" tab, a hamburger menu, or similar) — not directly evidenced.

Within Transactions (iphone-15), a single transaction opens a detail/review pane with its own sub-structure: merchant identity header → "N transactions →" link to all transactions from that merchant → Category picker → Tags picker → Date field → Notes field → Goal picker → Assign-to picker → Actions list (Split / Add attachment / Delete). This detail pane appears to be presented in a review queue context ("4 remaining" header, Skip/Mark-as-reviewed footer), meaning the transaction detail editor doubles as the review-queue item view.

Goals (iphone-10) is both a marketing-grid concept (2×2 image cards) and, in the actual product screenshot, a vertical list of full-bleed photo cards with progress bars — one goal per row rather than a grid, when shown inside the real app on iPad.

Net Worth / Accounts (iphone-12, iphone-16) organizes by a horizontal segmented tab row (NET WORTH selected, then CASH, INVESTMENTS, REAL ESTATE, VEHICLES, CREDIT CARDS, LOANS) sitting above a single combined trend chart, with the account list below grouped into matching sections (Cash, Investments, Real Estate, Vehicles), each section carrying its own subtotal and % of assets.

## Layout & content
**Cash Flow (iphone-09, iPhone):** Screen title "Cash Flow" centered at top. Combo chart: 4 months (MAR, APR, MAY, JUN) each with a green bar (income) above a shared baseline and a pink/red bar (expenses) below it, plus a black line (implied net trend) drawn across the tops of the income bars. The current month (JUN) is rendered in a more saturated green/red than the three prior (muted) months — a clear "this month is different" visual cue. Below the chart, a bold section header "June 2025", then three summary rows, each with a status dot to the left of the label and the amount right-aligned:
- ● (green dot) "Income" — $7,676 in green text
- ● (red dot) "Expenses" — $5,198 in red text
- ○ (hollow/outline dot) "Savings" — $2,478 in bold black text, with a thin dashed rule directly above the amount (visually marking it as a derived/subtotal line: Income − Expenses)
A cut-off "Income" sub-list header appears at the very bottom of the visible frame, implying the screen continues into an income breakdown.

**Goals grid (iphone-10, marketing only):** 4 cards, 2×2, each a full-bleed photo with a bold caps micro-label (BUY A CAR / BUY A HOME / COLLEGE FUND / RETIREMENT) and a large dollar figure directly beneath — the amount is the goal target, not current progress. A thin white progress bar sits at the very bottom edge of each card; visually all four are near-empty except a nub of fill at the left edge. Each card also carries one or two small circular account-source badges (bank/brokerage logos) in the bottom-right corner, e.g. "WF" (Wells Fargo) on Buy a Car, two overlapping badges on Buy a Home, "V" (Vanguard, red) on College Fund, sun-logo + "V" on Retirement — indicating which linked account(s) fund each goal.

**Goals list (iphone-10, iPad app):** Header "Goals" with a "•••" overflow menu top-right. Rows are full-bleed photo cards (taller than the marketing grid's, one per row):
- "EMERGENCY FUND" — $50,225, progress bar ~90% filled, one circular badge (blue, plain glyph)
- "DOWN PAYMENT" — $15,595, progress bar ~10% filled, one circular badge "citi"
A third card (beach photo, presumably Retirement) is cut off at the bottom of frame.

**Budget (iphone-11, iPad):** Header row: "December 2024" centered, with a sidebar-toggle icon and bell icon at left, "•••" overflow and a calendar icon at right. Immediately below, a full-width green banner: "Left to budget ⓘ" (label + info icon, left) and "$4,640" (bold, right, white-on-green). Below that, two summary blocks:
- "Income" (left) / "$8,410 budget" (right, gray caption) with a green horizontal progress bar partially filled (~50%); below the bar, "$4,200 earned" (left) and "$4,210 remaining" (right)
- "Expenses" (left) / "$3,770 budget" (right) with an orange/red progress bar mostly filled (~90%); below, "$3,371 spent" (left) and "$399 remaining" (right)
Then a full budget table, organized as collapsible category groups (chevron-down icon) each followed by line-item sub-rows, with two right-aligned numeric columns captioned "Budget" and "Remaining":
- Income group: $8,410 / $4,210 → sub-items "💵 Paychecks" (budget box "$8,400", remaining "$4,200" in a green pill) and "💰 Interest" ("$10" / "$10" green pill); "👁 Show 2 unbudgeted" link below
- Expenses, "Gifts & Donations" group: $50/$50 → "🎗️ Charity" $50/$50 green pill; "Show 1 unbudgeted"
- "Auto & Transport" group: $580/$532 (black text, i.e. partially spent) → "🚗 Auto Payment" $580/$580 green pill; "Show 5 unbudgeted"
- "Housing" group: $1,600/$7 (nearly exhausted) → "🏠 Mortgage" $1,380 budget-box / "-$5" in red text (over budget — negative remaining); "🔨 Home Improvement" $220/$12 green pill; "Show 1 unbudgeted"
- "Bills & Utilities" group: $690/$7 → "🗑️ Garbage" $320 budget box, row cut off at bottom, progress bar nearly full/dark
Every budgeted line item shows its budget amount in a bordered editable-looking box and its remaining amount in a colored pill (green = money left, red text with minus sign = overspent). Category groups mix income and expense line items with emoji glyphs as category icons.

**Collaboration / per-person accounts (iphone-12, marketing):** Two round profile photos (one man, one woman) with concentric ring halos, connected by curved arrows pointing down to two side-by-side account cards:
- "Jon" header, "•••" menu, "4 accounts >" link. Rows (icon, name, type subtitle, amount right, "1 minute ago" timestamp below amount): Apple logo "Apple Card" / Credit Card / $1,000.00; Chase logo "Sapphire" / Credit Card / $1,250.00; purple "a" logo "Ally Savings" / Savings / $50,000; Chase logo "Amazon" / Credit Card / $100.00.
- "Melanie" header, "•••" menu, "4 accounts >" link. Rows: Amex logo "Savings" / Savings / $10,000.00; green leaf logo "Stocks" / Brokerage / $25,000.00; Coinbase "C" logo "Coinbase" / Crypto / $7,500.00; Zillow "z" logo "Our Home" / Real Estate / $250,000.00.
All 8 amounts and all "1 minute ago" timestamps are formatted identically and right-aligned in two columns (amount, then timestamp beneath it) — this is a deliberately staged/synthetic demo dataset (round numbers, uniform timestamps).

**Net Worth / Accounts, light (iphone-12, iPad app peek):** Tab row NET WORTH (selected) / CASH / INVESTMENTS / REAL ESTATE / VEHICLES / CREDIT CARDS / LOANS. Big total "$686,989.93", green up-arrow line "$22,292.97 (3.4%) 1 month" beneath it. Line chart (light blue fill under a blue line), generally upward with one visible dip, then a time-range row: 1M (selected) / 3M / 6M / 1Y / ALL. Below the chart, "Cash" section: green up-arrow "$649.70 (1%) 1 month" (left) and, right-aligned, the bold section subtotal "$65,819.70" with a smaller gray "7% of assets" line directly beneath it. First account row: citi logo, "Melanie's Checking" / "Checking", "$15,594.64", "11 hours ago".

**Collaboration, no-drama (iphone-13, marketing):** Light blue background, gray (not orange) "COLLABORATION" eyebrow — the only slide in this unit whose eyebrow is not orange. Laurel-wreath icons flank "Best App for Couples" / "Motley Fool, 2024" (third-party award citation used as social proof). Lifestyle photo of two adults and a child. Floating card over the photo: a 3-way segmented toggle — "Shared" (orange filled circle, overlapping-rings/venn icon, appears selected/highlighted) — "Melanie" (avatar) — "Jon" (avatar) — this is an account-scope switcher for viewing combined vs. individual finances. Below it, a floating "Net Worth" card: label "Net Worth" (gray caption) then "$568,356.49" (large bold black), a divider, then two account rows: Chase logo "Joint Checking" / masked account "•••••521" / "$36,552.45" / "5 minutes ago"; flag-logo "Davis Savings" / "•••••970" / "$17,233.12" / "9 minutes ago". Masked last-4 account numbers appear directly under the account name, left column, while amount and relative timestamp stack in the right column.

**Privacy (iphone-14, marketing only, no app UI):** Headline "Bank-level security" (serif, no italics used anywhere in this slide, unlike every other slide in the unit which italicizes one phrase in the headline). Three vertically stacked icon+copy blocks, each a colored circle with a white glyph directly above a two-line centered statement:
- Orange circle, padlock glyph → "Login details are never stored and bank access is read-only"
- Teal circle, phone/device glyph → "Multi-factor authentication for added security"
- Yellow circle, "X" glyph → "We'll never sell your data or service you ads"

**Transactions review (iphone-15, iPad app):** Header: back arrow, centered "4 remaining" (a review-queue counter), a partially visible "Join…" badge cut off at top-right (likely a "Joint" account tag). Content card: building icon placeholder, "Verizon" (bold merchant name), "12 transactions →" (blue, tappable link to all transactions from this merchant). Fields, each with a small-caps gray label: "CATEGORY" → pill buttons "📱 Phone" (shown selected/outlined) and a second pill obscured by the overlay graphic; "TAGS" → pills "🔵 Tax" and "🔵 Reimburse…" (cut off); "Date" bordered field "December 4, 2024"; "Add notes…" placeholder text field; "Select goal…" placeholder field; "Assign to…" placeholder field; "ACTIONS" label over what the underlying (ghosted, overlay-obscured) layer shows as "⤴ Split transaction", "📎 Add attachment", and "Delete transaction" rows. A large diagonal orange banner is overlaid across the whole card, showing a white circular checkmark icon and the caption "Mark as Reviewed" — illustrating the swipe-to-review gesture. Below the card, two full-width buttons: "Skip for now" (outline/white) and "Mark as reviewed" (solid orange, visually primary), and a thin horizontal scrub/progress indicator at the very bottom (dark segment on the left portion of the bar, implying position within the review queue).

**Dark mode / Accounts (iphone-16, iPad app, dark theme):** Header row: sidebar-toggle icon, bell icon, centered title "Accounts", "•••" overflow, "+" add-account button (top-right). Tab row identical to the light version: NET WORTH (selected pill) / CASH / INVESTMENTS / REAL ESTATE / VEHICLES / CREDIT CARDS / LOANS. "$686,989.93" (white bold) with green "$22,292.97 (3.4%) 1 month" beneath — same figures as iphone-12's light-mode peek, confirming both marketing slides share one demo dataset. Chart: teal line with gradient fill on near-black background, same trend shape as the light version. Time range row 1M (selected)/3M/6M/1Y/ALL. Section-by-section subtotal pattern repeats exactly as described for iphone-12:
- "Cash": +$649.70 (1%) 1 month / $65,819.70, "7% of assets" — rows: citi "Melanie's Checking" (Checking) $15,594.64, 18 hours ago; Chase-logo "Joint Savings" (Savings) $50,225.06, 18 hours ago
- "Investments": +$10,600.90 (2%) 1 month / $542,032.32, "58% of assets" — rows: green-sun "Jon's 401k" (401k) $180,684.29; green-sun "Melanie's 401k" (401k) $150,141.42; red "V" "Melanie's IRA" (Individual Retirement Account (IRA)) $200,737.82; green-leaf "Brokerage" (Brokerage (Taxable)) $10,468.79 — all "18 hours ago"
- "Real Estate": +$5,909.99 (2%) 1 month / $300,054.83, "32% of assets" — row: Zillow "z" "Home" (Primary Home) $300,054.83, 18 hours ago
- "Vehicles": +$102.89 (0.5%) 1 month / $20,330.80, "2% of assets" — row: car icon "Honda CR-V" (Car) $20,330.80, 18 hours ago
Density: every account row is exactly 2 lines (name+type on the left, amount+relative-timestamp on the right); section headers are exactly 2 lines (delta% + label, subtotal + "% of assets"). Numbers are consistently formatted as "$X,XXX.XX" (two decimal places) throughout Accounts/Net Worth screens, vs. Budget and Cash Flow screens which show whole-dollar amounts with no decimals ("$4,640", "$7,676"). Percent-of-assets and month-over-month delta lines are always gray/muted secondary text directly under or beside the bold primary figure.

## Controls inventory
- Sidebar nav items (Dashboard, Accounts, Transactions, Cash Flow, Budget, Recurring, Goals, Investments) — each a clickable row with icon + label; current section shown with a filled/highlighted row background.
- iPhone bottom tab bar (5 icons: Dashboard, Accounts, Transactions, Cash Flow, Budget) — selected tab (Cash Flow) shown bolded.
- Settings gear icon (top of sidebar, next to Monarch wordmark).
- Sidebar-toggle icon and bell (notifications) icon — top-left of main content header, present on Budget, Transactions-review, and Dark-mode Accounts screens.
- "•••" overflow menu — appears on Budget header, Goals header, Accounts header, and on the per-person "Jon"/"Melanie" cards.
- Calendar icon — top-right of Budget header (month picker, implied).
- "+" add button — top-right of Accounts header (add account, implied).
- Time-range segmented control on Net Worth chart: 1M / 3M / 6M / 1Y / ALL, single-select pill style.
- Account-type tab row on Accounts screen: NET WORTH / CASH / INVESTMENTS / REAL ESTATE / VEHICLES / CREDIT CARDS / LOANS, single-select.
- "N accounts >" link (per-person card) — drills into that person's full account list.
- "N transactions →" link (transaction-review card) — drills into all transactions for that merchant.
- Category pill buttons ("Phone", "Other" visible) on the transaction-review card — appear to be single-select chips, one shown active/outlined.
- Tag pills ("Tax", "Reimburse…") — appear multi-select (both shown simultaneously applied).
- Date field, Notes field, "Select goal…" field, "Assign to…" field — all editable/tappable form controls with placeholder text when empty.
- Actions list on transaction detail: "Split transaction", "Add attachment", "Delete transaction" (destructive action listed alongside neutral ones, no visual distinction such as red text observed, though the overlay makes exact styling hard to confirm).
- Swipe-to-review gesture (illustrated, not a static control) — swiping a transaction row triggers "Mark as Reviewed".
- "Skip for now" / "Mark as reviewed" footer buttons on the transaction review screen — Skip is outline/secondary style, Mark as reviewed is solid-orange/primary style.
- Collapsible category-group chevrons on the Budget screen (chevron-down icon per group row).
- Editable budget-amount boxes per line item (bordered rectangle showing a dollar figure, implying tap-to-edit).
- "Show N unbudgeted" expandable links (eye icon) under each budget category group — reveal categories with activity but no assigned budget.
- Remaining-amount status pills: green pill = remaining/unspent, red text with a leading minus = overspent (e.g. "-$5" on Mortgage).
- Account-scope segmented toggle on the Collaboration/no-drama slide: "Shared" / "Melanie" / "Jon" — lets the viewer filter net worth to combined or single-person view.
- Goal progress bars (thin, bottom-of-card) on both the marketing grid and the real Goals list — visual-only in the screenshots (no interaction shown), fill level appears to encode current-progress vs. target.
- Per-account/per-goal source badges (small circular bank/brokerage logos) — indicate which linked institution funds an account or goal; some goals show two overlapping badges (implying an aggregate/multi-source funding indicator).

## Flow steps
Transaction review, inferred from iphone-15 (single frame, but the UI encodes a queue flow):
1. Do: open a flagged/unreviewed transaction from the review queue → See: detail pane for the transaction (merchant, "N transactions" link, category/tags/date/notes/goal/assign fields, actions list) plus a header counter "4 remaining" showing how many are left in the queue.
2. Do: adjust category/tags/notes/goal/assignee as needed (optional, since a default state already shows "Phone" category and "Tax"/"Reimburse" tags pre-filled or previously set).
3. Do: swipe the row (or tap "Mark as reviewed") → See: an orange "Mark as Reviewed" confirmation graphic sweeps across the card; the queue counter presumably decrements and advances to the next transaction (not directly evidenced — single frame only).
   Alternative: Do: tap "Skip for now" → See: (inferred) the transaction is left unreviewed and the queue advances without marking it reviewed.
No explicit undo affordance is visible in this frame for a mark-as-reviewed action.

## States
- Budget over-spent state: "Mortgage" row remaining shown as "-$5" in red text — a concrete example of a negative-remaining / overspent line item within an otherwise fully-budgeted group.
- Budget partially-filled progress state: Income progress bar ~50% filled ("$4,200 earned" of "$8,410 budget"); Expenses progress bar ~90% filled ("$3,371 spent" of "$3,770 budget") — bars visually communicate proportion consumed/earned relative to target.
- Goal near-empty progress state: all 4 marketing-grid goal cards show progress bars filled only a sliver at the left edge, despite large target amounts, implying these are freshly-created/aspirational goals in the demo data (contrast with the real-app Goals list where "Emergency Fund" shows ~90% filled).
- Transaction review "in-progress" state: header counter "4 remaining" — a numeric countdown state for a review queue, not zero/empty.
- "Show N unbudgeted" — a collapsed/hidden state for categories with unbudgeted activity, requiring an explicit tap to reveal; exact copy is "Show 2 unbudgeted", "Show 1 unbudgeted" (used twice), "Show 5 unbudgeted".
- No empty, loading, or error states are visible anywhere in this unit — all 8 images show populated marketing/demo data or pure copy slides.

## Business rules implied
- Overspending a budget category renders the remaining amount as a negative, red-text figure rather than clamping at zero — evidenced by "Mortgage" showing "-$5" remaining in `iphone-11-4-budgeting.png`.
- Budget remaining amounts are visually differentiated by sign: green pill = non-negative remaining, red text = negative/overspent — evidenced across every sub-row in `iphone-11-4-budgeting.png`.
- A "Savings" line (Income − Expenses) is computed and displayed as a distinct summary row separate from Income and Expenses, marked with a dashed rule to indicate it's derived — evidenced in `iphone-09-Frame_1400002680.png`.
- Categories/budget line items can exist with recorded activity but no assigned budget amount, and are hidden by default behind a "Show N unbudgeted" toggle rather than shown inline — evidenced repeatedly in `iphone-11-4-budgeting.png`.
- Accounts and goals can be linked to more than one funding/source institution simultaneously (multiple overlapping badges on a single goal card) — evidenced by the "Buy a Home" and "Retirement" cards in `iphone-10-8-goals.png`.
- Net worth is broken into mutually exclusive top-level groups — Cash, Investments, Real Estate, Vehicles, Credit Cards, Loans — each with its own subtotal, month-over-month delta, and "% of assets" figure, summing conceptually to the overall Net Worth total — evidenced identically in `iphone-12-3-collaboration.png` and `iphone-16-9-dark-mode.png`.
- Individual accounts can be attributed to a specific household member (Jon vs. Melanie) while still rolling up into a combined household Net Worth view, with an explicit "Shared / [Person A] / [Person B]" scope toggle to switch between combined and individual perspectives — evidenced by `iphone-12-3-collaboration.png` and `iphone-13-Frame_1400002682.png`.
- Bank access is described as read-only and credentials are described as never stored by the product itself — evidenced by exact copy in `iphone-14-10-security.png`: "Login details are never stored and bank access is read-only."
- A transaction can simultaneously carry one category, multiple tags, a note, a linked goal, and an assigned household member, plus support split/attachment/delete actions — evidenced by the field set in `iphone-15-5-transactions.png`.
- Transaction review is modeled as a queue with a remaining-count, and each item can be actioned via "Mark as reviewed" or explicitly "Skip for now" (skip is a first-class alternative to marking reviewed, not merely a back/cancel) — evidenced in `iphone-15-5-transactions.png`.

## Standout details
- The "this month" bar highlight on Cash Flow (iphone-09): the current month's income/expense bars are rendered in a distinctly more saturated color than prior months, giving an at-a-glance "you are here" cue on a multi-month chart without any text label.
- The dashed rule above the "Savings" row on Cash Flow visually signals "this is a computed subtotal, not a raw category" — a lightweight convention for derived figures worth reusing.
- "% of assets" as a secondary line under every Net Worth section subtotal (Cash, Investments, Real Estate, Vehicles) — gives portfolio-composition context for free, right where the number already lives.
- Swipe-to-review is illustrated directly in the App Store marketing image itself (giant diagonal "Mark as Reviewed" banner) rather than only described in text — a strong example of "show the gesture, don't just say it."
- The Skip/Mark-as-reviewed pairing on the review screen treats "I looked at it and chose not to act" as distinct from "I approved it" — two named exits from a queue item instead of one.
- Masked account numbers ("•••••521") shown directly beneath the account name on the Joint Checking / Davis Savings rows in `iphone-13-Frame_1400002682.png` — a compact way to disambiguate multiple accounts at the same institution without full numbers.
- Per-person account cards (Jon / Melanie) with independent "N accounts >" drilldowns, shown as siblings under one collaboration graphic — a clean pattern for shared-household finance without collapsing individual ownership.
- Third-party award citation used as in-product social proof copy ("Best App for Couples — Motley Fool, 2024") laid directly into the marketing screenshot with a laurel-wreath icon, not just relegated to a press page.
- Every headline across the unit italicizes exactly one word or phrase for emphasis (e.g. "See where *every dollar* flows.", "Budget with ultimate *flexibility*", "Manage your money as a *team*") except the Privacy slide ("Bank-level security"), which uses no italics at all — a possible deliberate signal that security copy should read as plain, unembellished fact rather than persuasive copy.

## Open questions
- Whether the "4 remaining" transaction-review queue advances automatically to the next item after Mark-as-reviewed/Skip, and whether marking-as-reviewed is undoable, is not shown — only a single static frame is evidenced.
- The exact destination of Recurring, Goals, and Investments on the iPhone form factor is unresolved: the one true iPhone screenshot (iphone-09) shows only a 5-icon tab bar (Dashboard, Accounts, Transactions, Cash Flow, Budget) with no visible "More" affordance, so whether those three sections exist on iPhone at all, and if so how they're reached, is not evidenced by this unit.
- The obscured second category pill and second tag pill in `iphone-15-5-transactions.png` (partially hidden by the overlay graphic) cannot be read; their exact labels are unknown.
- Whether "Assign to…" on a transaction assigns to a household member, a category owner, or something else is inferred from context (household collaboration is a major theme elsewhere in this unit) but not directly confirmed by the image itself.
- The precise semantics of the "Housing" group showing "$1,600 / $7" remaining while its only visible non-negative sub-item ("Home Improvement", $12 green) and one negative sub-item ("Mortgage", -$5) don't obviously sum to $7 cannot be fully reconciled — a "Show 1 unbudgeted" row is present and likely holds the reconciling item(s), but its content isn't shown.
- Whether the Actions list on the transaction detail ("Split transaction" / "Add attachment" / "Delete transaction") has any special (e.g. red/destructive) styling for Delete could not be confirmed because that region is beneath the orange swipe-gesture overlay in the only image showing it.
- The exact icon glyph inside the blue circular badge on the "Emergency Fund" goal row (iphone-10) is too small/low-detail in this rendering to identify beyond "a plain white glyph on blue."
