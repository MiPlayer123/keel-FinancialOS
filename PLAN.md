# KEEL Execution Plan — Stage 1 (v1, 2026-07-10)

**Controlling specs:** `INFRA.md` + `docs/17` (runtime/config) → `docs/BC-v2.1.md` (backend contracts) → doc 15 > 16 > 14 > 13 > 10 > 09.
**Immediate objective:** TASK-000 / Stage 1A–1B: the smallest runnable monorepo that proves the KEEL financial spine locally on Supabase CLI/Docker, passing all 12 required tests, deployable unchanged to the configured Supabase Free project.

## 0. Standing assumptions (flagged in NOTES.md)

- **Path A (personal instrument first)** is the working default per doc 15 §4; shares ~90% of Stage 0–1 work with Path B. Founder can flip the sentence later; nothing built here forecloses Path B.
- Local-first: everything runs without cloud credentials (`BANK_PROVIDER=simulator`, `AI_PROVIDER=fixture`). Cloud link/deploy and Plaid Sandbox are ⚑ human checkpoints (rotated secret, DB password, named secret key) and are **not** blockers for Stage 1A.
- Review protocol per operator instruction: after every major stage, a Claude review agent **and** a Codex review agent audit the diff; findings triaged (fix / reject-with-reason in NOTES.md) before the stage commit is declared done.

## 1. Toolchain decisions

| Concern | Choice | Why |
|---|---|---|
| Workspace | pnpm workspaces, no Turborepo yet | INFRA §0 (Turborepo optional; add on measured need) |
| Language | TypeScript strict everywhere; ESM | INFRA |
| Pure-package tests | Vitest + fast-check (property tests) + v8 coverage (100% for `ledger`) | quality bar |
| DB tests | pgTAP via `supabase test db` + SQL fixtures | RLS/grant/trigger tests belong in-database |
| Edge functions | Deno (Supabase runtime), `_shared/` auth-mode wrapper | INFRA §4/§9 |
| Integration tests | Vitest against local Supabase stack (service + publishable clients) | atomicity/idempotency/replay tests need the real stack |
| Lint/format | ESLint flat config + Prettier, minimal rules; `import` boundaries enforced by dependency-cruiser or eslint rule | Dependency law, CI rule 13 |
| CI | GitHub Actions: typecheck, unit, db-test, integration (supabase start in CI), secret scan (gitleaks) | INFRA §17 |

## 2. Monetary + ledger conventions (locked before code)

- Money = `{ amountMinor: bigint, currency: 'USD' | … }`. JS `number` never holds money. JSON transport uses strings for minor units.
- Sign convention: **debit-positive** (doc 10 §2.4). Assets/expenses increase positive; liabilities/income/equity increase negative. Worked example (groceries split + card payment) is an executable test.
- Postings invariant: per `journal_batch` per currency, Σ amount_minor = 0 — enforced in `packages/ledger` (constructor refuses unbalanced batches), in the service layer, and by a **deferred constraint trigger** in Postgres.
- Corrections are **revisions/reversals** (new batches referencing the original), never UPDATE of posted rows. Period locks reject new postings dated into a locked period unless an explicit reopen event exists.
- Idempotency: every command and every ingested event carries an economic-event key; unique indexes make replay a no-op.

## 3. Stage 1A work breakdown (each step = one commit, tests green)

### A1 — Workspace scaffold
`pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json` (strict, ESM, NodeNext), Vitest workspace config, ESLint+Prettier, `.editorconfig`, folder skeleton per INFRA §2. Placeholder packages compile; `pnpm test` runs empty suites green.

### A2 — `packages/contracts`
- Branded types: `Minor` (bigint), `CurrencyCode`, entity/account/category enums (enums over strings).
- Command/query/event envelopes: `{ commandId, economicEventKey, actor, householdId, entityScope, payload }`.
- Typed AI response record (Law 11 shape) + approval-token shape — types only, no AI runtime.
- Error taxonomy (typed, no string throwing).
- Zod schemas co-located for runtime validation at boundaries (contracts may depend on zod only).

### A3 — `packages/ledger` (the heart; 100% coverage gate)
- `Money`: construct/add/negate/allocate (largest-remainder allocation for splits — never loses a cent), reject non-integer, reject float inputs, reject currency mixing.
- `JournalBatch` builder: balanced-per-currency invariant at construction; postings immutable.
- Split engine: split by amounts/percentages; property test: Σ splits = parent for arbitrary inputs.
- Revisions/reversals: `reverse(batch)`, `revise(batch, corrections)` produce compensating batches, original untouched; property test: replaying (batch + reversal) nets to zero.
- Period locks: pure lock-check `assertPostable(date, locks)`.
- Worked examples from doc 10 §2.4 as named tests.

