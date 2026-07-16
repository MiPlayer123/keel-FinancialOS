# Census — ramp-community-02

## Evidence
- `design/references/ramp/community-09-policy-agent-analytics.png` → Analytics dashboard for Ramp's policy/approvals AI ("Ramp's policy agent" + "Department" tables with trend sparkline and outcome breakdown) paired with a right-hand transaction "Activity" timeline.
- `design/references/ramp/community-10-budget-dashboard.webp` → "2026 Budget" overview dashboard: summary donut + monthly bar chart + a budget line-items table (department/category rows with utilization bars).
- `design/references/ramp/community-11-bill-pay-new-bill-ocr.png` → Bill Pay "New Bill" draft screen, split-pane: left is the source invoice PDF viewer, right is an AI-populated bill form mid-OCR-processing ("Ramp is still processing this invoice for you...").
- `design/references/ramp/community-12-bill-pay-list-filters.png` → Bill Pay "Bills" list (Overview tab) with an open filter-builder popover for an "Accounting Class is not Administrative" filter.

## Information architecture
- Ramp's top-level surfaces evidenced here: a **Policy Agent / analytics** area (reachable via "Explore the data →" links suggesting drill-through reports), a **Budget** module (top-level "2026 Budget" page with its own Overview/Actuals tabs and Settings/Activity), and **Bill Pay**, which itself has four tabs: Overview, Drafts, For approval, For payment (image 12), and a distinct "New Bill" draft/detail view reached from Drafts (image 11).
- Bill Pay's IA is a classic queue-by-status pattern: Overview (all bills) vs. Drafts vs. For approval vs. For payment — i.e., a bill's lifecycle stage is a first-class navigation tab, not just a filter.
- The Budget page groups "Overview" (aggregate charts + rollup table) separate from "Actuals" (tab exists but not shown open) — summary and transaction-level detail are architecturally split.
- Within Budget's rollup table, rows are typed and nested: a "Dept" row (e.g., Product Management) sits at one level, and a "Category Rollup" row (e.g., Marketing) is indented under a return-arrow (↳) glyph, implying budgets can be organized by two different grouping dimensions (department and category) inside the same table, with categories nested under whatever they roll up to.
- The policy-agent analytics view puts a live "Activity" feed one panel away (right side, same screen, no navigation required) from the aggregate policy-agent stats — i.e., the system pairs "what the AI decided in aggregate" directly next to "what the AI is doing right now," on one screen, no click needed.
- "Explore the data →" links (next to "Ramp's policy agent" and "Department" section headers) imply each summary table is one click from a fuller report/detail view, though that destination is not captured in this evidence set.
- The Bill Pay filter system is a popover reached by clicking an existing filter pill ("Accounting Class is not Administrative"), which opens a searchable checkbox list — filter editing happens in place, not via a separate modal or page.

## Layout & content
**Image 09 — Policy agent analytics:**
- Top strip: three equal-width stat cards, each with (top-left) a metric label, (top-right) a colored percent-change badge, (large) a headline percentage with a trailing arrow (→), and beneath that a full-width sparkline/area chart.
  - Card 1: "In policy spend" · badge "Up 1.6%" (green) · "91.6% →" · blue-gradient area sparkline.
  - Card 2: "Repayments" · badge "Down 79%" (red/orange) · "91.2% →" · caption "of repayments requested have been repaid" · green-gradient sparkline with a sharp downward spike near the right edge.
  - Card 3: "Policy agent" · badge "Up 0.4%" (green) · "99.6% →" · caption "of approval suggestions accepted" · purple-gradient sparkline.
  - Every money-adjacent figure here is a percentage, not a raw currency amount, and every one carries an explicit period-over-period direction+magnitude badge directly beside it — status is never separated from the number.
