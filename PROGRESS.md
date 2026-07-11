# KEEL Progress Tracker

> Context-recovery file. If you are picking this up cold: read `CLAUDE.md`, then `PLAN.md`, then this file top-to-bottom, then the last ~20 lines of `NOTES.md`. The "Resume" section tells you the exact next action.

**Last updated:** 2026-07-10 (session 1)
**Current stage:** Stage 1A (TASK-000) — planning/audit phase
**Path decision:** Path A (personal instrument) working default — see NOTES.md D-001.

## Environment facts

- Machine: macOS; node v24.9.0, pnpm 10.33.0, supabase CLI 2.109.1, codex-cli 0.144.1 (default model gpt-5.6-sol xhigh via ~/.codex/config.toml — never pass -m).
- Docker Desktop: must be running for `supabase start` (launched; first image pull is slow).
- Git: initialized on `main`; baseline spec commit `63fe87c`.
- Cloud binding (founder decision D-006): documented project `yrbteeownwjhcushwaga` in a separate Supabase account; publishable key + DB password come from founder at deploy ⚑. Supabase MCP account only sees unrelated projects — do not use it for KEEL cloud ops.
- Executor model (D-007): Codex (gpt-5.6-sol) implements specced leaf tasks in parallel; Claude orchestrates/reviews/owns architecture. Local-only until cloud ⚑ (`BANK_PROVIDER=simulator`, `AI_PROVIDER=fixture`).
- supabase/config.toml exists (project_id `keel`, per-function verify_jwt=false). `supabase/functions/.env` created from example (git-ignored).

## Checklist — Stage 1A (see PLAN.md §3 for step contents)

- [x] Read full spec corpus (CLAUDE.md, INFRA.md, BC-v2.1, docs 09–19, TASK-000)
- [x] Git init + baseline commit + secret-boundary .gitignore
- [x] PLAN.md written
- [x] Claude plan audit done (14 findings) → dispositions in PLAN.md §3.5; Codex audit re-running (model fix: default gpt-5.6-sol, not -m gpt-5.6-codex)
- [x] A1 workspace scaffold (commit b170df7; TS pinned 5.9 — typescript-eslint lacks TS7 support)
- [x] A2 packages/contracts (commit 6c65ece; 19 tests)
- [~] A3 packages/ledger — delegated to Codex agent (in flight)
- [~] A4 packages/authz — delegated to Codex agent (in flight)
- [~] A5 packages/test-fixtures — delegated to Codex agent (in flight)
- [ ] A6 supabase migrations + seed (+ pgTAP)
- [ ] A7 edge functions (api/worker/webhook-provider/scheduled + simulator adapter)
- [ ] A8 the 12 TASK-000 required tests all green
- [ ] A9 apps/web minimal auth smoke + GitHub Actions CI
- [ ] Stage-exit Claude review + Codex review; dispositions in NOTES.md
- [ ] Stage 1A declared done (clean-checkout proof) → tag `stage-1a`

## Human checkpoint queue (⚑ — blocked on founder)

1. Rotate Plaid Sandbox secret; place in `supabase/functions/.env` (local) + Supabase secrets (cloud).
2. Supabase DB password for `supabase link` / `db push`.
3. Named Supabase secret key for worker/scheduled auth.
4. Vercel binding for apps/web deploy.

None of these block Stage 1A (simulator + fixtures only).

## Resume

Next action: run parallel plan audits (Claude general-purpose agent + Codex agent on codex 5.6), triage findings, then start A1.
Resume commands: `git log --oneline | head`, `cat NOTES.md | tail -40`, check Docker (`docker info`), then continue the checklist.
