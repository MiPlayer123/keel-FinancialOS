# KEEL Progress Tracker

> Context-recovery file. Picking this up cold: read `CLAUDE.md`, then `PLAN.md` (incl. §3.5/§3.6 audit amendments), then this file, then the last ~60 lines of `NOTES.md`. The "Resume" section is the exact next action.

**Last updated:** 2026-07-11 ~01:30 (session 1)
**Current stage:** Stage 1C building (server-only Plaid read path). PLAN-1C cleared by 4 audit rounds (tag plan-1c-ready). Done+green+committed: C1 adapter, C2a schema, C5a-core reconcile, C2b crypto. Plaid Sandbox LIVE-verified (creds in ignored env). C5b (sync worker) built 2 ways but REVERTED (simulator-drain regression) - preserved in git stash@{0} + /tmp; main stays green. Next: finish C5b (resume plan in NOTES), then C3 saga, C4 webhook, C6 cron, stage-exit.
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