- Below the cards, left column, "Ramp's policy agent" table (subtitle: "See how closely reviewers align with AI agent policy decisions."), columns: Outcome | % of total | Trend (with an info "ⓘ" icon on the Trend header) — six numbered rows, each with a small colored bullet dot preceding the outcome label:
  1. "Suggested review, expense was approved" — 49.24% — sub-line "$3,160,347.33" — Trend "↓ 0.2%"
  2. "Suggested approval, expense was approved" — 37.98% — "$2,438,110.85" — "↑ 0.6%"
  3. "Suggested rejection, expense was approved" — 12.40% — "$795,683.02" — "--" (flat/no change)
  4. "Suggested review, expense was repaid" — 0.15% — "$9,693.91" — "↓ 0.2%"
  5. "Suggested rejection, expense was repaid" — 0.15% — "$9,428.02" — "↑ 0.4%"
  6. "Suggested approval, expense was repaid" — 0.09% — "$5,504.82" — "↓ 0.2%"
  - Every dollar figure sits as a secondary/smaller line directly under its own percentage — the percentage is primary, the raw dollar total is the supporting context, never the reverse.
  - To the right of this table, one combined area/line chart with y-axis gridlines drawn as pill-shaped labels (100%, 80%, 60%, 40%, 20%) rather than plain axis ticks; a dominant green band plus two thinner lower lines (grey-blue and orange) trend downward left-to-right.
- Below that, "Department" table (subtitle: "Understand which teams are contributing most to policy violations, and why."), columns: Department | Out of policy | Trend | Insight:
  1. "Corporate" — "$308,226.35" (underlined) with sub-line "112 items" — "↑ 3.7%" — Insight: "Alcohol violations and gift card purchases consistently bypass controls across multiple employees"
  2. "Field & Events Marketing" — "$97,886.01" (underlined) with sub-line "61 items" — "↑ 3.9%" — Insight: "Consistent pattern of alcohol purchases and weekend spending with non-itemized receipts"
  - Dollar amounts are underlined here (implying a clickable/drill-through link), unlike the percentages in the policy-agent table above.
- Right column, full height: "Activity" header (with a collapse chevron "⌄" to its left) over a vertical timeline feed, each entry = small circular actor avatar + actor name + "· Today, H:MM AM/PM" timestamp + one line of plain-English description of what happened, connected by a thin vertical rule:
  1. Ramp (bird-logo avatar) · Today, 4:36 AM · "Approved transaction because it's in policy and no other issues were found"
  2. Catalina Crunch (merchant-logo avatar) · Today, 4:35 AM · "Catalina Crunch cleared this transaction"
  3. Ramp · Today, 12:24 AM · "Automatically matched a receipt from Gmail Integration with this transaction"
  4. Ramp · Today, 12:15 AM · "Updated the memo" followed by a distinct gray chip/pill showing the new memo value: "Office snacks and beverages"
  5. Matthew Shafeek (person-initial avatar, blue) · Today, 12:15 AM · "Spent $56.19 at Catalina Crunch"
  - Every AI action in the feed states its own justification in plain language ("because it's in policy and no other issues were found") rather than just naming the action.

**Image 10 — Budget dashboard:**
- Page header "2026 Budget" (large), top-right "Activity" button and "Settings" button (gear icon).
- Tab row: "Overview" (active/underlined), "Actuals".
- Toolbar row: "Search or add filter..." input (search icon) on the left; on the right, "Full budget period" (icon), "View report" (icon), and a three-way segmented control "All | Over budget | My budgets".
- Summary block (left of donut): three labeled figures, each preceded by a small dot/glyph matching a legend below the bar chart:
  - "Total budget" — $29,975,372.00 (solid dark-green dot)
  - "Spent" — $9,145,171.54 (solid medium-green dot)
  - "Committed" — $401,362.82 (hatched/textured dot)
- Donut chart: center label "32%" (large) over "Spent" (small, gray) — ring shows a dark-green arc (spent portion) against a light track (remaining).
- Bar chart (right side, cut off at the right edge of the image, months Jan '25–Sept '25 fully visible, Oct–Dec partially visible): y-axis $3M/$2M/$1M gridlines; each month is a layered/composite bar — a light full-height "Budget" bar with a darker or hatched overlay for "Committed"/"Actuals" portions; two bars (Jul '25 and Sept '25) show a distinct crosshatch/diagonal-stripe texture overlay, visually distinguishing forecast/committed spend from posted actuals in past vs. current months.
  - Legend beneath chart: "Budget" (light swatch), "Committed" (hatched swatch), "Actuals" (dark dot swatch).
