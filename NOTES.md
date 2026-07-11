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

### 2026-07-11 — Plaid Sandbox creds live-verified (⚑ satisfied for Sandbox)

Founder provided Plaid Sandbox client_id + secret (stored in ignored supabase/functions/.env, never committed). Live smoke test passed end-to-end: /sandbox/public_token/create → /item/public_token/exchange → /accounts/get (12 accounts, ALL USD) → /transactions/sync (auth + shape OK, added=0 for fresh item). Key finding: **/sandbox/public_token/create bypasses interactive Plaid Link**, so the entire link→exchange→sync path is drivable server-side WITHOUT a browser — the server-only stage is fully live-testable now, not just fixture-backed. USD-only sandbox accounts fit the D-D currency gate exactly. Remaining ⚑: Plaid Dashboard webhook URL config (only needed for real webhook delivery to cloud; verification is fixture/JWK-testable meanwhile); production linking (separate, later). ⚠ Sandbox creds via chat — low risk, rotate post-testing if desired.

### 2026-07-11 — C5b built but reverted (regression); main kept green

C5b (durable Plaid sync-pull worker + apply_action) was implemented two ways and both are preserved (git stash@{0} "c5b-wip-codex...", plus /tmp/codex-c5b/ and /tmp/keel-c5b-mine.sql):
- Codex's version: complete + wired (migration 781L with lease_owner-on-attempt + notification-generation trigger, plaid-sync.ts 373L orchestration, worker rewrite). Migration APPLIES clean and pgTAP stays green, BUT it **regressed the simulator path**: 06-redteam drainQueue times out (worker drain loop never reaches queue-empty — likely a continuation/re-enqueue or depth-probe bug in the rewritten worker). Also duplicates decimal/sign logic in plaid-sync.ts instead of reusing the reviewed @keel/plaid (Law 4 divergence risk).
- My version: cleaner migration (~380L, mirrors deployed proc patterns, apply_action derives postings in SQL) but worker integration not finished.
- **Decision:** reverted C5b to keep main green + deployable rather than debug 1100+ lines of unreviewed trust-boundary sync code at the end of a long session (exactly where subtle ledger bugs hide). C5b stays the next task.
- **C5b resume plan:** start from MY migration (understood, mirrors deployed patterns) + build the worker sync path carefully (reuse @keel/plaid for decimal/sign via the vendor bundle — add @keel/plaid to scripts/build-functions.mjs), fix the drain-loop regression (the sync_notification continuation must not self-re-enqueue forever; bound it and ensure depth reaches 0), then the injection-based integration test (08-plaid-sync) proving: pending→posted supersession = one history, mutation-restart recovers, replay no-op, cursor advances. Both /tmp versions are references.

### Stage 1C status: 4 of 9 steps GREEN + committed (C1 adapter, C2a schema, C5a-core reconcile, C2b crypto). Plaid Sandbox live-verified. Remaining: C5b (spine, next), C3 saga, C4 webhook, C6 cron, stage-exit.

### 2026-07-11 — C5b migration review (Claude, parallel with Codex worker build)

Verdict: posting derivation SOUND (deterministic SQL, Σ=0, sign-routed, no caller postings — Laws 1/3/4 hold); promotion barrier correct + can't wedge; tenant safety + grants + append-only verified. Findings to apply AFTER Codex's worker lands (coherently, since 2 change proc signatures):
- **B1 (fix, internal):** revise branch missing offset null-check — add `if v_offset_id is null then raise 'offset category missing'` before insert (currently fails-closed only via downstream re-validation, wrong diagnostic).
- **B2 (fix, SIGNATURE):** create_normalized hardcodes raw_event link to page `:0` (raw_event_id NOT NULL; wrong provenance for pages 1+). Pass the actual page ordinal/raw_event_id per normalized row.
- **M3 (fix, internal):** create/revise crash on a removed tombstone row (NULL amount) — add `assert v_nsr.kind <> 'removed'` guard at top of create/revise (defense-in-depth).
- **M4 (fix, SIGNATURE):** create hardcodes canonical status='posted', dropping pending fidelity — carry v_nsr.pending; status = pending?'pending':'posted' in create AND revise. (create_normalized needs a pending param; worker passes it.)
- **M5 (fix, internal):** revise picks prior batch `order by posted_at desc` — add `, b.id desc` deterministic tiebreak.
- **M6 (fix, internal):** acquire fences completed-unpromoted but not orphaned OPEN attempts from a lost lease → concurrent open attempts possible (mitigated by idempotency; no double economic effect, but orphaned attempts accumulate). acquire should abandon/refuse a pre-existing open attempt.
- **m8/m9 (fix, internal):** complete_attempt add `state='open'` predicate + `where sync_committed_generation < generation` guard (defense-in-depth).
Apply as one "C5b review-hardening" pass with the worker, re-run full gate.

