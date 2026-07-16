# Census — monarch-iphone-03

## Evidence
- `design/references/monarch/iphone-17-Frame_1400002685.png` → App Store marketing slide, "SECURITY" theme: headline copy + a photo of a person holding a phone, three benefit callouts (bank-level encryption / read-only access / no data selling). No app UI chrome is shown in this image — it is pure marketing copy, not a screenshot.
- `design/references/monarch/iphone-18-1-hero.png` → App Store marketing hero slide: press-award callouts over a full-app screenshot of the **Accounts** screen (Net Worth tab) rendered inside what is unambiguously an **iPad-shaped device frame** (visible bezel, camera, physical volume buttons), with the left nav sidebar collapsed/hidden.
- `design/references/monarch/iphone-19-Frame_1400002692.png` → App Store marketing slide, "TRACK SPENDING" theme: a phone-shaped screenshot of the transaction-review / swipe-to-categorize screen for a single merchant (Peloton), with a diagonal overlay card demonstrating the "Marked as Reviewed" swipe outcome.
- `design/references/monarch/iphone-20-2-net-worth.png` → App Store marketing slide, "ACCOUNTS" theme: linked-institution logo row over a full-app screenshot of the **Accounts** screen, again inside an **iPad-shaped device frame**, this time with the left nav sidebar expanded and scrolled to show more account groups (Vehicles, Credit Cards, Loans) than image 18.

Note: despite the manifest grouping these four files under `group: "iphone"`, images 18 and 20 both depict an iPad-framed screenshot of a desktop/tablet-width layout (visible sidebar nav, multi-column tab bar) — only images 17 and 19 show a true phone-width UI (image 17 has no UI at all, just marketing copy + photo).

## Information architecture
From image 20's expanded sidebar, the left nav rail (iPad/desktop width) lists, top to bottom, with one icon each:
1. Dashboard (house icon)
2. Accounts (stacked-layers icon) — highlighted/active with a gray pill background, confirming this is the current screen
3. Transactions (card icon)
4. Cash Flow (bar-chart icon)
5. Budget (map icon)
6. Recurring (calendar icon)
7. Goals (target icon)
8. Investments (trending-up icon)

Sidebar header: "🦋 Monarch" wordmark (butterfly glyph + serif logotype) with a gear/settings icon at the top of the sidebar.

Within the Accounts screen itself, a second-level tab bar sits directly under the page title (visible in image 18): **NET WORTH** (selected), **CASH**, **INVESTMENTS**, **REAL ESTATE**, **VEHICLES**, **CREDIT CARDS**, **LOANS** — i.e., account-type filtering is one tap away without leaving the Accounts screen. Below that, a time-range selector for the net-worth chart: **1M** (selected), **3M**, **6M**, **1Y**, **ALL**.

The transaction-review screen (image 19) is reached as its own modal/full-screen flow distinct from the main nav — its header shows a back arrow (←) and a count-down title ("3 remaining") rather than a page name, implying it is a queue/task view layered on top of Transactions rather than a nav-level destination. From it, "12 transactions →" (blue link text) is one tap away to see all transactions for that merchant — i.e., merchant-level drill-down is one click from an individual transaction's review card.

