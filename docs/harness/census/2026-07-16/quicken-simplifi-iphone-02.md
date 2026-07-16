# Census — quicken-simplifi-iphone-02

## Evidence
- `iphone-09-PromotionalImage-1024x1024-10.png` → App Store icon/branding tile: "Quicken" wordmark (indigo, speech-bubble "Q") stacked over "Simplifi" wordmark, on white ground. No app UI, no data. 1024×1024 square (App Store promo-image aspect), plain logo lockup only.
- `iphone-10-0x0ss-2.png` → Marketing screenshot: "Smart budgeting" headline over a Spending Plan card — big "$1,415 / Left this month" figure, a ring/donut chart, and a 5-row category breakdown list (Income, Bills, Planned Spend, Other Spend, Savings Goals).
- `iphone-11-0x0ss-7.png` → Marketing screenshot: "All your finances in one, and then some" headline over an Investments card — "$200,725" total with a green %-change pill and daily-dollar delta, an area/line balance chart, and a "Month" list of six trailing month-end balances (December→July).
- `iphone-12-0x0ss.png` → Marketing screenshot: "Know what's next with your money" headline, this time the card is shown mounted inside a black iPhone bezel (device frame). Card contents: "Projected Cash Flow" line chart with a "Today" marker and a callout bubble "$31,452"; a "Banking" section ("$87,762" / "Cash & Checking" subtitle, then "Credit -$10,553" and "Savings $80,107" rows); three pill-shaped line-item rows "Consultation +$150.00", "Cabinet Design +$375.00", "Installation +$900.00".
- `iphone-13-0x0ss-4.png` → Marketing screenshot: "Tools that are predictive & adaptive" headline over the identical card content as iphone-12 (Projected Cash Flow $31,452 callout, Banking $87,762/Credit -$10,553/Savings $80,107, same three pill line items), but presented as a free-floating card with no phone bezel — near-duplicate content under different marketing copy.
- `iphone-14-0x0ss-5.png` → Marketing screenshot: "Turn 'what ifs' into an actual plan" headline over two stacked cards — a "Retirement" card (stacked area chart, x-axis 55/65/75, callout "$2.4mil" pinned at age 65) and, below it, the same "Investments $200,725" card/chart seen in iphone-11 (cropped before its "Month" list would appear).

## Information architecture
No navigation chrome (tab bar, top nav, hamburger, back button, status bar) is visible in any of the six images — these are marketing-composite crops of individual feature "cards" pasted onto a solid indigo background with headline/subhead copy, not full in-context app screens. Only `iphone-12` shows any device chrome at all (a black phone bezel around the card), and even that omits the OS status bar/home indicator.
Because of this, no tab structure, screen hierarchy, or "N clicks away" relationship can be determined from this unit. The only structural signal is card grouping within a single screen:
- A "Spending Plan"-type screen appears to contain, top-to-bottom: a headline total ("Left this month"), a donut chart, then a categorized list (Income/Bills/Planned Spend/Other Spend/Savings Goals) — implying these five buckets are siblings under one "plan" view.
- A "Home/Dashboard"-type screen (iphone-12/13) appears to stack, top-to-bottom: Projected Cash Flow chart → Banking accounts summary (Cash & Checking, Credit, Savings) → a short list of recent/pinned line items (Consultation, Cabinet Design, Installation) — suggesting a dashboard that combines a forecast widget, an account-balances widget, and a recent-activity widget on one surface.
- A "Retirement" card and an "Investments" card appear stacked directly on top of each other in iphone-14, suggesting Retirement and Investments live on the same scrollable screen (or are adjacent in a planning/investing section).

## Layout & content
**Spending Plan card (iphone-10):**
- Big figure "$1,415" (dollar sign rendered smaller than the digits) with label directly beneath it: "Left this month" — status/context is a caption under the number, not inline.
- Donut/ring chart (5 slices, hollow center, no labels or values printed on the chart itself) sits below the headline figure.
- Below the chart, a card with 5 rows, each: colored square icon (with a "+" or "–" glyph inside) — label — right-aligned signed dollar amount — chevron ("›"). Rows: Income (+$4,000), Bills (-$1,385), Planned Spend (-$600), Other Spend (-$400), Savings Goals (-$200). Density: 5 rows, all visible without scrolling in the crop; this is a summary view (no per-transaction detail shown).
- Number formatting: whole-dollar amounts, comma thousands separator, explicit leading "+" on the one inflow, explicit leading "–" on the four outflows; income amount rendered in green, all four outflow amounts rendered in plain black (not red) despite being negative/decreases.
- Arithmetic check: 4000 − 1385 − 600 − 400 − 200 = 1415, i.e., the headline "$1,415 Left this month" is exactly Income minus the four outflow buckets shown — an internally consistent, directly verifiable roll-up.