### A4 — `packages/authz`
- Scope model: household → membership(role) → entity membership → account owners → resource permissions.
- One compiler: `authorize(actor, action, resource) → Allow(scope) | Deny(reason)` — fail-closed, exhaustive switch on action class.
- Property test: no path returns Allow when household ids differ (tenant isolation at the pure layer).

### A5 — `packages/test-fixtures`
- Simulator event streams: baseline, duplicate-delivery, out-of-order, delayed-posting, changed-amount (pending→posted mutation), removed-transaction. Deterministic seeds, no `Date.now()`.
- Red-team strings (prompt-injection payloads for memo/CSV fields) — used later by CI rule; included now as data.
- Golden expected canonical outcomes for each stream (replay determinism oracle).

### A6 — Supabase schema (migrations + seed)
Order matters; all idempotent under `supabase db reset`:
1. Extensions (`pgmq`, `pg_cron` where local), roles `keel_api`, `keel_worker`, `keel_readonly` (NOLOGIN role-grants; `keel_migrator` = migration context), revoke-by-default.
2. Identity/authz: `households, household_memberships, entities, entity_memberships, connections, accounts, account_owners, resource_permissions, approval_policies` (+ FK to `auth.users`).
3. Ingestion: `raw_provider_events` (append-only, unique `(provider, provider_event_id)`, body immutable via trigger + no UPDATE/DELETE grants), `normalized_source_records`, `sync_checkpoints`, `import_batches`, `import_rows`.
4. Ledger: `canonical_transactions`, `transaction_source_links`, `journal_batches`, `journal_postings` (BIGINT minor, currency char(3), nonzero check), `journal_revisions`, `period_locks`; **deferred trigger**: per batch per currency Σ=0.
5. Events/audit: `audit_log` (append-only, no UPDATE grant), `domain_events` (append-only), pgmq queues (`sync-events`, `import-batches`) + helper `keel_enqueue()` so mutation+audit+event+enqueue commit atomically.
6. Idempotency: `command_executions (economic_event_key unique)` table gating command replay.
7. RLS on every exposed table: household-scope policies using KEEL membership tables; canonical financial tables get **no INSERT/UPDATE/DELETE policies for `authenticated`** (writes only via functions running as `keel_api` through SECURITY DEFINER command procs or the service role path — decision recorded in migration comments).
8. Seed: two households, cross-membership matrix, entities, accounts, categories — every field explicit (no implicit defaults).

### A7 — Edge functions
- `_shared/`: `withAuth({ mode: 'user' | 'secret:automations' | 'none' })`, typed command router, DB helper opening one transaction per command, error mapper.
- `api`: `health`, `commands.execute` (typed envelope → domain service), `queries.execute`. Rejects missing/invalid JWT (test 9).
- `worker`: pops small pgmq batches, idempotent handlers, rejects non-secret callers (test 10).
- `webhook-provider`: stores raw body first, then Plaid-Verification JWT + SHA-256 body-hash verification against fixture keys (test 11), dedupes, enqueues.
- `scheduled`: orchestration stub invoked by cron; no business logic.
- Plaid adapter **interface** + `SimulatorBankProvider` implementing it; real Plaid calls deferred until simulator tests pass (TASK-000).

### A8 — Integration + DB test pass (the 12 required tests)
Map TASK-000 tests → suites:
1. Balance invariant → pgTAP (trigger) + ledger property tests.
2. Float rejection → contracts/ledger unit + DB column types + CHECKs.
3. Idempotent commands → integration (same key twice ⇒ one batch).
4. Revision preserves original → ledger unit + DB append-only test.
5. Cross-household isolation → pgTAP RLS + authz property + API integration.
6. Client cannot write canonical tables → pgTAP grant/RLS denial tests.
7. Atomic mutation+audit+event+queue → integration (forced failure ⇒ nothing persisted).
8. Simulator replay determinism → integration replaying A5 hostile streams twice ⇒ identical canonical state.
9. api rejects bad JWT → function integration.
10. worker/scheduled reject non-secret → function integration.
11. Plaid webhook fixture verification → function unit/integration with fixture JWK.
12. Secret scan → gitleaks in CI + test asserting no `sb_secret`/`PLAID_SECRET=`-value patterns in tracked files.

### A9 — `apps/web` minimal + CI
Next.js shell: sign-in (email OTP against local Auth), authenticated "call api/health" smoke page. No canonical writes. GitHub Actions workflow running the full gate locally-equivalent.

**Stage 1A exit:** clean checkout → `pnpm install && supabase start && supabase db reset && pnpm test` all green; NOTES.md updated; ⚑ list surfaced. **Then: Claude + Codex stage audits before declaring done.**

