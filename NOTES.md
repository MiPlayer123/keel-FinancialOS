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

- **D-006 Cloud binding resolved by founder (2026-07-10).** Use the spec-documented project `yrbteeownwjhcushwaga` (lives in a separate Supabase account, not the connected MCP account). Consequences: cloud operations go through `supabase link`/CLI with founder-supplied DB password (⚑), not the Supabase MCP; publishable key to be pasted into `.env.example` by founder; MCP stays useful for docs search only. Local development unaffected.
- **D-007 Codex as primary implementation executor (founder instruction).** Parallel Codex (GPT-5.6) agents implement well-specified leaf tasks; Claude orchestrates, specs, reviews, and owns architecture-sensitive code. Fallback: Claude subagents or direct implementation if Codex unavailable.
- **D-008 Plaid Sandbox testing** enters at Stage 1C/M2 after simulator gates pass (TASK-000 sequencing), needs rotated credentials (⚑). Founder confirmed intent to test Plaid API later.

### Commands / state

- `git init -b main`; baseline commit `63fe87c` (specs + .gitignore).
- Docker Desktop launched (`open -a Docker`) for later `supabase start`.
- Verified `supabase/functions/.env` is git-ignored (`git check-ignore`).
- Tooling present: node 24.9.0, pnpm 10.33.0, supabase CLI 2.20.3 (update available), codex-cli 0.144.1.

## 2026-07-11 — Session 1 continued (Stage 1A build)

### Plan audits (D-002 protocol executed)

- **Claude adversarial audit**: 14 findings (1 blocker: write-path ambiguity). All dispositioned in PLAN.md §3.5. Blocker resolved: SECURITY DEFINER command procs owned by non-BYPASSRLS `keel_api`.
- **Codex audit (gpt-5.6-sol, xhigh)**: 14 findings (5 blockers). All dispositioned in PLAN.md §3.6. Highest-value catch: **idempotency registry was globally keyed — cross-household key collision could leak another tenant's stored command result**. Fixed: `command_executions` PK is now `(household_id, economic_event_key)`; `keel_idempotency_check` takes the household id.
- First Codex attempt stalled: `-m gpt-5.6-codex` is not available on this account. Correct usage: NO model flag; `~/.codex/config.toml` already defaults to `gpt-5.6-sol` + xhigh.

### Deviations (with spec cites)

- **D-009** pgmq queue names use underscores (`sync_events`, `import_batches`, `transaction_enrichment`) vs INFRA §8 hyphenated labels — pgmq identifier rules.
- **D-010** `authenticated` holds EXECUTE on `keel_cmd_*` procs, so a direct PostgREST `.rpc()` bypasses the Edge Function *transport* while hitting the identical authorized contract (procs re-derive actor from `auth.uid()` + memberships; search_path pinned; revoked from public/anon). Strict INFRA §5 reading says "runs inside an Edge Function"; ruled acceptable because Law 7's substance is "no privileged side doors" and this path carries zero extra privilege. Revisit at security-review ⚑.
- **D-011** `periods.reopen` typed command deferred to Stage 1B (needs step-up auth per INFRA §7); schema + lock-guard honor `reopened_at` now.
- **D-012** transfer_links schema in 1A; confirm flow + income/spend exclusion property test in 1D with reports.
- **D-013** Webhook ordering: verify-then-store adopted (CLAUDE.md "verification before ingestion" wins over doc 17 "stores the raw body first"); rejected payloads quarantined in `webhook_rejections`.
- **D-014** CLAUDE.md cites "BC-v2.1 §9.1" but the included BC-v2.1 ends at §7 — stale cross-reference; commit messages cite law numbers instead.
- **D-015** keel local stack moved to ports 55320-55329 (`supabase/config.toml`) because the rem-mobile-app stack occupies 54xxx defaults.

### Codex implementation fleet (D-007 executed)

- packages/authz: Codex-built, 35 tests green, no deviations.
- packages/test-fixtures: Codex-built, 25 tests green; 2 recorded deviations (no '+' prefix on amounts — contracts schema; 6 provider records in baseline because the card-payment pair needs a record per account).
- packages/ledger: Codex agent in flight.
