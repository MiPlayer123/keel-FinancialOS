# Census — quicken-simplifi-web-01

## Evidence
- `design/references/quicken-simplifi/web-01.png` → A single promotional/marketing composite image (not a raw in-app capture): the Quicken/Simplifi wordmark logo lockup on a light lavender background, next to two overlapping smartphone device-mockup frames. The rear phone shows a "Savings Goals" list screen (partially occluded by the front phone); the front phone shows a "Banking" home/dashboard screen with account totals, a "Recent Spending" widget, and the top of a "Top Spending" widget.

## Information architecture
- This is a marketing collage, so navigation chrome is only partially inferable:
  - Rear phone ("Savings Goals" screen): top-left has a back chevron `<`, implying this screen is reached by drilling in from a parent list/tab (e.g., a "Goals" tab) rather than being a root screen.
  - Front phone ("Banking" screen): top-left has a hamburger/menu icon (☰), top-right has a person/profile icon — implying a slide-out drawer or global nav menu plus an account/profile entry point, both one tap away from this home screen.
  - No bottom tab bar is visible in either crop, so the primary nav model (tabs vs. drawer vs. both) cannot be determined from this image alone.
  - On the "Banking" screen, content is vertically stacked in stacked "widget" sections in this order top to bottom: Banking (account-group totals) → Recent Spending (transaction list with "See More") → Top Spending (category breakdown, cut off after first row). This suggests a single scrollable home dashboard composed of independent modules rather than separate top-level pages.
  - On the "Savings Goals" screen, goals are stacked as individual cards in a vertical list (Summer vacation → Renovation → Emergency fund, in that order, with more implied below since Emergency fund's card is cut off at the bottom edge).

## Layout & content
- **Rear phone — "Savings Goals" screen:**
  - Header: large bold title "Savings Goals" with a lighter-weight subheading below it, "These are the items you are saving towa[rd]…" (truncated by the front phone's occlusion — exact remaining wording not visible).
  - Card 1 — "Summer vacation": small circular icon (green background, plant/palm-tree-style glyph) to the left of the title text "Summer vacation". Below the title, a horizontal progress bar — teal/turquoise fill on the left, a thin purple/indigo segment marker further right, with "46%" printed just to the right of the bar. Below the bar, centered caption "$920 saved so far". Below that, a three-line legend, each line a small colored square swatch + label: teal swatch "Available $920", purple swatch "Spent $100", pale/light swatch "Left to save $1,080". To the right of the legend (partially occluded) is additional text beginning "🎯 Goal $2…" and "Expecte…" (both truncated).
  - Card 2 — "Renovation": circular icon (tan/brown background, tool/hammer-style glyph) + title "Renovation". Progress bar is teal and appears mostly filled (roughly 80%+ visually) with a truncated percentage label "8…" at the right edge of the bar. Caption below, truncated: "$4,600 saved …" (rest not visible). Legend: teal "Available $4,600", purple "Spent $0", pale "Left to save $1,000". Right-side text again truncated ("Goal $…", "Expecte…").
  - Card 3 — "Emergency fund": circular icon (purple/indigo background, gear-style glyph) + title "Emergency fund". Progress bar teal-filled with "70%" label at the right end; the card is cut off by the bottom edge of the image immediately after the bar, so its saved-amount caption and legend (if any) are not visible.
  - Every money figure on this screen sits directly beside or under an explicit status word — "Available", "Spent", "Left to save", "saved so far" — money is never shown unlabeled.
  - Number formatting: dollar sign prefix, comma thousands separator, no decimals shown on this screen (e.g., "$920", "$4,600", "$1,080") — contrasts with the front phone's screen, which does show cents.

- **Front phone — "Banking" screen:**
  - Top band: solid indigo/purple background panel. Label "Banking" (small, regular weight) directly above a large bold total "$8,462.75". Below that, four sub-rows, each a label left-aligned / amount right-aligned pair, all in white text on the purple field:
    - "Cash & Checking" — "$4,315.82"
    - "Credit" — "-$1,553.07" (only negative figure in the image; sign shown as a leading minus, not parentheses; rendered in the same white color as the positive rows, so no color-coding is evidenced here for negative values)
    - "Savings" — "$5,700.00"
    - "Other Banking" — "$0.00"
  - Second band: white/light card, header row "Recent Spending" (left, bold) and "$335.08" (right, bold) — the total for the period. Directly under the header, smaller gray subheading "Friday - Today" (an explicit date-range scope label sitting right under the aggregate figure it qualifies).
  - Below that, a list of transaction rows, each with: merchant name (bold, left), category (smaller, gray, directly under merchant name), amount (bold, right-aligned), and date (smaller, gray, directly under the amount, right-aligned):
    - "Central Cafe" / "Dining & Drinks" — "$80.59" / "Jun 23"
    - "Winemaker" / "Dining & Drinks" — "$77.00" / "Jun 20"
    - "Sportmart" / "Hobbies" — "$150.15" / "Jun 20"
  - A horizontal divider, then a centered link-styled text "See More" in the indigo/purple brand color.
  - Third band begins: white card header "Top Spending" (bold), then the start of a row: a thin vertical purple bar/indicator to the left of "Rent" — the amount for this row is cut off by the bottom edge of the image and not legible.
  - Density: 3 of presumably more transaction rows shown before "See More" (i.e., summary list capped at 3 with progressive disclosure), and only 4 account-group subtotal rows for the whole "Banking" total (a grouped/aggregate view, not the full account list — individual bank accounts are not itemized here, only categories: Cash & Checking, Credit, Savings, Other Banking).
  - Alignment: on the front-phone screen, every money amount is right-aligned against its row while its label/category/date sits left-aligned (transactions) — consistent two-column money-right layout throughout.
  - Number formatting on this screen always shows two decimal places (e.g., "$4,315.82", "$0.00", "$150.15"), unlike the goals screen which shows whole dollars only.

## Controls inventory
- Back chevron `<` (top-left, rear phone) — apparent action: navigate back to a prior screen (likely a goals list or dashboard).
- Hamburger/menu icon ☰ (top-left, front phone) — apparent action: open a navigation drawer/menu.
- Profile/person icon (top-right, front phone) — apparent action: open account/profile settings.
- "See More" (centered text link, indigo color, front phone) — apparent action: expand/navigate to the full Recent Spending transaction list.
- Progress bars (3 visible, rear phone) — visual-only in this image; no visible affordance (handle, button) suggesting direct manipulation, so likely read-only indicators rather than interactive sliders.
- Legend swatches (colored squares next to "Available / Spent / Left to save") — appear to be static legend labels, not toggles, in this image.
- No visible filters, sort controls, bulk-select checkboxes, or explicit badges-with-meaning in this image (e.g., no "recurring" or "pending" tags on any transaction).

## Flow steps
N/A — this is a single static marketing composite of two independent screens, not a captured multi-step task sequence. The back chevron on the rear phone implies a drill-down relationship (some parent screen → "Savings Goals"), but the parent screen and the tap that produced it are not shown.

## States
- Only a populated/"success" state is visible for both screens (goals with nonzero progress; accounts with nonzero and one negative balance; transactions present). No empty, loading, or error state is shown or can be quoted from this image.

## Business rules implied
- A savings goal decomposes into three tracked money buckets shown together on one bar: "Available", "Spent", and "Left to save" — implying the product distinguishes money already set aside (available) from money spent out of that set-aside amount, separate from the amount still needed to hit the goal target (image: `community/../web-01.png`, Summer vacation / Renovation cards).
- Each goal card pairs a percentage-complete figure with a plain-language caption ("$X saved so far") rather than showing only the percentage or only the dollar amount — both are surfaced together (Summer vacation, Renovation, Emergency fund cards).
- The top-level "Banking" total is a sum across sub-groups by account type/category (Cash & Checking, Credit, Savings, Other Banking) rather than a flat list of individual linked accounts — implying accounts are classified into a fixed small set of type-groups for the home summary (front-phone Banking band).
- Credit balances are represented as negative numbers within the same aggregate total (Credit: "-$1,553.07"), implying liabilities net against assets in the "Banking" total shown at the very top (front-phone Banking band).
- "Recent Spending" is scoped to an explicit, visible date range ("Friday - Today") rather than an implicit or unlabeled window — the range sits directly under the dollar total it describes (front-phone Recent Spending band).
- Each transaction is shown with a category label directly under the merchant name at the list level (not hidden behind a detail tap), implying category is first-class/always-visible metadata for spending list rows (Central Cafe/Dining & Drinks, Winemaker/Dining & Drinks, Sportmart/Hobbies rows).
- Transaction lists are capped to a short preview (3 rows shown) with an explicit "See More" progressive-disclosure control rather than showing a full list inline on the home dashboard (front-phone Recent Spending band).
- "Top Spending" uses a colored vertical bar/indicator per category (purple bar next to "Rent") suggesting a consistent color-per-category coding scheme used elsewhere in the app for spend breakdowns (front-phone Top Spending band, cut off before further rows).

## Standout details
- Two-tone single progress bar per goal (teal = available, purple segment = spent) communicates two different sub-amounts within one compact bar instead of two separate bars or a stacked chart — efficient, at-a-glance breakdown.
- Each goal gets a distinct custom icon-in-circle keyed to its subject matter (plant/palm for "Summer vacation", tool/hammer for "Renovation", gear for "Emergency fund") rather than one generic goal icon — small personalization touch that aids quick visual scanning of a goal list.
- Money figures are never presented without an adjacent qualifying label ("Available $920", "Spent $100", "Left to save $1,080", "$920 saved so far", "Friday - Today" under "$335.08") — every number's status/context is directly beside or under it, matching a "status adjacent to the number it qualifies" design principle.
- The home dashboard visually compresses three distinct concerns (net-worth-style account rollup, recent transaction feed, and category spend breakdown) into one continuously scrollable surface with consistent card/section chrome, rather than separate tabs for each.
- Progressive disclosure pattern: only 3 transactions shown by default with a single centered "See More" affordance, keeping the home screen glanceable while keeping deeper detail one tap away.

## Open questions
- The full text of the "Savings Goals" subheading is cut off after "These are the items you are saving towa…" — exact remaining wording not observable.
- The exact "Goal $…" target amount and "Expecte…" (likely "Expected [completion date]") text for both the Summer vacation and Renovation cards are truncated by phone overlap and not legible.
- The exact percentage for the Renovation goal's progress bar is truncated to "8…" — could be 80%, 85%, 89%, etc.; the bar's visual fill is consistent with a high-progress state but the precise figure is not legible.
- Whether the Emergency fund card includes the same "$X saved so far" caption and Available/Spent/Left-to-save legend as the other two cards cannot be confirmed — the card is cut off by the image's bottom edge right after the "70%" progress bar.
- Whether negative dollar amounts (e.g., the Credit sub-balance) are rendered in a distinct color (e.g., red) anywhere in the actual product cannot be determined from this image — here it renders in plain white text against the purple banner background, which may simply reflect that banner's fixed text color rather than the app's general negative-number convention.
- The amount for the "Rent" row under "Top Spending" is cut off by the image's bottom edge and not legible, as is any additional row that may follow it.
- Whether this app has a bottom tab bar (and what it contains) cannot be determined — neither phone crop shows the bottom of a full screen with nav chrome intact.
- Because this image is a marketing/App-Store-style composite (device mockup frames + logo lockup on a lavender background) rather than a raw full-resolution in-app screenshot, minor rendering details (exact font, spacing, chrome) should be treated as representative but not pixel-exact evidence of the live product UI.
