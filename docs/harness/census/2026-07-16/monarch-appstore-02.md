# Census — monarch-appstore-02

## Evidence
- `design/references/monarch/appstore-monarch-pad-09-2064x2752.jpg` → App Store marketing slide (iPad-frame device shot) titled "Light & dark mode" showing Monarch's **Accounts** page, Net Worth tab, dark mode, on an iPad.
- `design/references/monarch/appstore-monarch-pad-10-2064x2752.jpg` → App Store marketing slide titled "Bank-level security" — a text/icon-only trust slide (no app screenshot, no device frame), three icon+copy blocks stacked vertically.

## Information architecture
Visible from image 09's left sidebar (persistent, full-height, dark background, orange butterfly/moth "Monarch" wordmark logo top-left with a gear/settings icon at the far top-right of the sidebar header row):
- Dashboard (house icon)
- **Accounts** (stacked-layers icon) — currently selected, shown with a distinct dark-gray rounded-rectangle highlight behind the row
- Transactions (card icon)
- Cash Flow (bar-chart icon)
- Budget (map icon)
- Recurring (calendar icon)
- Goals (target/circle icon)
- Investments (trending-up-arrow icon)

Accounts is a top-level nav item, not nested under anything. Within Accounts, a secondary horizontal tab strip subdivides by asset class: NET WORTH (selected), CASH, INVESTMENTS, REAL ESTATE, VEHICLES, CREDIT CARDS, LOANS. Selecting NET WORTH shows a rollup of every account grouped by these same categories on one scrollable page — so the category tabs and the on-page grouped list appear to be two views of the same taxonomy (tabs likely filter to a single category; Net Worth shows all categories together). Individual accounts (e.g., "Melanie's Checking," "Jon's 401k") are one level below the category group — visually indented/listed under each group header, not a separate nav destination in this shot.

Top app-chrome row above the tab strip: a sidebar-collapse icon, a bell (notifications) icon, the centered page title "Accounts," and on the far right a "..." overflow menu and a "+" (add) icon — implying add-account and per-page overflow actions live at this global bar, one click from the list.

The second image (slide 10) is not a product screen — it carries no nav chrome at all, so it settles nothing further about IA.

