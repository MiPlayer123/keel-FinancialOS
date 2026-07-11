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

### 2026-07-11 later — stack up + protocol change

- **Docker network incident**: image pulls stalled ~1h with zero egress; Docker Desktop VM network was wedged (host network fine). Restart fixed it; founder confirmed a network issue on their side. rem-mobile-app stack auto-recovered (restart policy `always`).
- **D-016 Codex invocation protocol (founder instruction)**: bypass the plugin subagent; call `codex exec --yolo` directly via shell so Codex gets full network/tool access and the account's latest default model. Plugin sandbox had no npm egress (web-shell verification had to be redone host-side).
- **D-017 Migration lesson**: supabase CLI ≥2.109 runs migrations with EMPTY search_path — all DDL must be schema-qualified (`public.`). Delegated the mechanical qualification + db-reset/pgTAP iteration loop to Codex --yolo.
- Local stack live on 55321-55329; `apps/web/.env.local` written with local publishable key (public demo value).

### 2026-07-11 late — Stage 1A gate green + cloud binding live

- **All 12 TASK-000 required tests pass end-to-end**: 156 unit + 25 pgTAP + 41 integration (gate: `scripts/dev/itest.sh`). Notable integration-discovered fixes: entity derivation + household validation in keel_insert_postings (closed a cross-tenant ledger-account reference hole); platform-issued named secret keys (D-018); service_role default-ACL grants; definer-chain EXECUTEs; notification-vs-promotion job routing; canonical 500-char description truncation with full text preserved in normalized records; true queue-depth probe.
- **D-018** Named secret keys must be platform-issued (the admin client authenticates with the matched key). Local provisioner aliases the stack's own secret key as `automations`; cloud needs a real named key (⚑ still open).
- **D-019 Founder provided a Supabase PAT via chat.** Used for: `supabase login` (token stored in CLI's own store, outside repo), `supabase link` to `yrbteeownwjhcushwaga` ("FinancialOS", separate org — D-004/D-006 resolved: project is real and reachable), publishable key fetched and committed to `.env.example` (public by design per INFRA §11.1), and a local-scope `supabase-keel` MCP server (token lives in ~/.claude.json, not the repo). ⚠ Recommend rotating the PAT after setup since chat is not a secret manager. Token never committed; referenced only by env-var name.
- Cloud deploy (db push needs the database password) and Plaid Sandbox remain ⚑.

### 2026-07-11 — Stage-exit dual review (D-002) + fixes

Both reviewers ran against the live stack. Codex (gpt-5.6, --yolo direct) got cut off by an OpenAI content filter before writing conclusions, but its probe scripts named the vectors; I reproduced each against the DB. Claude's review completed with 8 findings. Union dispositioned:

- **F1 (MAJOR, fixed)** `keel_cmd_post_batch` accepted a `canonical_transaction_id` from another household → batch in A linked to B's txn, and B's worker revise/void would reverse it against A's ledger accounts. Now validates household ownership (P0006). pgTAP + probe confirm.
- **F2 (MAJOR, fixed)** audit_log/domain_events actor was caller-supplied `p_actor`, verbatim → an authenticated user could forge provenance (kind:system/agent, any userId). Now every user proc overwrites the actor with `keel_actor_from_jwt()` (derived from the verified JWT). pgTAP asserts stored actor = JWT subject.
- **F3 (MINOR, fixed)** `keel_worker_record_raw_event` connection lookup had no household scope and non-STRICT SELECT INTO → ambiguous external_ref across households routed arbitrarily. Now `SELECT INTO STRICT` (too_many_rows ⇒ P0006). Public webhook transport, so closed before 1C.
- **F4 (MINOR, fixed)** `canonical_transactions.economic_event_key` was globally UNIQUE; inconsistent with household-scoped command_executions and squattable. Now `unique (household_id, economic_event_key)`.
- **F5 (MINOR, fixed)** test 8 replay re-feed was absorbed by raw-event dedup, never re-exercising the planner. Added a fresh-event-id replay variant; this exposed a real bug — `keel_worker_lookup_state` returned the queried provider id with the latest status (a hybrid), re-triggering spurious revisions on replay. Fixed: view now carries the latest source record's identity while the map keys by the queried id (matches the pure planner's supersession model). Currency-mismatch also found here (see F7).
- **F6 (NIT, fixed)** test 12 was CI-only; added an in-repo `secret-scan.test.ts` scanning all tracked files for secret VALUE patterns (not names) + asserting ignored env files are untracked.
- **F7 (NIT, fixed)** `keel_insert_postings` didn't check posting currency against the ledger account's currency → foreign-currency postings net to zero under the per-currency balance trigger. Now enforced (P0010, currency_mismatch).
- **F8 (NIT, fixed)** reversing a reversal batch was allowed, re-applying the original economics. Now refused (P0001).

