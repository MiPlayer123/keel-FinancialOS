# Dashboard / home surface

Ground truth for "KEEL today": `design/current/2026-07-16/dashboard-desktop.png` and
`design/current/2026-07-16/dashboard-mobile-390.png`; census `keel-core-01.md` (§Layout Home)
and `keel-mobile-04.md` (§Layout Dashboard). KEEL's Home, top to bottom: (1) "Free to spend ·
this month" hero ($8,803.00 · $586.86/day for 15 days left · In so far $10,541.01 · Spent so far
−$1,738.01); (2) "Net position" $14,763.85 (bare number); (3) "Cash flow · last 30 days"
(In/Out/Net); (4) three stat cards (Biggest purchase 7d, Spending pace vs last month, Top merchant
this month); (5) "Projected cash · next 30 days" (PROJECTION badge, degenerate flat chart); (6)
"Net worth · last 90 days" line chart; (7) "Cash flow by month" bars; (8) "Spending · last 30 days"
category bars; (9) "Accounts" list + "Updated 21m ago · Sync". Single-column, ~9 stacked cards,
no drill-in controls anywhere.

## Convergent patterns
(what ≥3 competitors ALL do on the home surface that KEEL does not)

1. **Net worth gets the full hero treatment: number + signed delta + %-change + time-range
   selector + trend chart, fused into ONE unit.** Monarch (`appstore-monarch-pad-01`, `iphone-07`):
   "$686,989.93 / ↑ $22,292.97 (3.4%) 1 month" + 1M/3M/6M/1Y/ALL tabs above the area chart. Copilot
   (`community-10-mac-dashboard-dark`, `mac-07`): "Net Worth $16,762 / ↗ 5.05%" pill + 1W/1M/3M/YTD/
   1Y/ALL tabs + chart in one card. Rocket Money (`iphone-03` net worth, `iphone-05` dashboard):
   "$69,556 / ↑ $437 in the last month" + 1M/3M/6M/1Y/All. YNAB (`iphone-02` Reflect): Net Worth card
   with Assets/Debts split + combo chart. KEEL shows "Net position $14,763.85" as a **bare number
   with no delta, no %, no range control, no as-of**, and its net-worth trend lives in a *separate*
   card seven modules lower down.

2. **A time-range selector (1W/1M/3M/YTD/1Y/ALL) on every trend chart.** Copilot, Monarch, Rocket
   Money, Simplifi (`iphone-02` 1W/1M/3M/6M/1Y) all let the user re-scope the chart from the home
   surface. KEEL's charts are hard-wired ("last 30 days", "last 90 days", "next 30 days") with no
   range control at all.

3. **A needs-action / to-review module on the home surface.** Copilot Dashboard "Transactions to
   review" card with per-row checkboxes + "✓ Mark all as reviewed" (`community-10`, `mac-07`); YNAB
   Home "2 New transactions → Review" as the first card (`iphone-03`); Rocket Money "Payday in 3
   days" nudge (`iphone-05`). KEEL's Home is 100% passive read-only — no review count, no
   "N to categorize", no action anywhere despite a whole Review nav page existing.

4. **Upcoming bills / recurring cash-flow on the home surface.** Copilot "Next Two Weeks" upcoming
   recurring bills with "Overdue" flags (`community-10`); Simplifi "Projected Cash Flow" solid→dashed
   line with a "Today" marker and a peak callout (`iphone-05`); Monarch Recurring "$5,100.00
   remaining due"; Rocket Money payday countdown. KEEL's projected-cash card is degenerate/empty
   ("No confirmed recurring bills in the window yet") and there is no upcoming-bills list at all.

5. **Category spending paired with budget context (spent vs budgeted, over/under color).** Copilot
   Top Categories (Rent $1,984 of $2,000 = green bar, Shopping $292 over $250 = red bar,
   `community-10`); Rocket Money, Simplifi, Monarch, YNAB all show budget-relative spend. KEEL's
   "Spending · last 30 days" shows raw amounts + proportional bars with **no budget comparison and
   no over/under status**.

