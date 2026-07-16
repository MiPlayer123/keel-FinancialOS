# KEEL Competitive Teardown — 2026-07-16

**Status: FINAL.** 295 screenshots (279 competitor: Copilot, Monarch, YNAB,
Quicken Simplifi, Quicken Classic, Rocket Money, Ramp, Brex, cross-cutting
flows; 18 KEEL current-state) → 49 structured census records
(`docs/harness/census/2026-07-16/`, conservation-checked manifest) → 12
dimension analyses (`docs/harness/plans/fragments-2026-07-16/`) → this merge.
**154 findings: 2 P0 · 57 P1 · 67 P2 · 27 P3** — every finding cites census
records + image files; the fragments are the detail layer, this document is
the ranked map. Complements `design/FEATURE-GAP-REPORT.md` (capability-level,
07-12) at the interaction/pixel level. Rule throughout: patterns, never
pixels — everything expressed in KEEL's design language (Law 8).

---

## The two P0s (fix before anything else)

### P0-A — Transfer/CC-payment pollution corrupts every analytic number
`DASHBOARD-1` + `REPORTSCASHFLOW-1` + `BUDGETS-4`. On KEEL's own screens:
"Top merchant this month" AND "Biggest purchase" are both the user's Discover
card payment ($895.33); "Biggest single purchase" in Reports is a **$4,518.33
Citibank CC bill**; Loan Payments is the #1 "spending" category everywhere
($5,999.55 dashboard / $15,156.15 six-month); the 6-month table shows
**$30,645.49 of Transfers inside a table footnoted "confirmed transfers
excluded"**; savings rate renders **−124%**; Budgets lists "Transfers —
$36.23 spent" directly under a subtitle promising "transfers excluded."
Every competitor strips transfers/CC-payments from all spend surfaces
(Copilot transfer rows carry no category pill at all).
**Fix:** wire the existing transfer-exclusion into ALL aggregation paths
(spend mix, top-merchant, biggest-purchase, savings rate, budgets "spent");
suppress obvious CC-payoff patterns pre-confirmation; add an "N unreviewed
transfers may affect these numbers → Review" banner; never let two insight
cards resolve to the same transaction.

### P0-B — The suggest→approve thesis is invisible: Review is empty while the ledger is full of suggestible material
`CATEGORIZATIONRULES-1` + `REVIEWAPPROVAL-1/3/5` + `RECURRING-4/12`. The
audit log shows "Auto-categorized new transactions · KEEL (automatic)" while
Review's copy promises categorizations "will surface here … each waiting for
your approval" — a copy/behavior contradiction on the product's core law
(Law 2/10/11). No typed-response card exists (verdict · confidence ·
reason_codes · evidence_refs have no UI). No nav badge, no "needs review"
row state, no per-type queue. Copilot runs its entire product through this
loop (nav badge "16", To-Review row state, inline quick-fix, bulk bar);
Ramp shows the AI verdict *with its evidence* and thumbs up/down.
**Fix:** route sub-threshold categorizations into Review as typed
suggestions; auto-apply above threshold with a visible reversible "auto"
badge; ship the W1.5 badge; add a reviewed/unreviewed transaction state;
reconcile the empty-state copy.

**Also load-bearing (P1 but data-trust):** "Personal Profile · Checking
−$1,711.04" sits under Assets unflagged; `ONBOARDINGIMPORT-7` — local-dev
credentials render on the production-dated sign-in screen (Law 12 hygiene);
`REPORTSCASHFLOW-4` — red on favorable deltas (spending *dropped* $38k shown
red) while a genuine −124% savings rate is plain black: Law 8 inverted twice.

---

## Dimension digest

Full findings live in `docs/harness/plans/fragments-2026-07-16/<dim>.md`.

