# KEEL Competitive Teardown — 2026-07-16

**Status: DRAFT-IN-PROGRESS** — being written live while the census/synthesis
workflow completes. Sections marked ⏳ get enriched from dimension fragments.

**Method.** 295 screenshots (279 competitor across Copilot, Monarch, YNAB,
Quicken Simplifi, Quicken Classic, Rocket Money, Ramp, Brex + cross-cutting
flows; 18 KEEL current-state 2026-07-16) → 49 structured census records
(`docs/harness/census/2026-07-16/`) → 12-dimension synthesis
(`docs/harness/plans/fragments-2026-07-16/`) → this merge. Every image is
accounted for (conservation-checked manifest). Complements
`design/FEATURE-GAP-REPORT.md` (capability-level, 07-12) with
interaction/pixel-level findings. Rule: patterns, never pixels — everything
lands in KEEL's own design language (Law 8).

---

## Executive summary — the biggest problems, ranked

1. **[P0] Transfers are polluting every analytic surface.** On KEEL's own
   dashboard, "Top merchant this month" and "Biggest purchase" are BOTH
   `ONLINE PAYMENT TO DISCOVER CARDS 07/15` — the user's own credit-card
   payment. "Spending · last 30 days" is dominated by **Loan Payments
   $5,999.55** (the ledger shows these are `Online Payment … To CITIBANK
   CREDIT CARD` rows, one at −$4,519.33) and even lists **Transfers $48.23 as
   a spending category**. Copilot's evidence shows the fix pattern: transfer
   rows carry NO category pill at all — they sit entirely outside the
   categorization scheme (census `copilot-community-01`: "T"-glyph rows,
   inflow leg green, no pill). Cash-flow/net-worth exclusion of confirmed
   transfers exists in KEEL's backend; the categorize/spending overlay and
   the insight tiles are not honoring it. **This is a trust-destroying
   correctness bug on the first screen a user sees.**

2. **[P0] The Review page is empty while the ledger is full of unconfirmed
   suggestions.** KEEL's Review page says "Nothing to review" while the same
   seed's ledger visibly contains repeated CC-payment/transfer pairs and
   auto-categorized rows. Copilot runs its entire product through this loop —
   a **Transactions badge (16)** in the nav, "To Review" status on the row's
   date line, inline category popover, bulk review bar. If KEEL's detectors
   aren't emitting suggestions for this seed, the suggest→approve spine (the
   product thesis!) is invisible in the demo.

3. **[P1] Sidebar accounts carry no balances.** KEEL lists `CHASE COLLEGE /
   Personal Profile / CREDIT CARD` as bare text. Copilot (and Quicken) put a
   right-aligned balance on every sidebar account row, grouped under
   collapsible type headers ("Credit cards ▾", "Depository ▾") — the founder's
   own first example. One glance = position; one click = the account.

4. **[P1] No merchant normalization anywhere.** KEEL renders raw bank memos
   in full caps: `ORIG CO NAME DEEPTUNE CO ENTRY DESCR:PAYROLL SEC:PPD ORIG
   ID:911757…`. Every competitor shows a clean merchant ("Spotify",
   "Sunoco") with the raw string preserved one click away. This is AI risk
   class A (auto+undo) in KEEL's own ladder — allowed to be automatic.

5. **[P1] Transaction rows have no category *chips* and no detail panel.**
   KEEL's ledger uses a bare `<select>` per row and a pencil icon; there's no
   master-detail view, no notes/tags/attachments surface, no status on the
   row. Copilot's row grammar — merchant · dim account · colored category
   pill (emoji + label) · amount · overflow — plus a right-hand detail panel
   with Category/Account/Notes/Tags/Similar-Transactions is the convergent
   pattern across Copilot/Monarch/Simplifi.

6. **[P1] No split editor.** Copilot ships Equal/Custom tabs, live
   "Left to split $0.00" (green when balanced — literally KEEL's Σ=0
   invariant as UI), EXCLUDED legs, and a "🔀 $100.00 split 4 ways" field
   with sibling-leg list. KEEL's ledger schema supports splits
   (`packages/ledger` splits conserve); the UI exposes none of it.

7. **[P0-adjacent data bug] A checking account shows −$1,711.04 under
   Assets.** "Personal Profile · Checking" is negative on both dashboard and
   Accounts. Either a mis-signed manual account, double-counted transfer
   legs, or an entity account misfiled — whichever it is, the Accounts page
   presents it without any flag. Competitors annotate anomalies (Copilot:
   amber utilization badge, staleness "Updated 5 hours ago" per account).

8. **[P1] Charts violate KEEL's own design laws.** "Cash flow by month" uses
   green + **purple/indigo** bars (money out is not negative-red, but purple
   is off the stone+emerald token palette and reads fintech-neon). The
   "Projected cash · next 30 days" y-axis renders **"15.2K" five times** —
   a broken tick formatter on the first screen. Copilot's cash-flow chart
   shows the calm pattern: single accent, a "Now" pill separating fact from
   future, one labeled tick.

