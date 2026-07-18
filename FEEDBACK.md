# FEEDBACK.md — triage tracker (2026-07-18 batch)

Source: Mikul's voice-memo walkthrough of the live app. Verified against actual code +
live DB by 4 read-only audit agents + 1 web-research agent on 2026-07-18.

**Status:** `[ ]` open · `[~]` in progress · `[x]` done (merged + verified) · `[?]` blocked on Mikul · `[-]` no action / deferred

---

## A. Bugs & friction

- [ ] **F-001 — Connecting a bank requires a page refresh** · bug · P1 · **WS-A**
  - **Verified: CONFIRMED, root causes found.** (1) Sidebar/app caches (`['keel-query']` react-query keys, 45s staleTime, persistent AppShell) are never invalidated after Plaid Link succeeds — `onLinked` only reloads the connections page's local list. (2) Second-connect dead click: `react-plaid-link` handler-staleness bug in `plaid-link-button.tsx` — after first success the destroyed handler still reads `ready=true`, second open silently no-ops and the button spins forever. (3) Bonus: `/connections/link` never calls `keel_cron_drain_sync`, so the initial backfill sits queued up to ~3 min.
  - **Fix:** remount `usePlaidLink` in a `key={token}` child; invalidate `['keel-query']` on link; drain queue after finalize.

- [ ] **F-002 — "Sync now" weird right after first connect** · bug/UX · P2 · **WS-A**
  - **Verified: CONFIRMED.** While the initial backfill holds the sync lease, manual sync is deferred (`acquired:false`) but the UI unconditionally toasts success, clears the spinner, and the row still says "Not synced yet." The `isSyncing` flag is already computed in `fetchConnections` but never rendered on the Connections page.
  - **Fix:** render per-row "Initial sync in progress…", disable Sync Now while syncing, poll like the account page already does.

- [ ] **F-003 — Review: confirmed items linger** · UX · P2 · **WS-B**
  - **Verified: CONFIRMED.** No optimistic removal — confirm awaits decide → re-runs full detection → refetches list (3 serial round-trips). Bulk approve is a serial per-item for-loop.
  - **Fix:** optimistic row removal with rollback; skip re-detection on post-decision refetch; `Promise.allSettled` for bulk.

- [ ] **F-004 — Review says "all caught up" then shows 143 items** · bug · P2 · **WS-B**
  - **Verified: CONFIRMED, two mechanisms.** Loading gate uses AND across three loaders (cached recurring returns instantly → gate falls through while slow detect-then-list hooks still run → false empty state). Nav badge is a separate fetch-once count that never refetches.
  - **Fix:** OR the loading gate / per-section skeletons; unify page + badge on one shared react-query key.

- [ ] **F-005 — App is slow** · perf · P1 · **WS-H (wave 3)**
  - **Verified: CONFIRMED, top causes ranked.** (1) `keel_list_transactions_rich` is unbounded — entire household history as one jsonb blob with 4 correlated laterals/row, fetched by 7 pages. (2) Every save nukes the whole query cache → full re-download. (3) ~8–11 separate edge invocations per page mount. (4) Zero virtualization; account page renders all 644 rows. (5) Account filtering is client-side.
  - **Fix:** paginated/filtered server query + scoped invalidation + virtualized lists.

- [ ] **F-006 — "Free to spend" shows with no budget** · UX · P2 · **WS-F**
  - **Verified: CONFIRMED (nuance).** Card renders unconditionally and isn't budget-based at all (income/spend/recurring math; budgets aren't even fetched on Home). Fix folded into dashboard redesign (F-024).

## B. Account page polish — all → **WS-D**

- [ ] **F-007 — Balance chart range picker** · P2 — **Verified:** hard-fixed to 90d, but `keel_account_balance_daily` already accepts from/to — UI-only work. Add 30d/90d/YTD/custom.
- [ ] **F-008 — Click-to-edit name, no pencil** · P3 — **Verified:** two persistent pencil icons (name + entity).
- [ ] **F-009 — Header cleanup, ⋯ overflow menu** · P2 — **Verified:** "Set opening balance"/"Fix balance" are always-visible ghost buttons (not hover); header carries 8+ elements. Move secondary actions into a ⋯ menu.
- [ ] **F-010 — Transaction sidebar full-height + inline notes + tags/category** · P2 · **WS-F** — current edit dialog verified; rebuild as full right-side panel. Keep splits + attachments.