## 3.5 Amendments from plan audit v1 (Claude adversarial review, 2026-07-10)

Dispositions of all 14 findings; full audit text in NOTES.md session log.

1. **Write path (blocker) — DECIDED: SECURITY DEFINER command procs.** TS packages compute typed command effects (postings, lineage, keys); persistence is one `keel.cmd_*(...)` SECURITY DEFINER procedure per command, owned by a dedicated non-BYPASSRLS definer role with minimal grants. Procs re-enforce invariants (balance per currency, idempotency key uniqueness, period locks, append-only) and write canonical rows + audit + domain event + pgmq enqueue in their single transaction — INFRA §5 steps 4–11 satisfied atomically; `authenticated` gets zero direct DML on canonical tables (test 6); test 7 atomicity is structural. Shared `keel.begin_command()` helper handles idempotency/audit preamble. No new runtime secrets; PostgREST `.rpc()` compatible; identical local/cloud.
2. **`@supabase/server`** — adopted as the auth wrapper per INFRA §4/docs 17; `_shared/withAuth` becomes a thin adapter over it. If the package turns out unavailable in the Edge runtime, fall back to supabase-js + manual JWT validation and record the deviation (verify during A7).
3. **config.toml** — done (project_id `keel`, per-function `verify_jwt=false` merged).
4. **Exit commands corrected**: clean checkout = `pnpm install && supabase start && supabase db reset && pnpm test:unit`, then `pnpm test:integration` (globalSetup orchestrates `supabase functions serve --env-file supabase/functions/.env`). A7 adds: `.env` provisioning script that also generates a **local-only random named secret** for `secret:automations` (legitimate local provisioning; the cloud named secret remains ⚑).
5. **Stage 1A command vocabulary (locked)**: `accounts.create`, `ingest.record_raw_event`, `ingest.promote_event` (raw → canonical transaction + balanced batch), `journal.post_batch`, `journal.reverse_batch`, plus read surfaces `ledger.trial_balance`, `transactions.list`. Tests 3/7/8 run against `ingest.*` + `journal.*`.
6. **bigint read path**: every read surface returns `amount_minor::text` (views + RPC json build); integration test asserts JSON string typing end-to-end. Contracts DTOs already string-typed.
7. **Simulator placement**: `BankProviderAdapter` interface in `packages/contracts`; `SimulatorBankProvider` in `packages/test-fixtures`. **Deno interop**: Edge functions consume shared packages via an esbuild bundling step (`pnpm build:functions` → `supabase/functions/_shared/vendor/keel.mjs`); no npm publishing, no sloppy-imports flag dependence.
8. **pgmq queue names**: underscores (`sync_events`, `import_batches`) — deviation from INFRA §8's hyphenated labels recorded (pgmq identifier rules).
9. **Test 2 restated**: boundary rejection (zod string-integer) + pgTAP catalog assertion that no money column is float/numeric; drop the vacuous CHECK claim.
10. **Test 12**: CI also scans built web bundle output for secret patterns, not just tracked files.
11. **pgTAP RLS mechanics**: tests set `role authenticated` + `request.jwt.claims` explicitly; plus one supabase-js publishable-client write-denial integration test.
12. **Role model**: `keel_api`/`keel_worker` are NOLOGIN grant-bundles assumed via the definer procs' ownership chain; no new LOGIN roles, no pooler password secret. Verified against finding 1 decision.
13. **Cron transport** noted for 1B (pg_cron → `net.http_post` to `scheduled`); stub only in 1A.
14. **`professional_access_grants`** deferred from A6 (satisfies TASK-000 via `resource_permissions`); explicit deferral, lands with support/professional surface in 1D.

## 4. After Stage 1A (forward view, gated)

- **1B** local integration hardening (already mostly covered above; whatever pgTAP/RLS surface remains).
- **1C** hostile ingestion: pending→posted lineage, reconnect/account lineage, import staging + rollback, replay sandbox.
- **1D** core domains: categories/dimensions, transfers, recurring, reconciliation/statements, exports (`admin.export_all` CSV/JSON/QIF/beancount).
- **1E** thin engineering UI (INFRA §16 list).
- ⚑ cloud link + deploy, Plaid Sandbox live test — needs human secrets.

## 5. Progress + context-recovery protocol

- `PROGRESS.md` = single source of "where are we"; updated **every work session** (checkbox per step, current step, next action, resume commands).
- `NOTES.md` = build journal: decisions, deviations (with spec cite), failed approaches, test results, ⚑ queue.
- Commits: small, message = `stage-1a(A3): … [BC-v2.1 §9.1]` style.
- Reviews: parallel Claude + Codex audit at plan time (this document) and at each stage exit; findings + dispositions recorded in NOTES.md.