**Investments card (iphone-11, recurs in iphone-14):**
- Section label "Investments" (small, plain) above the headline figure "$200,725" (large, bold, small superscript-style "$").
- Immediately below the total: a green-outlined pill badge "↑ 0.92%" plus adjacent plain green text "+$39.92 today" — two co-located representations of the same change (percent and dollar), both green (gain), both directly adjacent to the total they qualify.
- Area/line chart below, y-axis gridlines labeled "$210k / $200k / $190k / $180k" (abbreviated "k" units), chart fill in solid indigo, no visible x-axis labels/dates on the chart itself.
- Below the chart (iphone-11 only — cut off in iphone-14), a "Month" list: 6 rows, each a month name left-aligned and a dollar balance right-aligned: December $200,736, November $198,214, October $194,052, September $192,718, August $196,624, July $191,891. All values plain black regardless of month-over-month direction (e.g., August→September is a decrease, but not colored red) — this list is descriptive history, not an evaluative delta list.

**Projected Cash Flow + Banking + line items card (iphone-12/13, identical content):**
- "Projected Cash Flow" title, line chart with a vertical "Today" marker; line is solid up to "Today" and dashed/dotted after it — a clear actual-vs-projected visual convention. Y-axis labeled "$35k/$30k/$25k/$20k". A callout bubble "$31,452" is pinned to a specific point on the dashed (future) portion of the line, positioned at a local peak after a dip.
- "Banking" section: label "Banking", headline figure "$87,762", caption directly beneath it "Cash & Checking" (the caption names what the headline number is, rather than being a generic status word). Below that, two more rows with no icons, just label + right-aligned amount: "Credit  -$10,553" and "Savings  $80,107". These three figures do not sum to a fourth displayed total or to each other in any evident way (87,762 − 10,553 + 80,107 = 157,316, not shown anywhere), so "Banking $87,762" reads as the Cash & Checking balance specifically, with Credit and Savings shown as separate, unaggregated account lines beneath it.
- Three pill-shaped rows below, each a rounded/stadium-shaped outlined container: "Consultation  +$150.00", "Cabinet Design  +$375.00", "Installation  +$900.00" — all amounts green with leading "+", two decimal places shown (unlike the whole-dollar big totals elsewhere). Visual style (pill outline, no icon, no chevron) differs from both the Spending Plan's icon-square rows and the Investments' plain "Month" rows.

**Retirement card (iphone-14):**
- Title "Retirement", headline callout "$2.4mil" (abbreviated large-number format, distinct from the "$200,725"/"$210k" formatting used elsewhere) positioned above a vertical marker on the x-axis at "65".
- Stacked/layered area chart in three colors (indigo top layer, green middle layer, yellow-green bottom layer), x-axis labeled "55 / 65 / 75" (ages), y-axis labeled "$3m / $2m / $1m" — no legend distinguishing what the three colored layers individually represent.

## Controls inventory
Because these are static marketing crops, very few controls are legible, and none can be confirmed as tappable within this evidence — only their apparent affordance is noted:
- Chevron ("›") at the right edge of each Spending Plan category row (Income, Bills, Planned Spend, Other Spend, Savings Goals) — apparent "drill into category" affordance (iphone-10).
- Green outlined pill "↑ 0.92%" next to the Investments total — reads as a badge, not an obviously tappable control, but visually set apart with a border like a chip (iphone-11, iphone-14).
- Colored square icon with "+"/"–" glyph at the left of each Spending Plan row — functions as a category-type badge (inflow vs. outflow), not evidenced as interactive.
- Pill-outlined rows (Consultation/Cabinet Design/Installation) — same ambiguity; bordered like tappable list rows but no chevron or other affordance shown.
No visible filters, sorts, search fields, bulk-selection controls, tabs, or toggles in any of the six images.

## Flow steps
N/A — this unit contains six independent marketing stills, each promoting a different feature (Spending Plan, Investments, Cash Flow/Banking ×2 near-duplicates, Retirement). There is no multi-screen sequence, no evidenced user action, and no confirmation/undo affordance shown anywhere in this unit.

## States
No empty, loading, or error states are shown — every screen in this unit is a fully populated "happy path" marketing composite with realistic-looking but clearly staged data (round investment gains, a full month of category spend, six months of trailing balances). No system copy (error text, empty-state copy, toasts) is visible anywhere in this unit.