6. **Per-account trend + last-synced freshness at the row level.** Monarch shows per-account
   "N hours ago" under each balance (`appstore-monarch-pad-01`, `community-10-accounts...`); Copilot
   shows per-account sparkline + %-change pill + balance for every row (`community-10`, Accounts
   pane). KEEL's Home Accounts block shows name/type/balance with a *single global* "Updated 21m ago"
   and no per-account trend.

## Findings

### DASHBOARD-1 — "Biggest purchase" and "Top merchant" both surface the same credit-card bill payment; debt payments pollute every spend metric [P0]
- **Evidence:** `dashboard-desktop.png`, `dashboard-mobile-390.png`; census `keel-core-01.md`
  (Business rules bullet on Biggest purchase / Top merchant; §Layout "Spending · last 30 days" Loan
  Payments $5,999.55), `keel-mobile-04.md` (Open questions). Compare Monarch/Copilot Reports
  "confirmed transfers excluded, net of refunds" footnotes (census `keel-money-02.md` Reports).
- **Competitors:** Monarch and Copilot exclude transfers/CC-payments from spend and merchant
  rollups by design ("confirmed transfers excluded" on every report; Copilot renders transfer rows
  like "Payment To Chase Card" with *no* category pill, `community-11`). A CC bill payment never
  appears as a "purchase," a "merchant," or a top spend category.
- **KEEL today:** The "Biggest purchase · 7 days" card and the "Top merchant this month" card BOTH
  read "$895.33 / ONLINE PAYMENT TO DISCOVER CARDS 07/15" — the identical row, and it is a
  credit-card bill payment, not a purchase or a merchant. The same modeling gap makes "Loan
  Payments $5,999.55" the #1 line in "Spending · last 30 days," dwarfing real spend (Food & Drink
  $828.58) 7×. Two of three insight cards are visibly wrong AND redundant, and the spending
  breakdown is distorted by a debt/transfer payment. On the primary trust surface this reads as
  "the app doesn't understand my money."
