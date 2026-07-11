# KEEL build journal

Record every decision, deviation, failed approach, command run, test result, migration, and human checkpoint here. Never record credential values. Refer to secrets only by environment-variable name.

---

## 2026-07-10 — Session 1 (Stage 1A kickoff)

### Decisions

- **D-001 Path A default.** Doc 15 §4 requires a one-sentence Path A/B decision before code. Founder hasn't stated it; operator instruction is "go end-to-end". Working default: **Path A (personal instrument first)** — lowest-commitment option, shares ~90% of Stage 0–1 work with Path B, fully reversible. ⚑ founder may override.
- **D-002 Stage review protocol.** Per operator instruction: every major stage exit gets a parallel Claude review + Codex (5.6) review; findings triaged here with fix/reject dispositions before the stage is declared done. Plan itself audited the same way before build.
- **D-003 Toolchain.** Vitest + fast-check for pure packages; pgTAP via `supabase test db` for RLS/grants/triggers; Deno for edge functions; gitleaks for CI secret scan. Rationale in PLAN.md §1.
- **D-004 Cloud binding discrepancy (⚑).** Spec-configured project `yrbteeownwjhcushwaga` is not visible from the connected Supabase MCP account (only "Rem" and "wagoo" in org Wagoo). The publishable key the specs say is "checked in" was never present in the corpus. Created `.env.example` with the documented URL + empty key placeholder, and ignored `supabase/functions/.env` from its template (simulator defaults, no secrets). Stage 1A is local-only, so nothing blocks; cloud link/deploy waits for founder to resolve binding (use documented project, or one of the accessible orgs' projects, or a fresh Free project).
- **D-005 No Plaid credentials exist locally.** Searched repo/Downloads/Desktop; none found. Plaid work stays simulator-only per TASK-000 regardless; rotated Sandbox credentials remain a ⚑.

### Commands / state

- `git init -b main`; baseline commit `63fe87c` (specs + .gitignore).
- Docker Desktop launched (`open -a Docker`) for later `supabase start`.
- Verified `supabase/functions/.env` is git-ignored (`git check-ignore`).
- Tooling present: node 24.9.0, pnpm 10.33.0, supabase CLI 2.20.3 (update available), codex-cli 0.144.1.