| Dimension | Findings | Top items |
|---|---|---|
| **nav-layout** | 12 | Sidebar accounts: no balances/subtotals/net-worth in rail (the founder's own example — Copilot/YNAB/Quicken/Simplifi/Monarch all do it); no global ⌘K search (Ramp/Brex/Copilot/Quicken); no desktop top bar (utilities crammed in footer, avatar **overlaps "Sign out"** on every screen); mobile = drawer-only, no bottom tabs; 13-item flat nav unchunked; zero nav badges |
| **dashboard** | 13 | P0-A tiles; "Free to spend $8,803 / $586/day" reserves nothing for upcoming bills (Simplifi/Copilot/Rocket all compute left-after-bills); net position = bare number, no delta/%/range, trend divorced 7 cards down; 100% passive (no to-review, no upcoming bills); spending bars unreadable when one category dominates 100×; projected-cash chart renders "15.2K"×4 axis (looks broken); cards are dead-ends (no drill-in); no per-account freshness; no as-of stamp (Law 9) |
| **accounts** | 9 | Only Assets/Liabilities bands — no Cash/Credit/Investments/Loans groups+subtotals; net worth bare (no trend/delta/as-of); no per-account "Updated Nh ago"/reauth state; no account detail (register+running balance+history chart = W1.9 unshipped); no balance/limit/utilization; no rename/hide/close; no institution logo/last-4; ALL-CAPS raw provider names |
| **ledger-transactions** | 18 | No splits (W2.4 blocked by a read-model bug, not design); raw ACH memos as primary label; **mobile cannot edit/categorize at all** (Law 8 gap); filters lack status/uncategorized/amount facets + saved views; bulk = category-only; no reviewed state; only "PENDING" (no cleared/reconciled on row despite Statements being a strength); no attachments/receipts; no exclude-from-reports flag; no tags; no column headers; no keyboard (j/k/c/e); no date-group headers; "Show 47 more" instead of virtualization |
| **categorization-rules** | 14 | P0-B silent auto-cat; bare `<select>` picker (no typeahead/recents/inline-create — Copilot pattern); rules = 1 condition × 2 actions, no dry-run count (Monarch previews affected rows); flat 19-category taxonomy, no groups/subcats (W2.3); no create-rule-from-transaction; no merge/archive UI; audit leaks `ingest.apply_action` raw strings ×15 |
| **budgets** | 13 | Rows show *only* "spent" — no target/remaining/bar (a spend list mislabeled Budgets); no hero ("Left this month") or totals; no over/under state at all (needs a non-red near-limit signal — every competitor's amber is off-limits under Law 8); Transfers-row contradiction (P0-A); flat list; no drill-to-transactions; no rollover model reserved; no pacing ("is $679 fine on day 16?"); no income line so "left to budget" can't exist; "Set budget" button instead of inline cell |
| **recurring** | 12 | Page captured 100% empty vs live backend; no calendar view (Monarch's primary view); no series detail (cadence/next/price history/matched txns); no paid/due/overdue/missed occurrence states; no Suggested-vs-Active split (Law 2 seam!); no $X/mo·$Y/yr total; no price-change detection surfaced despite tolerance data existing; "cancel" verb collides with Rocket's concierge meaning — rename "Stop tracking" |
| **reports-cashflow** | 15 | P0-A; charts are dead-ends (donut/Sankey/bars unclickable — only the 6-month table drills); four unsynchronized date paradigms on one page (top card says June, cards below say July); **no account/entity filter — directly undercuts the multi-entity thesis**; Law 8 delta-color inversion; no per-report export (Law 6 exists but unreachable from where users look); no Net Worth report; donut truncates tail silently; Sankey static. *Strength: per-widget as-of/scope footnotes beat every competitor — keep.* |
| **goals-forecast** | 9 | Goals = empty undesigned page (competitors ship target/progress/date/funding objects); free-to-spend ignores bills+goal earmarks; projection chart non-functional; no debt-payoff simulator (while "Loan Payments" is the #1 category!); no what-if levers; goals don't earmark real money |
| **onboarding-import** | 16 | No first-run onboarding, no zero-data states (charts would render degenerate for a real new user); **CSV button missing from "Export all data" despite Law 6 naming CSV**; Disconnect = irreversible crypto-shred styled as a neutral button, no confirm; Connections only ever shows "active" (no reauth/error/stale path); Import = bare button (vs Lunch Money column-mapping / YNAB duplicate-handling copy); dev credentials on login; Settings = one long scroll; audit viewer leaks internals; no scoped export |
| **review-approval** | 12 | P0-B cluster; audit trail floods with duplicate rows + raw event names (the trust surface!); no bulk approve; no confidence routing disclosure ("here's what we auto-did: N"); no feedback loop on suggestions; approval-chain schema exists but no multi-approver surface (Ramp/Brex are the reference); no keyboard/swipe queue |
| **mobile** | 11 | No bottom nav; cannot edit a transaction; Review has no phone model (vs Monarch swipe queue); ledger buries rows under a screen of filter chrome; merchant+category truncate to garbage; ~14,800px unvirtualized DOM; floating "N" overlaps a dollar figure; charts unadapted; full cents in width-critical heroes |

---

## Convergent patterns (what ≥3 competitors do that KEEL doesn't)

The strongest signals in the corpus — each verified across ≥3 independent apps:

| # | Pattern | Evidence |
|---|---|---|
| C1 | Sidebar accounts = balance-bearing clickable rows in type groups w/ subtotals + pinned net worth | Copilot, YNAB, Quicken, Simplifi, Monarch |
| C2 | Review/needs-attention **count as nav badge** | Copilot "16", Ramp (per-item), YNAB "2" |
| C3 | Normalized merchant primary label; raw string preserved in detail | all consumer apps |
| C4 | Category picker = typeahead popover, recents, inline "New category", old value shown crossed out | Copilot, Monarch, Lunch Money |
| C5 | Transfers live **outside** categorization (no pill, paired glyph, excluded from all spend math) | Copilot, YNAB, Monarch, Simplifi |
| C6 | Master-detail transaction surface: status+date, account w/ last-4, notes, tags, split summary, similar-transactions | Copilot, Monarch, Simplifi |
| C7 | Split editor w/ live left-to-split→0 (KEEL's Σ=0 invariant as UI!) + per-leg exclude | Copilot, Simplifi, Monarch, YNAB, Quicken |
| C8 | Per-account staleness "Updated Nh ago" + reauth state at the row | Copilot, Monarch, Quicken, Rocket |
| C9 | Credit: balance/limit pair + utilization badge | Copilot, Monarch, Rocket |
| C10 | Time-range pills (1W/1M/3M/YTD/1Y/ALL) on every trend chart | Copilot, Monarch, Rocket, Simplifi |
| C11 | Net worth hero = number + signed delta + % + window + chart fused | Monarch, Copilot, Rocket, YNAB |
| C12 | Budget row = budgeted · spent · remaining + progress bar; page hero = "Left to budget/this month" | YNAB, Monarch, Copilot, Simplifi |
| C13 | Recurring calendar month-grid + per-occurrence paid/due/overdue states + $X/yr totals | Monarch, Simplifi, Rocket (+Copilot ring) |
| C14 | Report page driven by ONE scope bar (date+account+category); every chart drills to transactions | Monarch, YNAB, Simplifi (+Copilot) |
| C15 | Export the report you're looking at | Monarch, YNAB, Simplifi, Copilot |
| C16 | Home leads with actionable modules (to-review, upcoming bills, ready-to-assign) | Copilot, YNAB, Rocket, Simplifi |
| C17 | Mobile: persistent bottom tabs/tab strip; edit-anything-on-phone; swipe review | YNAB, Rocket, Copilot, Monarch |
| C18 | Rules: multi-condition → multi-action with live affected-count dry-run | Monarch, Brex, Ramp |
| C19 | Relative due dates near-term ("in 3 days"), absolute beyond; "~Dec 4" for projections | Rocket, Simplifi, Copilot |
| C20 | Import: column-mapping preview, row counts in the CTA, duplicate-handling copy up front | Lunch Money, YNAB, Simplifi |

Details worth stealing (small, high-charm): Copilot's natural-language rule
chips ("Named **Spotify**", "from **$6** to **$15**"); solid-vs-dashed
fact/forecast chart grammar + "Now" pill; left-to-pay progress ring;
Rocket's "(−$142.15) 5 transactions selected" total-in-the-count; YNAB's
"Worried about duplicates?" import copy; Lunch Money's "PROCESS 210 ROWS"
scope-in-the-button; Simplifi's exclude checkboxes with one-line blast-radius
captions; Brex's day-grouped notifications with per-row "View" deep-links.

---

## Recommended build order

**Wave 0 — trust repairs (days, mostly wiring/copy):**
1. P0-A exclusion wiring across dashboard/reports/budgets aggregations + the
   unreviewed-transfers banner. 2. Fix projected-cash degenerate axis →
   proper empty state. 3. Law 8 delta-color rule (neutral direction glyphs;
   red = negative money only) + purple→token palette on cash-flow bars.
4. Sidebar footer collision + floating "N"; pull dev creds off login.
5. Investigate the −$1,711.04 "asset" checking account (data lineage).
6. Add CSV to Export-all (Law 6); confirm-dialog + danger styling on
   Disconnect.

**Wave 1 — the daily-driver spine (the biggest UX-per-effort wins):**
7. Sidebar rail: balances + subtotals + net worth + click-through (C1).
8. Review loop v1: typed suggestion cards + nav badge + reviewed-state +
   bulk approve (P0-B; W1.5+). 9. Merchant normalization overlay + raw
   demoted to secondary (C3). 10. Category picker popover w/ typeahead +
   inline create (C4). 11. Transaction detail surface (desktop panel /
   mobile bottom-sheet — kills the mobile-can't-edit gap) (C6).
12. Net-worth hero fusion + range pills on Home/Accounts (C10/C11).
13. Home "Needs attention" + "Coming up" modules (C16).

**Wave 2 — parity depth (mostly already in PLAN as W-items — this teardown
adds the missing specifics):** splits w/ live remainder (W2.4, unblock read
model), budgets v1 with target/remaining/bar/hero + non-red near-limit
signal (W2.2 + BUDGETS-3 decision), recurring sections/states/detail/totals
(W1.1+), reports scope bar + drill-through + per-report export, account
detail w/ running balance (W1.9), rules multi-condition + dry-run (W2.1+),
subcategories (W2.3), mobile bottom tabs + swipe review.

**Wave 3 — differentiators no competitor in the set has:** entity-scoped
reports (the multi-entity thesis, REPORTSCASHFLOW-3), reconciled-status
chips on rows/accounts (leveraging Statements — a genuine moat), typed-AI
evidence cards with confidence routing disclosure (Law 11 as UX), price-
change suggest→approve, debt-payoff simulator fed by real Loan Payments.

## KEEL strengths to preserve (found by the same magnifying glass)

Reports' per-widget as-of/scope/exclusion footnotes (no competitor matches —
extend to Home, don't dilute); statement reconciliation + period locks;
paycheck component modeling; reimbursements engine; append-only audit spine
(fix its *presentation*, keep its substance); full-fidelity export; ledger
filter-bar bones; "Detection runs nightly" transparency copy; dashed-border
empty-state convention (apply it consistently); calm mono `tabular-nums`
money typography.

---

## Conservation ledger

295/295 images → 49/49 census units (0 missing) → 12/12 dimension fragments
→ 154 findings (2 P0 · 57 P1 · 67 P2 · 27 P3), all merged here. Workflow:
61 agents, 0 errors, 313 image-reads. Every finding traces:
finding → fragment → census record(s) → image file(s).
