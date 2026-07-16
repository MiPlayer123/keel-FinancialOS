# Mobile & 390px behavior

Scope: how KEEL transforms for phone (390px) — nav pattern, register density, quick-add,
swipe actions, chart adaptation — judged against KEEL's own mobile-390 shots
(`dashboard-mobile-390.png`, `ledger-mobile-390.png`, `accounts-mobile-390.png`,
`review-mobile-390.png`; census `keel-mobile-04.md`, `keel-core-01.md`) and the Law-8
usable-at-390px bar. Competitor phone evidence: `monarch-iphone-01/02/03`,
`ynab-iphone-01`, `copilot-iphone-01`, `rocket-money-iphone-01`,
`quicken-classic-iphone-01`, `quicken-simplifi-iphone-01`.

## Convergent patterns
(≥3 competitors do this on phone; KEEL does not)

1. **A persistent bottom tab bar of 5 primary destinations.** Monarch phone = 5-icon
   bottom bar (Dashboard / Accounts / Transactions / Cash Flow / Budget), with
   Recurring/Goals/Investments behind a "More"; Rocket Money = 5-icon bottom bar
   (Dashboard / Recurring / Spending / Transactions / More), with Net Worth + Credit
   behind "More"; Copilot = a persistent horizontally-scrollable primary tab strip
   (8 tabs). All keep top destinations one tap away and thumb-reachable. **KEEL phone
   has NO bottom nav and no tab strip** — every screen shows only a top hamburger + "keel"
   wordmark, no right-side icons (`keel-mobile-04.md` IA §; all four mobile shots). Every
   destination beyond the current page is ≥2 taps and hidden behind the drawer.

2. **An always-available "add" affordance, usually a bottom-corner FAB.** YNAB = persistent
   floating circular "+" bottom-right across Home views (`ynab-iphone-01` controls);
   Quicken Classic = floating circular "+" overlapping the account register
   (`quicken-classic-iphone-01`, iphone-02); Monarch = "+" in the Accounts header;
   Copilot = "+" add tiles in Recurrings. **KEEL's only add entry is a small "+ Add" pill
   buried in the ledger toolbar, below ~870px of filter chrome, and nothing on Home or
   Accounts** (`ledger_top` crop; `keel-mobile-04.md` controls). No FAB on any screen.

3. **A phone-native review queue with per-item approve / skip / swipe.** Monarch = swipe-to-
   review with a "N remaining" countdown title and explicit "Skip for now" vs "Mark as
   reviewed" (`monarch-iphone-02` iphone-15, `monarch-iphone-03` iphone-19); YNAB = Home
   surfaces "2 New transactions → Assign / Review" as a badged queue item
   (`ynab-iphone-01` iphone-03); Copilot = "To review" card with per-day grouping and a
   full-width "MARK AS REVIEWED" bulk action (`copilot-iphone-01` iphone-02). **KEEL's
   Review page on phone is a static centered empty state with zero interaction design —
   no queue chrome, no swipe, no skip/approve affordances even sketched** (`review-mobile-390.png`;
   `keel-mobile-04.md` Review §).

## Findings

### MOBILE-1 — No bottom navigation; every destination is hidden behind a hamburger [P1]
- **Evidence:** `dashboard-mobile-390.png`, `ledger-mobile-390.png`, `accounts-mobile-390.png`,
  `review-mobile-390.png` (all show only ☰ + wordmark, no bottom bar / tab strip / right
  icons); `keel-mobile-04.md` IA § ("no right-side icons … hamburger is never opened … full
  nav tree is not observable"). KEEL has ~13 top-level sections (Home, Accounts, Ledger,
  Recurring, Budgets, Goals, Reports, Paychecks, Reimbursements, Statements, Review,
  Connections, Settings — `keel-core-01.md` sidebar).
- **Competitors:** Monarch and Rocket both ship a 5-slot bottom tab bar + "More"; Copilot a
  persistent tab strip. Primary destinations (Transactions, Budget, Spending, Review) are
  one thumb-tap away and always visible; overflow lives in "More".
- **KEEL today:** All navigation is collapsed into a single top-left drawer. Reaching the
  ledger, budgets, review, or reports from Home is open-drawer → find item → tap (≥2 taps,
  target in the top-left corner — the least thumb-reachable zone on a phone). The active
  section is not even indicated in the phone chrome.
