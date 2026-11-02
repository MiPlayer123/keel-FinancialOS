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

## Open findings

### P0
- **Demo data is stale (ends 2026-07-20).** Every "last 30 days" widget on Home is empty, net worth is a flat
  line with Δ $0.00, and Reports defaults to an empty "This month". The demo currently sells nothing.
  Fix: a re-date script that shifts the demo household forward (or a rolling seed), run monthly.
- **Duplicate category names** — two "Shopping", two "Services", two "Income" at parent grain, and taxes
  appear as "Government & Nonprofit" (top spend, 40%). Show `Parent › Child` when names collide, and give
  tax withholding a real "Taxes" parent in the demo seed.

### Home (P1)
- Net worth chart: one y-tick ("174.3K"), no range context, no assets/liabilities split. Use a sparkline-sized
  chart with start→end labels and an assets / liabilities / net breakdown; Copilot and Monarch keep it compact.
- Layout has ragged two-column cards with dead space (Spending card stub next to a tall empty Cash-flow card).
  Pair cards of equal height, or use a 12-col grid with fixed rows.
- Missing the "where do I stand this month" number above the fold — month-to-date spend vs the **same point
  last month** with a pace line (Copilot's best pattern). This would replace "Cash flow · last 30 days".
- Empty windows: when the last 30 days are empty, fall back to the latest period with data and say so.
- "Upcoming recurring" asks to confirm series even though the demo seeds 6 — check status mapping.
- Notes & tasks takes a prime slot; move below the fold or make it collapsible.
- Mobile: header spends a full row on Review + Search buttons; fold them into the top bar.

### Reports (P1)
- Default range "This month" is near-empty early in a month (today is the 2nd). Default to last month until
  ~day 7, or remember the user's last range.
- Month-in-review details use leaf categories (Rent, Federal withholding) while the donut uses parents —
  pick one grain (parents with leaf hover) so the numbers reconcile.
- "Biggest movers" compares the last two months of the range even if both are empty; compare the last two
  months **with data**.
- Matrix: totals row prints `$0.00` while cells print `—`; on mobile the visible columns are the oldest
  (empty) months — scroll to/pin the newest months.
- Sankey on mobile is a 560px horizontal scroller with labels cut off; on phones replace it with a ranked
  bar list (YNAB pattern).
- Investment allocation shows 100% "Unclassified" — hide until holdings have asset classes.
- Transfer-nudge banner sits above the filters on every visit; move it inline under the summary.

### Charts (P2)
- Add a comparison baseline: dashed prior-period / 12-month-average tick on monthly bars.
- Tooltips: add Δ vs prior month (and %) and transaction count.
- Donut: cap at ~6 slices + "Everything else" (already done) but rank-list alternative on mobile.
- Annotate one-off events (account linked, bonus) so jumps aren't misread.

## Patterns worth stealing (research)
Copilot: month-to-date vs same-point-last-month, pace line, review queue on Home, horizontal "Upcoming" strip.
Monarch: customizable/reorderable cards, weekly recap narrative (hideable), click any chart segment → filtered
transactions, saved reports with relative dates. YNAB: ranked category list with % of total. Lunch Money:
stats panel (top merchants, largest purchases), % change in trend tooltips. Simplifi: payee/tag filters with
"exclude transaction".