- Table below, columns: Name | Budget Owners | Total Budget | Utilization (which itself contains sub-columns/labels: Actuals, Committed, a horizontal progress bar, and a right-aligned Remaining/Overage figure); an additional column is sliced off at the right edge of the image (not fully visible).
  - Row 1: "Dept" tag + "Product Management" (with an expand/collapse chevron ˅) — Owners "Megan Yen · Geoff Charles" — Total Budget $655,288.00 — Actuals $404,464.03 (underlined) / Committed $0.00 / progress bar ~62% filled dark green / Remaining $250,832.97.
  - Row 2: identical values to Row 1 ("Dept · Product Management", same owners, same $655,288.00 total, same $404,464.03/$0.00/$250,832.97) — appears to be either a duplicate/mock-data artifact in the source screenshot or a second grouping instance; evidence does not disambiguate (see Open questions).
  - Row 3: "Category Rollup" tag + "Marketing", indented and prefixed with a return arrow (↳) — Owners "-" — Total Budget $0.00 — Actuals $13.69 (underlined) / Committed $0.00 / progress bar shown in orange/red, overflowing its track — and where the other rows show "Remaining," this row shows "Overage" with the figure "$13.69" rendered in red.
  - Numbers are right-aligned within their columns; all dollar figures use "$" prefix, comma thousands separators, and two decimal places consistently (e.g., "$29,975,372.00", "$13.69").

**Image 11 — Bill Pay new-bill OCR screen:**
- Full browser chrome visible: tab reads "Bill Drafts | Ramp", address bar "demo.ramp.com/bills/drafts/new" with a padlock icon, top-right "Guest" account chip and a browser overflow-menu (⋮).
- A yellow horizontal band crops the very top of the image (annotation/highlight artifact from the source capture, not legible as UI text — see Open questions).
- Left pane — PDF/invoice viewer:
  - Toolbar: hamburger menu, "Sample invoice" filename label, page counter "1 / 1", zoom controls "− 82% +", a crop/frame icon, a rotate icon; far right of toolbar: download icon, print icon, more-options (⋮) icon.
  - Rendered invoice (mock/sample data, humorous copy): teal header band with a miner pictogram icon; issuer "Gold Mining Outfitters, LLC", "400 Mission Street", "San Francisco, California 94016"; document title "Invoice"; "BILL TO:" block ("The Mining Collective, LLC", "4890 Onboarding Rampager Way", "New York, New York 10003", "CONTACT: tong@ramp.com"); metadata block "INVOICE #: 898989", "DATE: October 15th, 2021", "DUE ON: October 30th, 2021".
  - Line-item table, columns DESCRIPTION | QUANTITY | PRICE | AMOUNT:
    - "Pickaxes: T-shaped hand tools used for prying" 4 $40.05 $160.20
    - "Shovels: Dirt scoopers" 4 $10.03 $40.12
    - "Gold mining machines: Machines used to extract gold resources" 1 $10,000.10 $10,000.10
    - "Dynamite: A high explosive loved by Yosemite Sam" 10 $150.01 $1,500.10
    - "Fuses: Things that help the dynamite go boom" 7 $0.02 $0.14
    - "Matches: Tools for starting a fire" 10 $0.01 $0.10
  - "NOTES:" block: "Invoice for gold mining supplies. Old timey prices for an old timey business (where else can you get a pickaxe for a nickel?) Good luck seeking your fortune!"
  - Teal footer band, right-aligned: "TOTAL" label above bold large figure "$11,700.76".