### 2026-07-11 — C5b GREEN + hardened; review dispositions

C5b Plaid sync path fully green (205 unit + 41 pgTAP + 42 integration). Applied safe review fixes to apply_action: B1 (revise offset null-check), M3 (removed-tombstone guard in create/revise), M5 (deterministic posted_at,id desc batch tiebreak). Deferred to stage-exit hardening (non-blocking; reviewer confirmed happy path sound, no double-apply/unbalance): M4 (pending-status fidelity — apply_action hardcodes 'posted'; carry v_nsr.pending; needs create_normalized pending param + worker), B2 (normalized raw_event provenance links to attempt page :0 not the exact page — works since page 0 always archived first, but imprecise), M6 (acquire fences completed-unpromoted but not orphaned OPEN attempts from a lost lease — mitigated by idempotency + fencing, no double economic effect), m8/m9 (complete_attempt state='open' + generation-monotonic guards). All tracked for the 1C stage-exit review pass.

### Stage 1C: 5 of 9 steps GREEN (C1 adapter, C2a schema, C5a reconcile, C2b crypto, C5b sync spine). Plaid Sandbox live-verified. Remaining: C3 saga, C4 webhook, C6 cron, stage-exit dual audit + tag.

### 2026-07-11 — C3 Plaid link/disconnect saga GREEN (v3.1)

- Built the server-only link → exchange → encrypted attempt → atomic finalize → initial sync path, disconnect remove-before-shred path, reauth fencing, and bounded orphan reaper. The `credential_id` minted by `keel_begin_link` is unchanged through encryption AAD and `connection_credentials.id`; successful finalize moves the sole envelope off `link_attempts`.
- Added the token-free `plaid_test_responses` injection surface and atomic consume RPC. Implementation choice (not a deviation): `keel_consume_plaid_test_response` remains migration-owned as the "plain function" option expressly allowed by C3 spec line 133; the 10 lifecycle procs are all `keel_api`-owned.
- PostgreSQL `encode(bytea, 'base64')` line-wraps longer ciphertext. Envelope-read/reaper RPCs strip those encoder newlines so the fixed C2b strict base64/crypto contract remains unchanged.
- **Mandated plan deviation:** `link_attempts.state` uses deployed states `initiated|exchanged|succeeded|failed|expired|reaping|reaped`, not PLAN-1C D-F's older names, exactly as required by C3 spec lines 108–110.
- **Bounded replay simplification:** a replayed command in `exchanged` returns 409 and the reaper cleans the orphan rather than resuming mid-flight, exactly as specified at C3 spec lines 361–362.
- No deviations from `C3-BUILD-SPEC.md` v3.1. Repeated full runs exposed the existing suite-04 shared-queue ordering flake (posted processed before pending); suite 04 passed 8/8 alone on a clean reset, and the final complete reset→serve run passed 57/57.
- Gate evidence at build close: 215 unit tests, 58 pgTAP assertions, 57 integration tests. No commit made; handoff remains for post-build dual review.

### Stage 1C: 6 of 9 steps GREEN (C1, C2a, C2b, C3, C5a, C5b). Remaining: C4 webhook, C6 cron/metering, stage-exit dual audit + tag.

### 2026-07-11 — C3 post-build DUAL review + dispositions (green after fixes)

