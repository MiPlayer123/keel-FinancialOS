# C3 Build Spec v3.1 — Plaid link/disconnect saga + lifecycle (Stage 1C, D-F/§3)

> **v3.1 (confirmation-round fixes):** after v3, a Codex confirmation caught 8 more real
> defects, now fixed inline: remove duplicate `connection_id` add (already in C2a — migration
> would fail); atomic injection-consume RPC (JS client can't delete-with-subquery); race-free
> fence (assert_lease + apply_action LOCK the connection `for no key update`, apply_action
> derives it via `raw_event_id`); reconnect marks the redundant attempt 'failed'+retain-envelope
> (no second decryptable copy, reaper cleans); outcome-aware `keel_fail_link_attempt(p_removed)`;
> `jsonb_agg` account arrays (not scalar subquery); reap return carries `householdId`;
> `removal_attempts.initiated_by_user_id` set; audit reap claim/retry; atomic command
> idempotency + replay short-circuit + guarded failure transitions.


Server-only Plaid Sandbox link → active connection → initial sync, plus disconnect
(remove + crypto-shred), orphan reaper, and item-lifecycle reauth transitions.
Deterministic + hermetic in CI via a **token-free** injection table; the live
Sandbox HTTP path is a guarded fallback (not exercised in CI).

Read first: `CLAUDE.md` (Laws 1,2,5,12; risk ladder), `PLAN-1C.md` §D-B/§D-F/§2/§3,
`INFRA.md` §4/§5.

> **v3 note:** reworked after TWO pre-build dual reviews (Claude + Codex), both
> NEEDS REWORK. v3 fixes: Law-12 token-free fixtures (C-1); internal saga procs are
> service-only, not `authenticated` (C-2); `link_attempts` fully server-only (C-3);
> finalize **moves** the envelope off the attempt so shred is complete (C-4); real
> atomic fencing via lease-clear + generation bump + status guards (C-5); reaper
> claims rows with SKIP LOCKED (C-6); best-effort `/item/remove` on
> persistence-failure & zero-USD (C-7/C-13); finalize idempotent on `succeeded`
> (C-8); disconnect state checks + no-credentials≠success (C-9); keel_api grants +
> definer RLS policies on C2a tables (C-10); schema constraints (C-11); liability
> mapping (C-12); version-indexed KEK (C-14); adversarial tests (C-15). Build
> EXACTLY as written; do not redesign.

## Non-negotiable invariants
- **Law 12:** Plaid access/public/link tokens are plaintext ONLY in Edge memory.
  Plaintext NEVER enters Postgres — **including test fixtures** — nor logs, audit
  rows, health-event `details`, `usage_events`, `removal_attempts`, or Plaid error
  payloads persisted anywhere. No `raise`/`console.log` of any token or decrypted
  material. Postgres stores only the AES-GCM envelope (bytea).
- **Law 2:** every mutation writes `audit_log`; lifecycle is a durable, idempotent,
  reversible saga (attempt rows).
- **Shred-after-remove:** DEK/ciphertext destroyed ONLY after Plaid confirms
  `/item/remove` (200, or `ITEM_NOT_FOUND` = already gone). Never before. There is
  exactly ONE decryptable copy of any token at any time.
- **Crypto contract FIXED (C2b):** reuse `_shared/credential-crypto.ts` verbatim.
  Envelope = { ciphertext, iv, wrappedDek, wrapIv (base64), kekVersion }. Token AAD
  = `credentialId|householdId|provider` (version-free). DEK-wrap AAD adds `|kekVersion`.
  **`credentialId` is minted in `keel_begin_link`, used as the encryption AAD, and
  becomes `connection_credentials.id` unchanged.** provider = `'plaid'`.
- **Deterministic spine:** no LLM. USD gate + asset/liability classification are pure.

## Reference patterns (mirror exactly)
- SECURITY DEFINER proc + membership + idempotency + audit: `keel_cmd_create_account`
  (`...210600_command_procs.sql:215`); helpers `keel_assert_member_write`,
  `keel_actor_from_jwt`, `keel_finish_command`, `keel_enqueue`, `keel_is_household_member`.
- Account+ledger creation: same file `:264-286`.
- Sync enqueue the worker consumes: `processSyncNotification` (`worker/index.ts:224`)
  takes `refs.connectionId`.
- **Ownership block** (copy): `...c5b_sync_pull.sql:505-527` (`grant create on schema
  public to <role>; do $$ alter function ... owner to <role>; revoke ...; grant
  execute ...; $$; revoke create`).
- **Definer RLS policy** (copy): `sync_attempts_worker_all` (`c5b:499-501`) and the
  210500 definer-policy loop (`...210500_grants_rls.sql:196`).
- Injection precedent: `sync_test_pages` + `readSyncPages` (`_shared/plaid-sync.ts`).
- keel_api ALREADY holds `update(status) on connections`, insert on
  ledger_accounts/accounts/account_owners, `keel_enqueue`. It lacks C2a-satellite
  privileges + policies — §1d adds them.
- `ledger_account_kind` enum = asset|liability|income|expense|equity (liability exists).
- `keel_worker_apply_action(p_normalized_id, p_action_kind, p_economic_key, p_apply_key)`
  takes NO owner/lease param and does NOT assert lease → its fence must be a status/
  generation check derived from the normalized row's connection (§1e).

---

## 1. Migrations

### FILE 1 — `20260711140000_c3_connection_status_disconnecting.sql` (enum only)
`alter type public.connection_status add value if not exists 'disconnecting';`
Own file (Postgres forbids using a new enum value in the txn that adds it).

### FILE 2 — `20260711140100_c3_link_disconnect_saga.sql`

#### 1a. Schema
Extend `link_attempts` (envelope + lineage + reaper-claim + idempotency):
```
alter table public.link_attempts
  add column command_id uuid,
  add column credential_id uuid,
  add column plaid_item_id text,
  add column credential_iv bytea,
  add column credential_wrapped_dek bytea,
  add column credential_wrap_iv bytea,
  add column credential_kek_version int,
  add column entity_id uuid,              -- NOTE: connection_id ALREADY exists (C2a link_attempts) — do NOT re-add (dup column → migration fails). Reuse it as the finalize lineage col.
  add column expires_at timestamptz not null default (now() + interval '30 minutes'),
  add column reap_attempts int not null default 0,
  add column reap_claim_id uuid,
  add column reap_claimed_at timestamptz,
  add column last_reap_error text,
  add column last_reaped_at timestamptz;
-- keep existing credential_ciphertext bytea (ciphertext part), failure_code/message.
```
- Recreate state CHECK by name to: `initiated|exchanged|succeeded|failed|expired|reaping|reaped`.
  (Deviation from PLAN D-F naming — follow deployed set; note in NOTES.md.)
- Envelope all-or-none + byte-length CHECK on link_attempts:
  `check ((credential_ciphertext is null and credential_iv is null and credential_wrapped_dek
  is null and credential_wrap_iv is null and credential_kek_version is null) or
  (octet_length(credential_iv)=12 and octet_length(credential_wrapped_dek)=48 and
  octet_length(credential_wrap_iv)=12 and octet_length(credential_ciphertext) >= 16 and
  credential_kek_version > 0))`.
- Composite tenant FKs (MATCH SIMPLE): `link_attempts(household_id,entity_id) → entities`,
  `link_attempts(household_id,connection_id) → connections`.
- `command_id` idempotency: `create unique index ... on link_attempts (household_id, command_id)
  where command_id is not null;` — begin_link inserts with `on conflict do nothing` then
  re-selects (atomic; no select-then-insert race — finding #11).
- `alter table public.removal_attempts add column failure_code text;` (whitelisted code, NO token).
- `connection_credentials`: `alter table ... add constraint connection_credentials_one_per_conn
  unique (household_id, connection_id);` + same envelope byte-length CHECK + `kek_version > 0`.

#### 1b. Injection table `plaid_test_responses` (server-only, **token-free**)
```
create table public.plaid_test_responses (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null, kind text not null, ordinal int not null default 0,
  body_text text not null, created_at timestamptz not null default now());
create index plaid_test_responses_lookup on public.plaid_test_responses (scope_key, kind, ordinal);
```
RLS enable; revoke all from anon, authenticated; grant select, insert, delete to service_role.
**Atomic consume RPC (finding #17 — the JS client can't do delete-with-subquery):**
`keel_consume_plaid_test_response(p_scope_key text, p_kind text) returns text` —
`delete from plaid_test_responses where id = (select id from plaid_test_responses where
scope_key=p_scope_key and kind=p_kind order by ordinal limit 1) returning body_text` (null
if none). security definer, owned by keel_api or a plain function; execute→service_role. The
plaid-client calls `admin.rpc('keel_consume_plaid_test_response',...)`.
**Law 12: `body_text` MUST NOT contain any access/public/link token.** For the
`item_public_token_exchange` kind, the injected body carries ONLY `{item_id}` — the
client synthesizes the test access_token in Edge memory (§2a). `sandbox_public_token_create`
injects `{}` (client synthesizes a memory-only public_token). `accounts_get`/`item_remove`
bodies are naturally token-free and injected verbatim.

#### 1c. Procs (all `security definer`, `set search_path = public`, owned by keel_api)

**USER-FACING (membership-checked; execute→`authenticated`):** only the two the
browser legitimately initiates.
1. `keel_begin_link(p_command_id uuid, p_household_id uuid, p_entity_id uuid, p_provider text, p_institution_id text) returns jsonb`
   - `keel_assert_member_write(p_household_id)`; reject provider<>'plaid'; entity∈household (P0006).
   - **Idempotent (atomic — finding #11):** `insert into link_attempts(command_id, household,
     initiated_by_user_id=auth uid, entity_id, provider, institution_id, state='initiated',
     credential_id=gen_random_uuid()) on conflict (household_id, command_id) where command_id
     is not null do nothing;` then `select id, credential_id from link_attempts where
     household_id=... and command_id=...`. audit `connection.link_begin` only on a fresh insert.
   - return `{attemptId, credentialId, state, connectionId}` (state+connectionId let the route
     short-circuit a replayed command — finding #11).
2. `keel_disconnect_begin(p_household_id uuid, p_connection_id uuid, p_reason text) returns jsonb`
   - `keel_assert_member_write`; `select ... for update` connection (household match else P0006).
   - reject status='disconnected'.
   - **Idempotent:** if status='disconnecting' with a `pending` removal_attempt, return it.
   - else atomically: status='disconnecting', `sync_desired_generation += 1`,
     **clear lease** (`sync_lease_owner=null, sync_leased_until=null`); insert
     removal_attempts(household_id, connection_id, **initiated_by_user_id = auth uid**
     (NOT NULL col — finding #16), state='pending', reason); audit `connection.disconnect_begin`.
   - return `{removalAttemptId, hasCredentials: exists(connection_credentials for conn)}`.

**INTERNAL (execute→`service_role`; called by the Edge orchestrator AFTER authz, or
by worker/reaper — NEVER by the browser). C-2: these must NOT be granted to authenticated.**
3. `keel_record_link_exchange(p_attempt_id, p_household_id, p_credential_id, p_plaid_item_id, p_ciphertext_b64, p_iv_b64, p_wrapped_dek_b64, p_wrap_iv_b64, p_kek_version) returns void`
   - `for update` attempt; verify household; verify `p_credential_id = attempt.credential_id`
     (mismatch → raise). Idempotent: if state='exchanged' with same item+credential → return.
   - require state='initiated'; set state='exchanged', plaid_item_id, decode all four
     bytea parts, credential_kek_version. audit `connection.link_exchange` (item_id +
     credential_id only). (Reaper safety net once persisted.)
4. `keel_finalize_link(p_attempt_id, p_household_id, p_institution_id, p_consent_expires_at, p_accounts jsonb) returns jsonb`
   `p_accounts` = USD-only, non-empty array `{external_ref, name, subtype, currency, kind}`
   where `kind` ∈ (asset|liability) from the pure mapper (§2b). NO balances (Law 4).
   - `for update` attempt; verify household.
   - helper for every account-list return: `v_account_ids := coalesce((select jsonb_agg(id order
     by created_at) from accounts where connection_id = <conn>), '[]'::jsonb)` — **jsonb_agg,
     NOT a scalar subquery (finding #8: multiple accounts → cardinality error)**.
   - **Idempotent (C-8):** if state='succeeded' → return `{connectionId: attempt.connection_id,
     accountIds: v_account_ids(attempt.connection_id)}` (this attempt already moved its envelope
     off; nothing to shred).
   - reject state in ('reaping','reaped','failed','expired') (C-6: don't finalize a claimed attempt).
   - require state='exchanged'; reject if attempt.credential_ciphertext is null (moved/shredded).
   - **Reconnect (finding #4):** if an ACTIVE connection already exists for
     (household,'plaid',plaid_item_id) WITH a connection_credentials row: this attempt's token is
     a redundant DISTINCT live token for the same item. Do NOT mark it 'succeeded' (that would
     strand its envelope unreapably). Instead set attempt state='failed',
     failure_code='duplicate_item', connection_id=existing, completed_at — **retaining its
     envelope** so the reaper `/item/remove`s the redundant token. audit `connection.link_duplicate`.
     Return the EXISTING `{connectionId, accountIds: v_account_ids(existing)}`. Do NOT re-create
     connection/credentials/accounts.
   - `if jsonb_array_length(p_accounts)=0 then raise` (defensive).
   - create connection (status 'active', external_ref=plaid_item_id, institution_id,
     consent_expires_at, generations 0).
   - insert connection_credentials(id=attempt.credential_id, household, connection,
     credential_owner_user_id=attempt.initiated_by_user_id, envelope bytea copied from attempt, kek_version).
   - **C-4 (complete shred prerequisite): NULL the attempt's crypto columns**
     (credential_ciphertext/iv/wrapped_dek/wrap_iv/kek_version) — the connection_credentials
     row is now the SOLE decryptable copy. Keep credential_id + plaid_item_id as lineage.
   - per account: `v_kind := (acct->>'kind')::ledger_account_kind`; create ledger_account
     (kind=v_kind, is_category false) + accounts(connection, external_ref, currency 'USD') +
     account_owners(attempt.initiated_by_user_id); audit each.
   - state='succeeded', completed_at, connection_id; enqueue `sync_notification`
     {refs:{connectionId}}; audit `connection.linked`; return {connectionId, accountIds}.
5. `keel_fail_link_attempt(p_attempt_id, p_household_id, p_reason, p_removed boolean) returns void`
   - `for update` attempt; **only transition non-terminal states** (`state in
     ('initiated','exchanged')`; if already 'succeeded'/'failed'/'reaped' → return, don't clobber — finding #11).
   - **Outcome-aware (finding #7):** if `p_removed` (Edge already confirmed `/item/remove` while
     token in memory) → **shred** the attempt envelope now (crypto cols null), state='failed'.
     else → retain envelope, state='failed' (the reaper will `/item/remove` it later).
   - failure_code=p_reason (whitelisted, NO token). audit `connection.link_failed`.
6. `keel_disconnect_complete(p_household_id, p_connection_id, p_removal_attempt_id, p_removed, p_failure) returns void`
   - `for update` connection + removal_attempt (verify linkage).
   - **Idempotent (C-9):** if connection.status='disconnected' and removal_attempt.state='succeeded' → return.
   - require connection.status='disconnecting' AND removal_attempt.state='pending' (else raise stale).
   - if p_removed: shred `delete from connection_credentials where household=... and connection=...`;
     status='disconnected'; removal_attempt 'succeeded', completed_at; audit `connection.disconnected`.
   - else: removal_attempt 'failed', failure_code=p_failure; leave 'disconnecting'; audit `connection.disconnect_failed`.
7. `keel_set_connection_reauth(p_connection_id, p_event_type, p_required boolean) returns void`
   - `for update` connection. if p_required and status='active': status='reauth_required',
     `sync_desired_generation += 1`, **clear lease** (C-5). if not p_required and
     status='reauth_required': status='active'. never touch disconnecting/disconnected.
     insert connection_health_events(event_type, severity=p_required?'error':'info',
     details `{eventType}`). audit. Idempotent. execute→service_role, keel_worker.
8. `keel_get_connection_credential_envelope(p_connection_id) returns jsonb`
   - return the one connection_credentials row as `{credentialId, householdId,
     provider:'plaid', ciphertext, iv, wrappedDek, wrapIv (base64), kekVersion}` (null if none).
     Sole credential read path → service_role needs NO direct SELECT on the table. execute→service_role.
9. `keel_reap_orphan_link_attempts(p_now timestamptz default now(), p_limit int default 25) returns jsonb`
   - **Claim (C-6):** in one statement, `update link_attempts set state='reaping',
     reap_claim_id=gen_random_uuid(), reap_claimed_at=p_now where id in (select id from
     link_attempts where credential_ciphertext is not null and reap_attempts<5 and
     ((state in ('exchanged','failed') and expires_at<p_now)
       or (state='reaping' and reap_claimed_at < p_now - interval '10 minutes'))
     order by expires_at for update skip locked limit p_limit) returning ...` — then return
     the claimed rows as a JSON array, each including **`householdId`** (finding #15 — §2e
     needs it for the decrypt AAD), credentialId, plaidItemId, reapClaimId, and the base64
     envelope. **The `state='reaping' and reap_claimed_at` stale-claim branch reclaims
     attempts stranded by an Edge crash after claim / before mark (liveness); the fresh
     reap_claim_id supersedes the crashed run's, so its late `mark` fails the claim-id check.**
     **audit `connection.link_reap_claimed` per claimed attempt (finding #18 — every mutation audits).**
     execute→service_role.
10. `keel_mark_link_attempt_reaped(p_attempt_id, p_reap_claim_id, p_removed, p_error) returns void`
    - `for update` attempt; require state='reaping' and reap_claim_id=p_reap_claim_id (else raise stale claim).
    - if p_removed: state='reaped'; shred envelope (crypto cols null); last_reaped_at. audit `connection.link_reaped`.
    - else: `reap_attempts += 1`, last_reap_error=p_error (whitelisted), clear reap_claim_id;
      if reap_attempts>=5 → state='failed' (parked, audit `connection.link_reap_exhausted`) else
      state='exchanged' (unclaim, retry later, **audit `connection.link_reap_retry`** — finding #18). execute→service_role.

#### 1d. Grants / ownership / policies (C-10 — the C5b-class fix)
- keel_api table privileges (definer owner):
  ```
  grant select, insert, update, delete on public.link_attempts to keel_api;
  grant select, insert, delete on public.connection_credentials to keel_api;  -- select is for the envelope-read definer proc
  grant select, insert, update on public.removal_attempts to keel_api;
  grant insert on public.connection_health_events to keel_api;
  grant update (sync_desired_generation, sync_lease_owner, sync_leased_until) on public.connections to keel_api;
  -- keel_api already has update(status) + accounts/ledger/owners insert.
  ```
- **Definer RLS policies** (C2a tables have RLS on but NO keel_api policy → writes blocked):
  add `create policy <t>_api_all on public.<t> for all to keel_api using (true) with check (true);`
  for: connection_credentials, link_attempts, removal_attempts, connection_health_events.
  (Mirror `sync_attempts_worker_all`.)
- keel_worker: ensure `grant select on public.connections to keel_worker` (apply_action guard
  reads status; add if absent) + it already has the sync-column updates.
- Own all 10 procs as keel_api via the ownership block; execute audiences:
  1,2 → `authenticated`; 7 → `service_role, keel_worker`; 3,4,5,6,8,9,10 → `service_role`.
- **C-3: `link_attempts`, `connection_credentials`, `plaid_test_responses` get NO
  authenticated grant and NO member-read policy.** The sandbox link flow is synchronous
  (the api returns the result); the browser never reads attempts. (Status-watch UI → 1E.)

#### 1e. Fence in-flight sync (C-5, finding #5 — must be genuinely race-free)
disconnect_begin / set_reauth lock the connection `for update`, bump generation, and clear
the lease atomically (§1c#2/#7). For that to actually fence a concurrent worker, the worker's
write RPCs must (a) LOCK the same connection row (so they serialize against the committed
disconnect) and (b) re-check `status='active'` under that lock. Unlocked MVCC reads (deployed
`assert_lease`, `c5b:94`) can miss an uncommitted clear — so `CREATE OR REPLACE` these
(copy bodies verbatim, add ONLY the lock + guard):
- `keel_worker_acquire_sync_lease`: acquire ONLY when `v_conn.status='active'`; else
  `return jsonb_build_object('acquired',false,'reason',v_conn.status)`. (Already loads conn.)
- `keel_worker_assert_lease(p_connection_id, p_owner)`: change its connection read to
  `select ... from connections where id=p_connection_id for no key update` and raise unless
  `sync_lease_owner = p_owner AND sync_leased_until > now() AND status='active'`. Now every
  RPC that calls assert_lease (archive_page, create_normalized, complete_attempt) blocks on
  and re-reads the connection under lock → a committed disconnect_begin fences them.
- `keel_worker_apply_action(p_normalized_id, ...)`: apply_action does NOT call assert_lease and
  takes no owner. Derive the connection via `v_nsr.raw_event_id → raw_provider_events.connection_id`
  (`raw_event_id` is present on EVERY normalized row incl. voids — works for all branches; do NOT
  use `v_nsr.connection_id`, which doesn't exist). `select ... from connections where id=<that>
  for no key update`; `if status<>'active' then raise 'KEEL_SYNC_SUPERSEDED' using errcode='P0007';`
- `keel_worker_complete_attempt`: load connection via `v_attempt.connection_id` `for no key update`;
  `if status<>'active' or v_attempt.generation < sync_desired_generation then raise
  'KEEL_SYNC_SUPERSEDED' P0007;` (keep m8/m9 guards).
Ordering note: `for no key update` on connections does not conflict with the FK-child inserts
(raw/normalized/canonical reference connections) — it blocks only competing row locks
(disconnect's `for update`), which is exactly the intent. Re-run 08-plaid-sync + 06-redteam to
prove NO active-path regression (the guards fire only on non-active/superseded).

#### 1f. pgTAP `supabase/tests/004_c3_link_saga.sql`
Assert: 'disconnecting' ∈ enum; 10 procs exist + security definer + owner keel_api;
authenticated executes ONLY begin_link + disconnect_begin (NOT 3-10); anon executes none;
`plaid_test_responses`, `connection_credentials`, `link_attempts` deny anon+authenticated
select; keel_api has the all-policies; connection_credentials unique(household,connection);
non-member begin_link → scope violation.

---

## 2. Edge

### 2a. `_shared/plaid-client.ts` (token-free injection; version-indexed KEK not here)
`interface PlaidClient { linkTokenCreate, sandboxPublicTokenCreate, publicTokenExchange,
accountsGet, itemRemove }`; `createPlaidClient(admin, {env, clientId, secret})`. Per call
`(scopeKey, kind, requestBody)`:
1. Atomic consume-on-read: `admin.rpc('keel_consume_plaid_test_response', {p_scope_key, p_kind})`
   (the RPC does the delete-with-subquery server-side — finding #17). If a row →
   parse it; **for `item_public_token_exchange`, the row has only `{item_id}` → return
   `{access_token: 'access-sandbox-'+scopeKey, item_id}` (token synthesized in Edge memory,
   never from Postgres)**; for `sandbox_public_token_create` return
   `{public_token: 'public-sandbox-'+scopeKey}`; others parsed verbatim.
2. else if clientId+secret: live `fetch(https://${env}.plaid.com/<path>, POST {client_id,
   secret,...requestBody})`; non-2xx → throw `PlaidClientError` with ONLY
   error_code/error_type/request_id.
3. else throw 'plaid unavailable'.
`itemRemove` success = 200 & no error_code (Plaid returns only `{request_id}`; NO `removed`
field post-2019-05-29); `ITEM_NOT_FOUND` ⇒ success. **Never log bodies/tokens.**
Confirmed shapes: exchange→`{access_token,item_id,request_id}`; accounts/get→`{accounts:[{account_id,
name,official_name,mask,type,subtype,balances:{available,current,iso_currency_code,
unofficial_currency_code}}],item,request_id}` (currency in `balances`); item/remove→`{request_id}`.

### 2b. `packages/providers/plaid` pure mapper (unit-tested)
`mapAccountsGetToKeel(body): { accounts: {externalRef,name,subtype,currency,kind}[],
skipped: {externalRef,currency}[] }`. USD gate: `balances.iso_currency_code ?? iso_currency_code`
=== 'USD' → accounts else skipped. **kind (C-12): `type` depository|investment → 'asset';
credit|loan → 'liability'; other → 'asset'** (deterministic; no balances extracted, Law 4).
Unit tests: all-USD, mixed CAD-skipped, empty, missing-currency→skipped, credit→liability,
loan→liability, depository→asset. Add to vendor bundle.

### 2c. `_shared/credential-kek.ts` (C-14 version-indexed KEK)
`getKek(version:number): string` — reads env `KEEL_CREDENTIAL_KEK` (current) keyed by
required `KEEL_CREDENTIAL_KEK_VERSION` (int, NO default), and optional
`KEEL_CREDENTIAL_KEK_V<n>` retained keys; returns the base64 KEK for `version`; throws on
unknown version. `currentKekVersion()`. Encrypt uses current; decrypt selects by
`envelope.kekVersion`. Missing current KEK → callers 500 'credential subsystem unavailable'.

### 2d. `api/index.ts` routes (auth:'user'; internal transitions via a SERVICE client)
Add authz Actions to the closed unions (compile-required): `'connections.link'` +
`'connections.disconnect'` in `@keel/contracts` `CommandName`, in `WRITE_ACTIONS`, and in
`ACTION_MINIMUM_ROLES`='partner' (`packages/authz/src/action.ts`). NOT in COMMAND_TO_PROC.
For the service-only saga transitions use **`ctx.supabaseAdmin`** — the service client
`withSupabase` already provides (this is how `worker/index.ts:578` gets `admin`); do NOT
hand-build one from a raw key. `ctx.supabase` (user client) is used ONLY for the
authorized `begin` calls. KEK + Plaid secrets are read via `Deno.env.get(...)` (same as
`plaid-sync.ts:51` and `webhook-provider`), which is allowed (only `Deno.env.set` is forbidden).

- `POST /api/connections/link` body `{commandId, householdId, entityId, institutionId?}`:
  1. `authorize(ctx,'connections.link',{householdId})` fail-closed.
  2. `keel_begin_link(commandId,...)` via USER client → `{attemptId, credentialId, state, connectionId}`.
     **Replay short-circuit (finding #11):** if `state='succeeded'` return 200 with the existing
     `{connectionId, accountIds}` (query accounts) — do NOT re-run Plaid. If `state='failed'/'reaping'/'reaped'`
     return 409 (that command already terminated). Only `state='initiated'` proceeds to step 3.
     (Resume-from-'exchanged' is a bounded simplification: treat a mid-flight replay as 409 rather
     than resuming — the reaper cleans the earlier attempt's token; note in NOTES.md.)
  3. plaid.sandboxPublicTokenCreate(attemptId) → {public_token} (memory).
  4. plaid.publicTokenExchange(attemptId,{public_token}) → {access_token, item_id}.
  5. `rec = encryptToken(access_token, credentialId, householdId, 'plaid', getKek(currentKekVersion()), currentKekVersion())`.
  6. **try** `keel_record_link_exchange(...)` via SERVICE client. **catch (C-7):**
     `removed = plaid.itemRemove(attemptId,{access_token})` best-effort while token in memory;
     `keel_fail_link_attempt(attemptId, householdId, 'exchange_persist_failed', removed)` → 500.
  7. plaid.accountsGet(attemptId,{access_token}) → `{accounts,skipped}=mapAccountsGetToKeel`.
  8. **if accounts.length===0 (C-13):** `removed = plaid.itemRemove(attemptId,{access_token})`
     best-effort immediately (token in memory); `keel_fail_link_attempt(attemptId, householdId,
     'no_usd_accounts', removed)` → return 422 `{code:'no_supported_accounts'}`. (removed=true ⇒
     envelope shredded now; false ⇒ reaper cleans.) Do NOT wait for the reaper otherwise.
  9. `keel_finalize_link(attemptId, householdId, institutionId, null, accounts)` via SERVICE
     client → `{connectionId, accountIds}`; 200. `access_token` only in local consts; never returned/logged.
- `POST /api/connections/disconnect` body `{householdId, connectionId}`:
  1. `authorize(ctx,'connections.disconnect',{householdId})`.
  2. `keel_disconnect_begin(...)` via USER client → `{removalAttemptId, hasCredentials}`.
  3. if hasCredentials: `env=keel_get_connection_credential_envelope(connectionId)` (SERVICE);
     `token=decryptToken(env, env.credentialId, householdId, 'plaid', getKek(env.kekVersion))`;
     `removed = plaid.itemRemove(connectionId,{access_token:token})` (ITEM_NOT_FOUND⇒true);
     Plaid error ⇒ removed=false + error_code.
     **else (no credentials, C-9): removed=false, failure='no_credentials'** (manual
     intervention — do NOT claim success without a Plaid removal).
  4. `keel_disconnect_complete(householdId, connectionId, removalAttemptId, removed, failureCode|null)` (SERVICE).
  Return `{status: removed?'disconnected':'disconnecting'}`.

### 2e. Reaper — worker route `POST /worker/reap-links` (auth secret:automations)
Widen the worker guard (`worker/index.ts:567` `path!=='/drain'`) to accept `/reap-links`.
`keel_reap_orphan_link_attempts()` (SERVICE) → for each claimed row: rebuild envelope from
base64, `decryptToken(env, credentialId, householdId,'plaid', getKek(kekVersion))`,
`plaid.itemRemove(attemptId,{access_token})` (ITEM_NOT_FOUND⇒removed), then
`keel_mark_link_attempt_reaped(attemptId, reapClaimId, removed, errorCodeOrNull)`. Bounded ≤25.
Never log tokens. (pg_cron scheduling → C6.)

### 2f. Bundle: `pnpm build:functions` after adding the mapper export.

---

## 3. Integration test `tests/integration/09-plaid-link.test.ts`
Item `plaid-item-c3`. Inject token-free `plaid_test_responses`. Alpha household + a Beta user.
Deterministic-key: `access-sandbox-<attemptId>` synthesized in Edge (T8 canary target).
- **T1 happy link** (2 USD accts, exchange inj `{item_id:'plaid-item-c3'}`): 200
  {connectionId,2 ids}; connection 'active'; 2 accounts+ledger_accounts; 1
  connection_credentials; **attempt crypto columns NULL (C-4)**; inject a sync page adding a
  txn → drain → canonical posted; trial_balance reflects.
- **T2 USD gate**: mixed CAD → only USD created.
- **T2b liability mapping (C-12)**: a `credit` USD account → its ledger_account.kind='liability'.
- **T3 disconnect ok** (item_remove `{request_id:'ok'}`): {status:'disconnected'};
  credentials GONE; generation bumped; lease cleared; removal 'succeeded'.
- **T4 disconnect fail** (item_remove `{error_code:'INTERNAL_SERVER_ERROR',error_type:'API_ERROR'}`):
  {status:'disconnecting'}; credentials NOT shredded; removal 'failed'.
- **T5 reauth guard**: `keel_set_connection_reauth(conn,'ITEM_LOGIN_REQUIRED',true)`; enqueue
  sync; drain → acquire refuses (reason 'reauth_required'); canonical count unchanged.
- **T6 reaper happy**: stale 'exchanged' attempt whose envelope is a REAL in-test encryption
  of a dummy token; item_remove ok; POST /worker/reap-links → 'reaped' + crypto cols null
  (prove it decrypted → reached itemRemove via consumed injection row).
- **T7 tenant isolation**: Beta user disconnect on Alpha conn → 403/404; no change.
- **T8 Law-12 canary (C-1/C-15)**: after T1, scan connection_credentials, link_attempts,
  audit_log, connection_health_events, usage_events, AND plaid_test_responses (pre-consume)
  for the synthesized access_token AND public_token literals → absent everywhere.
- **T9 in-flight sync vs disconnect (C-5)**: acquire a lease/open attempt on a connection,
  `keel_disconnect_begin`, then `keel_worker_apply_action`/`complete_attempt` with the held
  owner → refused (P0007 / stale lease); no new canonical rows; cursor/generation not advanced.
- **T10 reaper retry cap (C-6)**: stale attempt, item_remove errors 5×, reap 5× → reap_attempts
  climbs then state 'failed'; no unbounded retry.
- **T11 finalize replay (C-8)**: finalize same attempt twice → one connection, one credentials
  row, one account set; second returns same ids.
- **T12 direct-RPC abuse (C-2/C-15)**: an authenticated user client calling
  `keel_finalize_link`/`keel_disconnect_complete`/`keel_record_link_exchange` directly →
  permission denied (execute not granted to authenticated).
- **T13 exchange-persistence failure (C-7)**: force record_link_exchange to fail (e.g. inject a
  conflicting attempt state) → route best-effort itemRemove consumed + attempt 'failed'; no orphan.
- **T14 dual reaper (C-6)**: two concurrent reap calls over the same stale set → each attempt
  claimed once (SKIP LOCKED); no double itemRemove for one attempt.

## 4. Gate (ALL green; do NOT commit)
`pnpm -w typecheck && pnpm -w lint && pnpm -w test` (incl. mapper units), `supabase test db`
(incl. 004), `scripts/dev/itest.sh` (09 + NO regression on 05/06/08). Update NOTES.md
(decisions + deviations w/ spec cite) + PROGRESS.md. Hand back for post-build dual review.

## 5. Out of scope (do NOT build): real webhook verify → C4; pg_cron + metering breakers → C6;
interactive update-mode relink → 1E; account-lineage id-churn re-match → 1D+; balance_snapshots → deferred.