- **Fix:** Add a fixed bottom tab bar at <640px: Home / Ledger / Review / Accounts / More
  (Review carries the W1.5 suggestion badge). Keep the drawer as "More". Respects Law-8
  390px and DESIGN-NOTES ≥44px targets. Desktop sidebar unchanged.
- **Maps to:** NEW (nav shell); Review badge slot = W1.5.

### MOBILE-2 — No way to categorize / edit a transaction on phone (inline picker is sm+ only) [P1]
- **Evidence:** `PLAN-FEATURE-PARITY.md` W1.4 states verbatim "mobile has no recategorize
  path — inline picker is sm+ only"; `ledger_top` crop confirms phone ledger rows are
  display-only (no category pill, no chevron, no edit icon — unlike desktop rows which carry
  an editable category pill + pencil, `keel-core-01.md` Ledger §).
- **Competitors:** Monarch opens a full-screen review card with single-select category chips
  + tags + notes + Split/Delete, driven by swipe (`monarch-iphone-03` iphone-19); Copilot
  taps a transaction's category pill → category sheet (`copilot-iphone-01` iphone-08); YNAB
  edits assignment inline. Categorizing on the phone is the daily-driver loop for all three.
- **KEEL today:** On phone you can view a transaction but cannot recategorize it, rename it,
  or open its detail — the one interaction KEEL's own "AI-first suggest→approve" thesis
  depends on (Law 2/10 Class B) is unreachable on the device people actually reconcile on.
  The Review page (the other approve path) works but is empty and queue-less (MOBILE-3).
- **Fix:** Ship a phone transaction-detail sheet (tap row → bottom sheet with category
  picker, name/note, original-description, split entry point) so the sm+ inline picker has a
  phone equivalent. This is the mobile half of W1.4 that was scoped out.
- **Maps to:** W1.4 (its explicitly-deferred mobile path).

### MOBILE-3 — Review queue has no phone interaction model (no swipe, no skip, no queue chrome) [P1]
- **Evidence:** `review-mobile-390.png` shows only a dashed empty-state box; `keel-mobile-04.md`
  Review § / Open questions ("What does a populated Review card look like … not evidenced").
  No swipe affordance, no "N remaining" counter, no Approve/Skip buttons are designed.
- **Competitors:** Swipe-to-review is the signature phone gesture — Monarch markets it
  directly ("Review transactions with a swipe", `monarch-iphone-03`) with Skip-for-now vs
  Mark-as-reviewed as two named exits and a live "3 remaining" countdown in the title bar;
  Copilot batches with one "MARK AS REVIEWED"; YNAB badges the count on Home.
- **KEEL today:** The suggest→approve loop (Law 11 typed responses: verdict/tldr/confidence/
  evidence/approve) has no phone-native way to work through a stack. When suggestions exist,
  the current design would presumably render desktop cards — punishing on a phone.
- **Fix:** Design the populated Review as a card stack: one suggestion per card
  (tldr + confidence + evidence-on-tap per Law 11), swipe-right = approve (binds the
  approval token), swipe-left/skip = defer, "N remaining" in the header. Reuse on the ledger
  detail sheet (MOBILE-2). Extend the ledger swipe to quick-categorize.
- **Maps to:** NEW (phone review interaction); relies on W1.5 badge + Review contract.

### MOBILE-4 — Phone ledger buries every transaction under a full screen of filter chrome [P1]
- **Evidence:** `ledger_top` crop — at 390px the header + search field + four stacked
  dropdown pills (All time, All accounts, All categories, Newest first) + "Group by / Select"
  row + "Add / Import" row consume the entire first viewport (~870px tall) before a single
  transaction appears; `keel-mobile-04.md` Ledger controls (11 controls stacked above the list).
- **Competitors:** Quicken collapses filtering to a search field + a single sliders icon +
  a clock icon (`quicken-classic-iphone-01` iphone-02); Monarch review uses one sliders icon;
  the register itself starts near the top of the screen. Phone filters live behind one icon
  that opens a sheet, not stacked inline.
- **KEEL today:** The list you came to see is off-screen on load; the primary content is
  demoted below secondary controls. This inverts mobile priority (content-first).
- **Fix:** Collapse the filter/sort/group controls into a single "Filters" sheet trigger
  (sliders icon) beside the search field at <640px; move "Add" to the FAB (MOBILE-1/W2.4);
  render active filters as a thin removable chip row. Transactions start within the first
  viewport.