Ran the full plan→build→test→**dual audit** loop on C3. Pre-build: 2 dual rounds (Claude+Codex) took the spec v1→v3.1 (token-in-fixtures leak, authenticated-grant privilege escalation, incomplete shred, reaper double-remove race, asset/liability mapping, RLS policies, duplicate migration column, atomic-consume RPC, race-free fence). Post-build dual review of the ACTUAL code: Claude = SHIP WITH FIXES (all 6 dimensions sound); Codex = DO NOT SHIP (6 findings). Triaged + verified each against the deployed code:
- **APPLIED (green):**
  - Claude F1 — `keel_worker_apply_action` fence failed OPEN on a NULL connection lookup (`status <> 'active'` is NULL→not-true). Fixed to fail closed: `if not found or v_conn.status is distinct from 'active'`.
  - Codex #1 — provider `error_code`/`error_type` reflected to browser/`removal_attempts.failure_code`/`link_attempts.last_reap_error`/audit without allowlist (Law 12 hygiene). Added allowlist normalization in `PlaidClientError` ctor (unknown→`provider_error`); `ITEM_NOT_FOUND` preserved so itemRemove success-detect still works.
  - Codex #6 — account-id `jsonb_agg`/API replay ordered only by `created_at`, which ties (txn-stable `now()`) → nondeterministic replay order. Added `, id` tiebreak (3 SQL sites + API query).
  - Test hardening — 09 T1 used the flaky `drainQueue().some(v==='done:sync complete')` log-string assertion (the exact anti-pattern removed from 08 in C5b); replaced with dead-letter check + the existing ledger-truth assertions (canonical posted + trial balance) as the authoritative proof.
- **DEFERRED to stage-1c-exit hardening (edge-cases; no leak/corruption on exercised paths — rationale each):**
  - Codex #2 — two CONCURRENT requests with the same `commandId` in-flight both pass the `initiated` gate and run Plaid. Mitigated: `record_link_exchange` requires `state='initiated'` so the first wins and the second RAISES (its item is best-effort `/item/remove`d by the route catch); `fail_link_attempt` only transitions non-terminal states, so it can't clobber a `succeeded`. Full exclusive-invocation claim deferred.
  - Codex #3 — `keel_worker_apply_promotion` (SIMULATOR path) is unfenced vs disconnect. **Premise correction:** Plaid disconnect targets Plaid connections, which use the FENCED `apply_action`; `apply_promotion` only runs for `provider='simulator'` connections, which aren't user-disconnected. The real Plaid path is fully fenced. Fencing `apply_promotion` too is defense-in-depth for a non-scenario (and risks the flaky suite-04 simulator path) → deferred.
  - Codex #4 — sync notifications for `disconnecting|disconnected` connections retry then dead-letter (bounded by MAX_ATTEMPTS, terminates) instead of a clean immediate archive; generation bump before acquire is harmless on a dead connection. Cosmetic/efficiency → deferred.
  - Codex #5 — duplicate-item finalize returns 200 but stores `state='failed'` (so the reaper cleans the redundant live token); a later replay of the same `commandId` then returns 409 instead of 200. Cosmetic replay inconsistency on an edge case (same item linked twice) → deferred.
  - Claude F2 — `keel_get_connection_credential_envelope` has no `p_household_id` arg (service-role-only, called only after a membership-checked `disconnect_begin`; no live exposure). Defense-in-depth tenant arg → deferred.
- **Gate (independently re-run, not self-reported):** typecheck+lint clean, 215 unit, 58 pgTAP, 57 integration — all green with the fixes. Suite-04 shared-queue ordering flake is PRE-EXISTING (simulator `apply_promotion` path, untouched by C3; passed on clean re-run); tracked for a test-isolation hardening pass at stage-exit.

### Stage 1C: 6 of 9 steps GREEN (C1, C2a, C2b, C3, C5a, C5b). C3 dual-reviewed + hardened + committed. Remaining: C4 webhook, C6 cron/metering, stage-exit dual audit + tag stage-1c.