## C. Transfers

- [ ] **F-011 — Transfer detection coverage** · P2 · **WS-E**
  - **Verified.** SQL detector: exact-amount, ≤3-day window, greedy 1:1, no tolerance (a $0.01 fee kills a match). Confirming writes classification overlay only (correct per Laws — excluded from cash flow at read time). Investment accounts de-facto excluded because their transactions are never ingested (→ F-013 is the real unlock).
  - **Fix:** add small-tolerance/wider-window suggestion tier after F-013 lands; measure on real data.

- [ ] **F-012 — "Transfer" category should prompt for counterparty account (incl. manual)** · feature · P1 · **WS-E**
  - **Verified: CONFIRMED gap.** Picking category "Transfers" is a one-sided tag — excluded from spending analytics but NOT from cash flow, and no opposite leg is booked. Building blocks exist: `RecordTransferDialog` (balanced 2-leg posting incl. manual accounts) and `linkTransfer` (pair two existing txns).
  - **Fix:** intercept the Transfer pick with a counterparty step: connected account → match/link candidate; manual account → new server proc atomically posts opposite leg + confirmed transfer_link.

- [ ] **F-013 — Investment-account transactions not shown** · P1 · **WS-C**
  - **Verified: CONFIRMED.** No `/investments/transactions/get` anywhere in the repo; Plaid `/transactions/sync` doesn't cover investment accounts. Live DB: Fidelity brokerage + cash mgmt have 0 transactions (vs 554/644 for checking).
  - **Fix:** add investments-transactions pull to worker for investment accounts, map cash-flow events into the raw→canonical pipeline so transfer detection sees them.

## D. Investments — → **WS-C**

- [ ] **F-014 — Holdings not pulled** · P1
  - **Verified: CONFIRMED in practice.** Holdings sync code shipped TODAY (holdings table + worker call each drain) but live DB has 0 rows — the existing Fidelity Item predates the `investments` product on the link token, so holdings calls fail silently (errors never persisted/surfaced). Also `cash management` subtype isn't holdings-eligible.
  - **Fix:** persist/surface per-connection holdings errors; ⚑ **Mikul must re-link Fidelity in update mode** to grant the investments product.
- [ ] **F-015 — Investments page** · P1 — **Verified:** no route, no nav entry; only a per-account HoldingsCard + a Reports allocation card. Manual holdings entry already exists. Build `/dashboard/investments`: accounts, holdings, total value, allocation; holdings history snapshot table for value-over-time.

## E. Categories

- [ ] **F-016 — Subcategories with roll-up** · P1 · **WS-G**
  - **Verified: mostly already built.** Two-level hierarchy fully exists in schema (parent_id + one-level trigger), manager UI, picker, reparent proc, Sankey rollup. Missing: seeded default subcategories (0 today), matrix-report rollup w/ drill, parent option in picker inline-create.
- [ ] **F-017 — Uncategorized flagged** · P2 · **WS-B** — **Verified: mostly surfaced** (dashboard card, ledger filter, Review suggestions). Gap: txns matching no rule/PFC never reach Review — add a "Still uncategorized" section.
- [ ] **F-018 — Auto-categorization quality** · P2 · **WS-G** — improves with default subcategories + seed mapping; measure against harness (≥85% bar).
- [ ] **F-019 — Drop "AI suggests" copy** · P3 · **WS-B** — **Verified:** exactly one string (`review/page.tsx:54`). Reason lines are deterministic and already demoted; keep.

## F. Navigation & IA — → **WS-F**

- [ ] **F-020 — Left-nav cleanup + per-page tabs** · P1
  - **Verified:** 15 top-level items today (target ≤9). Research: Monarch = Dashboard/Accounts/Transactions/Reports/Budget/Recurring/Goals/Investments/Advice/Settings; Copilot similar. Proposed: Home, Accounts, Transactions, Investments, Recurring, Budgets & Goals, Reports, Review, Settings — with Paychecks/Reimbursements/Statements as tabs or grouped, Connections under Settings/Accounts, Notes & Tasks demoted. **Decisions (Mikul 2026-07-18): rename Ledger → "Transactions"; demote Notes & Tasks.**