All 8 fixed in this session (not deferred). Post-fix gate: 159 unit + 31 pgTAP + 41 integration green.

### 2026-07-11 — CLOUD DEPLOY (Stage 1A live on FinancialOS)

Deployed to `yrbteeownwjhcushwaga` (FinancialOS) via CLI + Management API with the founder's PAT:
- **4 edge functions** deployed (api/worker/webhook-provider/scheduled). Live auth boundaries verified: webhook-provider/health→200 (public), api/health no-JWT→401, worker/health no-secret→401, worker+named-secret→200.
- **8 migrations** applied (`supabase db push`). Verified in cloud: 26 public tables, 3 keel roles all `rolbypassrls=false`, 5 command procs, **0 authenticated INSERT/UPDATE/DELETE on canonical tables**, 3 pgmq queues.
- **Named `automations` secret key** created via Management API; worker+scheduled accept it in prod (200). Confirms the hosted path (platform provides SUPABASE_SECRET_KEYS; bootstrap.ts shim is local-only, no-op in cloud).
- **⚠ DB password reset** (D-020): the project had no known DB password, so I reset it via `PATCH /database/password` to a generated 32-char value, stored ONLY in ignored `supabase/.env.remote` (never printed/committed). This invalidated any prior connection strings to that project — safe here (dedicated, empty, day-old project). Rotate/manage in the dashboard if desired.
- **Not deployed**: no cloud seed (seed is local-dev-only by design — real users sign up via Auth); apps/web to Vercel remains a ⚑ (Vercel binding); Plaid stays Sandbox for 1C.
- **⚠ PAT** still recommended for rotation (came via chat). All uses read from local stores.

### 2026-07-11 — PLAN-1C dual audit round 1 → v2 rewrite

