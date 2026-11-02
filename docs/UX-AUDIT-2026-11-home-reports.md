# UX audit — Home + Reports (2026-11-02)

Audited live (keel.mikulsaravanan.com, demo household) at 1440px and 375px, plus a research pass over
Monarch, Copilot, YNAB, Simplifi, Lunch Money, Empower and Origin. Severity: **P0** broken/misleading,
**P1** clear UX win, **P2** polish.

## Fixed on `feat/reports-ux-pass`

| # | Page | Issue | Fix |
|---|------|-------|-----|
| R1 | Reports | Filter bar took 2 rows on desktop and 6 on mobile; Export sat outside it | One row: range dropdown (custom dates appear only for "Custom range") · entity · accounts · taxes · Export pinned right |
| R2 | Reports | Month in review got stuck on an empty month (e.g. "No activity in Nov 26" after switching to Last 12 months) and offered empty months as chips | Chips = in-range months **with activity**; defaults to the newest complete month; any scope change re-anchors it |
| R3 | Reports | Month in review was a large block above everything | Collapsed to a one-line summary (Spent Δ · Earned · Net % saved · Top category) with "Details" to expand |
| R4 | Reports | Monthly chart showed a second row of month labels (keyboard drill buttons) that read as a broken, misaligned x-axis | Row is visually hidden until it receives keyboard focus |
| R5 | Reports | Duplicate React keys in the Sankey when two categories share a name (console errors) | Index-qualified keys |

| H1 | Home | No "where do I stand this month" number | New **This month** card: month-to-date spend vs the same day last month, earned, net, cumulative pace chart (last month dashed) |
| H2 | Home | Ragged two-column grid with holes; net worth hero took the full top row | 7/5 two-column layout: This month + compact net worth on top; spending + recent left; upcoming, cash flow (6 mo), free-to-spend, projection, notes right |
| H3 | Home | Empty "Cash flow · last 30 days" and empty "Projected cash" cards | Cash-flow card replaced by This month; projection card only shows once it has a real forecast |
| R6 | Reports | Biggest movers compared the last two months of the range even when empty | Compares the two newest months with activity (title follows) |
| R7 | Reports | Duplicate category names across entities | Colliding names get the entity suffix ("Shopping · Personal") — display only |
| R8 | Reports | Matrix totals `$0.00` vs cells `—`; mobile opened on oldest months | Totals show `—`; table starts scrolled to the newest months |
| R9 | Reports | Sankey clipped on phones; allocation card 100% "Unclassified" | Sankey hidden below `sm` (donut covers it); allocation hidden until something is classified |
| R10 | Reports | "This month" landing view is near-empty early in a month | Bare /dashboard/reports opens on Last month for days 1–7 (`defaultScopePreset`) |
| R11 | Reports | Month in review used leaf categories while the donut used parents | Top categories roll up to parents, so they reconcile with the donut/matrix |
| R12 | Reports | Monthly bars had no baseline | Dashed average-spend line (complete months) + "spending ↑/↓ vs prior month" in the tooltip |

Entity suffixes appear only when same-named categories from different entities both have activity in scope.

## Status of the original findings (2026-11-02)

| Finding | Status |
|---|---|
| Demo data stale | Done — demo household re-dated +3 months on live (separate session; script on its branch) |
| Duplicate category names | Done (R7, entity suffix only on active collisions) |
| Taxes filed under "Government & Nonprofit" in the demo seed | **Open** — demo seed data, not UI |
| Net worth: one y-tick, no assets/liabilities split | Done — compact hero + Assets · Liabilities line (matches sidebar subtotals) |
| Ragged Home layout | Done (H2) |
| "Where do I stand this month" | Done (H1); before anything posts it shows last month's result |
| Empty windows | Done — This month falls back to last month; empty projection hidden |
| Upcoming recurring empty | Done in UI — active schedules now listed (overdue labelled). **Open (data):** demo login's `recurring.list` returns no series; separate session investigating |
| Notes & tasks in a prime slot | Done — bottom of the right column |
| Mobile header row | Done — one row; Review shortcut lives in the tab bar on phones |
| Reports default range | Done (R10) |
| Month review grain | Done (R11) |
| Biggest movers | Done (R6) |
| Matrix `$0.00` / mobile oldest months | Done (R8) |
| Sankey on mobile | Done — hidden below `sm`; the donut's ranked list covers it |
| Allocation 100% Unclassified | Done (R9) |
| Transfer banner above filters | Done — moved under the scope bar |
| Chart baseline | Done — dashed average-spend line |
| Tooltip Δ / % | Done; transaction count in tooltip **open (P2)** |
| Event annotations on charts | **Open (P2)** — needs an events source (account linked, bonus) |
| Home "Cash flow by month" inflated Apr–Jun after the redate | **Open (data)** — redate reversals counted as gross flow in `dashboard.cash_flow_monthly`; separate session investigating |

## Patterns worth stealing (research)
Copilot: month-to-date vs same-point-last-month, pace line, review queue on Home, horizontal "Upcoming" strip.
Monarch: customizable/reorderable cards, weekly recap narrative (hideable), click any chart segment → filtered
transactions, saved reports with relative dates. YNAB: ranked category list with % of total. Lunch Money:
stats panel (top merchants, largest purchases), % change in trend tooltips. Simplifi: payee/tag filters with
"exclude transaction".