- [ ] **F-021 — Cmd+K** · P2 — **Verified: already exists** (pages/accounts/categories/actions). Gap: no transaction/payee search — needs the server-side search from WS-H; defer the search source to WS-H.
- [ ] **F-022 — Top-bar purpose** · P2 — fold into F-020 (Review count, sync status, search affordance).
- [ ] **F-023 — Personal / LLC / Retirement separation** · P1 · **WS-G**
  - **Verified: schema strong, UI thin.** `entities` (kinds incl. llc_single…), `accounts.entity_id NOT NULL`, picker + reassign + reports filter all exist. Live DB: everything (incl. the LLC checking) is under the single "Personal" entity. "Retirement" is an account class, not a legal entity.
  - **Fix:** per-entity net worth + sidebar/accounts grouping; create LLC entity + reassign (data task); retirement grouping via account class/subtype. **Decision (Mikul 2026-07-18): entities + retirement-as-account-class (no fake Retirement entity).**

## G. Dashboard — → **WS-F**

- [ ] **F-024 — Dashboard redesign** · P1
  - **Verified:** current order NeedsAttention → FreeToSpend → NotesTasks → NetWorthHero → …, all full-width. Redesign: net worth top line, income/expense + cash flow by month, compact card grid, recent txns, upcoming recurring, paychecks; notes/tasks small card; free-to-spend gated/re-based (F-006). Bonus bug: dashboard "Sync" button only syncs `connections[0]` — fix in WS-A.

## H. Paychecks / reimbursements / recurring / statements / receipts

- [ ] **F-025 — Paycheck auto-detection + templates** · P2 · **WS-I**
  - **Verified.** Recording is manual; recurring-inflow detection already prefills employer/net/deposit txn, but every gross→net line is re-keyed each time; `paycheck_templates` table exists but is dead schema.
  - **Fix:** derive per-employer template from last paycheck; Review suggestion "record with your usual breakdown" applying the template through the existing math-checked proc.
- [ ] **F-026 — Reimbursements: clarify + fix income bug** · P2→raised · **WS-I**
  - **Verified.** Mechanics complete (claims, settlements, capacity checks). Real bug found: `keel_is_non_income_settlement` is unwired — **settled reimbursements still count as income in reports.** Also no explainer, and settlement matching is fully manual.
  - **Fix:** wire income exclusion (bug), explainer/empty-state, suggest-approve settlement matching for exact-amount inflows.
- [ ] **F-027 — Notes & Tasks: demote to dashboard card** · P2 · **WS-F** — Mikul's decision 2026-07-18: remove the top-level page/nav entry; keep the compact dashboard card and object anchoring.
- [ ] **F-028 — Recurring detection incl. bills** · P2 · **WS-I**
  - **Verified: detection already exists & runs nightly** (deterministic grid detector, suggest-only, Spotify-class subscriptions covered). Gaps: no subscription/bill/utility classification or grouping; ≥3-occurrence latency; detected series vs manual schedules unlinked (projection double-counts).