## Layout & content
**Image 09 (Accounts / Net Worth, dark mode):**
- Marketing frame: cream/off-white backdrop, small bold orange all-caps eyebrow "CUSTOMIZE," large serif headline "Light & dark mode" centered above the device. Two large partial decorative circles (blue bottom-left, green bottom-right) bleed off the canvas edges behind the iPad.
- Device chrome: iPad, silver bezel, three camera-cluster dots at top edge, volume rocker and a button visible on the right edge.
- Status bar inside device: "9:23 PM   Thu Dec 5" left; wifi icon and "100%" battery right.
- Hero number: "$686,989.93" — large, bold, white, no currency-code label beyond the "$" glyph. Directly beneath it, on the same line: a green upward arrow, "$22,292.97 (3.4%)" in green, then gray "1 month" — i.e. every headline money figure is immediately paired with its delta amount, delta percent, and the comparison window, color-coded green for gains.
- Below the number: a line chart (teal/blue stroke with a gradient fill fading to transparent) trending up-left to up-right with visible small dips/plateaus (not perfectly smooth), plotted against a faint dashed horizontal baseline near the chart's bottom.
- Time-range selector below chart: "1M" (selected, pill/rounded highlight), "3M", "6M", "1Y", "ALL" — plain text buttons, evenly spaced.
- Below that, a vertically stacked, grouped list of account-group cards. Density: 5 group headers and 8 individual account rows are visible in the frame (Honda CR-V row is cut off at the very bottom, partially obscured by what appears to be a horizontal scrollbar thumb). This is a summary(header)-then-detail(rows) split repeated per group:
  - **Cash** group header: "Cash" (bold white, left) — "$65,819.70" (bold white, right, same row). Second line: green "↑ $649.70 (1%)" + gray "1 month" (left) — gray "7% of assets" (right, with a dotted underline rendered beneath the percentage figure specifically).
    - "Melanie's Checking" (citi logo icon) / gray subtext "Checking" — right-aligned "$15,594.64" / gray "18 hours ago" beneath it.
    - "Joint Savings" (blue bank icon) / gray subtext "Savings" — "$50,225.06" / "18 hours ago".
  - **Investments** group header: "$542,032.32", "↑ $10,600.90 (2%) 1 month", "58% of assets".
    - "Jon's 401k" (green sunburst icon) / "401k" — "$180,684.29" / "18 hours ago".
    - "Melanie's 401k" (same green sunburst icon) / "401k" — "$150,141.42" / "18 hours ago".
    - "Melanie's IRA" (red "V" icon, Vanguard) / "Individual Retirement Account (IRA)" — "$200,737.82" / "18 hours ago".
    - "Brokerage" (green leaf icon) / "Brokerage (Taxable)" — "$10,468.79" / "18 hours ago".
  - **Real Estate** group header: "$300,054.83", "↑ $5,909.99 (2%) 1 month", "32% of assets".
    - "Home" (blue "Z" icon, Zillow) / "Primary Home" — "$300,054.83" / "18 hours ago".
  - **Vehicles** group header: "$20,330.80", "↑ $102.89 (0.5%) 1 month", "2% of assets".
    - "Honda CR-V" (car icon) / "Car" — "$20,330.80" / "18 hours ago" (row is cropped at the frame's bottom edge; a horizontal gray bar under it may be a scrollbar, not certain — see Open questions).
- Alignment/number formatting: every dollar figure uses "$" + comma thousands separator + two decimal places (e.g., "$686,989.93", "$15,594.64"), right-aligned in its row; labels/institution/account-type text left-aligned; percentages always in parentheses immediately after the delta dollar amount, e.g. "(3.4%)", "(1%)", "(2%)", "(0.5%)". Every group total has an explicit "N% of assets" gray annotation directly under its percent-change figure — status/context sits directly adjacent to (below-right of) each headline number, consistent with "status adjacent to the number it qualifies."
- Card/row backgrounds are a slightly lighter dark gray than the near-black page background, with thin hairline dividers separating rows within a group; group cards appear as separate rounded containers stacked with gaps between them.

**Image 10 (Bank-level security):** Pure marketing copy slide, cream background, no app chrome, no money figures, no device frame visible in what's shown. Orange all-caps eyebrow "PRIVACY," serif headline "Bank-level security," then three centered icon+caption blocks stacked vertically:
  1. Orange circle, white padlock icon → "Login details are never stored and bank access is read-only"
  2. Teal circle, white phone/tablet icon → "Multi-factor authentication for added security"
  3. Yellow/gold circle, white "X" icon → "We'll never sell your data or service you ads"

## Controls inventory
From image 09 only (image 10 has no interactive controls, it's static marketing copy):
- Sidebar: Settings gear icon (top of sidebar) — apparent action: open settings.
- Sidebar nav items (8): Dashboard, Accounts (selected/highlighted), Transactions, Cash Flow, Budget, Recurring, Goals, Investments — each an icon+label row, apparent action: navigate.
- Top bar: sidebar-collapse toggle icon; bell icon (notifications); "..." overflow menu; "+" icon — apparent action: add new account/item.
- Category tab strip (7 tabs): NET WORTH (selected), CASH, INVESTMENTS, REAL ESTATE, VEHICLES, CREDIT CARDS, LOANS — all-caps text tabs, apparent action: filter the account list to that asset class.
- Time-range selector (5 options): 1M (selected), 3M, 6M, 1Y, ALL — pill-style toggle buttons, apparent action: rescale the net-worth chart's lookback window.
- Institution/account-type badge icons (citi, blue bank mark, green sunburst ×2, red "V"/Vanguard, green leaf, blue "Z"/Zillow, car icon) — small circular logo chips identifying the linked institution or asset type per row, not obviously interactive but function as visual grouping/recognition aids.
- No visible filter/sort/bulk-action controls, no checkboxes, no badges beyond the institution logo chips, no explicit "edit" or "hide account" affordance visible in this crop.

## Flow steps
N/A — both images are single static marketing screenshots, not a multi-step sequence.

## States
- No empty, loading, or error states are shown in either image; both depict a fully populated, "happy path" success state.
- Freshness state per account row is exposed via literal relative-timestamp copy: "18 hours ago" on every account row — implying each linked account carries a last-synced timestamp shown at the row level, not just globally.
- Slide 10's three copy blocks read as static trust/reassurance statements rather than product UI states, but they encode explicit product guarantees as their literal text: "Login details are never stored and bank access is read-only," "Multi-factor authentication for added security," "We'll never sell your data or service you ads."

## Business rules implied
- Every account is grouped under exactly one asset-class category (Cash, Investments, Real Estate, Vehicles, and by the tab strip also Credit Cards, Loans), and each category shows a "% of assets" figure — implying net worth is computed as a sum across categories with each category's share of total assets tracked (image 09).
- Net worth change is tracked over a selectable window (1M/3M/6M/1Y/ALL) with both an absolute dollar delta and a percentage delta shown together, colored green for a gain (image 09).
- Each linked account displays its own last-sync timestamp ("18 hours ago") independent of other accounts — sync recency is tracked per-account, not just per-session (image 09).
- Per the "Bank-level security" slide's literal copy, the product's stated data-handling rules are: credentials are never stored server-side, bank data access is read-only (no write/move-money capability implied), MFA is offered/required for account access, and user data is not sold nor used to serve ads (image 10). These are marketing claims, not directly observed backend behavior, but they are the product's own stated rule set.

## Standout details
- Percent-of-total ("% of assets") is rendered with a dotted underline beneath just that figure — a small typographic cue that seems to mark it as a secondary/derived metric distinct from the bold primary dollar total next to it (image 09).
- The green up-arrow + colored delta + neutral-gray comparison-window label pattern ("↑ $22,292.97 (3.4%)  1 month") is applied uniformly at both the net-worth level and every single group-header level, giving a consistent glanceable trend idiom repeated at every rollup tier (image 09).
- Account-type badges use recognizable third-party brand marks (Citi, Vanguard "V", Zillow "Z") as the row icon instead of a generic bank glyph, reinforcing at-a-glance institution recognition (image 09).
- The trust slide bundles three distinct guarantees (credential handling, MFA, no data-selling/ads) under one "Bank-level security" headline even though only the first is strictly a security claim — the ad-monetization promise is grouped into the same trust narrative as security/privacy (image 10).
- Marketing frame device is an iPad in image 09 yet slide 10 in the same appstore-pad file series drops the device frame entirely for a plain icon/text layout — the campaign is not visually consistent about always showing the app inside a device mockup.

## Open questions
- Whether the horizontal gray bar under the cropped "Honda CR-V" row in image 09 is a scrollbar thumb, a progress/loading indicator, or an unrelated decorative element cannot be determined — the row and whatever is below it are cut off by the frame's bottom edge.
- Whether selecting one of the CASH / INVESTMENTS / REAL ESTATE / VEHICLES / CREDIT CARDS / LOANS tabs filters the same grouped-list view down to just that category, or navigates to a differently laid-out page, is not shown — only the NET WORTH (all-categories) view is captured.
- No Credit Cards or Loans group is visible in the captured scroll position, so whether those categories render identically to the others (same header/row pattern) is unconfirmed from this evidence.
- The "+" icon's exact target (add account vs. add manual asset vs. something else) is not disambiguated — no tooltip, label, or follow-on screen is captured.
- Slide 10 contains no product screenshot at all, so nothing about the actual settings screen, MFA enrollment flow, or data-sharing preference toggle (if any) is observable — only the marketing claim text.
- Whether "18 hours ago" reflects a per-institution sync cadence or a global batch sync applied to all accounts simultaneously (all rows in this shot show the identical "18 hours ago") cannot be distinguished from a single snapshot.