- **Fix:** Exclude loan-payment / transfer / CC-payment categories (and confirmed transfer legs
  once gap #1 lands) from the biggest-purchase, top-merchant, and spending-breakdown queries; and
  guard against two cards resolving to the identical transaction (fall through to the next-ranked
  row). This is the same exclusion competitors bake into every spend surface.
- **Maps to:** NEW (dashboard metric-exclusion), depends on transfers exclusion (FEATURE-GAP #1).

### DASHBOARD-2 — "Free to spend" hero ignores committed upcoming bills, overstating safe-to-spend [P1]
- **Evidence:** `dashboard-desktop.png` hero "$8,803.00 · $586.86 / day for the 15 days left this
  month"; census `keel-core-01.md` (Home hero), cross-checked against `keel-money-02.md` Reports
  Sankey ("Saved $8,803.00" = income − spend). Simplifi `iphone-02`; Copilot `community-10`.
- **Competitors:** Simplifi's whole "Left this month" pitch is income *minus bills, goals, and
  planned spending* — the subhead literally reads "See exactly what's left after bills, goals, and
  planned spending" (census `quicken-simplifi-iphone-01.md`). Copilot's "$147 left out of $3,560
  budgeted" is budget-relative. Rocket Money's "$623 left to spend / $48/day for 13d" is
  budget-anchored. All three reserve committed obligations before telling you a daily burn rate.
- **KEEL today:** "Free to spend" = income-in-so-far ($10,541) − spent-so-far ($1,738) = $8,803,
  then divides by remaining days to suggest "$586.86/day." Nothing is reserved for rent, loan
  payments, or subscriptions — and KEEL *knows* its recurring bills are unconfirmed (the projection
  card is empty). Telling a user they can spend $586/day when a mortgage and card bill are still
  due is optimistically misleading; it invites overspend on the app's most prominent number.
- **Fix:** Once W2.5 forecast + confirmed recurring exist, compute "Free to spend" = cash − upcoming
  confirmed bills in the window (reserve committed outflows), and label the reservation. Until then,
  soften the framing (e.g. "Income minus spending so far" not "Free to spend / per-day burn"), and
  scope-stamp it so the number isn't read as a spending allowance.
- **Maps to:** W2.5 (cash-flow forecast / lowest-balance) + copy change.

### DASHBOARD-3 — Net position is a bare number; no delta, no %-change, no time-range, and its trend chart is divorced from it [P1]
- **Evidence:** `dashboard-desktop.png` ("Net position $14,763.85" card + separate "Net worth · last
  90 days" chart much lower); census `keel-core-01.md` (Net position card "no further breakdown"),
  `keel-mobile-04.md` (Net position "no as-of stamp"); DESIGN-NOTES §"Net worth as the anchor (one
  number + trend line)". Convergent pattern 1.
- **Competitors:** Every net-worth-tracking competitor fuses number + signed delta + % + range
  selector + chart in ONE card (Monarch `appstore-monarch-pad-01`; Copilot `community-10`; Rocket
  Money `iphone-03`). The delta ("↑ $22,292.97 (3.4%) 1 month") sits on the same line as the number.
- **KEEL today:** "Net position $14,763.85" is a naked figure. The user cannot tell if net worth is
  up or down, by how much, or over what window — the answer exists, but 7 cards away in a chart with
  no summary delta. KEEL already computes the history (`keel_net_worth_as_of`, net-worth chart) but
  never distills it into a delta next to the anchor number.
- **Fix:** Promote net worth to a proper hero: show the number with a signed 30-day delta + %-change
  pill (red only when the *money* is negative per Law 8; use ↑/↓ glyph + neutral text for
  direction), add a 1M/3M/YTD/1Y/ALL range selector, and inline the trend sparkline/chart directly
  under it. Fold the standalone "Net worth · last 90 days" card into this hero.
- **Maps to:** FEATURE-GAP #13 (net-worth trend), NEW (delta compute for dashboard).

### DASHBOARD-4 — No time-range control on any dashboard chart [P1]
- **Evidence:** `dashboard-desktop.png` charts all fixed-window; census `keel-core-01.md`
  (Controls: "no visible date-range picker, filter, or drill-in control anywhere on the dashboard";
  all figures fixed to "this month / last 30 days / last 90 days / next 30 days").
- **Competitors:** Pill range selectors are universal on trend charts — Copilot 1W/1M/3M/YTD/1Y/ALL,
  Monarch 1M/3M/6M/1Y/ALL, Simplifi 1W/1M/3M/6M/1Y, Rocket Money 1M/3M/6M/1Y/All (census
  `copilot-community-02`, `monarch-iphone-01`, `quicken-simplifi-iphone-01`, `rocket-money-iphone-01`).
- **KEEL today:** Net worth is locked to 90 days, cash flow to 30 days, projection to 30 days — no
  way to zoom out to a year or in to a week without leaving Home.
- **Fix:** Add a shared pill range selector (1M/3M/YTD/1Y/ALL) to the net-worth and cash-flow charts,
  re-querying the existing read-model with a range param. Keep it at 44px touch targets for 390px.
- **Maps to:** NEW (dashboard range param on existing read-model).

### DASHBOARD-5 — Home surface has no needs-action / to-review / upcoming-bills module; it is entirely passive [P1]
- **Evidence:** `dashboard-desktop.png` (no actionable card); census `keel-core-01.md` (Controls:
  only "Sync" is interactive), `keel-mobile-04.md`. Contrast KEEL's Review page existing but only
  reachable via separate nav.
- **Competitors:** The two most action-required items lead the home surface. Copilot Dashboard:
  "Transactions to review" card (checkboxes + "Mark all as reviewed") + "Next Two Weeks" upcoming
  bills with "Overdue" flags (`community-10`). YNAB Home: "2 New transactions → Review" and
  "$1,000.00 Ready to assign → Assign" as the first two cards, each with its own count + CTA verb
  (`iphone-03`; census `ynab-iphone-01` Standout). Rocket Money surfaces a payday countdown.
- **KEEL today:** Home shows only summary numbers and charts — nothing to *do*. There is no review
  count, no "N transactions need a category", no upcoming-bill list, no reauth/sync-stale nudge. A
  daily driver has no reason to open Home except to look.
- **Fix:** Add a compact "Needs your attention" module near the top: review-queue count (suggested
  transfers + recurring + uncategorized), and an "Upcoming bills · next 14 days" list from confirmed
  recurring occurrences with due-in-N-days and an overdue flag. Both link into Review/Recurring.
- **Maps to:** W1.5 (review badge → promote to a home module), W2.5 (upcoming bills).

### DASHBOARD-6 — Spending-by-category has no budget context and collapses to unreadable slivers when one category dominates [P1]
- **Evidence:** `dashboard-desktop.png` / `dashboard-mobile-390.png` "Spending · last 30 days"
  (Loan Payments $5,999.55 fills the bar; Personal Care/Transfers/Other render as pixel slivers);
  census `keel-mobile-04.md` (§Layout Spending: "several render as barely-visible slivers a few
  pixels wide — proportional bars become illegible once one category dominates by 10-100x").
- **Competitors:** Copilot Top Categories pairs each category's spend with its budget and colors the
  bar green/red for under/over ("Rent $1,984 / budget $2,000 green; Shopping $292 / budget $250
  red", `community-10`). Monarch's Cash Flow rows encode share-of-total as the bar width with the
  percent printed inline (`monarch-iphone-01`, `appstore-monarch-pad-06`).
- **KEEL today:** Bars are raw-amount proportional with no budget line and no over/under status, so
  they read as "how big" not "how am I doing." And because the top item (a debt payment, see
  DASHBOARD-1) is 7-100× the others, every other bar is an illegible sliver — the chart conveys
  almost nothing.
- **Fix:** (a) After the DASHBOARD-1 exclusion, real-spend categories will be comparable-scale. (b)
  Once budgets exist (W2.2), overlay budgeted amount + "$X left / $X over" per row with Law-8 red
  only for over. (c) Consider a log or share-of-total treatment, or an explicit "Loan Payments"
  exclusion toggle, so no single row starves the rest.
- **Maps to:** W2.2 (budget overlay), depends on DASHBOARD-1.

### DASHBOARD-7 — Projected-cash chart renders a degenerate flat band with four identical "15.2K" axis labels — reads as a broken chart on the primary surface [P1]
- **Evidence:** `dashboard-desktop.png` / `dashboard-mobile-390.png` "Projected cash · next 30 days"
  (flat band, y-axis "15.2K ×4"); census `keel-core-01.md` (States: "identical/duplicate y-axis
  tick labels look like a chart-scaling rendering artifact rather than an intentional flat-line"),
  `keel-mobile-04.md` (same).
- **Competitors:** Simplifi's projected cash flow is a live solid→dashed line with a "Today" marker
  and a peak callout "$31,452" (`iphone-05`); Copilot's monthly-spending chart carries an inline
  "$97 under" annotation (`community-10`). When there's nothing to show, competitors show an
  empty-state, not a broken-looking axis.
- **KEEL today:** With no confirmed recurring bills, the chart draws a flat band whose four gridline
  labels are all "15.2K" — indistinguishable from a chart-scaling bug. The explanatory copy below
  is good, but the chart itself undermines it. KEEL has a strong dashed-border empty-state
  convention everywhere else (Review, Goals, Statements) — the projection card doesn't use it.
- **Fix:** When there are zero confirmed recurring occurrences in the window, suppress the degenerate
  chart and render KEEL's standard dashed-border empty-state with a CTA ("Confirm recurring bills to
  project your balance → Recurring"). Only draw the chart once there's real variance; label the axis
  with a proper scaled range.
- **Maps to:** W2.5 (forecast) + empty-state reuse.

### DASHBOARD-8 — Dashboard cards are not drill-in; no "view all" path to the full surface behind each number [P2]
- **Evidence:** `dashboard-desktop.png`; census `keel-core-01.md` (Controls: "no visible
  drill-in control anywhere on the dashboard itself"), `keel-mobile-04.md`.
- **Competitors:** Every Copilot dashboard module has a header-right link to its full surface
  ("TRANSACTIONS ↗", "ACCOUNTS ↗", "VIEW ALL ↗", "RECURRINGS ↗" — census `copilot-community-02`
  IA). Simplifi caps its home lists at 3 rows with a "See More" (`quicken-simplifi-web-01`). Monarch
  Reports rows are click-to-ledger. The dashboard is a triage layer *into* detail.
- **KEEL today:** The Home cards are dead ends. Clicking "Spending · last 30 days" Food & Drink, the
  Cash-flow card, or the net-worth chart does nothing — the user must re-navigate via the sidebar to
  Ledger/Reports/Accounts and re-scope. (KEEL's own Reports 6-month table *does* link category→
  ledger, per `keel-money-02.md` — that pattern isn't reused on Home.)
- **Fix:** Make each dashboard module drill in: spending category → filtered Ledger; net-worth /
  cash-flow → Reports at the matching scope; account row → account detail; "Needs attention" →
  Review. Add a "View all →" affordance per card.
- **Maps to:** NEW (wire existing routes; reuse Reports' category→ledger link).

### DASHBOARD-9 — Accounts block shows one global "Updated 21m ago"; no per-account freshness or trend [P2]
- **Evidence:** `dashboard-desktop.png` bottom Accounts region ("Updated 21m ago · Sync", rows are
  name/type/balance only); census `keel-core-01.md` (§Layout bottom Accounts), `keel-mobile-04.md`.
- **Competitors:** Monarch shows a per-account last-synced timestamp under every balance ("4 hours
  ago", "9 hours ago" — census `monarch-iphone-01` Business rules "sync recency is a first-class,
  per-account, always-shown fact"). Copilot shows per-account sparkline + %-change pill + balance
  for every row (`community-10`, `mac-04` "Updated 5 hours ago"). KEEL's own Connections page even
  shows per-institution "Synced 7/16/2026, 6:45:06 PM" (census `keel-ops-03`) — that granularity
  isn't carried to Home.
- **KEEL today:** A single "Updated 21m ago" for the whole list hides which account is stale. A
  reauth-needed or partially-synced account is invisible here. No trend per account.
- **Fix:** Show per-account last-synced (relative) and a sync-health dot on each Home account row;
  optionally a tiny balance delta. Surface stale/reauth state inline (feeds DASHBOARD-10).
- **Maps to:** NEW (surface `balances.latest` / connection-health per row; W1.9 available-vs-current).

### DASHBOARD-10 — No alerts / notifications on the home surface (reauth-needed, bill due, low balance, budget overrun) [P2]
- **Evidence:** `dashboard-desktop.png` (no alert region, no bell in chrome); census `keel-core-01.md`,
  `keel-mobile-04.md` (top bar "no right-side icons — no notification bell"); FEATURE-GAP #26
  (Notifications: Missing).
- **Competitors:** Monarch carries a persistent notifications bell in top chrome on every screen
  (census `monarch-iphone-01` IA). Rocket Money surfaces a payday countdown and sync-stale "19 hours
  ago / Sync now" on the dashboard. Copilot/YNAB surface a review count. Home is where "something
  needs you" lives.
- **KEEL today:** There is no alert surface anywhere on Home and no notifications system at all. A
  connection needing reauth, a projected low-balance day, a bill due tomorrow, or a budget overrun
  never reaches the user unless they go hunting.
- **Fix:** Add a lightweight home alert strip (dismissible) driven by existing signals first:
  `connection_health_events` (reauth/stale sync), forecast lowest-balance (W2.5), budget overrun
  (W2.2). This is the highest-leverage use of the home surface and reuses signals KEEL already has.
- **Maps to:** FEATURE-GAP #26 (notifications), reuses W2.5 / W2.2 / connection health.

### DASHBOARD-11 — Hero numbers carry no "as of" / reproducibility stamp (Law 9 tension) [P2]
- **Evidence:** `dashboard-desktop.png` (Free-to-spend, Net position, Cash-flow cards carry no
  timestamp; only the bottom Accounts list has "Updated 21m ago"); census `keel-core-01.md` (Open
  questions: "no 'as of' timestamp shown anywhere on the Home page except 'Updated 21m ago'").
- **Competitors:** Simplifi stamps "Friday - Today" directly under its Recent Spending total (census
  `quicken-simplifi-web-01`); Monarch reports print the resolved date range; and KEEL's own Reports
  page already carries exemplary per-widget scope footnotes ("2026-07-01 – 2026-07-16, dominant
  currency only, confirmed transfers excluded, net of refunds" — `keel-money-02.md`).
- **KEEL today:** The Home hero figures have scope *labels* ("this month", "last 30 days") but no
  as-of instant or formula-version — the reproducible-numbers invariant (Law 9, BC-v2.1 §9.1) that
  Reports honors is absent on the surface users look at most.
- **Fix:** Add a single small "as of {timestamp} · confirmed transfers excluded" line to the
  dashboard (once per surface is enough; it need not repeat per card), matching the Reports
  footnote discipline. Cheap trust win.
- **Maps to:** NEW (as-of stamp; reuse Reports scope-footnote pattern).

### DASHBOARD-12 — Stat cards use bare deltas where a plain-language framing would read better [P3]
- **Evidence:** `dashboard-desktop.png` "Spending pace vs last month +11% / $1,738.01 so far vs
  $1,555.73 by day 16"; census `keel-core-01.md`.
- **Competitors:** Rocket Money translates deltas into a reader-friendly sentence beside the number —
  "$143 below avg. spend", "$437 in the last month" (census `rocket-money-iphone-01` Standout);
  Copilot "$97 under" pill on the chart. Sentence beats a bare percent for at-a-glance meaning.
- **KEEL today:** "+11%" is correct but makes the user do the interpretation. The framing is neutral
  where "$182 ahead of last month's pace" would land instantly.
- **Fix:** Add a plain-language secondary line to pace/insight stats (e.g. "$182 ahead of last
  month" / "on track"). Copy-only, no new data.
- **Maps to:** NEW (copy polish).

### DASHBOARD-13 — Dashboard is a fixed single-column stack with no customization / reordering [P3]
- **Evidence:** `dashboard-desktop.png` (fixed 9-card stack); census `keel-core-01.md` (Density:
  "single-column-of-cards").
- **Competitors:** Weak convergence — Copilot, Monarch, YNAB, Rocket Money all ship *fixed*
  dashboards too, so this is not a table-stakes gap. Quicken Classic's swipeable balance-card
  carousel (`quicken-classic-iphone-01`, 3-dot indicator) and Rocket Money's paginated home cards
  are the only real customization/paging signals, and both are minor.
- **KEEL today:** No reorder, no add/remove, no collapse of home modules. Acceptable for now; filed
  only for completeness of the dimension.
- **Fix:** Defer. If pursued later, allow collapse/hide of individual modules and a saved order —
  after the higher-severity content gaps close.
- **Maps to:** NEW (deferred).
