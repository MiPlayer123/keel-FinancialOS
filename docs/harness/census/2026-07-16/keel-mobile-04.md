# Census — keel-mobile-04

## Evidence
- `design/current/2026-07-16/accounts-mobile-390.png` (780×1688) → Accounts list screen: net worth summary card, Assets group (2 accounts), Liabilities group (1 account).
- `design/current/2026-07-16/dashboard-mobile-390.png` (780×5386) → Home/Dashboard screen: "Free to spend" card, net position, 30-day cash flow, three single-stat insight cards, projected-cash chart, 90-day net worth chart, cash-flow-by-month bar chart, 30-day spending-by-category bars, condensed accounts summary.
- `design/current/2026-07-16/ledger-mobile-390.png` (780×14850, read in 9 cropped ~1800px slices for legibility) → Ledger/transactions screen: search bar, filter/sort/group controls, Add/Import actions, a long flat transaction list (07-15 back through 05-17), a "Show 47 more of 47" expander, and a totals footer.
- `design/current/2026-07-16/review-mobile-390.png` (780×2331 approx, full) → Review screen showing only the empty state ("Nothing to review").

All four are 390px-wide mobile viewport captures, light theme, at 2026-07-16.

## Information architecture
- Global chrome is identical on all four screens: top bar with a hamburger icon (☰) at far left, centered "keel" wordmark + green swoosh logomark, no right-side icons (no avatar, no notification bell, no search-in-header). The hamburger is never opened in this evidence set, so the full nav tree (which sections live behind it) is not observable from this unit alone — desktop equivalents visible elsewhere in the manifest (Budgets, Goals, Paychecks, Recurring, Reports, Connections, Settings, Statements, Reimbursements) are presumably reachable through it, but that is inferred, not shown.
- Below the top bar, every screen repeats one pattern: bold H1 page title, one-line gray subtitle description, then a full-width horizontal rule before content starts (e.g. "Accounts / Everything you own and owe, by type.", "Home / Your financial position at a glance.", "Ledger / Every transaction, categorized.", "Review / Approve or dismiss what the AI suggests."). This gives every top-level section a one-sentence mission statement, functioning as in-place documentation.
- Accounts and Dashboard both surface the same net-worth figure ($14,763.85) and the same 3 accounts, suggesting Accounts is one tap from Dashboard (or a shared component) rather than a deeply separate IA branch — Dashboard's own condensed "Accounts" block with "Updated 23m ago" appears to be a preview/entry point into the full Accounts page.
- Ledger is reached as its own top-level destination (not nested under Accounts), evidenced by its own H1/subtitle and independent full filter/sort chrome.
- Review is a top-level destination too, separate from Ledger, dedicated solely to an AI-suggestion queue (explicitly scoped to "Recurring series, transfer matches and categorizations" per its own empty-state copy) — i.e. it is not a duplicate of the ledger's per-row category editing, but a distinct queue surface for the suggest→approve workflow.
- A floating circular button (black, white "N" glyph) sits fixed at the bottom-left on Accounts, Dashboard, and Review (not observed on Ledger, though Ledger's bottom is buried far down a very long scroll so it may simply be out of the captured crop). It has no visible label/tooltip in these captures — its purpose (assistant launcher?) is inferred, not confirmed.

## Layout & content
**Accounts**
- Net worth card (white, rounded, bordered): label "Net worth" (gray, small) above "$14,763.85" (large bold black) — no status/date qualifier directly on this figure (no "as of" stamp visible next to it, despite BC-v2.1 §9.1 reproducible-numbers requirement). Two action buttons are anchored top-right of the same card: "⇄ Record transfer" and "+ Add account", stacked.
- "Assets" section header (gray) with its subtotal right-aligned in the same row: "$15,178.90". Two account rows follow:
  - CHASE COLLEGE / Checking — $16,889.94 (black/positive), chevron ">" at far right (row is tappable).
  - Personal Profile / Checking — **-$1,711.04** (red), chevron ">". Note: this is a negative balance shown inside the Assets group, not moved to Liabilities — the red color is the only signal distinguishing it from a normal positive asset row; the section header ("Assets") itself carries no negative-aware relabeling.
- "Liabilities" section header with subtotal right-aligned: "-$415.05". One row: CREDIT CARD / Credit Card — -$415.05 (red), chevron.
- Arithmetic checks out on-screen: Assets ($15,178.90) + Liabilities (-$415.05) = Net worth ($14,763.85) exactly matches the top card.
- Density: only 3 accounts total, occupying roughly the top third of the viewport; the remaining ~60% of the 390×~1688 canvas is blank white space — no manual-account prompt, no "connect more" nudge, no linked-institution branding/logos, no last-synced timestamp on this page itself.

**Dashboard**
- "Free to spend · this month" card: $8,803.00 (large bold), subtext "$586.86 / day for the 15 days left this month" (gray, small — a derived, dated statement of scope). Below it, two-column mini stats: "In so far / $10,541.01" (black) and "Spent so far / -$1,738.01" (red).
- "Net position" card: single figure "$14,763.85" — same net worth number as Accounts, no as-of stamp.
- "Cash flow · last 30 days" card: three rows — "↗ In $11,983.76" (black, up arrow), "↘ Out $7,557.22" (black, down arrow — notably NOT red despite being an outflow; inconsistent with the red-for-negative treatment used everywhere else), "Net $4,426.54" (bold, unsigned/positive black).
- Three single-stat insight cards, each gray-bordered, compact: "Biggest purchase · 7 days" → $895.33 with caption "ONLINE PAYMENT TO DISCOVER CARDS 07/15"; "Spending pace vs last month" → +11% with caption "$1,738.01 so far vs $1,555.73 by day 16"; "Top merchant this month" → $895.33 with the identical caption "ONLINE PAYMENT TO DISCOVER CARDS 07/15" (a credit-card bill payment being labeled the "top merchant" — see Business rules).
- "Projected cash · next 30 days" card carries a small pill badge reading "PROJECTION". Line chart y-axis shows "15.2K" repeated at all four gridline labels (essentially a flat, nearly-zero-variance line) with x-axis 07-25 / 08-04 / 08-15. Below the chart, two lines of gray/italic caption text: "No confirmed recurring bills in the window yet — confirm suggestions on the Recurring page to project them here." and "A preview from your confirmed recurring bills — not a statement of record."
- "Net worth · last 90 days" chart: y-axis -20K/-10K/0/10K/20K, x-axis 04-18/05-17/06-15/07-16. Line is green while above the zero baseline and red while below it (dips to roughly -20K between mid-May and mid-June, recovers to ~+20K by 07-16), with the region between line and zero shaded to match.
- "Cash flow by month" bar chart: y-axis 0/15K/30K/45K/60K, x-axis Apr 26/May 26/Jun 26/Jul 26 — paired bars per month, legend "● Money in / ● Money out" (green/purple dots). May 26 shows a large purple ("out") spike near 45K.
- "Spending · last 30 days": horizontal category bars, each row = category name, dollar amount right-aligned, and a green fill-bar beneath sized proportionally: Loan Payments $5,999.55 (bar nearly full width), Food & Drink $828.58, Entertainment $428.07, Shopping $135.42, Personal Care $65.71, Transfers $48.23, Other $51.66. The bottom five categories' bars are so short relative to Loan Payments that several render as barely-visible slivers a few pixels wide — proportional bars become illegible once one category dominates by 10-100x.
- Condensed "Accounts" block: header row "Accounts" (left) / "Updated 23m ago ↻ Sync" (right, with refresh icon), followed by three rows in the order Chase College/Checking $16,889.94, Credit Card/Credit Card -$415.05 (red), Personal Profile/Checking -$1,711.04 (red) — this ordering differs from the Accounts page itself (which groups Assets-then-Liabilities, listing Personal Profile before Credit Card).

**Ledger**
- Search bar: full-width, placeholder "Search transactions" with a magnifying-glass icon.
- Filter row: "All time ▾" and "All accounts ▾" side-by-side dropdown pills; below, full-width "All categories ▾"; below that, full-width "Newest first ▾" (sort).
- "Group by [None ▾]" control paired with a "☰✓ Select" button (bulk-selection mode toggle) on the same row.
- Action row: "+ Add" (solid green/primary) and "Import" (outlined/secondary) buttons.
- Transaction rows (flat list, no date-group headers — every row repeats its own "MM-DD" date even across consecutive same-day entries, e.g. five separate 07-05 rows in a row): left column monospace date; center column bold merchant/description text (frequently truncated mid-word with an ellipsis, e.g. "ORIG CO NAME:D…", "TST*THE KATI ROL…", "UEP*YOZ SHANGH…") with a gray subtitle line "Account · Category" underneath, itself also truncated ("CREDIT CARD · Shoppi…", "Personal Profile · Food …", "CHASE COLLEGE · Tra…"); right column amount in monospace/tabular figures, always signed with an explicit "+" or "-" prefix in addition to color (black for +, red for -).
- Density: roughly 8 rows visible per 1800px scroll slice (~47 rows across the full 14850px capture before the expander), i.e. a single continuous list with no pagination controls mid-list.
- Near the bottom, a centered pill button reads "Show 47 more of 47" — meaning the page loads an initial subset and the remaining 47 of a matching set are behind one expand action.
- Final card below the list: "167 transactions" (label) with "In $49,940.34" (black) and "Out -$60,042.97" (red) as a totals reconciliation footer.
- No column headers (no literal "Date / Description / Category / Amount" labels) — the three-part row layout is conveyed by position/typography only.

**Review**
- Single content region: a dashed-border, rounded-rectangle empty-state panel, vertically and horizontally centered content — circular badge-checkmark icon, then bold "Nothing to review", then centered gray body copy (quoted in States below). No list, no filters, no counts, no tabs are visible anywhere on this screen.
- Everything below the empty-state panel (roughly the bottom 55% of the viewport) is blank.

## Controls inventory
**Accounts**: "⇄ Record transfer" (button), "+ Add account" (button), each account row is tappable (chevron ">" affordance) — no visible filter, sort, search, or bulk-select controls on this screen.
**Dashboard**: "PROJECTION" (status pill/badge, non-interactive-looking), "↻ Sync" (icon+label button, presumably triggers account refresh), each of the three account rows presumably tappable (no chevrons observed on the condensed dashboard rows, unlike the full Accounts page) — no other buttons, filters, or toggles visible; charts have no visible legend-toggle or date-range picker controls besides the fixed axis windows shown.
**Ledger**: Search input; "All time ▾" filter; "All accounts ▾" filter; "All categories ▾" filter; "Newest first ▾" sort; "Group by [None ▾]" dropdown; "☰✓ Select" (bulk-select mode toggle, badge-style button); "+ Add" (primary action, green fill); "Import" (secondary action, outline); "Show 47 more of 47" (expander/pagination button); implicit per-row tap-to-open (no chevrons drawn on ledger rows, unlike Accounts rows, despite presumably being tappable).
**Review**: no interactive controls visible in the empty state (no "Refresh", no filter chips, no manual "check for suggestions" button).

## Flow steps
N/A for this unit — all four captures are single static states of independent top-level screens, not a connected multi-step flow. (Ledger's "Show 47 more of 47" and Select-mode are the only latent multi-step affordances, but neither's post-tap state is captured here.)

## States
- Review — empty state, exact copy: heading "Nothing to review"; body "Recurring series, transfer matches and categorizations will surface here as suggestions — each waiting for your approval." Icon is a circular outline badge with a checkmark, rendered in muted gray (calm, non-alarming tone, not a celebratory checkmark).
- Dashboard — projection-chart caveat state, exact copy: "No confirmed recurring bills in the window yet — confirm suggestions on the Recurring page to project them here." and, as a persistent disclaimer independent of data state: "A preview from your confirmed recurring bills — not a statement of record."
- No loading or error states are present anywhere in this unit's evidence; all four captures show only fully-loaded success/empty states.

## Business rules implied
- Net worth = sum of Assets subtotal and Liabilities subtotal, and each subtotal = sum of its member account balances, arithmetically exact on screen (`accounts-mobile-390.png`: $15,178.90 + (-$415.05) = $14,763.85, matching the Net worth card and also matching Dashboard's "Net position").
- A checking account can carry a negative balance and still be classified/displayed under "Assets" rather than "Liabilities" (`accounts-mobile-390.png`: "Personal Profile · Checking · -$1,711.04" sits in the Assets group) — account-type classification is evidently fixed by account type, not re-bucketed by current sign.
- Every money figure is signed with an explicit "+" or "-" character, not color alone (`accounts-mobile-390.png`, `ledger-mobile-390.png`, `dashboard-mobile-390.png` throughout) — consistent with the "status adjacent to the number it qualifies" / non-color-only signaling design law.
- Projected-cash forecasting is explicitly gated on user-confirmed recurring items and refuses to project unconfirmed ones (`dashboard-mobile-390.png`: "No confirmed recurring bills in the window yet — confirm suggestions on the Recurring page to project them here."), matching the suggest→approve law — a Class C preview will not silently promote an unconfirmed detection into a forecast input.
- The projection chart is explicitly labeled non-authoritative ("not a statement of record"), consistent with the typed-AI-response / risk-ladder distinction between preview-only (Class C) output and ledger fact.
- The Review queue is explicitly scoped to three suggestion types only — "Recurring series, transfer matches and categorizations" (`review-mobile-390.png`) — implying splits, receipt matches, and rules (also Class B per CLAUDE.md's risk ladder) either route elsewhere or are not yet surfaced through this queue.
- Raw bank/processor transaction text is preserved and displayed largely unprocessed in the ledger (`ledger-mobile-390.png`: "ORIG CO NAME:D…", "PSVJ *JPMC FEE", "FID BKG SVC LLC …", "TST*THE KATI ROL…"), consistent with the source-preservation invariant (immutable originals) — but as of this capture, no cleaned/normalized display name is shown alongside the raw string anywhere in the row.
- Person-to-person transfer memos are preserved verbatim including emoji (`ledger-mobile-390.png`: `Mitchell Dees "😋"`, `Steven Huang "🍕"`, `David Kwon "Puffs"`), reinforcing that ingested text is stored/displayed as data, not reinterpreted.

## Standout details
- The dual assets/liabilities math is fully auditable at a glance on the Accounts screen — subtotal-then-members-then-grand-total all visible without scrolling, on a 390px screen.
- Sign is redundantly encoded (explicit +/- prefix plus color) everywhere except Dashboard's "Cash flow · last 30 days → Out" row, which is the one figure in this whole unit that breaks the red-for-negative convention (see Open questions).
- The 90-day net-worth line chart shades and colors the line itself by sign (green above zero / red below), not just the fill — a nice compounding of the color-semantics law into a chart, not just table rows.
- The projection chart pairs a "PROJECTION" pill badge with two lines of plain-English disclaimer copy ("not a statement of record") — a lightweight but real implementation of the typed-AI-response transparency requirement, done in copy rather than a modal or tooltip.
- Review's empty state explicitly enumerates what categories of suggestion the queue will contain before any exist — sets expectations proactively rather than leaving a generic "no results" message.
- Monospace/tabular figures for both dates and amounts keep decimal points and digit columns visually aligned down the entire ledger column at 390px width.

## Open questions
- What does a populated Review card look like (approve/dismiss controls, confidence display, reason codes, evidence refs per Law 11) — not evidenced anywhere in this unit; only the empty state was captured.
- What happens when Ledger's "Select" button is tapped — no bulk-action bar or checkbox state is shown.
- What happens when "Show 47 more of 47" is tapped (paginate in place vs. navigate) — not shown.
- Is the negative "Personal Profile" checking balance under Assets intentional (e.g., overdraft allowed to remain an asset-type account) or a mis-bucketing that should route to Liabilities — the evidence shows the state but not the rule behind it.
- Why is Dashboard's "Out $7,557.22" rendered in black rather than red, unlike every other negative/outflow figure in this unit — inconsistency or deliberate exception for a directional (not signed-balance) figure?
- Is "ONLINE PAYMENT TO DISCOVER CARDS" (a credit-card bill payment) correctly the app's notion of "Top merchant this month," or is this a categorization gap where debt payments get miscounted as merchant spend?
- The floating black "N" button's function is never labeled in any of the four captures — its exact purpose (assistant? notifications?) cannot be confirmed from this evidence, only its persistent fixed position (and that on Dashboard it visually sits on top of/near the "Biggest purchase" card).
- The hamburger menu's contents (full nav tree) are never opened in this unit, so how many/which sections mobile nav actually exposes vs. desktop is unconfirmed from this evidence alone.
- Two ledger rows on 07-06 — "Payment Thank Yo…" +$671.35 and "Payment to Chase …" -$671.35 — are equal and opposite same-day amounts; whether this is an intended pair of distinct events or an un-collapsed internal transfer/duplicate is not resolvable from the (truncated) evidence alone.
