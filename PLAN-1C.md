# KEEL Stage 1C Plan (v3) — Plaid Sandbox Read Path (server-only, correctness-first)

**Status:** v3, after two dual-audit rounds (Claude + Codex). Round 2 verdict: v2 was still too big and several ingestion subsystems were under-designed. v3 **splits the stage** and designs each hard subsystem to the exact mechanics the audits demanded.
**Builds on:** Stage 1A (tagged `stage-1a`, deployed). Reuses the deterministic ledger, command/worker procs, verified-webhook ordering, RLS/grant posture, and the pure planner (with one amendment, D-D).
**Controlling specs:** INFRA.md §4/§5/§8/§9/§14/§16 → BC-v2.1 §3/§6 → docs/17 §3 → CLAUDE.md Laws 1,2,4,5,6,9,12.

## 0. Thesis (split narrow) — D-022

> A signed-in user links a Plaid **Sandbox** item; KEEL pulls its **USD** transactions through a correct, crash-safe sync onto the existing ledger; access tokens are envelope-encrypted and **never enter Postgres in plaintext or cross an RPC boundary**; correctness is proven by the *existing* `keel_trial_balance` / `keel_list_transactions` queries against a real Sandbox item.

**Split (resolves round-2 "too big" + INFRA §16 placement):**
- **This stage (1C): server-only Plaid read path.** No new UI, no export.
- **Export → Stage 1D** (INFRA §16 places exports there; the round-2 "Law-6 silently stubbed" objection is resolved by *not doing a partial export now*, and 1C adds nothing that makes data unexportable).
- **Viewer UI → Stage 1E** (INFRA §16). 1C proves end-to-end via API queries, not pixels.
- Already cut in v2 and staying cut: categorization, CSV import, transfers/exclusion, professional access, `periods.reopen`, multi-currency, receipts.

## 1. Design decisions (the hard parts, resolved)

### D-A. `connections` **is** the Plaid Item; retrofit composite tenant FKs; one unambiguous item id (Codex #6, Claude M6)
- No new Item table. Amend `connections`: add `institution_id`, `consent_expires_at`, `last_successful_sync_at`. `external_ref` **remains the sole physical item identifier** (rename in comments to "provider item id"); no alias column (avoids two mutable identities).
- **Routing:** the deployed webhook lookup keys on `(provider, external_ref)` but the uniqueness constraint is `(household_id, provider, external_ref)`. Make Plaid item ids globally unique by **adding a partial unique index `unique (provider, external_ref) where provider='plaid'`** (Plaid item ids are globally unique), so the STRICT webhook lookup can never be ambiguous. Keep the household-scoped unique for simulator.
- **Tenant-integrity retrofit** (migration C2): add parent uniques `connections(household_id, id)`, `accounts(household_id, id)`; convert the hot-path children to **composite FKs** so a child's `household_id` cannot disagree with its parent's — `accounts(household_id, connection_id) → connections(household_id, id)` (keep `connection_id` **nullable** for manual accounts: composite FK is NOT VALID for null connection_id, which Postgres MATCH SIMPLE already allows), `raw_provider_events(household_id, connection_id)`, `normalized_source_records(household_id, account_id) → accounts(household_id, id)`, new satellites likewise. A migration-compatibility subsection proves, per consumer (accounts, raw_provider_events, sync_checkpoints, worker procs, webhook), that no existing signature/constraint changes semantics.
- Credential owner is modeled independently (BC §3): `connection_credentials.credential_owner_user_id`.

### D-B. Credential crypto — KEK in Edge secrets, per-token DEK, **plaintext never enters Postgres** (Codex #1, Claude Blocker 1)
Supabase Vault has no DEK-wrap primitive and a DB proc cannot hand plaintext to an Edge HTTP call without returning it over RPC — so **encryption lives in the Edge function, not the database**:
- `KEEL_CREDENTIAL_KEK` (+ `..._KEK_VERSION`) live in Supabase Edge Function Secrets (never in DB, never a proc arg).
- On exchange (Edge, in memory): generate a random 256-bit **DEK**, AES-GCM-encrypt the Plaid `access_token` with the DEK, wrap the DEK with the KEK (AES-GCM). Only `{ciphertext, iv, wrapped_dek, wrap_iv, kek_version}` — **never plaintext** — is passed to `connections.finalize_link`.
- The **worker** (Edge), immediately before a Plaid call, reads the ciphertext row, unwraps the DEK with the KEK, decrypts the token **in Edge memory**, calls Plaid, and drops the plaintext. Postgres only ever holds ciphertext.
- **Rotation** = re-wrap DEKs under a new KEK version (operator Edge routine); tokens are not re-encrypted. Old KEK versions retained until re-wrap completes.
- **Disconnect** crypto-shreds by deleting the wrapped_dek (token unrecoverable) — only after `/item/remove` succeeds (D-F).
- Gates: no plaintext token ever appears in any RPC arg/result, `RAISE`/exception `DETAIL`/`CONTEXT`, structured log, dead-letter, audit/domain/health row, Storage, or DB column — proven with **unique token canaries** swept across all sinks; KEK rotation then a successful sync. `connection_credentials` gets zero `anon`/`authenticated` grants or policies.

