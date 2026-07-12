# KEEL Progress Tracker

> Context-recovery file. Picking this up cold: read `CLAUDE.md`, then `PLAN.md` (incl. §3.5/§3.6 audit amendments), then this file, then the last ~60 lines of `NOTES.md`. The "Resume" section is the exact next action.

**Last updated:** 2026-07-12 (Stage 1C tagged + LIVE-PROVEN; Stage 1D CORE export GREEN)
**Current stage:** ✅ **Stage 1C COMPLETE + TAGGED (`stage-1c` @c91e515) + LIVE-PROVEN end-to-end against real Plaid Sandbox** (commit 752b772): real link → 12 accounts → live /transactions/sync (via C6 cron) → 50 real transactions posted, 0 unbalanced batches (Law 3), exact decimal→minor (Law 4), C6 metered+budgeted the live calls, Law 12 clean on live data (no token/secret in any sink/log, credentials opaque bytea), live disconnect → real /item/remove + crypto-shred. Live testing exposed + fixed a real bug the hermetic suite couldn't (link route didn't send institution_id/initial_products to /sandbox/public_token/create). Several deploy-⚑ now satisfied for Sandbox (see NOTES 2026-07-12).
**✅ GREEN: Stage 1D CORE EXPORT (Law 6 / gate 13, task #11).** `@keel/exports` emits canonical JSON + RFC-4180/formula-safe CSV + asset-side QIF + balanced beancount with exact string-shift currency scaling and a recursive fail-closed secret scan; the dedicated NOLOGIN `keel_export` role has SELECT on exactly 28 v2-included public tables and zero excluded-table access; `keel_export_household` is owner-only, explicitly scoped, explicit-column, one-snapshot, and bigint-as-text; `/api/admin/export` repeats owner authz and returns inline below 5,000,000 UTF-8 bytes or 413. Reconstruction, cross-tenant, credential-canary, 41-table completeness, partner-denial, and all-format reconciliation proofs are green. Gate: 64 package tests at 100% statements/branches/functions/lines; 200 pgTAP; 84/84 integration across 11 files; C5c fetch-spy 0. No commit made.
**AFTER 1D export:** independent post-build review + human-approved commit; then remaining Stage-1C deploy-⚑ (reset-login reauth, KEK rotation route, Plaid Dashboard webhook, secret cron schedules, production), remaining Stage 1D finance domains (recurring/paycheck/statements), and Stage 1E viewer UI. Deferred export work: async Storage/job path, step-up MFA, operational cross-project restore, import→canonical lineage.
**C5c (GREEN, uncommitted — live /transactions/sync):** tagged injected/live/disabled dispatcher; Sandbox-only opt-in live fetch; encrypted credential decrypt with `'plaid'` AAD and `finally` clear; raw-byte pagination; per-request and promotion-loop lease renewal; bounded mutation restart; stalled-cursor rejection; partial completion; owner-fenced cleanup; fresh-attempt continuation; forced-off integration env plus outbound deny/spy. C6 now meters injected/live sync calls and reserves only at the live network boundary.
**C6 (GREEN, uncommitted — metering/breakers/cron):** typed Law-12-safe usage events; atomic daily reserve/refund; atomic cadence claim with lease/generation exclusions; counter-based quarantine cap; guarded/idempotent pure-SQL `keel-active-syncs` pg_cron job; all live Plaid boundaries metered and budgeted; `/scheduled/tick` active. Gate: 218 Vitest + 12 Deno/47 steps, 145 pgTAP, 78 integration, 0 Plaid sync fetches in itest. `config.toml` is untouched.
**Exit hardening (GREEN, uncommitted):** one forward migration replaces ambiguous legacy procedure signatures, preserves C3/C5c fences, carries real pending state + exact raw page lineage, and adds immutable tenant-derived ingestion skips. Worker/API/client/test changes close C3 #4, Law 12, C3 #2, and the safe-stale race. Gate: 220 Vitest + 12 Deno suites/54 steps, 175 pgTAP, 81 integration, 0 Plaid sync fetches in itest.
**Next action:** review the Stage-1C exit-hardening diff, then human-approved commit and tag `stage-1c`. Deploy-time ⚑: real linked-Sandbox pull plus vaulted-secret HTTP schedules for `/worker/drain`, `/worker/reap-links`, and optional `/scheduled/tick`; Production remains human-gated.
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