- Draggable pane-splitter (vertical dots icon) between the two panes.
- Right pane — "New Bill" form, close "×" icon top right:
  - Status/processing banner (light-blue background) with a small photographic icon (hands holding a device) and a spinner glyph, text: "Ramp is still processing this invoice for you..." then bold "Ultra-accurate AI processing usually takes about an hour. You can double-check the data below manually, or you could come back later." then "Pro-tip: upload invoices in bulk about an hour before you want to process them."
  - "Who's it for?" section: a lightning-bolt icon (AI-autofill indicator) beside vendor name "Gold Mining Outfitters" (bold), with three small icons to the right (expand, pencil/edit, swap); "Vendor Contact" sub-field showing "Tong · tong@ramp.com" with a dropdown chevron; a small trash icon plus muted text "No previous payments to this vendor."
  - "What for?" section: lightning-bolt + "Invoice #" "898989"; lightning-bolt + "Invoice Date" "10/15/21" (calendar icon); "Bill Due Date" "10/30/21" (calendar icon, no lightning-bolt shown next to this one in the captured frame); "Location" field with a dropdown chevron, value unset/empty.
  - Bottom action bar: "Save Changes" (outlined/secondary button, left), a QuickBooks "qb" logo icon, and "Review" (solid green primary button, right).