### D-C. Durable sync lease + attempts; atomic per-page; mutation abandons, never deletes (Codex #2/#3, Claude M5)
Replace the xact advisory lock (can't span HTTP round-trips) with durable state:
- **Lease** on `connections`: `sync_lease_owner uuid, sync_leased_until timestamptz, sync_desired_generation int, sync_committed_generation int`. A worker CAS-acquires the lease (advisory lock only guards the short acquire txn). Every `SYNC_UPDATES_AVAILABLE` notification bumps `sync_desired_generation`; on completion, if desired > committed the worker requeues (no lost signal).
- **`sync_attempts`** (base_cursor, attempt_id, started_at, state `open|completed|abandoned`). Each `/transactions/sync` page is archived as an **immutable `raw_provider_events`** row whose `provider_event_id` is **deterministic** = `sha256(external_ref || base_cursor || page_ordinal)` (stable across re-pull; account_external_ref = `'item-page'`). `raw_provider_events.body` stores the verbatim page (see D-E for lossless numeric capture).
- **Mutation restart** (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`): mark the attempt `abandoned` (evidence retained), start a new attempt from the committed base cursor.
- **Completion** (`has_more=false`): in one transaction, mark attempt `completed`, CAS-advance `sync_checkpoints.cursor`, and enqueue promotion of the reconciled event set (D-D). Cursor advances **only** on a completed attempt. A crash mid-pull re-pulls from the committed cursor; deterministic page ids make raw archival idempotent.

### D-D. Pending→posted **set reconciliation**; planner amendment; explicit removals (Codex #4/#3, Claude — planner)
Real Plaid splits supersession across `added`/`removed` (pending id in `removed`, posted in `added`, possibly different pages) — the 1A planner (which expected a single `added` with `pendingTransactionId`) would double-count or void the posted row.
- After a **completed** attempt, reconcile the whole added/modified/removed set **as a batch** before promotion: pair `removed(P)` with `added(Q, pending_transaction_id=P)` into **one supersession** (continue P's economic key, status→posted) and **suppress the standalone removal**; a `removed` with no matching `added` is a true void; `modified` updates in place.
- Extend `packages/ingest`: add `reconcileSyncBatch(events) → PromotionAction[]` that consumes the full set (the existing per-event `planEvent` becomes a helper). Unit-test both page orders, crashes, replay.
- **Amend `keel_worker_apply_promotion`**: it currently *creates* `normalized_source_records` itself — change it to **consume a pre-created normalized event id** produced during the fan-out (so raw→normalized happens once, in the sync path, and the planner/promotion operate on normalized ids). The normalized schema gains an explicit `kind` (`added|modified|removed`) so removals are representable.

### D-E. Decimal→minor, lossless, exact sign (Codex #5, Claude M7)
- **Lossless capture**: `response.json()` floats the number, so parse the **raw response text** with a bigint-preserving JSON parser (or extract the `amount` lexeme by string) — the decimal string never passes through JS `Number`.
- **Grammar**: accept `-?\d+(\.\d{1,2})?` for USD (scale 2); **reject** (don't round) more than 2 fractional digits or non-USD `iso_currency_code`; enforce int64 bounds. Conversion is pure string→bigint (pad/scale digits), no float, reusing `parseMinorUnits`.
- **Sign**: Plaid `amount` is **positive = money leaving the account** (not account-type-dependent). KEEL stores holder-perspective signed minor units with debit-positive assets; the adapter applies the exact transform (negate Plaid's sign to the account holder's perspective) and a property test pins credit + depository cases.
- **Per-transaction** currency check (account-level USD activation is necessary but not sufficient).

### D-F. Durable link/disconnect saga (Codex #7)
- `link_attempts` (id, household, status `started|exchanged|finalized|abandoned`, created_at, expires_at). `connections.begin_link` records an attempt (no Item yet); the Edge function calls Plaid `/link/token/create` then, after Link, `/item/public_token/exchange` (public token never logged); `connections.finalize_link` atomically creates the `connections` row + accounts (USD gate) + stores ciphertext + audits + enqueues initial sync. If finalize is unreachable, a reaper calls `/item/remove` for orphaned exchanged attempts.
- `removal_attempts` + transitional status `disconnecting`: invalidate sync generations first → retry `/item/remove` → on success crypto-shred DEK → mark `disconnected`. Shred never precedes a confirmed remove.

### D-G. Metering + breakers (Codex #10 / INFRA §14)
`usage_events` row per Plaid/JWK/link/exchange/remove/institution call (kind, latency, error, request_id — **no secrets**). Breakers: per-item sync-rate, per-item concurrent-attempt (via lease), and a global daily Plaid-call budget. (Storage/export breakers move to 1D with export.)

## 2. Account lineage (Codex #9, Claude — lineage)
Prefer the provider `account_id` for same-item mapping, but Plaid documents `account_id` can change even within an item; so whenever an account id disappears and another appears, run **scored candidate matching** (institution, subtype, mask, name, currency, prior balance, overlapping transactions) and **require user confirmation** when identity isn't uniquely proven. Never auto-create a second economic account or auto-merge on a tuple. Record reason/evidence/effective-dates/actor/old-new ids in `account_lineage`. Known 1D gap (documented): cross-item transaction de-dup (economic key embeds item id).

## 3. Item lifecycle
`linking → active`; `active →(ITEM_LOGIN_REQUIRED/ITEM_ERROR) reauth_required` (+health event; **guard: no raw/canonical writes while reauth_required**, checked at job-claim and immediately before each write); `reauth_required →(update-mode relink + finalize) active`; `active|reauth_required →(user) disconnecting → disconnected` (D-F). `PENDING_EXPIRATION`/`PENDING_DISCONNECT`/`LOGIN_REPAIRED` set/clear `reauth_required`; if update-mode isn't finished this stage, `reauth_required` is terminal-until-manual-relink (stated).

## 4. Webhook hardening (unchanged from v2 §4, retained)
Verify-then-store (D-013, now elevated to an explicit amendment of doc 17 §3 — D-021); bounded body size; `environment='sandbox'`; `alg=ES256` + `kid` + recent non-future `iat` + exact body hash constant-time compare; JWK cache by `kid` with TTL + negative-cache/rate-limit unknown kids; distinguish invalid-signature (401, quarantine) from JWK-fetch outage (5xx, retryable); dedupe delivery by signed-JWT-fingerprint + body-hash (not `request_id`); webhook is an idempotent "sync this item" trigger.

## 5. Work breakdown (Codex build-order; C2 split into schema vs crypto)
- **C0** — sanitized recorded Sandbox fixtures (link, exchange, sync pages incl. mutation-restart 400, pending-removed+posted-added pair across pages, initial-empty, ITEM_LOGIN_REQUIRED); ⚑ human approves sanitization. `PlaidBankProvider` contract.
- **C1** — Plaid adapter (`packages/providers/plaid`): typed calls, lossless decimal→minor + sign transform (D-E), JWK verify helper; unit-tested vs C0 + injected mutation-restart; no live calls in CI.
- **C2a** — schema: amend `connections`, add satellites (`connection_credentials`, `connection_health_events`, `account_lineage`, `balance_snapshots`, `link_attempts`, `removal_attempts`, `sync_attempts`, `usage_events`), composite tenant-FK retrofit + parent uniques + global item-id unique (D-A). No crypto yet — unblocks the spine.
- **C2b** — credential crypto (D-B): Edge KEK/DEK, `finalize_link` ciphertext path, worker decrypt-in-Edge, rotation routine. **⚑ security review before merge.**
- **C3** — link/disconnect saga (D-F) + lifecycle (§3).
- **C4** — real webhook verification (§4).
- **C5** — sync fan-out: durable lease + `sync_attempts` + deterministic page archive + set-reconciliation (D-C/D-D) + `apply_promotion` amendment. The correctness core.
- **C6** — metering + breakers (D-G); pg_cron enqueue of active-item syncs.

## 6. Acceptance gates
Scripted + live-Sandbox: pending-removed+posted-added across pages (both orders, crash, replay) → one economic history; mutation-restart mid-pagination → clean restart from committed cursor, no double-archive; concurrent notifications → lease serializes, no lost generation; ITEM_LOGIN_REQUIRED → reauth → update-mode → catch-up; initial empty sync; JWK rotation/outage (retryable vs invalid); stale job rejected by generation CAS. Plus: tenant isolation on every new table via other-household ids through commands **and** service-role worker calls; **Law 12** token-canary sweep across all sinks + KEK rotation then sync-works; decimal→minor property test (rounding-reject, sign, bounds); per-transaction USD rejection recorded (not dead-lettered — normalize-time skip); red-team re-run on Plaid fields (`name`, `merchant_name`, `original_description`, `personal_finance_category`). Reuse `keel_trial_balance`/`keel_list_transactions` to assert the ledger matches the Sandbox item.

## 7. Human checkpoints (⚑)
Rotate Plaid Sandbox secret + provision client id before any call; **KEK generation/provisioning** + **crypto security review** (C2b); Plaid Dashboard webhook/redirect config for the cloud endpoint; sanitized-fixture approval (C0); first live dynamic-Sandbox link/sync; reset-login/update-mode run. Production linking remains a separate later ⚑ (doc 17 §3). A single happy-path link is not a sufficient live gate.

## 8. Sequencing
C0 → C1 → C2a → C2b(⚑) → C3 → C4 → C5 → C6. C2a (schema/tenant retrofit) can land before the crypto review so the spine isn't blocked. Export (1D) and viewer UI (1E) are separate stages. Stage-exit dual review before tagging `stage-1c`.