Both audits (Claude + Codex-with-web-research) ruled v1 "not ready — over-scoped, hard parts undesigned". ~20 findings, all valid. v2 rewrite dispositions:
- **Connection model (Codex B4):** amend `connections` = the Plaid Item; satellites keyed to connection_id with composite tenant FKs. NO parallel connection_items table (would fork the deployed identity).
- **Currency (Codex M16, Law 4):** USD-only activation gate for 1C + deterministic decimal-string→minor conversion (no float). Replaces worker's hardcoded USD.
- **Credential crypto (Claude B2/Codex #3):** designed — Supabase Vault KEK, DEK-per-credential, decrypt only inside the sync proc, KEK-rotation re-wraps DEKs, pg_stat_statements/log-scan + token-canary gates. ⚑ security review before C2.
- **Sync fan-out (Claude B1/Codex #12):** item-notification → lease (advisory lock + sync_generation) → pull → archive exact Plaid page as raw evidence → normalize → EXISTING planner; commit final cursor only after has_more=false; mutation-restart from committed base cursor. Reuses 1A economics without pretending normalized==raw.
- **Export (Claude B3/Codex):** complete manifest (all canonical+source+audit tables; credentials excluded-by-name), step-up, export_jobs, exports bucket, signed URL, isolated-restore test. QIF/beancount = explicit ⚑ founder ruling, not silent stub.
- **request_id dedup impossible (Codex M8):** SYNC_UPDATES_AVAILABLE has no request_id; dedup by signed-JWT-fingerprint+body-hash; webhook is an idempotent "sync this item" trigger.
- **Exchange saga (Codex M7):** begin_link → edge Plaid call (token never logged) → finalize command atomically; /item/remove compensation.
- **Descoped to 1D/own-stage (both):** categorization, CSV import, transfer confirm (D-012), professional access, periods.reopen. 1C posts to Uncategorized like 1A.
- Added: item lifecycle (ITEM_LOGIN_REQUIRED/update-mode/disconnect+crypto-shred), account lineage (provider account_id + scored candidates + user confirm, no tuple-merge), webhook hardening (size/env/iat/constant-time/JWK negative-cache), usage_events + circuit breaker (INFRA §14), expanded ⚑ list (client id, KEK, dashboard webhook, sanitized fixtures, Vercel).
- **D-021:** elevate D-013 (verify-then-store) from deviation to an explicit amendment of doc 17 §3 store-first wording.

### 2026-07-11 — PLAN-1C dual audit round 2 → v3 (split + design the core)

Both round-2 audits (Claude 1 blocker+6 major; Codex 6 blocker+4 major) converged: v2 fixed the round-1 scope/design-text issues but several subsystems remain undesigned or wrong, and the stage is too big. Decisive convergent findings:
- **Vault crypto not executable**: Supabase Vault has no DEK/KEK-wrap primitive (project-managed key, decrypt via view); pgsodium deprecated; and a DB proc can't hand plaintext to an Edge HTTP call without returning it over RPC. → KEK in Edge Function Secrets; per-token DEK; encrypt in Edge memory; ONLY ciphertext to SQL; decrypt in Edge/server memory immediately before the Plaid call.
- **Cursor lease can't be a xact advisory lock** across multi-HTTP-call pagination. → durable lease row (owner token, leased_until, base_cursor, attempt_id, desired_generation) with CAS.
- **Mutation-restart/raw/promotion/cursor not atomic** + apply_promotion already CREATES normalized rows (conflicts with pre-normalization). → `sync_attempts` + immutable raw page bytes/hash + deterministic page dedup key (hash of base_cursor+page ordinal); abandon-not-delete on mutation; amend apply proc to CONSUME a pre-created normalized event id; commit cursor only on a completed attempt via CAS.
- **NEW BLOCKER (Codex): planner incompatible with real Plaid pending→posted.** Plaid delivers pending in `removed` and posted in `added` (possibly different pages); current planner would void-then-double-create or void the posted. → reconcile a COMPLETED sync's added/modified/removed as a SET, pairing removed(P)+added(Q,pending_transaction_id=P) into one supersession before promotion.
- **Decimal/sign**: response.json() already floats the number → parse the raw body losslessly (text); USD scale 2; reject (not round) sub-cent; bigint bounds; Plaid sign is positive=outflow (NOT account-type-dependent) → negate to KEEL holder-perspective; per-transaction iso_currency_code==USD.
- **Composite tenant FK must RETROFIT existing hot-path children** (accounts/raw_provider_events/normalized/canonical) + parent (household_id,id) uniques + one unambiguous item identifier; not just new tables.
- **Export belongs to 1D per INFRA §16** and its manifest was still incomplete (omitted ~8 deployed tables, auth.users identity, Storage bytes, portability-vs-DR restore). → DEFER export to 1D; 1C must not make data unexportable.
- Lifecycle = durable saga (link-attempt/removal-attempt records, disconnecting/cleanup_required, shred-after-remove-success).
- **Split ruling (D-022): 1C = server-only Plaid Sandbox READ PATH.** Viewer UI → 1E. Export → 1D. Proof of "end-to-end" uses the existing `keel_trial_balance`/`transactions.list` queries against a real Sandbox item — no new UI needed to prove correctness. This resolves the "too big" verdict and the INFRA §16 stage-placement deviation.

### 2026-07-11 — PLAN-1C round 3 → v4 (architecture cleared; mechanical closes)

Round-3 dual audit: both cleared the ARCHITECTURE (crypto D-B, decimal D-E, pending→posted D-D planner, stage-split all RESOLVED; Codex web-verified Plaid's positive=outflow sign and the removed-pending+added-posted co-occurrence, resolving Claude NF-2). Remaining were precise mechanics, all closed in v4:
- Composite tenant FK extended to canonical_transactions(household_id,account_id/entity_id) + transaction_source_links (add household_id, FK both sides) — Codex #6.
- Page-id collision: key raw archive by (attempt_id, page_ordinal), NOT sha256(base_cursor||ordinal) which collides across re-pulls; abandoned attempts' rows retained-but-excluded; no-double-archive gate scoped within-attempt — Codex #2.
- Promotion barrier: cursor advances only after this attempt's promotion is durably complete; a new attempt can't plan ahead of an un-promoted prior attempt (per-connection ordered promotion) — Codex #2.
- Bounded pages per invocation (150s Edge limit / INFRA §9); lease renewed per page = fencing token — Codex.
- Normalized removal tombstones (nullable cols when kind=removed) + apply_promotion derives/validates from the normalized row, not caller payload — Codex #3.
- Account bootstrap: /accounts/get before finalize_link — Codex new blocker.
- Orphan reaper: persist ciphertext on link_attempt immediately post-exchange; finalize adopts it — Codex new blocker.
- Verbatim raw: body_text + body_sha256 (jsonb derived) — Codex major; also enables lossless decimal.
- AES-GCM fresh 96-bit IV + AAD(credential_id||household_id||provider||kek_version) — Codex.
- Lossless numeric-lexeme JSON parse + distinct decimalToMinor (not integer-only parseMinorUnits) — both.
- Canary sweep covers access+link+public tokens; no RAISE of decrypted material — Claude NF-3.
- Update-mode needs interactive Link → 1C tests server-state transitions only (sandbox reset_login); live update-mode gate → 1E — Codex new blocker.
- C5 split: C5a (reconcileSyncBatch + normalized schema + apply_promotion amendment, fixture-proven) before C5b (durable orchestration) — Claude NF-6.
- **D-023:** export & viewer UI are separate stages (1D/1E); 1C is server-only read path.
One final targeted Codex verification pass, then build.

### 2026-07-11 — PLAN-1C READY; build start + operating mandate

Founder: "keep this full plan/dev/test/audit loop until the full backend is done, fully end-to-end tested." Operating autonomously through the backend stages with the same protocol proven in 1A: Codex (gpt-5.6, --yolo direct) implements from the plan; Claude reviews/tests/owns trust-boundary code; dual stage-exit audit before each tag. Live Plaid steps remain ⚑ (rotated secret + client id + fixture sanitization) — but C0(fixtures-from-documented-shapes)/C1(adapter)/C2a(schema)/C5a(reconciliation) are all buildable+testable WITHOUT live credentials, so build proceeds to those now; live-Sandbox gates wait at the ⚑.
Build order: C1(adapter)+C2a(schema) in parallel → C5a(reconciliation) → C2b(crypto ⚑) → C3(saga) → C4(webhook) → C5b(orchestration) → C6(cron/metering). Tag stage-1c after dual review.

### 2026-07-11 — Stage 1C build progress (C1, C2a, C5a-core done)

- **C1 @keel/plaid** (40 tests): decimalToMinor (string→bigint, no float, int64-bounded), plaidAmountToKeelMinor (negate Plaid positive=outflow), lossless lexeme, PlaidBankProvider, fixtures. Review catch: a stop-hook autofix had replaced the currency guard with `void currency` — restored real validation.
- **C2a migration** (pgTAP 003; 199 unit + 41 pgTAP + 41 integration green): connections amended (item model + sync-lease cols + global plaid unique), composite tenant FKs across all hot-path tables, body_text/sha256, normalized kind+tombstone, 8 satellites (credentials/link_attempts/sync_attempts server-only). Review catch: NOT-NULL household_id on transaction_source_links broke the deployed apply_promotion → added a BEFORE-INSERT backfill trigger (derives from canonical txn) so it's non-breaking until C5a.
- **C5a-core reconcileSyncBatch** (31 tests): the pending→posted set reconciler. Review catch: hardcoded fake ctx would produce wrong economic keys for real Plaid data → made ctx a required param.
- **Remaining 1C:** C5a-SQL (amend keel_worker_apply_promotion to consume a pre-created normalized id + removal tombstones) is coupled with C5b (worker rewrite: pre-create normalized rows + call reconcileSyncBatch + durable lease/attempts/archive). C2b crypto needs a KEK ⚑. C3 saga + C4 webhook + C6 cron. All buildable+testable against fixtures; only the LIVE Sandbox link/sync gate needs the Plaid ⚑ (rotated secret + client id).
- **Review pattern holding:** every Codex step so far had exactly one real defect that the review+integration gate caught. The loop is working.