- **Maps to:** W1.2 (ledger power filters — needs a mobile sheet presentation).

### MOBILE-5 — Ledger rows truncate merchant AND category, drop date grouping, carry no register affordances [P1]
- **Evidence:** `ledger_top` crop — merchant clipped mid-string ("ORIG CO NAME:D…",
  "TST* THE KATI ROL…") and the account·category subtitle ALSO clipped ("CHASE COLLEGE · Inc…",
  "CREDIT CARD · Shoppi…"), so the actual category is invisible; no date-group headers (two
  consecutive "07-07" rows each repeat the date); `keel-mobile-04.md` Ledger § ("flat list,
  no date-group headers … frequently truncated mid-word").
- **Competitors:** Quicken's phone register groups by month → date headers, shows merchant
  bold + full category beneath + amount + running balance per row, ~6 legible rows/screen
  (`quicken-classic-iphone-01` iphone-02). Monarch/Copilot rows keep a readable merchant +
  a color/emoji category chip (`monarch-iphone-03`, `copilot-iphone-01`) so category survives
  at phone width.
- **KEEL today:** The desktop table is ported to 390px with only ellipsis truncation. The
  category — the thing a finance app is organized around — is the first casualty, and there
  is no running balance and no MM-DD grouping, so scanning is date-noisy and category-blind.
- **Fix:** Phone row: date-group section headers; merchant on line 1 (allow 1 wrap, not
  clip); a category chip on line 2 (chip wins the width fight over the raw account string);
  amount right-aligned. Add running balance on the single-account register view (ties to W1.9).
- **Maps to:** W1.9 (register running balance) + W1.2/W1.4; mobile row layout = NEW.

### MOBILE-6 — No quick-add / FAB anywhere on phone [P2]
- **Evidence:** `dashboard-mobile-390.png` and `accounts-mobile-390.png` have no add control
  in reach; the only "+ Add" is the ledger toolbar pill below the filter wall (`ledger_top`).
  Accounts' "+ Add account" / "Record transfer" sit inside the net-worth card only
  (`accounts-mobile-390.png`).
- **Competitors:** YNAB and Quicken both ship a persistent bottom-corner "+" FAB; Monarch a
  header "+". Adding a transaction/account is a one-tap reflex from anywhere.
- **KEEL today:** No global add. (Manual transactions themselves are W2.4-deferred, but the
  affordance for add-account, record-transfer, and future manual-txn should still be a FAB.)
- **Fix:** Bottom-right FAB (opposite the current bottom-left "N"), context-aware: Ledger →
  Add transaction (W2.4) / Import; Accounts → Add account / Record transfer. ≥44px, above the
  bottom tab bar.
- **Maps to:** W2.4 (manual transactions) for the action; FAB = NEW.

### MOBILE-7 — The floating "N" button overlaps content and sits in the wrong corner, unlabeled [P2]
- **Evidence:** `dashboard-mobile-390.png` — the dark circular "N" button sits on top of the
  "Biggest purchase" insight card; `ledger_top` crop — it overlaps the "SNACK* SKWR" row;
  `keel-mobile-04.md` standout/open-questions (button "visually sits on top of/near" a card;
  "function is never labeled").
- **Competitors:** Bottom-corner floating buttons (YNAB "+", Rocket assistant) are given a
  clear single purpose and do not occlude list rows; Rocket keeps the bottom edge for the tab
  bar, not a floating avatar.
- **KEEL today:** An unlabeled avatar/assistant launcher is pinned bottom-left where it
  covers data at 390px. If it is the AI assistant (KEEL is AI-first), it is both mis-placed
  and under-sold; if it's a profile menu, it's redundant with the drawer.
- **Fix:** If it's the assistant, move it bottom-right, add a label/affordance, and add
  bottom padding to lists so it never occludes a row; if it's profile/settings, fold it into
  the "More" tab and remove the floating element. Reserve bottom-left for nothing.
- **Maps to:** NEW.

### MOBILE-8 — Charts are desktop charts stacked, not adapted for 390px [P2]
- **Evidence:** `dashboard-mobile-390.png` — the "Spending · last 30 days" proportional bars
  render the bottom five categories (Entertainment→Other) as near-invisible slivers because
  Loan Payments dominates 10–100× (`keel-mobile-04.md` Layout, Spending §); charts carry no
  date-range selector; "Projected cash" shows a degenerate axis (four identical "15.2K"
  ticks) on phone as on desktop.
- **Competitors:** Copilot uses low-chrome sparklines with a single inline pill callout
  ("$268 under") instead of full axes (`copilot-iphone-01`); Quicken/Simplifi anchor one
  direct-label callout to the key point and mark "Today" with a solid→dashed stroke
  (`quicken-simplifi-iphone-01`); Monarch/Rocket give every chart a 1M/3M/6M/1Y/ALL range
  selector on phone (`monarch-iphone-03`, `rocket-money-iphone-01`). Copilot auto-scales a
  spend axis to the data floor so small values stay legible.
- **KEEL today:** Full desktop chart chrome shrunk to 390px; dominant-category bars erase the
  smaller categories; no phone range control; the degenerate projection axis is shipped as-is.
- **Fix:** At <640px: cap/relabel the spending bars (log or "top 5 + Other", or show % so
  slivers keep a readable label); add a range-pill row to the net-worth/cash-flow charts;
  fix the flat-projection axis to a labeled single value + copy rather than four dupes.
- **Maps to:** W2.5 (forecast/projection chart), FEATURE-GAP #6 (reports/charts).

### MOBILE-9 — Accounts screen shows no per-account sync freshness on phone [P3]
- **Evidence:** `accounts-mobile-390.png` — account rows show name/type/balance/chevron only,
  no last-synced stamp; the "Updated 23m ago · Sync" indicator exists only in the Dashboard's
  condensed accounts block, not on the Accounts page itself (`keel-mobile-04.md` Accounts §,
  "no last-synced timestamp on this page itself").
- **Competitors:** Monarch shows "11 hours ago" under every account balance
  (`monarch-iphone-03`); Rocket shows "19 hours ago" + a "Sync now" link
  (`rocket-money-iphone-01`) — data freshness treated as first-class per-row content.
- **KEEL today:** On the phone Accounts page there is no signal of how stale a balance is and
  no manual refresh; the user must jump to Home to learn sync state.
- **Fix:** Add a per-account "· Nm ago" freshness line under each balance and a pull-to-refresh
  / "Sync" on the Accounts page. Ties to `balances.latest` (W1.9).
- **Maps to:** W1.9 (available-vs-current balance surfacing); freshness line = NEW.

### MOBILE-10 — Phone ledger renders a ~14,800px unpaginated DOM (no virtualization) [P2]
- **Evidence:** `ledger-mobile-390.png` is 780×14850; `keel-mobile-04.md` Ledger § (120 rows
  loaded + "Show 47 more of 47", single continuous list, no mid-list pagination). CLAUDE.md
  quality bar requires "virtualized lists" and <100ms interactions.
- **Competitors:** N/A as a marketed feature, but every competitor's phone list is
  short/summary-first or windowed; none stacks a full 167-row household register on one phone
  page.
- **KEEL today:** A full household register mounts as one tall DOM at 390px — scroll cost and
  memory pressure on low-end phones, against the app's own virtualization bar.
- **Fix:** Virtualize the phone ledger (windowed rendering) and/or server-side page it; the
  "Show 47 more" expander should append a window, not the whole tail. (Note W1.2's client-side
  120-row cap is a stopgap; phone needs true virtualization.)
- **Maps to:** W1.2 (filters/paging note flags server paging as wave-3) — NEW for virtualization.

### MOBILE-11 — Hero figures keep full cents at 390px where the number is width-critical [P3]
- **Evidence:** `dashboard-mobile-390.png` "$8,803.00" / "$14,763.85"; `accounts-mobile-390.png`
  net-worth "$14,763.85" — all rendered with cents in a large monospace face
  (`keel-mobile-04.md` Layout).
- **Competitors:** Copilot ("$477"), Monarch ("$748,606"), Rocket ("$69,556") all drop cents
  on the phone hero to keep the headline compact, showing cents only on itemized rows.
- **KEEL today:** Full monospace `$14,763.85` fits current data but leaves no headroom for
  6-figure net worths at 390px, and the precision adds little at hero altitude.
- **Fix:** Optional — round the hero number to whole dollars on phone (keep cents on line
  items / registers). Flag against KEEL's tabular-nums precision preference; if precision is a
  deliberate law here, keep but ensure the hero never overflows at 6+ figures.
- **Maps to:** NEW (polish); defer to a taste pass ⚑.
