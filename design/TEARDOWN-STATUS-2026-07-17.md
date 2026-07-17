# KEEL Teardown Coverage Ledger — audit @ `main` (8feba92, 2026-07-17)

Independent read-only audit of `design/COMPETITIVE-TEARDOWN-2026-07-16.md` (154
findings, 20 convergent patterns, 2 P0s) against the shipped codebase, merged
PRs #10–#15, and NOTES.md D-030…D-039. `◐` = partial: headline shipped,
residual gap noted. This file is the standing queue source — update it as
slices merge.

## The two P0s

| ID | Status | Evidence / gap |
|---|---|---|
| **P0-A** transfer/CC-payment pollution | **SHIPPED** | Wave 0 cluster A (PR #10), predicate redesigned D-034: `isDebtOrTransferLike` in `lib/spending`; `TransferNudgeBanner` on Home; budgets suppress movement buckets; reports donut footnote. Top-merchant tie-break removed. |
| **P0-B** suggest→approve invisible | **◐ core NOT COVERED** | Typed evidence cards + "Why?" disclosure + reason codes SHIPPED for **transfers + recurring** (PR #15, D-038); nav `ReviewBadge` SHIPPED. **Missing:** categorizations still auto-applied silently (never routed to Review), no reviewed/unreviewed transaction state, no reversible-"auto" badge, no bulk approve, no confidence-routing disclosure. |

## Convergent patterns C1–C20

| # | Pattern | Status | Evidence / gap |
|---|---|---|---|
| C1 | Sidebar accounts = balances + subtotals + net worth | **SHIPPED** | `SidebarAccounts` (PR #12); 3-way split, click-through |
| C2 | Review count as nav badge | **SHIPPED** | `review-badge.tsx` — counts transfers+recurring only (extend with P0-B) |
| C3 | Normalized merchant label, raw in detail | **SHIPPED** | `lib/merchant-name.ts` + tooltips (PR #15); NACHA/ACH extraction |
| C4 | Category picker: typeahead + recents + inline-create + old value struck | **PLANNED → next** | Still bare `<Select>` (`txn-edit-dialog.tsx` CategoryPicker); `command.tsx` (cmdk) already in repo |
| C5 | Transfers outside categorization, excluded from spend math | **SHIPPED** | D-034 predicate; residual: no paired-glyph on ledger rows |
| C6 | Master-detail txn surface | **◐** | `TxnEditDialog` covers edit incl. mobile; no detail panel, account last-4, status chip |
| C7 | Split editor: live remainder + per-leg exclude | **PLANNED** | Splits render read-only; editor = W2.4 |
| C8 | Per-account freshness + reauth at the row | **◐** | Connection-level only; account rows show no "Updated Nh ago" |
| C9 | Credit limit + utilization badge | **NOT COVERED** | Detail shows balance + available only |
| C10 | Time-range pills on every trend chart | **◐** | Reports donut only; account trend + dashboard net-worth fixed 90d |
| C11 | Net-worth hero fused (num+Δ+%+window+chart) | **NOT COVERED → next** | Pieces exist scattered; never fused |
| C12 | Budget rows + hero | **SHIPPED (exceeds)** | Full bars/remaining/rollover; missing income line only |
| C13 | Recurring calendar + occurrence states + $/yr | **◐** | Calendar + paid/due shipped; missing overdue/missed, $X/yr, price-change |
| C14 | ONE report scope bar + chart drill | **NOT COVERED** | No account/entity filter (undercuts multi-entity thesis); charts non-drill |
| C15 | Export the report you're viewing | **NOT COVERED** | Global settings export only |
| C16 | Home leads with actionable modules | **◐** | Nudge + FTS + bills shipped; no unified "Needs attention" |
| C17 | Mobile bottom tabs + edit-anything + swipe review | **◐** | Edit gap closed; no bottom tabs / swipe queue |
| C18 | Rules multi-condition→action + dry-run count | **◐** | Retroactive preview count shipped; builder/NL chips absent |
| C19 | Relative due dates | **NOT COVERED** | "Due soon" badge + absolute ISO only |
| C20 | Import column-mapping + dup copy | **SHIPPED (exceeds)** | `import-csv-dialog.tsx` guessColumns, dup detection, QIF splits |

## Counts

- Patterns: 7 SHIPPED full · 6 partial · 2 planned · 5 not covered.
- P0s: P0-A shipped · P0-B core outstanding.
- Dimensions: budgets + goals strong; categorization-rules and review-approval
  are the two not-covered-dominant dimensions — both are P0-B adjacent.

## Build queue (priority order)

1. **P0-B categorization loop** — route sub-threshold categorizations into
   Review as typed suggestions; reviewed/unreviewed txn state; visible
   reversible "auto" badge. Reuses PR #15 card/disclosure/badge infra; needs a
   categorization-suggestion query + `reviewed` flag on `transactions.rich`.
2. **C4 category picker** — cmdk popover (typeahead/recents/inline-create/old
   value struck). No new deps.
3. **C14 reports scope bar + drill** — date+account+entity bar driving every
   widget; charts deep-link to filtered ledger.
4. **C11 net-worth hero fusion** (+C10 pills on its chart), Home & Accounts.
5. **C7 split editor** — live remainder→0 (Σ=0 as UI), per-leg exclude.
6. **C15 per-report scoped export.**
7. **Ledger reviewed/reconciled chips + status facet** (Statements moat).
8. **C9 credit limit/utilization.**
9. **C8 per-account freshness + row-level reauth.**
10. **C16 Home "Needs attention" module.**

Runners-up: recurring $X/yr + "Stop tracking" rename (copy contradiction —
`recurring/page.tsx` still says "cancel"); Review bulk-approve; mobile bottom
tabs + swipe queue; debt-payoff simulator.

## Shipped-vs-teardown tensions (documented)

1. Destructive-action red (`--destructive` token) — deliberate D-034 override;
   Law 8 red-reservation governs money figures.
2. Budgets over-state painted `--keel-negative` — residual tension with the
   teardown's "non-red over signal" note; keep or amend consciously.
3. Recurring copy "cancel" not yet renamed "Stop tracking".
4. Re-anchor delta dated today leaves pre-correction chart segment stale
   (D-037); candidate fix is a "corrected on date" chart annotation, never a
   backdated rewrite (Law 9).

## Off-teardown differentiators in flight

AI assistant surface (PR #16 + assistant-ui follow-up) — Wave-3-class
differentiator; receipts POC research parked in docs/research/.