**Image 12 — Bill Pay list + filter:**
- Breadcrumb "Bill Pay" (small, gray) above page title "Bills" (large, bold).
- Tab row: "Overview" (active/underlined), "Drafts", "For approval", "For payment".
- Applied-filter pill (gray, rounded): funnel/filter icon + text "Accounting Class is not" + a nested white pill reading "Administrative".
- Open filter-editor popover beneath/over the pill: back arrow "←", search field "Find a filter..." (search icon); a checkbox list of accounting classes: "Administrative" (checked, green check, with an "Only" link at the row's right edge), "Cost of Sales" (unchecked), "Hardware" (unchecked), "none" (unchecked, lowercase as shown), "Raw Materials" (unchecked), "Services" (unchecked), "Software" (unchecked); footer row inside the popover: a green "Exclude" toggle (on) and an "Remove filter" link (underlined).
- The underlying bill table/rows are obscured by the open popover and not legible in this capture.

## Controls inventory
- **Policy agent analytics (img 09):** stat-card arrow affordance ("→" after each headline percentage, implying click-through); "Explore the data →" links (×2, one per table section); Trend column info icon "ⓘ" (hover/click for definition, implied); Activity panel collapse chevron "⌄"; underlined dollar figures in the Department table (implied drill-through links).
- **Budget dashboard (img 10):** "Activity" button; "Settings" button (gear icon); tabs "Overview"/"Actuals"; "Search or add filter..." text input; "Full budget period" control (icon-prefixed, likely a period-selector); "View report" control (icon-prefixed); three-way segmented toggle "All / Over budget / My budgets"; per-row expand/collapse chevron ("˅") on Dept and Category Rollup rows; underlined Actuals figures (drill-through links); horizontal utilization progress bars (green = within budget, orange/red = over budget) doubling as a status indicator.
- **Bill Pay new-bill (img 11):** PDF-viewer toolbar controls (hamburger menu, zoom out/in, crop/frame, rotate, download, print, overflow menu); vendor-row icon trio (expand, edit/pencil, swap); "Vendor Contact" dropdown; "Location" dropdown; lightning-bolt badges marking AI-autofilled fields (Vendor, Invoice #, Invoice Date); "Save Changes" button (secondary); "Review" button (primary, green); QuickBooks integration icon (accounting-sync indicator); pane-splitter drag handle.
- **Bill Pay list (img 12):** tabs (Overview/Drafts/For approval/For payment) doubling as status filters; filter pill showing the active rule in plain language ("Accounting Class is not Administrative"); filter-popover search box; per-value checkboxes; a per-row "Only" link (isolate to just this value); "Exclude" toggle switch (inverts the filter's polarity); "Remove filter" link; back arrow to return from the value-list to a filter-type picker (implied by "←").

## Flow steps
Bill creation via OCR (img 11), as evidenced by a single mid-flow screenshot:
1. User uploads/opens an invoice PDF → sees it rendered in the left viewer pane ("Sample invoice", page 1/1).
2. System (AI) begins extracting bill fields → right pane shows a "New Bill" draft form with a processing banner: "Ramp is still processing this invoice for you..." and sets expectations ("usually takes about an hour") while filling in what it already has (vendor, invoice #, invoice date each flagged with a lightning-bolt icon).
3. User may act immediately → "double-check the data below manually" (edit fields directly) or "come back later" (leave and return once processing finishes).
4. User can save partial work ("Save Changes") or proceed once satisfied ("Review", primary button) — no confirmation dialog or undo affordance is visible in this single frame.
Bill Pay list filtering (img 12), single-frame evidence:
1. User clicks an existing filter pill → a popover opens with a searchable value list.
2. User can search ("Find a filter..."), toggle individual values, or click "Only" to isolate one value.
3. User can flip "Exclude" to invert the same rule from "is" to "is not" without rebuilding the filter.
4. User can discard the whole rule via "Remove filter".
No confirmation/undo state is visible for any flow in this evidence set.

## States
- **Processing/in-progress (img 11):** explicit banner copy — "Ramp is still processing this invoice for you..." / "Ultra-accurate AI processing usually takes about an hour. You can double-check the data below manually, or you could come back later." / "Pro-tip: upload invoices in bulk about an hour before you want to process them." — a spinner glyph accompanies the text.
- **Empty/unset field (img 11):** "Location" field shown with no value and only a dropdown chevron — an unset-but-optional state, not an error.
- **Vendor-history empty state (img 11):** "No previous payments to this vendor." shown inline next to a trash icon under the vendor block — a soft empty-state notice, not blocking.
- **Over-budget status (img 10):** the Marketing "Category Rollup" row swaps its rightmost label from "Remaining" to "Overage" and renders both the progress bar and the figure ("$13.69") in orange/red, versus green bar + black "Remaining" text for on-track rows — a state change communicated purely through color and label-swap, no icon or copy warning shown.
- **Filter active state (img 12):** a filled/checked green checkbox plus a distinct "Exclude" toggle communicates two independent on/off states (which values are selected, and whether the rule includes or excludes them) simultaneously.
- No fully-empty-list, loading-skeleton, or hard-error state is captured anywhere in this unit's four images.

## Business rules implied
- Approval decisions distinguish "suggested" (AI recommendation) from the eventual human/system outcome ("expense was approved" / "expense was repaid"), and the system tracks reviewer/agent (dis)agreement as its own metric set — image 09, "Ramp's policy agent" table (six outcome combinations of suggestion × result).
- The AI agent can autonomously approve a transaction and states its own reasoning as a first-class log line rather than a bare status change — image 09, Activity: "Approved transaction because it's in policy and no other issues were found."
- Receipt matching can happen automatically from a connected mailbox with no user action, and this is logged distinctly from a manual match — image 09, Activity: "Automatically matched a receipt from Gmail Integration with this transaction."
- Memo/category text edits made by the AI are versioned/shown as discrete log entries with the new value surfaced verbatim — image 09, Activity: "Updated the memo" + chip "Office snacks and beverages."
- Policy-violation detection is broken out per-department with a plain-language causal explanation attached to each aggregate figure, not just a number — image 09, Department table Insight column ("Alcohol violations and gift card purchases consistently bypass controls...").
- Budget tracking distinguishes three mutually distinct states per line — Actuals (posted), Committed (encumbered but not yet posted), and Remaining/Overage (derived) — and a budget can be over-committed at the category level even while a total-budget figure of "$0.00" is shown for that same rollup row, implying category rollups can carry spend without a directly assigned budget ceiling — image 10, "Marketing" row (Total Budget $0.00, Actuals $13.69, "Overage $13.69").
- Budgets can be organized/rolled up along at least two axes simultaneously — by department ("Dept" tag) and by expense category ("Category Rollup" tag) — within one table — image 10.
- OCR/AI invoice extraction is asynchronous and bulk-oriented; the product explicitly recommends batching uploads roughly an hour ahead of when the data is needed, implying a queued/background processing model rather than synchronous per-invoice extraction — image 11, "Pro-tip: upload invoices in bulk about an hour before you want to process them."
- Vendor payment history is tracked and surfaced at bill-creation time (e.g., "No previous payments to this vendor."), implying the system flags new/unfamiliar payees during entry — image 11.
- Bill Pay's accounting-class filter supports both inclusion and exclusion of the same value set via one "Exclude" toggle, and supports isolating a single value via "Only," rather than requiring the user to manually check/uncheck every other option — image 12.

## Standout details
- Every AI-driven activity-log entry states the "because" — the Activity feed narrates causes ("because it's in policy and no other issues were found") rather than just naming actions, which reads as an explicit trust/legibility design choice for autonomous decisions.
- Fields the AI has auto-filled are marked with a small lightning-bolt glyph (img 11: Vendor, Invoice #, Invoice Date), giving a lightweight, consistent "AI touched this" affordance without needing a caption or color change.
- The processing banner in img 11 proactively sets a time expectation ("usually takes about an hour") and offers two explicit escape hatches ("double-check the data below manually, or you could come back later") plus a workflow tip for batching — turning a wait state into actionable guidance instead of a bare spinner.
- Percent-based headline metrics (img 09 stat cards) always carry their trend badge in the same visual slot (top-right of the card), and always pair the badge's color (green/red) with a directional arrow-coded value, making the "is this good or bad" read instant without parsing the sign.
- Trend column carries an info icon (ⓘ) next to its header in the policy-agent table, suggesting the product documents how "Trend" is computed on hover — a reproducibility affordance in miniature.
- Budget utilization bars double as their own status legend: green fill silently means "on track," while an orange/red fill simultaneously relabels the adjacent text from "Remaining" to "Overage" — one visual change carries both magnitude and verdict.
- Filter UI cleanly separates "which values" (checkboxes + search) from "include vs exclude" (a single toggle), avoiding the common anti-pattern of needing separate "is" and "is not" filter types.
- The invoice mock data (img 11) uses a deliberately absurd "Gold Mining Outfitters" theme with tongue-in-cheek line items (dynamite "loved by Yosemite Sam," matches "for starting a fire") — a demo/sample-data convention worth noting only as evidence hygiene, not a real product pattern.

## Open questions
- Image 10 (budget table): rows 1 and 2 show identical department name, owners, and dollar figures ("Product Management," same $655,288.00/$404,464.03/$250,832.97). The evidence does not settle whether this is a genuine duplicate-row bug/artifact in the captured demo data, two distinct sub-entities that happen to share a name and totals, or a rendering glitch in the screenshot capture.
- Image 10: a column exists to the right of "Utilization" but is cropped off at the image edge — its header and contents are not legible, so its purpose (e.g., row actions, a percent-utilization figure, a "view" link) is unknown.
- Image 10: the exact meaning of the crosshatch-textured bars for Jul '25 and Sept '25 (vs. plain bars for other months) is inferred as a "Committed" overlay from the legend, but the chart itself does not label which segment of each bar corresponds to which legend swatch — could not confirm precisely which bar segments map to Budget vs. Committed vs. Actuals for any single month.
- Image 11: a yellow band crops the very top edge of the screenshot; no text in it is legible, so it's unclear whether it's a browser extension banner, an annotation added during evidence collection, or something else — flagged rather than guessed.
- Image 11: "Bill Due Date" lacks a lightning-bolt AI-autofill icon in this frame while "Invoice Date" and "Invoice #" have one — unclear whether this is a meaningful distinction (e.g., due date computed by a business rule rather than extracted) or simply outside the crop/an inconsistency in the demo capture.
- None of the four images show what happens after "Review" is clicked in Bill Pay, what a fully processed (non-processing) bill draft looks like, what a rejected/flagged-by-policy transaction's Activity entry reads like, or any error/empty-list state for the Bills table — these remain unobserved.
- The exact destination/content of the "Explore the data →" and "View report" links is not shown; only their existence and placement are confirmed.