## Business rules implied
- The Spending Plan's "Left this month" figure is a direct arithmetic roll-up: Income − (Bills + Planned Spend + Other Spend + Savings Goals) = $4,000 − $1,385 − $600 − $400 − $200 = $1,415, matching the displayed headline exactly (`iphone-10-0x0ss-2.png`).
- Spending is bucketed into exactly five named categories at the top level of the plan: Income, Bills, Planned Spend, Other Spend, Savings Goals (`iphone-10-0x0ss-2.png`).
- Negative/outflow amounts are rendered with a leading "–" in plain black text, not in red, in both the Spending Plan rows and the Banking "Credit -$10,553" row — red is not used as a negative-money signal anywhere in this evidence (`iphone-10-0x0ss-2.png`, `iphone-12-0x0ss.png`, `iphone-13-0x0ss-4.png`).
- Positive/inflow amounts (income, investment gains, line-item credits) are consistently rendered in green with a leading "+" (`iphone-10`, `iphone-11`, `iphone-12`, `iphone-13`).
- Projected/future cash flow is visually distinguished from actual/historical cash flow by a solid-vs-dashed line change at a "Today" marker (`iphone-12-0x0ss.png`, `iphone-13-0x0ss-4.png`).
- Investment performance is reported with two co-located, redundant representations of the same change — a percentage (in a pill badge) and a same-day dollar delta — both anchored directly beneath the total they describe (`iphone-11-0x0ss-7.png`, `iphone-14-0x0ss-5.png`).
- Large dollar totals switch to an abbreviated unit suffix at different magnitudes: chart axis ticks abbreviate as "$Nk" (e.g., "$210k"), while the retirement headline abbreviates as "$N.Nmil" (e.g., "$2.4mil") — two different abbreviation conventions coexist in the same product (`iphone-11-0x0ss-7.png` vs. `iphone-14-0x0ss-5.png`).
- Historical monthly balances (the "Month" list) are shown as neutral/undifferentiated figures with no color or delta indicator even when month-over-month values decrease (e.g., August $196,624 → September $192,718), unlike the "today" investment delta which is colored (`iphone-11-0x0ss-7.png`).

## Standout details
- Small-caps-style numeral formatting: the "$" glyph is rendered visibly smaller than the digits that follow it in every large headline figure ("$1,415", "$200,725", "$87,762") — a consistent typographic treatment across screens.
- Dual-format change indicator on Investments: a bordered pill for the percentage plus plain text for the dollar delta, both green, both directly under the total — lets a viewer read either "shape" (rate or amount) of the same gain at a glance.
- Solid-line-to-dashed-line transition at a "Today" vertical marker on the cash-flow chart is an efficient, label-free way to encode "actual" vs. "projected" without a legend.
- A callout bubble is pinned to a specific future point on the projected cash-flow line (the local trough/peak after a dip), spotlighting a specific projected balance ("$31,452") rather than just leaving the viewer to read the axis — draws the eye to a projected low point worth planning around.
- Colored-square icon containing a literal "+" or "–" glyph inside the Spending Plan category rows doubles as both a color-coded chart-legend key and an at-a-glance inflow/outflow marker on the list itself, tying the donut chart and the list together without printed labels on the donut.
- Pill-shaped (stadium-border) row styling used only for the three business-sounding line items (Consultation, Cabinet Design, Installation) is visually distinct from every other row style in the evidence (icon-square rows, plain label/value rows) — suggests a deliberately different treatment for what may be invoice- or project-style entries versus ordinary transactions.

## Open questions
- True in-app navigation (tabs, menus, screen order) cannot be determined — none of the six images shows nav chrome; all are cropped marketing cards on a plain colored background, and only one (`iphone-12`) even shows a partial device bezel.
- Whether "$87,762" under "Banking" is a combined total (e.g., checking + savings − credit) or simply equals the "Cash & Checking" balance alone is unresolved; the three visible figures ($87,762, -$10,553, $80,107) do not sum to any other displayed number, so it reads as the latter, but this is an inference, not confirmed text.
- The exact real-world meaning of the "Consultation / Cabinet Design / Installation" line items (invoice items? a specific job's payments? recent transactions?) and whether they belong under the "Banking" section header above them or are an independent list is not stated anywhere in the crop.
- No legend accompanies the Retirement card's three-colored stacked area chart, so the meaning of each color band (e.g., contributions vs. growth vs. principal) cannot be confirmed from this evidence.
- The Spending Plan donut chart has no printed labels/values on the slices; matching slice colors to the list rows below (Income/Bills/Planned Spend/Other Spend/Savings Goals) is done by color inference only and is not explicitly confirmed by connecting lines, callouts, or shared labels in the image.
- Whether `iphone-12` and `iphone-13` represent the same literal screen (identical data down to the cent) reused under two different marketing headlines, or two separately staged but coincidentally identical mock states, cannot be distinguished from the image content alone.
