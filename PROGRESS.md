# KEEL Progress Tracker

> Context-recovery file. Picking this up cold: read `CLAUDE.md`, then `PLAN.md` (incl. §3.5/§3.6 audit amendments), then this file, then the last ~60 lines of `NOTES.md`. The "Resume" section is the exact next action.

**Last updated:** 2026-07-11 (C3 @6cb43ec + C4 @368a420 COMMITTED; C5c in design)
**Current stage:** Stage 1C building (server-only Plaid read path). GREEN + COMMITTED: C1, C2a, C2b, C3 (link/disconnect saga @6cb43ec), C4 (webhook verification @368a420, DoS-hardened), C5a, C5b. **7/9 1C steps committed.**
**C5c (in progress — live /transactions/sync, task #10):** the C6 pre-build review exposed that C5b's worker pulls from the `sync_test_pages` INJECTION table, never a live Plaid call (`plaid-sync.ts:51` stub). Founder delegated the call → ruling: wire the live pull in (C5c) before C6. Spec `C5C-BUILD-SPEC.md` at **v2** after a dual review found the "unchanged machinery" premise false (injected = whole page set; live = windowed cursor prefix → force-completes with false success at has_more/maxPages; live mutation-restart can't drive the worker's array-replay). v2 redesign: self-contained live fetcher (internal bounded mutation-restart) returning `{pages,hasMore,nextCursor}`; `complete_attempt(p_fully_synced)` gates last_successful_sync_at + drives continuation re-enqueue; `abandon_attempt` on failure; hard `KEEL_LIVE_SYNC_ENABLED` opt-in (OFF in itest/CI so hermetic even with a real .env); sandbox-only gate. A Codex v2 confirmation is in flight (`/tmp/c5c-confirm-out.txt`).
**Next action:** read the c5c confirmation verdict → build C5c (Codex) → dual post-build review → gate → commit. THEN C6 v2 (`C6-BUILD-SPEC.md` needs the review fixes listed in NOTES: graceful pg_cron, atomic reserve-budget, real enqueue dedup, counter-cap, backoff, reaper-cron=deploy-⚑) → stage-exit dual audit + tag stage-1c. Deferred C5b (M4/B2/M6/m8/m9) + C3 (Codex #2-5, Claude F2) + C4 (F1/F3, quarantine global rate-cap) items tracked in NOTES for stage-exit.
**Path decision:** Path A (personal instrument) working default — NOTES D-001.

## Environment facts

- macOS; node 24.9.0, pnpm 10.33.0, supabase CLI 2.109.1, codex-cli 0.144.1.
- **Codex usage: NEVER pass -m; ~/.codex/config.toml defaults to gpt-5.6-sol xhigh** (gpt-5.6-codex is NOT available on this account).
- **KEEL local Supabase runs on ports 55320–55329** (D-015; rem-mobile-app stack owns 54xxx). API: http://127.0.0.1:55321.
- Cloud binding (D-006): documented project `yrbteeownwjhcushwaga` in a separate Supabase account; founder supplies publishable key + DB password at deploy ⚑. The connected Supabase MCP does NOT see this project.
- Executor model (D-007): Codex gpt-5.6-sol implements specced leaf tasks in parallel; Claude orchestrates/reviews/owns trust-boundary code.
- Local env: `pnpm provision:local` generates `supabase/functions/.env` + local automations secret (`.env.local-automations`); `pnpm build:functions` bundles domain packages for Deno.

## Checklist — Stage 1A

- [x] Spec corpus read; git init; baseline commit
- [x] PLAN.md + dual audits (Claude: PLAN §3.5; Codex: PLAN §3.6 — incl. cross-household idempotency fix)
- [x] A1 workspace scaffold (b170df7)
- [x] A2 @keel/contracts — 19 tests (6c65ece)
- [x] A3 @keel/ledger — 54 tests, 100% coverage (1540e6f, Codex-built)
- [x] A4 @keel/authz — 35 tests (d8f93bd, Codex-built)
- [x] A5 @keel/test-fixtures — 25 tests (b9d256e, Codex-built)
- [x] A6 migrations: enums/roles, identity/authz, ingestion (append-only), ledger (deferred balance trigger + period locks), audit/events/idempotency, grants+RLS, user command procs, worker procs, quarantine+transfers, seed w/ auth.users (12bde88) — **not yet executed against a live DB**
- [x] A7 edge functions: api / worker / webhook-provider / scheduled + esbuild vendor bundle + provisioner (12bde88) — **not yet served/tested**
- [x] pgTAP suites written (supabase/tests/001, 002) — **not yet run**
- [x] CI workflow written (.github/workflows/ci.yml) — **not yet pushed/proven**
- [x] @keel/ingest + fixture key rework (golden oracles reproduce; supersession continues pending key)
- [x] apps/web shell (builds, typechecks; verified host-side)
- [x] Local stack up (ports 55321-55329)
- [x] `supabase db reset` green (migrations + seed apply; D-017 schema-qualification)
- [x] `supabase test db` green (25 pgTAP tests)
- [x] Integration suite green: 41/41 via `scripts/dev/itest.sh` (reset → serve → test; order load-bearing)
- [x] Red-team ingestion test green (14 payloads inert, verbatim, exactly-one-txn)
- [x] Stage-exit reviews (Claude + Codex): 8 findings, ALL fixed (F1-F8); dispositions in NOTES
- [x] Clean-checkout proof (fresh clone: install/typecheck/lint/159 unit/bundle/web build) + tag `stage-1a` (8e63d3c)

## Human checkpoint queue (⚑)

1. Rotate Plaid Sandbox secret → `supabase/functions/.env` + Supabase cloud secrets (needed Stage 1C).
2. Supabase DB password for `supabase link`/`db push` to `yrbteeownwjhcushwaga`.
3. Publishable key for the documented cloud project → root `.env.example`.
4. Cloud named `automations` secret key.
5. Vercel binding for apps/web.

None block Stage 1A.

## Resume

1. Check background agents/tasks: ingest agent, web agent, `supabase start`.
2. When stack is up: `supabase db reset` → fix migration errors → `supabase test db`.
3. `pnpm build:functions` → `supabase functions serve --env-file supabase/functions/.env` → write integration suite (vitest project at tests/integration; needs @supabase/supabase-js devDep; use seed users alex/casey password `keel-local-dev-password`; automations secret from `.env.local-automations`; webhook JWK fixture: generate ES256 pair in-test, put public JWK in served env — regenerate `supabase/functions/.env` with PLAID_WEBHOOK_JWK before serving).
4. Map every TASK-000 test 1–12 to a passing suite (matrix in PLAN §3/A8), then stage-exit dual review, then tag.
