# Implementation Plan: Paycheck Split Templates, Gross→Net Booking, and Auto-Apply

> Produced 2026-07-19 by a planning agent (full codebase read). Status: awaiting adversarial Codex review before build.

## 0. What already exists (verified in code — the plan builds on it, not around it)

The premise "there is NO split/template infrastructure" is **partially wrong**, and the plan respects that:

| Exists today | Where |
|---|---|
| Full paycheck decomposition spine: `employers`, `paychecks`, `paycheck_components`, `paycheck_sources`, `paycheck_transaction_matches`, `paycheck_status_events`, and an **empty-but-live `paycheck_templates` table** (jsonb `component_blueprint`, `template_version`, immutable rows, RLS + export chain already wired) | `supabase/migrations/20260712130000_paychecks.sql` (templates lines 63–74; immutability trigger line 128) |
| Commands `paychecks.create/edit/reverse/restore/dismiss_detected` → `keel_paycheck_create`, `keel_paycheck_edit` (reverse+create supersession, all-or-nothing), `keel_paycheck_reverse/restore`, `keel_cmd_dismiss_detected_paycheck` | same migration + `20260718090000_paycheck_edit.sql`; API map at `supabase/functions/api/index.ts` lines 84–88, 125–126 |
| Pure deterministic reconciliation validator (`reconcilePaycheck`, bigint, gross = Σ earnings; net = gross + reimbursements − deductions = Σ direct deposits; destination components fully matched; capacity checks) | `packages/paychecks/src/index.ts` |
| Paycheck recurring classification: deterministic `'paycheck'` bucket on inflow series (`keel_recurring_classification`), keyed off `counterparty_key` payroll tokens | `20260719090000_recurring_paycheck_classification.sql`, tightened in `20260719110000_recurring_paycheck_token_tighten.sql` |
| Paychecks UI page with detected-paycheck cards, an **implicit client-side "F-025 employer template"** (scales the last active paycheck's lines to a new deposit via exact bigint math, drift pinned to largest earning line), record/edit/reverse dialogs | `apps/web/src/app/dashboard/paychecks/page.tsx` (`scaleTemplate` lines 130–162, `templatesByEmployer` lines 291–310) |
| Class-B suggest→approve precedent: `category_suggestions` table + deterministic detector + `keel_cmd_decide_category_suggestion` | `20260717160000_categorization_review.sql` |
| Ledger split editing via correction model (reversal batch + replacement + `journal_revisions`), with a **direction guard**: income categories only on money-in, splits sum to exact negation of cash | `20260717190000_set_splits.sql` |
| Transfer booking to manual counterparty accounts + undo (`keel_book_transfer_counterparty`, `keel_undo_transfer`, `transfer_links.booked_txn`) | `20260718130000_transfer_book_counterparty.sql` |
| Autonomy enum `public.autonomy_level ('off','suggest','auto_with_log')` and household-level `approval_policies` (class D pinned 'off') | `20260710210000_extensions_roles_enums.sql` line 45, `20260710210100_identity_authz.sql` lines 98–110 |
| Recurring detection pipeline in worker: `keel_recurring_read_txns` → `detectRecurringSeries` → `keel_recurring_upsert_candidates` (writes `recurring_occurrences.matched_txn_id`) → reap | `supabase/functions/worker/index.ts` `processRecurringDetection` lines 103–194 |
| Agent actor kind already in contracts: `{ kind: 'agent', agentName, onBehalfOf }` | `packages/contracts/src/commands.ts` lines 37–42 |

**Governing spec sections (cite in commit messages):**
- BC-v2.1 "Paychecks and income decomposition" (lines 137–149): names `paycheck_templates` as a durable contract table; components incl. 401(k)/employer match/HSA/FSA; "Components reconcile to gross and net."
- BC-v2.1 §6 Mandatory gate 6 (line 400): "Paycheck components reconcile to gross, net, and destination transactions" — already enforced by `keel_paycheck_create`; every new write path must preserve it.
- BC-v2.1 line 30: gross-to-net splitting across taxes, benefits, 401(k), HSA/FSA, ESPP/RSU, employer match, multiple deposits.
- BC-v2.1 "Explicitly deferred regulated scope": payroll *execution* stays out — templates describe facts, never move money (keeps everything ≤ class B).
- doc 10 §2.4 (lines 141–143): debit-positive posting convention (Σ=0 per currency). **doc 10 §6 has NO paycheck worked example (verified: only STS/payoff/TWR). The worked example this feature adds goes into executable-fixtures + flagged in NOTES.md as a new §2.4-style invariant example, not cited from §6.**
- doc 13 T3.8: the Tax Position engine consumes "W-2 withholding from paycheck engine" — keep component kinds unchanged.
- CLAUDE.md Laws 1–4, 7, 9, 10.

## 1. Design decisions

### D1. Two layers, explicitly separated
1. **Decomposition layer (exists):** the `paychecks` record + components + matches — the reproducible gross→net fact tied to the deposit.
2. **Ledger booking layer (new, optional per application):** re-post the deposit's live batch so reports show gross income + tax expenses:
   - cash (checking) `+net`; income category (e.g. "Salary") `−gross`; expense categories per tax/insurance line `+amount`; pre-tax transfer lines (401k/HSA) `+amount` to a **destination asset ledger account** (not an expense).
   - Σ = net − gross + Σ deductions = 0 exactly when the paycheck reconciles (gate 6 guarantees this).
   - **Cannot** reuse `keel_cmd_set_splits` (its direction guard forbids mixed-sign and must not be weakened). New proc `keel_paycheck_book_splits` implements the mixed-sign batch under the paycheck contract's stricter invariant (only reachable when a reconciling active paycheck exists for that deposit), using the same correction model (reversal + replacement + `journal_revisions`) so undo is a compensating event (Law 2).

### D2. 401(k) destination account (the "external-asset placeholder")
- Template `pretax_transfer` lines carry a `destination_account_id` that must resolve to a **manual (unconnected) asset account's** ledger account — same restriction as `keel_book_transfer_counterparty` (a connected retirement account ingests its own contribution; booking the leg there double-counts). Typed error otherwise.
- UI: account picker filtered to manual asset accounts + one-click "Create retirement placeholder account" (existing `accounts.create`).
- Connected-401(k) booking deferred (NOTES.md deviation); reconciliation path is the existing paycheck `matches` mechanism.

### D3. Template model — build on `paycheck_templates`, normalize lines
- **`paycheck_template_lines`** (immutable): `line_key, kind, role ('earning','tax','pretax_transfer','posttax_deduction','net_deposit'), amount_kind ('fixed_minor','percent_of_gross_bps','remainder'), amount_minor, bps (0<bps<10000), category_ledger_account_id (required tax/posttax when booking), destination_account_id (required pretax_transfer), position`. Exactly one `remainder` line (partial unique index); role↔kind check.
- **`paycheck_series_settings`** (mutable pointer + autonomy — the per-series grant Law 2 needs): `series_id, employer_id, active_template_id, booking_enabled default false, income_category_ledger_account_id, autonomy autonomy_level default 'suggest', unique(household_id, series_id)`. `auto_with_log` requires a template. Class-B: `suggest`=suggest+approve default, `auto_with_log`=explicit grant, `off`=never suggest.
- **`paycheck_split_suggestions`** (class-B records, `category_suggestions` pattern): `series_id, template_id, template_version, deposit_txn_id, computed_components jsonb, computed_gross_minor, computed_net_minor, source ('detector','agent'), reason_code, evidence, status ('suggested','accepted','dismissed','stale'), applied_paycheck_id`, unique `(household_id, deposit_txn_id, template_id, template_version)` idempotent. Stored `computed_components` bind approval to exact payload (Law 11); acceptance **re-computes server-side and compares** — mismatch ⇒ `stale`.

### D4. Deterministic template application math (Law 1)
One algorithm, TS (`packages/paychecks`, UI preview + property tests) + SQL (server truth), parity-tested. Given deposit N and lines: compute gross by grossing-up fixed+percent deductions in bigint (guard P<10000 by table check); each percent line `round_half_up(G*bps,10000)`; single `remainder` line absorbs residue, require `r ≥ 0` else `does_not_reconcile` reason (no silent fail); emit in `keel_paycheck_create` shape and validate with `reconcilePaycheck`. Property tests: Σ earnings=G; net=N; idempotence; TS/SQL parity. Fixtures fictional (no real employer strings).

### D5. Auto-apply hook location
In `processRecurringDetection` (worker), after reap: `keel_detect_paycheck_split_suggestions(household)` (owner `keel_worker`) emits suggestions for confirmed series with an active template + autonomy≠off, for matched-occurrence deposits with no active paycheck + no live suggestion. Then for `autonomy='auto_with_log'`, `keel_auto_apply_paycheck_splits(household)` accepts via the same internal apply core (stable `economic_event_key='paycheck-tpl:'||series||':'||deposit`, system actor), audited, non-fatal on error. Idempotent by unique key + `keel_idempotency_check`.

### D6. Undo (Law 2)
`paychecks.unapply` → `keel_cmd_paycheck_unapply`: reverse the paycheck (`keel_paycheck_transition_core('reversed')`), reverse the booking batch if present (compensating revision), mark originating suggestion `dismissed`. Plain `paychecks.reverse` on a template-applied paycheck blocked with a typed error pointing to `unapply`.

## 2. Migrations
1. `20260720090000_paycheck_split_templates.sql` — enums, 3 tables, immutability/status triggers, RLS + `keel_api` definer policies + `service_role` select, export-chain extension, read models `keel_list_paycheck_templates`, `keel_list_paycheck_split_suggestions`, ownership asserts.
2. `20260720100000_paycheck_template_commands.sql` — `keel_cmd_paycheck_save_template` (full envelope ritual), `keel_cmd_paycheck_set_series_settings` (autonomy grant record).
3. `20260720110000_paycheck_apply_and_booking.sql` — `keel_paycheck_apply_core` (internal), `keel_cmd_paycheck_apply_template`, `keel_cmd_decide_paycheck_split_suggestion` (batch 1–50), `keel_cmd_paycheck_unapply`, `keel_paycheck_book_splits`; additive `paychecks.template_id`, `paychecks.template_version`.
4. `20260720120000_paycheck_split_detection.sql` — `keel_detect_paycheck_split_suggestions`, `keel_auto_apply_paycheck_splits` (owner `keel_worker`, execute service_role only).

## 3. Contracts / authz / API / worker edits
- `packages/contracts` ids + payload schemas + registry: `paychecks.save_template | set_series_settings | apply_template | decide_split_suggestion | unapply`.
- `packages/authz`: 5 commands (`partner` min; **`set_series_settings` requires `owner`** — autonomy grant is a policy change) + queries `paychecks.templates`, `paychecks.split_suggestions`.
- `supabase/functions/api/index.ts`: COMMAND_TO_PROC +5, QUERY_TO_PROC +2; rebuild `node scripts/build-functions.mjs`, deploy `api worker`.
- `supabase/functions/worker/index.ts`: two non-fatal RPCs after reap.
- Law 7 satisfied: backfill agent hits the identical `POST api/commands` envelope with `actor.kind='agent'` — no UI-only path.

## 4. UI slices (`apps/web/src/app/dashboard/paychecks/page.tsx` + `keel-api.ts`)
1. Series detail / template editor modal (roles, fixed$/%, remainder, category picker, manual-asset picker, live TS preview, version history).
2. Autonomy toggle (Off / Suggest / Auto-apply w/ undo) + confirm dialog → `paychecks.set_series_settings`.
3. Split suggestions section (Review-style cards, select-all + batch Approve) → `paychecks.decide_split_suggestion`.
4. Paycheck cards: `templateVersion` chip, "Booked to ledger" badge, Undo → `paychecks.unapply`.
5. Supersede implicit F-025 client template when a server template exists; lift `V1_EDITABLE_KINDS` for template-managed employers.
6. `keel-api.ts` fetchers/mutators.
Run `cd apps/web && pnpm build` (ESLint gate) before pushing.

## 5. Backfill agent flow (suggest→approve, batch)
Detection emits suggestions for all unapplied matched deposits (past included); agent path for pre-coverage deposits calls `paychecks.apply_template` which **down-shifts to a suggestion (`source='agent'`) for `actor.kind='agent'`** (class B never crosses). Founder batch-approves (≤50/command), each re-verified server-side; each application undoable; replays idempotent.

## 6. Tests
`packages/paychecks/test/template.test.ts` (fast-check + edge + fixtures); contracts/authz registration + role floors; `tests/integration/22-paycheck-templates.test.ts` (save v1/v2, apply booked+unbooked, Σ=0 deferred trigger, violations typed, destination-must-be-manual-asset, suggestion gen, batch accept, stale rejection, auto_with_log audited + undoable, unapply restores exactly, idempotent replay, tenant isolation, period-lock); red-team payroll-memo injection fixture in `06-redteam.test.ts` (Law 5).

## 7. Staged delivery (commit-sized, each cites stage/gate + spec)
- **A** pure math (`packages/paychecks`) — no runtime deps.
- **B** schema + reads (migration 090000 + contracts ids + authz queries + API query map + fetch). Deployable inert.
- **C** template authoring (100000 + command entries + editor modal + autonomy toggle).
- **D** apply/undo/booking (110000 + integration test core + manual apply/undo UI). **Delivers founder asks 1 & 2.**
- **E** suggestions + batch approve (120000 detection + worker suggest hook + suggestions UI). **Delivers backfill surface (ask 4).**
- **F** auto-apply (`keel_auto_apply_paycheck_splits` honoring `auto_with_log` + auto badge + undo verification + NOTES entries). **Delivers ask 3.**