- [ ] **F-029 — Statements: cadence + import** · P3 · **WS-I**
  - **Verified: full manual statement + reconciliation feature already exists** (user hadn't found it). Gaps: no statement-cadence/reminders; uploads are attach-only (lines hand-keyed).
  - **Fix (slice 1):** statement cadence + reminder; CSV line import later.
- [ ] **F-030 — Receipts hub with matching** · P2 · **WS-J** — **Decision (Mikul 2026-07-18): build extraction + auto-matching now.**
  - **Verified.** Upload/attach substrate shipped 2026-07-17 (immutable originals, per-txn/paycheck/claim/statement attach). Extraction + matching (`document_extractions`, `document_transaction_matches`) deliberately deferred per docs/research/RECEIPTS-2026-07-16.md. Building it = worker AI extraction (class B) + Review matching, ≥90% precision bar.

## I. Research & infra

- [x] **F-031 — Plaid pricing/alternatives** · research **DONE**
  - **Answer: stay on Plaid.** Trial plan = 10 Production Items free (lifetime count — `/item/remove` does NOT free slots); next tier is Pay-as-you-go, no commitment, ~$0.30–0.60/Item/mo for transactions → ~$40/mo ballpark at 20 users. Alternatives all fail coverage or access: Teller (free 100 connections but no Fidelity/investments), SimpleFIN ($15/yr per user, MX-backed, 1×/day batch, user-managed tokens), MX/Finicity/Akoya/Yodlee (sales-led enterprise), Quiltt ($100–500/mo floor). Venmo is effectively Plaid-only.
- [ ] **F-032 — Human Interest failure + silent Link errors** · P3 · **WS-A**
  - **Verified.** Almost certainly NOT a Plaid limit (4-5 Items < 10 cap, though wipes/retries burn lifetime slots — worth a dashboard check). **Plaid does not support Human Interest as an institution** (no institution page; 401k recordkeepers generally unlinkable) → manual 401k account is the path. Real code gap: `onExit` discards Plaid's error entirely (silent modal close) and limit codes aren't in the allowed-error list.
  - **Fix:** surface Link exit errors with institution + message; allow limit-related codes through.

## J. Explicitly fine / no action

- [-] **F-033** Overall design — fine for now. · **F-034** Mobile — solid. · **F-035** Goals — keep. · **F-036** Assistant UI — fine. · **F-037** Net worth ~$75k low — explained by unconnected accounts (+ F-013/14). · **F-038** Reports — solid overall.
- [ ] **F-039 — Reports drill-downs & polish** · P2 · **WS-G** — category→sub drill (after F-016 rollup), better hovers, payee view. Custom report builder deferred.

---

## Bonus findings (from verification, not in original feedback)

- [ ] **X-001 — Dashboard "Sync" button only syncs `connections[0]`** — other banks never sync from Home; "Updated Xh ago" misleading. → **WS-A**
- [ ] **X-002 — No react-query invalidation on rename/disconnect/reconnect either** — same class as F-001. → **WS-A**
- [ ] **X-003 — Settled reimbursements count as income** (`keel_is_non_income_settlement` unwired). → **WS-I** (folded into F-026)

## Workstreams

| WS | Scope | Items | Wave | Status (2026-07-18) |
|----|-------|-------|------|--------|
| WS-A | Connect/sync UX + Link error surfacing | F-001 F-002 F-032 X-001 X-002 | 1 | built (green) + committed; adversarial review running |
| WS-B | Review page correctness + speed | F-003 F-004 F-017 F-019 | 1 | **reviewed: safe-to-merge**; P2 cleanups applied; ready to merge |
| WS-C | Investments: txn ingestion, holdings errors, page | F-013 F-014 F-015 | 1 | agent still building (largest task) |
| WS-D | Account page polish | F-007 F-008 F-009 | 1 | built (green) + committed; review running (verifying F-007 not cosmetic) |
| WS-E | Transfers UX | F-011 F-012 | 2 | not started |
| WS-F | IA/nav + dashboard redesign + txn sidebar | F-020 F-022 F-024 F-006 F-010 F-027 | 2 | not started |
| WS-G | Categories/subcategories + entities + reports drill | F-016 F-018 F-023 F-039 | 2 | not started |
| WS-H | Performance | F-005 F-021(search) | 3 | not started |
| WS-I | Paychecks templates, reimbursements, recurring grouping, statements cadence | F-025 F-026 F-028 F-029 X-003 | 3 | not started |
| WS-J | Receipts matching (approved) | F-030 | 3 | not started |

**Merge plan:** WS-B/WS-A/WS-D are pure-web (no migrations, no edge-function-only risk except WS-A's plaid-client/api tweaks) → integrate the three together after all reviews clean, one build, one push/deploy. WS-C (migrations + worker/api deploy + human Fidelity re-link) merges separately with backend coordination. WS-A and WS-C both touch `plaid-client.ts`/`api/index.ts` → WS-C rebases onto WS-A.