## Layout & content
**Image 18 / 20 (Accounts screen, iPad frame):**
- Top bar: sidebar-toggle icon, bell (notifications) icon, centered title "Accounts", and on the right a "…" (more options) icon and a "+" (add) icon.
- (Image 18 only, sidebar collapsed) Big net-worth figure: **$686,989.93**, with adjacent delta directly under it: "↑ $22,292.97 (3.4%)  1 month" in green — status (direction arrow + signed dollar delta + percent + period) sits immediately below the headline number, not beside it.
- Below the figure, a filled blue area/line chart with a dashed horizontal reference line (appears to mark the chart's starting/baseline value) and the 1M/3M/6M/1Y/ALL range tabs beneath it.
- Below the chart, a **grouped, subtotaled list** of accounts. Each group has a header row (bold group name, right-aligned group subtotal) with its own delta line directly under the name ("↑ $649.70 (1%)  1 month" style) and a right-aligned "X% of assets" (or "% of liabilities") caption under the subtotal, visually separated from the dollar figure by a short dashed underline/divider.
- Groups observed, in order, with exact figures:
  - **Cash** — $65,819.70, ↑ $649.70 (1%) 1 month, 7% of assets
    - Melanie's Checking — Checking — $15,594.64 — "11 hours ago" (citi logo icon)
    - Joint Savings — Savings — $50,225.06 — "11 hours ago" (bank logo icon)
  - **Investments** — $542,032.32, ↑ $10,600.90 (2%) 1 month, 58% of assets
    - Jon's 401k — 401k — $180,684.29 — "11 hours ago"
    - Melanie's 401k — 401k — $150,141.42 — "11 hours ago"
    - Melanie's IRA — Individual Retirement Account (IRA) — $200,737.82 — "11 hours ago"
    - Brokerage — Brokerage (Taxable) — $10,468.79 — "11 hours ago"
  - **Real Estate** — $300,054.83, ↑ $5,909.99 (2%) 1 month, 32% of assets
    - Home — Primary Home — $300,054.83 — "11 hours ago"
  - **Vehicles** (visible in image 20 only) — $20,330.80, ↑ $102.89 (0.5%) 1 month, 2% of assets
    - Honda CR-V — Car — $20,330.80 — "11 hours ago"
  - **Credit Cards** (image 20 only) — $2,022.09, ↓ $179.15 (-8.1%) 1 month, 1% of liabilities
    - Joint Credit Card — Credit Card — $2,022.09 — "11 hours ago"
  - **Loans** (image 20 only, cut off at bottom edge) — $239,225.63, delta partially cropped ("...$4,850.34 (-2%)"), "99% of liabilities" partially visible.
- Every account row follows the same template: circular institution/account-type icon (left) · account nickname (bold) + account subtype label (gray, smaller, under the name) · balance (right, bold) + "11 hours ago" freshness timestamp (gray, smaller, right-aligned under the balance).
- Every dollar figure across both images uses `$X,XXX.XX` formatting — comma thousands separators, always two decimal places, right-aligned.
- Density: image 18's crop shows 3 full groups (Cash, Investments, partial Real Estate) — roughly 9 account rows plus 3 group headers in the visible area. Image 20's crop (sidebar expanded) shows 6 groups (Cash through Loans) — roughly 9 account rows plus 6 group headers, i.e. a summary (group subtotal + % of total) directly fused with the same-row detail (per-account balance) rather than separate summary/detail screens.
- Institution logos row (image 20, above the device frame): 5 circular brand marks — Chase (blue square), Capital One (dark navy), Robinhood (green feather), an unlabeled green sunburst icon, and Vanguard (dark red "V").

**Image 17 (Security slide):**
- Eyebrow label "SECURITY" (orange, all-caps, letter-spaced) over serif headline "Your data is yours. *Always.*" (last word italicized).
- Three stacked white rounded-rect cards, each: icon (left) + single line of text (right):
  - orange bank/columns icon — "Bank-level encryption"
  - teal padlock icon — "Read-only access"
  - gold shield-with-person icon — "We never sell your data or serve you ads"
- Photo of a person in a denim jacket and cap holding a phone, layered behind/below the cards; an orange angular shape in the bottom-left corner.

**Image 19 (Transaction review slide):**
- Eyebrow "TRACK SPENDING" (orange) over serif headline "Review transactions with a *swipe*." (last word italicized).
- Phone screenshot, status bar time "9:41", header: back arrow (←), centered title "3 remaining" (a countdown, not a page name), a filter/sort icon (sliders glyph) on the right.
- Merchant card: pink "P" logo icon, merchant name "Peloton" (bold), blue link text "12 transactions →" directly under the name.
- Section "CATEGORY" (gray caps label) with a 2-column chip grid: "🏋️ Fitness" (selected — orange outline/fill), "📢 Adverti[sing]" (cut off), "🚗 Auto payment", "🎗️ C[haritable, cut off]", "👶 Child Care", "🔍 Other".
- Section "Tags" (mixed-case label, smaller/less prominent than "CATEGORY") with its own chip grid: "🔵 Tax", "🔵 Reimburse[ment]" (cut off), "🔵 Business", "🏷️ Other".
- Section "Date" with a bordered field showing "June 13, 2025".
- A bordered text field with placeholder "Add notes…".
- Bottom action row (partially obscured by overlay): "Skip for now" (plain/secondary) and an orange "Mark as rev[iewed]" button (cut off).
- Large diagonal orange overlay card with a white circular checkmark icon and bold text "Marked as Reviewed" — this is a demonstrative overlay illustrating the outcome of the swipe gesture, composited on top of the same screenshot rather than a second, separate screen capture.

## Controls inventory
- Sidebar toggle icon (top-left of main panel) — collapses/expands the left nav rail (inferred from its presence/absence between images 18 and 20).
- Bell icon — notifications, top bar.
- "…" (more options) icon — top-right of Accounts page.
- "+" (add) icon — top-right of Accounts page; almost certainly "add account."
- Tab bar: NET WORTH / CASH / INVESTMENTS / REAL ESTATE / VEHICLES / CREDIT CARDS / LOANS — filter the Accounts view by account type; NET WORTH shown selected (light gray pill background).
- Chart range selector: 1M / 3M / 6M / 1Y / ALL — 1M shown selected.
- Nav rail items (Dashboard, Accounts, Transactions, Cash Flow, Budget, Recurring, Goals, Investments) — each a clickable destination; Accounts shown active with gray background highlight.
- Settings gear icon — top of sidebar next to "Monarch" wordmark.
- Filter/sort icon (sliders) — top-right of the transaction-review screen.
- Category chips (single-select apparent — "Fitness" shown with a distinct orange outline/highlight vs. the other unselected gray-outline chips): Fitness, Advertising(?), Auto payment, C...(?), Child Care, Other — each with a leading emoji icon.
- Tag chips (appear multi-select-capable, styled as a distinct row from Category): Tax, Reimburse(ment), Business, Other — first three have a solid blue dot bullet, "Other" has a tag/label glyph instead.
- Date field — "June 13, 2025", tappable/editable.
- Notes field — free-text, placeholder "Add notes…".
- "Skip for now" — secondary/plain-text button, defers the current transaction without marking reviewed.
- "Mark as rev[iewed]" — primary orange button (label cut off, near-certainly "Mark as reviewed").
- "12 transactions →" — blue link text, drills into all transactions for the Peloton merchant.
- Badges/status: green up-arrow + delta + percent + period on Cash/Investments/Real Estate/Vehicles group headers and the net-worth total; a down-arrow + delta + percent + period on Credit Cards and Loans group headers styled identically (same green tone as the up-arrows), consistent with a liability balance decreasing being a favorable (green) net-worth event rather than a literal-sign-based red/green rule.
- "X% of assets" / "X% of liabilities" caption under each group subtotal, set off by a short dashed divider line — a composition-of-total indicator, not an interactive control.
- "11 hours ago" — per-account freshness/last-synced timestamp, not interactive but consistently placed under every balance figure.

## Flow steps
1. User is presented a transaction-review card for a flagged/uncategorized transaction (Peloton) → sees merchant name, a link to that merchant's other transactions, and pre-filled/selectable Category and Tag chips, Date, and Notes fields (image 19).
2. User swipes the card (gesture itself not directly visible, only implied by the marketing headline "Review transactions with a swipe") → sees a full-card orange overlay confirming "Marked as Reviewed" with a checkmark icon (image 19).
3. Header count ("3 remaining") implies the queue decrements after each reviewed transaction, though the pre- and post-swipe counts are not both captured in the evidence — only "3 remaining" is shown, with the confirmation overlay superimposed on the same shot.

## States
- Queue/count state: header text "3 remaining" — a live countdown of items left in the review queue, encoded directly in the nav-bar title rather than a separate label.
- Confirmation state: overlay text "Marked as Reviewed" with a checkmark icon, shown as an interstitial after a swipe action.
- No empty, loading, or error states are visible in any of the four images — all four are populated/happy-path marketing captures.

## Business rules implied
- Net worth is computed as a sum of grouped account-type subtotals (Cash, Investments, Real Estate, Vehicles minus Credit Cards, Loans), each subtotal further expressed as a "% of assets" or "% of liabilities" share — image 18/20.
- Account freshness is tracked and surfaced per-account ("11 hours ago" on every row), not just at the sync/institution level — image 18/20.
- A balance decrease on a liability account (Credit Cards: ↓ $179.15 (-8.1%); Loans: ↓ $4,850.34 (-2%)) is styled with the same "favorable" green treatment as an asset increase, i.e., color encodes net-worth direction/impact rather than literal positive/negative sign — image 20.
- Each account has both a user-assigned nickname (e.g., "Melanie's Checking," "Jon's 401k") and a system/account-type subtype label (e.g., "Checking," "401k," "Individual Retirement Account (IRA)," "Brokerage (Taxable)") shown together — accounts are owned/attributable to a named person within a shared household, not anonymized — image 18/20.
- A transaction can carry exactly one Category (chip styling implies single-select, only one chip — "Fitness" — shown highlighted) alongside multiple, separately-grouped Tags (Tax / Reimburse / Business / Other), i.e., category and tags are modeled as distinct, non-overlapping concepts on the same transaction — image 19.
- Merchant is a first-class grouping concept independent of individual transactions: reviewing one Peloton transaction surfaces a "12 transactions →" link to all transactions from that same merchant — image 19.
- The review workflow supports explicit deferral ("Skip for now") as distinct from completion ("Mark as reviewed"), implying a persistent review-queue state per transaction rather than a forced binary action — image 19.
- Marketing copy claims "Read-only access" and "We never sell your data or serve you ads" as explicit product/security commitments — image 17 (copy claims, not verified UI behavior).

## Standout details
- Group headers fuse three pieces of information in a tight three-line stack (name/subtotal, delta+period, %-of-total with a dashed divider) — a lot of context in a small vertical footprint without a separate "details" screen.
- The "% of assets" / "% of liabilities" caption is a nice touch: it reframes each group's dollar subtotal as a proportion of the whole balance sheet, at zero extra taps.
- Color-coding a liability paydown the same "green/up" as an asset gain (rather than naively coloring by literal sign) is a subtle but meaningful correctness choice for a net-worth-first product.
- The review-queue header repurposes the page-title slot for a live countdown ("3 remaining") instead of a static label — status is embedded directly in the primary navigation chrome.
- Emoji-as-category-icon (🏋️ Fitness, 🚗 Auto payment, 👶 Child Care, 🎗️, 📢) gives categories an instantly scannable, colorful identity without needing a custom icon set.
- Tags are visually and semantically separated from Category (different label casing — "CATEGORY" all-caps vs. "Tags" mixed-case — and different chip bullet style: dot vs. emoji) even though both render as chip grids, signaling a deliberate two-tier taxonomy (one required/primary, one optional/supplementary).
- The merchant-drilldown link ("12 transactions →") is placed directly under the merchant name inside the review card itself, letting a user jump to full merchant history without leaving or losing their place in the review queue.

## Open questions
- Whether the left nav sidebar is genuinely toggleable by the user, or whether images 18 and 20 are simply two different marketing crops/scroll states edited independently — the evidence shows both states but not an actual toggle interaction.
- Full label text for several cut-off chips: "Adverti[sing]", "C[?]" (charitable? started with a ribbon emoji 🎗️), and "Reimburse[ment]" — exact wording not fully legible/confirmed.
- Full text of the primary review button, "Mark as rev[iewed]" — plausible completion "Mark as reviewed" is inferred, not fully visible.
- Exact figures for the Loans group (subtotal $239,225.63 is legible; the delta line and "99%" caption are cropped/partially cut off at the image edge) — could not confirm full precision.
- Whether Category chips are strictly single-select and Tags strictly multi-select — inferred only from the fact that exactly one Category chip is shown highlighted versus zero Tag chips highlighted in this particular (unfilled) example; no interaction sequence evidences enforced cardinality.
- Whether "11 hours ago" reflects a global last-sync run or a genuinely per-account sync timestamp that could vary account-to-account — all visible rows happen to share the same value, so independent variation is not evidenced.
- Whether the dashed horizontal line on the net-worth chart is a fixed zero/baseline reference or a dynamic marker (e.g., start-of-period value) — not labeled.
- The device frame in images 18 and 20 is clearly iPad-shaped (bezel, camera dot, buttons) despite the manifest's "iphone" grouping and folder placement; it's unclear whether this reflects a manifest/curation labeling inconsistency or an intentional inclusion of iPad marketing assets within the iPhone unit — flagging rather than correcting.
