# KEEL Stage 1C Plan (v2) — Plaid Sandbox Read Path, End-to-End & Exportable

**Status:** v2, rewritten after dual audit (Claude + Codex, 2026-07-11). v1 was judged "not ready — over-scoped and under-designed"; this version narrows scope to one thing done correctly and designs the five hard subsystems the audits flagged.
**Builds on:** Stage 1A (tagged `stage-1a`, deployed to FinancialOS). Reuses the pure planner, the SECURITY DEFINER command/worker procs, verified-webhook ordering, and the RLS/grant posture.
**Controlling specs:** INFRA.md §4/§5/§8/§10/§14 → docs/BC-v2.1.md §3/§6 → docs/17 §3 (Plaid) → CLAUDE.md Laws 1,2,4,5,6,9,12.

## 0. Thesis (narrowed)

> A signed-in user links a Plaid **Sandbox** item, KEEL pulls its **USD** transactions through a correct sync-fan-out onto the existing deterministic ledger, sees accounts + transactions + postings + provenance + connection health in a thin UI, and can **export their full data** (Law 6). Access tokens are envelope-encrypted and never leave the server. No trust claims beyond Sandbox.

**Explicitly NOT this stage** (audit M5/§14; cite INFRA §16 which puts these in 1D): AI or rules categorization, transfer confirm/exclusion (D-012→1D), professional access (not D-014; that's a stale-cite note), CSV/QIF import (moved to its own stage 1C-CSV), recurring/reconciliation/receipts, multi-currency, `periods.reopen` (1B debt), Vercel deploy (⚑). Transactions post to the Uncategorized offset exactly as Stage 1A already does.

## 1. Blocking design decisions (resolved before any build)

### D-A. Connection model = amend `connections`, do NOT add a parallel Item table (Codex B4)
Stage 1A already makes `connections.external_ref` the provider item identifier; `accounts`, `raw_provider_events`, `sync_checkpoints`, and the webhook/worker procs all key off `connections.id`/`external_ref`. **Ruling:** `connections` **is** the Plaid Item. Stage 1C *amends* it (adds `institution_id`, `plaid_item_id` = external_ref alias, `consent_expires_at`, `last_successful_sync_at`, `cursor` moves to the existing `sync_checkpoints`) and adds **satellite** tables keyed by `connection_id`: `connection_credentials`, `connection_health_events`, `account_lineage`, `balance_snapshots`. No `connection_items`. Every new FK carries a **composite tenant constraint** (`(household_id, connection_id)` references) so a child can't point at another household's parent (Codex M5).

### D-B. Credential crypto = Supabase Vault, DEK-per-credential, decrypt only in the sync command (Claude B2 / Codex #3)
Specs only say "envelope-encrypted" (INFRA §11.1, doc 10 §7) — no KEK design exists, so we define one:
- Use **Supabase Vault** (`vault.create_secret`/`vault.decrypted_secrets`) as the KEK store; Vault holds the root key outside the table, injected by the platform, never a proc literal argument (avoids `pg_stat_statements` leakage — Codex #3b).
- Each access token gets a **per-credential DEK**; the ciphertext + wrapped-DEK live in `connection_credentials`; the DEK is wrapped by the Vault-managed KEK.
- **Decryption happens only inside `keel_worker_sync_connection`** (the SECURITY DEFINER proc that then hands the plaintext to the Plaid pull in the same invocation). `keel_readonly`, exports, queries, and the browser can never reach plaintext. No decrypt path is granted to `authenticated`/`anon`.
- **KEK rotation** = re-wrap DEKs (not re-encrypt tokens); a `credentials.rotate_kek` operator command re-wraps all rows.
- Gate additions: a `pg_stat_statements` + structured-log scan asserting no token/secret literal appears; unique **token canaries** inspected across every response, log, dead-letter, audit/domain/health row, Storage object, export, and DB column (Codex M17).
- **⚑ This crypto design is itself a security-review checkpoint before C2 ships**, and KEK generation/provisioning is a human step.

### D-C. Sync = item-notification → pull → archive-raw → normalize → existing planner, with a cursor lease (Claude B1 / Codex #6, #12)
The webhook records an **item-level** `SYNC_UPDATES_AVAILABLE` notification (not a `ProviderSyncEvent`). The `sync_notification` worker job (a no-op stub in 1A) becomes:
1. **Lease** the item: `pg_advisory_xact_lock(hashtext(connection_id))` + a `sync_generation` guard so cron/webhook/manual syncs cannot race or double-pull (Codex #6).
2. Read the **committed base cursor** from `sync_checkpoints`.
3. Loop `/transactions/sync`: for each page, **archive the exact Plaid response page** as an immutable `raw_provider_events` row (verbatim provider payload — this is the source evidence, Law 5 / Codex #12), *plus* create provider-neutral **normalized child events** (`ProviderSyncEvent` shape) in `normalized_source_records` referencing that raw archive. Only normalized events feed the existing planner/`apply_promotion` — the 1A pipeline is reused for economics, not for parsing raw bodies.
4. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` (HTTP 400): **discard the attempt**, restart from the committed base cursor (Codex #6, Plaid-verified).
5. Commit the **final cursor only after `has_more=false`**, in the same transaction as the last page's raw+normalized rows. A crash mid-fan-out safely re-pulls (raw insert idempotent on `(connection_id, provider, provider_event_id)`).
6. Coalesce duplicate notifications (a second notification while a lease is held is dropped/merged).

### D-D. Currency = USD-only activation gate + deterministic decimal→minor conversion, no float (Codex M16 / Law 4)
Plaid returns `amount` as a decimal major-unit **number** and an `iso_currency_code` that may be null/unofficial. **Ruling for 1C:** activate only accounts whose `iso_currency_code = 'USD'`; reject/skip others at account activation with a recorded reason (no silent drop). Conversion parses the decimal as a **string** (`"12.34" → 1234n` by digit manipulation against the currency exponent, never `parseFloat`/`Number`); a property test covers rounding, sign per account type (depository vs credit), missing minor digits, and overflow. The worker's hardcoded `'USD'` (worker/index.ts:61,160) is replaced by the account's validated currency.

### D-E. Export = complete manifest, step-up, queued job, isolated restore; QIF/beancount is a ⚑ ruling (Claude B3 / Codex #3-export)
`admin.export_all` (Law 6, BC gate 13) exports an **allowlisted manifest of every canonical + source + provenance table**: households/memberships/entities, connections/accounts/account_owners/ledger_accounts, raw_provider_events + normalized_source_records + transaction_source_links (source preservation), canonical_transactions/journal_batches/journal_postings/journal_revisions/period_locks, audit_log/domain_events, balance_snapshots/account_lineage/connection_health_events. `connection_credentials` is **excluded by design and named as such** in the manifest (so restore-read doesn't fail on a "missing" table). Export requires **step-up auth** (INFRA §7), runs as a resumable `export_jobs` batch, writes to the private `exports` Storage bucket, returns a **short-lived signed URL**, and is itself audited. A test restores the export into an **isolated database** and reproduces cited records.
**⚑ Founder ruling needed:** Law 6 lists CSV/JSON/QIF/beancount. This stage ships **CSV + JSON complete**; QIF/beancount are deferred to an export-formats step. Either the founder accepts that deferral (recorded with the Law 6 cite) or QIF/beancount join this stage. **No silent stubbing of a Law.**

## 2. Item lifecycle (Codex M10, Claude M2)

Full transitions with trigger, auth, audit, compensation:
- `linking →(exchange finalize) active`
- `active →(sync/error webhook: ITEM_LOGIN_REQUIRED | ITEM_ERROR) reauth_required` + `connection_health_events` row; **guard: no raw/canonical writes while `reauth_required`**, checked both when a worker claims a job and immediately before any write.
- `reauth_required →(update-mode Link relink + finalize) active` — update mode reuses the existing token; a completion command returns the item to active and triggers a catch-up sync.
- `active | reauth_required →(user) disconnected` → calls Plaid `/item/remove`, **crypto-shreds the credential** (drop DEK), invalidates queued sync jobs, and emits the required **export prompt** (INFRA §7).
- `PENDING_EXPIRATION`/`PENDING_DISCONNECT`/`LOGIN_REPAIRED`: handled as health events that set/clear `reauth_required`; if update-mode isn't finished this stage, `reauth_required` is **terminal-until-manual-relink** and the plan says so.

## 3. Account lineage (Codex M11)

Within the **same item**, map by the provider `account_id` (stable). Across a **new item** (relink/replacement card), never auto-merge on `(institution, mask, type)` — masks are null/duplicable. Generate **scored candidates** (institution, subtype, mask, name, currency, prior balance, overlapping transactions) and **require user confirmation** when identity isn't uniquely proven; record reason, evidence, effective dates, actor, old/new account ids in `account_lineage`. **Known 1D gap (documented, not silently):** the economic key embeds `connectionExternalRef`, so transactions re-imported under a new item id get new keys — cross-item transaction de-duplication is deferred to 1D.

## 4. Webhook hardening (Codex M8, M9)

Reuse 1A verify-then-store, and add: reject bodies over a size cap and non-`sandbox` `environment`; validate `alg=ES256`, `kid`, recent non-future `iat`, exact body hash with **constant-time** compare; **JWK cache keyed by `kid`** with bounded TTL, fetch-through on miss, **negative-cache + rate-limit unknown kids**; distinguish **invalid signature (401, quarantine)** from **transient JWK-fetch outage (5xx, retryable, no quarantine)**. Dedup delivery by a **signed-JWT-fingerprint + body-hash** (NOT `request_id`, which isn't in the payload); treat the webhook as an idempotent "sync this item" trigger, so a fresh signed delivery with an identical body can still enqueue after the prior job completes. **Amend the controlling contract:** elevate D-013 (verify-then-store) from a NOTES deviation to an explicit amendment of doc 17 §3's "store-first" wording (Codex M9 / Claude M1).

## 5. Metering & operational controls (Codex M15 / INFRA §14)

Add `usage_events` (one row per Plaid API call: kind, latency, error code, `request_id` for diagnostics, **no secrets**) and a **per-item sync-rate circuit breaker** (protects against webhook storms). Add minimal `providers`/`institutions` (via `/institutions/get_by_id`), immutable `balance_snapshots` (as-of + source), and `connections.last_successful_sync_at` freshness. Reads surface freshness/completeness (already partly in the 1A read-surface envelope).

## 6. Work breakdown (each = one commit, tests green; Codex-implemented under Claude review)

- **C0 — Recorded Sandbox fixtures + adapter contract**: capture sanitized real Plaid Sandbox responses (link, exchange, `/transactions/sync` pages incl. a mutation-restart 400, pending→posted, removed, initial empty, `ITEM_LOGIN_REQUIRED`) into fixtures; **⚑ human approves sanitization**. Define `PlaidBankProvider` against `BankProviderAdapter`.
- **C1 — Plaid adapter** (`packages/providers/plaid`): typed calls, decimal→minor conversion (D-D), JWK verification helper; unit-tested against C0 fixtures + an injected mutation-restart test (Claude m5). No live calls in CI.
- **C2 — Connection amendment + satellites + credential crypto** (D-A, D-B): migrations amend `connections`, add credentials/health/lineage/balance_snapshots/usage_events with composite tenant FKs; Vault-based DEK/KEK; **⚑ security review of crypto before merge**.
- **C3 — Link saga** (Codex M7): `connections.begin_link` (audited attempt) → edge function calls Plaid (public token never logged) → `connections.finalize_link` SECURITY DEFINER command atomically stores ciphertext + creates item/accounts (USD gate) + audits + enqueues initial sync; compensation `/item/remove` on irrecoverable finalize failure.
- **C4 — Real webhook verification** (D §4): replace fixture JWK path; negative suite; retryable-vs-invalid distinction.
- **C5 — Sync fan-out worker** (D-C): notification → lease → pull → archive raw page → normalize → existing planner; cursor commit law; concurrency lease; mutation-restart. The correctness-critical step.
- **C6 — Item lifecycle + health** (§2): status transitions, reauth guard, update-mode relink, disconnect + crypto-shred + export prompt.
- **C7 — Export** (D-E): `admin.export_all` manifest, step-up, `export_jobs`, `exports` bucket, signed URL, isolated-restore test.
- **C8 — Thin UI**: connections page (Plaid Link Sandbox, item list + health + freshness), accounts, transactions with posting + provenance drawer (normalized view, not raw PII — Claude m2), "sync now", export button, audit view. Desktop-first, 390px (Law 8). Critical-flow tests.
- **C9 — pg_cron + metering breakers**: scheduled enqueue of active-item syncs; usage_events assertions; sync-rate breaker.

## 7. Acceptance gates (Codex M17 / Claude m5)

Scripted-provider + live-Sandbox coverage for each: pending-added-then-removed; page-separated pending/posted pairing; **mid-pagination mutation restart** (adapter unit test, not just fixtures); concurrent sync sources (lease holds); `ITEM_LOGIN_REQUIRED` → reauth → update-mode recovery → missed changes applied; initial empty sync; identical webhook bodies re-enqueue; JWK rotation/outage; stale queued job rejected by `sync_generation`. Plus: tenant isolation on every new table via other-household ids through commands **and** service-role worker calls; **Law 12 token-canary** sweep across all sinks + KEK rotation then sync-still-works; **Law 6** export manifest completeness + isolated restore reproduces cited records; red-team gate re-run against Plaid fields (`name`, `merchant_name`, `original_description`, `personal_finance_category`); USD-only rejection recorded; decimal→minor property test.

## 8. Human checkpoints (⚑ — Codex M18, expanded)

Rotate Plaid Sandbox secret **and provision client ID** before any call; **KEK generation/provisioning**; **crypto design security review** (D-B); Plaid Dashboard webhook/redirect configuration for the cloud endpoint; **sanitized-fixture approval** (C0); QIF/beancount deferral ruling (D-E); Vercel binding (for cloud UI, optional this stage); first live dynamic-Sandbox link/sync run; reset-login/update-mode run; isolated-export restore inspection. **A single happy-path link is not a sufficient live gate.** Production linking remains a separate, later ⚑ (doc 17 §3: Sandbox items cannot be promoted to Production).

## 9. Sequencing & risk

Critical path C0→C1→C2→C3→C5 (real data in, correctly). C4 gates C5's real trigger. C6 depends on C5 (needs the sync/error signals). C7 (export) is Plaid-independent and lands in parallel — but must be **complete**, not a 4-table stub (both audits: a partial export is worse than none). C8 depends on C3+C7. C9 last.
Highest risks, reviewed hardest: **(1)** credential crypto/KEK (D-B, ⚑ security review); **(2)** cursor atomicity + fan-out (D-C); **(3)** decimal→minor currency (D-D); **(4)** export completeness + isolated restore (D-E). Each has a named gate above.

## 10. Protocol

`PROGRESS.md` per-step; `NOTES.md` decisions/deviations with cites; **stage-exit dual review (Claude + Codex)** before tagging `stage-1c`. Never fake Plaid credentials to bypass a gate.
