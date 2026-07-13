# PLAN — Feature parity sprint (2026-07-13, autonomous session)

Goal: close the daily-driver gap to Copilot/Monarch/Quicken-Simplifi. Purely
additive on branch `claude/keel-engineering-handoff-a81ndc`; nothing pushed to
main this sprint. Wave-1 items ride backend that is ALREADY DEPLOYED (the 1D
command procs are live but unreachable from the UI — inventory agent, NOTES);
wave-2 items ship dormant behind graceful degradation until migrations +
function deploy, like the 2026-07-13 trends work.

Sources: design/FEATURE-GAP-REPORT.md; docs/09 T0–T4 + docs/13 addendum
(digest agent); full backend↔frontend inventory (agent); competitor research.

Closed earlier today: transfers end-to-end (gap #1), recategorize + editable
name/note (part #2), rich ledger (part #3), net-worth/cash-flow/spending
charts (part #6/#13), account pages, webhook-key env fix.

## Wave 1 — pure frontend on live backend (testable tomorrow, zero deploys)

- **W1.1 Recurring page** (`/dashboard/recurring` + nav). recurring.list +
  confirm/pause/resume/cancel/reject are live; pause/resume/cancel are
  UNREACHABLE today. Sections: Active (next due, cadence, amount, pause/
  cancel), Suggested (confirm/reject), Paused (resume/cancel). Upcoming-30d
  list. = the Subscriptions view every competitor has (doc 09 T0.10).
- **W1.2 Ledger power filters + totals**: date presets (This month, Last
  month, 30/90d, YTD, All), account + category selects, sort (date/amount),
  filtered footer (count, money in, money out). Client-side (120 rows; the
  rich proc has no params — server paging is a wave-3 concern). (T0.4)
- **W1.3 Bulk categorize**: multi-select in ledger → one category applied to
  N rows via the existing audited categorize route. (T0.4 bulk edit)
- **W1.4 Edit dialog: category picker** (mobile has no recategorize path —
  inline picker is sm+ only) + "original description" affordance kept.
- **W1.5 Review badge**: nav badge = suggested transfers + recurring count.
- **W1.6 Paychecks page v1 → functional**: create-paycheck form (employer,
  date, currency, component rows: earning/withholding/benefit/deposit with
  live gross/net math shown from bigint strings), reverse/restore actions,
  component detail expansion. paychecks.create/reverse/restore live. (T2.4
  manual slice; page today is a permanently-empty read-only shell.)
- **W1.7 Reimbursements page v1 → functional**: create claim (counterparty,
  original expense txn picker, amount), settle against receipt txn, reverse;
  detail (shares, settlements, remaining). All 4 commands live. (T1.11)
- **W1.8 Statements page v1 → functional**: create statement (account,
  period, opening/ending, lines), detail view (lines, difference,
  session/items/adjustments — list proc already returns them), close +
  reopen flows. Commands live. (T0.12 reconcile — the Quicken retention
  feature; owner: "users don't understand" this page.)
- **W1.9 Account register upgrades**: running-balance column (computed
  newest→oldest from the account's current ledger balance so it ties to the
  header, Quicken register pattern per DESIGN-NOTES), available-vs-current
  provider balance via balances.latest (unused today).
- **W1.10 Settings: Activity card** — recent audit_log entries (RLS-readable,
  no viewer today): who/what/when, before→after summary. Trust surface
  (doc 15 proof primitives, cheap slice).
- **W1.11 Add manual account** — accounts.create is live: name, kind
  (asset/liability), subtype (cash, property, vehicle, other, loan),
  currency. Balance stays 0 until W2.4 manual transactions; page copy says
  so. (T0.2 slice.)

## Wave 2 — additive backend + frontend (dormant until deploy)

- **W2.1 Rules engine (deterministic, Law 1; T0.8)**. Migration:
  `category_rules` (household, entity, matcher kind `description_contains`
  v1, pattern citext-ish lower(), category id nullable, rename text
  nullable, priority, active, timestamps) + `source text default 'user'` on
  transaction_overrides. Procs: CRUD (audited) + `keel_apply_rules` —
  category overlay writes source='rule', display-name overlay source='rule';
  source='user' rows are NEVER overwritten. Worker classify: rules → PFC.
  UI: Settings→Rules + "create rule from this transaction" in edit dialog;
  retroactive apply reports affected count. Export ruling: INCLUDE.
- **W2.2 Budgets v1 (T1.1 category-mode slice)**. `budgets` (household,
  category_ledger_account_id, month, amount_minor; PK hh+cat+month), procs
  set (audited upsert/clear), list(month) with spent (overlay categories,
  confirmed transfers excluded), copy-from-previous-month. UI:
  /dashboard/budgets — month nav, category rows with progress, unbudgeted
  row, totals; overspent number wears negative-money color only (Law 8).
  Envelope/flex modes = later tiers, out of scope.
- **W2.3 Category management + subcategories (T0.5 slice)**. Nullable
  `parent_ledger_account_id` on ledger_accounts (constrained same entity +
  kind + is_category, one level); procs create/rename/re-parent/archive
  (archive requires unused or reassign-to). UI: Settings→Categories; grouped
  pickers; spending mix parent roll-up with drill-down.
- **W2.4 Manual transactions + splits (T0.6 slice)**. New proc
  `keel_cmd_manual_transaction`: canonical txn (source='manual') + balanced
  batch (account posting ± N category postings; Σ=0 via existing deferred
  trigger; splits native at entry). Delete = journal.reverse_batch + void
  marker on canonical. UI: Add-transaction dialog (ledger + account page),
  split rows, edit-by-reversal.
- **W2.5 Cash-flow forecast (Class C preview; T1.3 slice)**.
  `keel_cash_flow_forecast(days≤120)`: asset-cash balance + confirmed
  recurring occurrences → daily projected balance + upcoming bills + lowest
  point. UI on Home labeled "Projection" (Law 10 C: preview-only), plus
  bills list with due dates.

## Order

W1.1 → W1.2/3/4 → W1.5 → W1.9 → W1.6 → W1.7 → W1.8 → W1.10 → W1.11 →
W2.1 → W2.2 → W2.3 → W2.4 → W2.5. Cut from the bottom on time pressure —
except W2.1+W2.2 outrank W1.8 if the statements form balloons (budgets and
rules are shop-for features; statements is depth).

Each item: own commit, gates = apps/web build + vitest + deno (+ pgTAP file
additions for new SQL, runnable by owner/CI). Every new table: RLS, tenant
FK, export ruling (manifest INCLUDE + wrapper + pgTAP columns), audit on
write, bigint-as-string end-to-end.

## Laws checklist (applies to every item)

Deterministic only — no LLM calls anywhere this sprint; forecast is Class C
preview-only. Every mutation audited; postings append-only (overlays or
reversal batches, never UPDATE). User edits beat rules beat PFC. Money =
BIGINT minor strings. Red = negative money only; status adjacent to its
number. 390px usable. Graceful degradation for every new query/route.
