# KEEL Progress Tracker

> Context-recovery file. If you are picking this up cold: read `CLAUDE.md`, then `PLAN.md`, then this file top-to-bottom, then the last ~20 lines of `NOTES.md`. The "Resume" section tells you the exact next action.

**Last updated:** 2026-07-10 (session 1)
**Current stage:** Stage 1A (TASK-000) — planning/audit phase
**Path decision:** Path A (personal instrument) working default — see NOTES.md D-001.

## Environment facts

- Machine: macOS; node v24.9.0, pnpm 10.33.0, supabase CLI 2.20.3, codex-cli 0.144.1 present.
- Docker Desktop: must be running for `supabase start` (launched via `open -a Docker`).
- Git: initialized on `main`; baseline spec commit `63fe87c`.
- No cloud credentials in play yet; local-only (`BANK_PROVIDER=simulator`, `AI_PROVIDER=fixture`).

## Checklist — Stage 1A (see PLAN.md §3 for step contents)

- [x] Read full spec corpus (CLAUDE.md, INFRA.md, BC-v2.1, docs 09–19, TASK-000)
- [x] Git init + baseline commit + secret-boundary .gitignore
- [x] PLAN.md written
- [ ] Plan audited by parallel Claude + Codex agents; findings triaged into PLAN.md/NOTES.md
- [ ] A1 workspace scaffold
- [ ] A2 packages/contracts
- [ ] A3 packages/ledger (100% coverage + property tests)
- [ ] A4 packages/authz
- [ ] A5 packages/test-fixtures (hostile streams + red-team data)
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