9. **[P2] Accounts page is a stub next to any competitor.** No type
   sub-grouping (Cash/Credit/Investments/Loans), no institution identity, no
   per-account staleness, no credit-limit/utilization pair
   ("$7,524.20 / $15,000.00" + "50.16%" badge in Copilot), no balance-history
   chart, no account detail two-pane. KEEL renders three rows and 70% empty
   space.

10. **[P2] Recurring intelligence is invisible.** Copilot shows a
    left-to-pay progress ring, natural-language rule chips ("Named
    **Spotify**", "from **$6** to **$15**"), and a dashed-projection
    timeline. KEEL has the detector backend (confidence bps, occurrences)
    but the dashboard's projected-cash panel sits empty with a plea to go
    confirm suggestions — on a seed where Review shows nothing to confirm.

*(Enriched top-list pending dimension fragments — budgets, reports, goals,
mobile, onboarding, approval-queues.)* ⏳

---

## KEEL ground truth (what our screens show today)

Evidence: `design/current/2026-07-16/*.png`, census `keel-*.md`.

- **Home**: Free-to-spend hero + per-day pace (good bones — Copilot-class
  idea), net position, 30-day cash flow, insight tiles, projected cash
  (empty; broken axis), net-worth 90d (red/green fill, correct token use),
  cash-flow-by-month (purple bars), spending mix (transfer-polluted),
  accounts strip with "Updated 21m ago · Sync" (good).
- **Accounts**: net-worth hero, `Record transfer` + `Add account` actions
  (good), Assets/Liabilities groups with subtotals — then nothing else.
- **Ledger**: filter bar (search, All time, All accounts, All categories,
  Newest first, Group by) — genuinely competitive bones; dense rows; inline
  category select; per-row edit pencil; totals footer (count/in/out). Missing:
  chips, detail panel, review state, date-group headers, splits, running
  balance on account registers, bulk UX beyond `Select`.
- **Review**: clean empty state with explanatory copy (good pattern) — but
  empty against a seed that plainly contains suggestible pairs.
- Remaining pages (Budgets, Goals, Reports, Recurring, Paychecks,
  Reimbursements, Statements, Connections, Settings, mobile) ⏳ from
  `keel-money-02` / `keel-ops-03` / `keel-mobile-04` census records.

**KEEL strengths no competitor in the set matches** (keep, don't dilute):
statement reconciliation with period locks; paychecks with component-level
gross→net; reimbursements/expense-shares; append-only audit + revisions;
full-fidelity export; entity model. The teardown is about the daily-driver
surface, where we're behind.

---

## Dimension findings ⏳

*One subsection per dimension, merged from
`docs/harness/plans/fragments-2026-07-16/<dim>.md` when synthesis lands:*

1. Navigation, sidebar & global layout
2. Dashboard / home surface
3. Accounts & account detail
4. Transactions register & detail (incl. splits)
5. Categorization & rules
6. Budgets
7. Recurring & subscriptions
8. Reports & cash flow
9. Goals, forecasting & planning
10. Onboarding, import/export & empty states
11. Review queues & approval workflows
12. Mobile & 390px

---

## Convergent patterns (≥3 competitors, KEEL lacks) ⏳

Seeded from completed records; to be completed from fragments:

| # | Pattern | Seen in | KEEL today |
|---|---------|---------|------------|
| C1 | Sidebar accounts with live balances under collapsible type groups | Copilot, Quicken, Monarch | names only |
| C2 | Review/needs-attention count as a nav badge | Copilot (16), Monarch, Rocket | none |
| C3 | Clean merchant name + raw string preserved | all consumer apps | raw memo only |
| C4 | Category as colored pill w/ icon, popover picker w/ typeahead + inline "New category" | Copilot, Monarch, Lunch Money | bare select |
| C5 | Transfers visually outside categorization (no pill; paired glyph) | Copilot, YNAB, Monarch | transfers ARE categories |
| C6 | Master-detail transaction panel (notes/tags/attachments/similar) | Copilot, Monarch, Simplifi | none |
| C7 | Split editor with live remainder-to-zero | Copilot, YNAB, Monarch | none |
| C8 | Per-account staleness ("Updated Nh ago") + connection state per row | Copilot, Rocket, Monarch | global only |
| C9 | Credit accounts: balance / limit pair + utilization | Copilot, Monarch | balance only |
| C10 | Time-range pill tabs (1W 1M 3M YTD 1Y ALL) on every chart | Copilot, Monarch, Empower-style | fixed ranges |

---

## Fix backlog delta (maps to PLAN-FEATURE-PARITY) ⏳

Populated after fragments; each row: finding → W-item or NEW slice, sized.

---

## Conservation ledger

- Census units: 49 planned / <N> complete at last update — see
  `docs/harness/census/manifest-2026-07-16.json`.
- Dimension fragments: 12 planned.
- Every finding cites census records; every census record cites image files.
