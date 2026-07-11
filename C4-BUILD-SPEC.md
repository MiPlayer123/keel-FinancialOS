# C4 Build Spec v3 — Real Plaid webhook verification (Stage 1C, PLAN-1C §4)

> **v3 (confirmation-round fixes):** a Codex v2 confirmation closed most findings; v3 fixes the
> 7 residual: JWK shape/import failure → `unverifiable`/503 not `invalid` (#3); safe-stale needs a
> max grace + not-expired-at-verification + stale-invalid-kid handling (#5); bounded quarantine via
> `webhook_rejections.body_sha256` dedupe (#6); `keel_webhook_record_delivery` supplies NOT-NULL
> `account_external_ref` + the queue `economicEventKey` and returns `{unroutable}` (#8/#19);
> early environment ack-drop BEFORE key resolution so a wrong-env kid can't quarantine real prod
> data (#12); a hermetic `{httpStatus,bodyText}` key-fetch injection seam + consume RPC (#14).


Upgrade the deployed `webhook-provider` function from a single static env JWK to real
Plaid verification: JWK **fetch-by-`kid`** (`/webhook_verification_key/get`) with a
**validated positive cache + safe-stale fallback + bounded negative cache**, `alg=ES256`
pinning, full **JWK shape validation**, **constant-time** body-hash compare, ≤5-min
non-future `iat`, bounded body size, **JWT-fingerprint dedup**, and a correct
**invalid (401) vs unverifiable (503)** classification. Verified webhooks remain the
idempotent "sync this item" trigger.

> **v2 note:** reworked after a dual pre-build review (Claude + Codex), both NEEDS REWORK
> (19 findings). v2 fixes: JWT-fingerprint dedup (body-hash dropped real repeats — Claude
> M1/Codex #7); function EXECUTE revoked from PUBLIC (Codex #1); full JWK-shape validation
> incl. no-`d` (Codex #2); exact `INVALID_WEBHOOK_VERIFICATION_KEY_ID` classification +
> allowlist (Codex #3); negative-cache-as-rate-limit + bounded kid/header (Codex #4);
> safe-stale positive key on outage (Codex #5); Content-Length pre-check (Codex #9);
> dedicated verbatim webhook-record proc (Codex #8); household-neutral operational
> recording — NOT audit_log (Codex #11); authentic wrong-env acked-not-quarantined (Claude
> B1); conditional cache upsert (Codex #10/B2). Build EXACTLY as written.

Read first: `CLAUDE.md` (Laws 2, 5, 12), `PLAN-1C.md` §4, `INFRA.md` §3.
Deterministic + hermetic CI: tests seed the cache via the production RPC and stub the live
client; the live `/webhook_verification_key/get` path is a guarded cache-miss fallback.

## What already exists (extend, don't rebuild)
`supabase/functions/webhook-provider/index.ts`: buffers bytes, `jose.jwtVerify` ES256
(`maxTokenAge:'5 minutes'`), checks `request_body_sha256`, quarantines→401, records via
`keel_worker_record_raw_event` (enqueues `sync_notification`). `tests/integration/05-webhook.test.ts`
signs ES256 with `stackEnv().webhookPrivateJwk` (header `alg`+`typ`, **no kid**, body has a
test-only `nonce`). `PLAID_WEBHOOK_JWK` env = matching public JWK.

## Non-negotiable invariants
- **Law 12:** Plaid `client_id`/`secret` and the raw `Plaid-Verification` header live only in
  Edge memory — never logged/stored/returned. Quarantine strips `plaid-verification`,
  `authorization`, `apikey`.
- **Law 5:** webhook body is data-tier — only ever selects the fixed `item_id → record +
  enqueue sync` path. No body-driven fetch/tool/write.
- **Verify-then-store (D-013):** nothing recorded until signature + JWK-shape + hash +
  environment all pass. **`unverifiable` must NEVER ingest** (no verify-skip).
- **Constant-time** hash compare; never `===`/`!==` on the hash.
- **Transport reality (Codex #6):** Plaid retries EVERY non-200 (401 included) for up to ~24h.
  So 401 vs 503 is a DIAGNOSTIC distinction, not "Plaid won't retry." Quarantine must be
  bounded/idempotent; a real outage returning 503 self-heals on redelivery.

## Confirmed Plaid shapes
- Header `Plaid-Verification`: JWS, protected header `{alg:'ES256', kid, typ:'JWT'}`, payload
  `{iat, request_body_sha256}`.
- `POST /webhook_verification_key/get {client_id, secret, key_id}` →
  `{key:{kty:'EC', kid, use:'sig', alg:'ES256', crv:'P-256', x, y, created_at (unix int),
  expired_at (unix int, nullable)}, request_id}`. Unknown key → HTTP 400
  `error_code:'INVALID_WEBHOOK_VERIFICATION_KEY_ID'`.
- Body hashed over RAW received bytes (never re-serialized).

---

## 1. Migration `supabase/migrations/20260711150000_c4_webhook_keys.sql`

### 1a. `plaid_webhook_keys` (server-only JWK cache)
```
create table public.plaid_webhook_keys (
  kid text primary key,
  jwk jsonb,                              -- validated EC public JWK; null when not_found
  fetched_at timestamptz not null default now(),
  refresh_after timestamptz not null,     -- positive TTL / negative TTL, set by the RPC
  key_created_at timestamptz,             -- from Plaid created_at (to_timestamp)
  key_expired_at timestamptz,             -- from Plaid expired_at (nullable)
  not_found boolean not null default false,
  fetch_failures int not null default 0,
  updated_at timestamptz not null default now(),
  constraint plaid_webhook_keys_kid_len check (char_length(kid) <= 128)
);
```
RLS enable; `revoke all ... from anon, authenticated`. **NO direct grant to service_role**
(Codex #1/m3/#11): the RPCs below are the ONLY access path.

### 1b. Cache RPCs — all `security definer`, `set search_path = public`, owned by keel_api,
**`revoke all ... from public, anon, authenticated; grant execute ... to service_role`**
(Codex #1). Grant keel_api select/insert/update on `plaid_webhook_keys` + a definer all-policy.
1. `keel_webhook_key_get(p_kid text) returns jsonb` — return
   `{jwk, notFound, keyExpiredAt, stale: (refresh_after <= now())}` for the row (null if absent).
   Returns the row EVEN IF stale so the caller can use a **safe-stale positive key on fetch
   failure** (Codex #5). Never bumps anything.
2. `keel_webhook_key_put_positive(p_kid text, p_jwk jsonb, p_key_created_at timestamptz,
   p_key_expired_at timestamptz) returns void` — upsert a validated positive key;
   `refresh_after = least(now() + interval '24 hours', coalesce(p_key_expired_at, 'infinity'))`,
   `not_found=false, fetch_failures=0, jwk=p_jwk`. **Positive always dominates** (on conflict
   overwrite). (Edge passes `to_timestamp(unix)` — Codex #10.)
3. `keel_webhook_key_put_negative(p_kid text) returns void` — upsert `not_found=true, jwk=null,
   refresh_after = now() + interval '10 minutes'` **ONLY IF no fresh positive row exists**
   (`insert ... on conflict (kid) do update ... where plaid_webhook_keys.not_found or
   plaid_webhook_keys.refresh_after <= now()`) — a fresh positive key must NOT be clobbered by
   a negative write (Codex #10/B2).
4. `keel_webhook_key_bump_failure(p_kid text) returns void` — `fetch_failures += 1, updated_at=now()`
   for observability on outage (no row create if absent; Codex #10/M3).
These four are the sole DML on the table.

### 1c. Verbatim delivery-record proc `keel_webhook_record_delivery` (Codex #8)
The existing `keel_worker_record_raw_event` takes only `p_body` and can't carry the fingerprint
or populate `body_text/body_sha256`. Add:
`keel_webhook_record_delivery(p_connection_external_ref text, p_provider_event_id text,
p_body jsonb, p_body_text text, p_body_sha256 text, p_received_at timestamptz) returns jsonb`
— resolve the connection (STRICT plaid lookup like record_raw_event; **on no-match return a typed
`{unroutable:true}` rather than raising** so the handler can 200/{routed:false} — finding #19).
Insert raw_provider_events with verbatim `body=p_body`, `body_text=p_body_text`,
`body_sha256=p_body_sha256`, **`account_external_ref='item-notification'` (NOT NULL col — finding
#8)**, `provider_event_id=p_provider_event_id` (dedup on the existing `(connection_id, provider,
provider_event_id)` unique — returns `duplicate=true` on conflict, no re-enqueue), audit
`ingest.webhook_recorded` (household from the resolved connection — this proc HAS a household, so
audit_log is fine here), and `keel_enqueue('sync_events', jsonb_build_object('jobType',
'sync_notification', **'economicEventKey', 'plaid:webhook:'||v_raw_id::text** (finding #8 — worker
queue contract requires it), 'refs', jsonb_build_object('connectionId', v_conn.id::text)))`.
Owned keel_api/keel_worker; execute→service_role. p_body stays verbatim (NO fingerprint injected).

### 1d. Bounded quarantine + hermetic key-fetch seam
- **Bounded quarantine (finding #6):** `alter table public.webhook_rejections add column
  body_sha256 text;` + `create index webhook_rejections_dedupe on public.webhook_rejections
  (body_sha256, reason, created_at);` The Edge `quarantine()` skips inserting when an identical
  `(reason, body_sha256)` row exists within a recent window (e.g. 1h). (Global rate cap → C6.)
- **Key-fetch injection (finding #14, server-only):**
  ```
  create table public.plaid_webhook_key_test_responses (
    id uuid primary key default gen_random_uuid(), kid text not null,
    ordinal int not null default 0, http_status int not null, body_text text not null,
    created_at timestamptz not null default now());
  ```
  RLS on; revoke anon/authenticated; grant select/insert/delete to service_role. RPC
  `keel_consume_webhook_key_response(p_kid text) returns jsonb` — atomic delete-returning the
  lowest-ordinal row for the kid as `{httpStatus, bodyText}` (null if none); security definer,
  revoke public/anon/authenticated, execute→service_role.

### 1e. pgTAP `supabase/tests/005_c4_webhook_keys.sql`
Assert: `plaid_webhook_keys` + RLS; anon/authenticated denied SELECT; **every C4 RPC
(`keel_webhook_key_get/put_positive/put_negative/bump_failure`, `keel_webhook_record_delivery`,
`keel_consume_webhook_key_response`) REVOKEs execute from public/anon/authenticated and grants
only service_role** (negative-ACL test — Codex #1/#13); positive put→get round-trip; negative put
does NOT overwrite a fresh positive (Codex #10); stale flag when refresh_after past;
`keel_webhook_record_delivery` dedups a repeated provider_event_id and returns `{unroutable:true}`
for an unknown item; `webhook_rejections.body_sha256` column exists.

---

## 2. Edge

### 2a. `_shared/plaid-webhook-verify.ts` — pure-ish, dependency-injected
`verifyPlaidWebhook(bodyBytes, verificationHeader, deps) : Promise<Verdict>`,
`Verdict = {outcome:'verified'|'invalid'|'unverifiable', reason, body?}`. `deps` = `{keyResolver}`
where `keyResolver(kid) : Promise<{jwk?, notFound?, stale?, outage?}>` (so unit tests inject
hit/miss/fetch-400/fetch-throw without live Plaid).
1. **Bounded size FIRST (Codex #9):** caller checks `Content-Length` header and rejects
   `> MAX_WEBHOOK_BYTES` (1 MiB) BEFORE `arrayBuffer()`; also cap `verificationHeader.length`
   (≤ 8 KiB). Oversized → `invalid` (no full read, no parse).
2. `jose.decodeProtectedHeader(jwt)`; require `alg==='ES256'`, `typ==='JWT'`, and a string
   `kid` with `length ≤ 128`; else `invalid`. (Belt with `jwtVerify({algorithms:['ES256']})`
   to block alg-confusion incl. `none`/HS256/RS256 — Codex #2, Claude H2.)
3. **Resolve key:** `keyResolver(kid)`:
   - fresh positive → use jwk.
   - `notFound` (negative cache) → `invalid`.
   - stale positive + fetch OK → refresh (put_positive) → use new jwk.
   - stale positive + fetch FAILS (outage) → **safe-stale (hardened, finding #5):** use the stale
     positive jwk ONLY if (a) within a fixed stale grace `now() - fetched_at ≤ STALE_GRACE`
     (e.g. 72h) AND (b) the key is not expired at verification time (`key_expired_at` null or
     `> token.iat`); else → `unverifiable`. bump_failure.
   - stale positive + fetch `INVALID_WEBHOOK_VERIFICATION_KEY_ID` (key rotated out entirely) →
     put_negative (replaces the stale positive) → `invalid` (finding #5).
   - miss + fetch OK → validate + put_positive → use jwk.
   - miss + fetch `INVALID_WEBHOOK_VERIFICATION_KEY_ID` (HTTP 400, exact code) → put_negative →
     `invalid`.
   - miss + fetch outage/5xx/429/timeout/network OR missing `PLAID_CLIENT_ID`/`SECRET` or
     `PLAID_ENV≠sandbox` config → bump_failure → **`unverifiable`** (Codex #3/#4).
4. **Validate JWK shape BEFORE import/cache (Codex #2):** `kty==='EC'`, `crv==='P-256'`,
   `alg` absent or `'ES256'`, `use` absent or `'sig'`, `kid===requested kid`, string `x` & `y`
   present, and **no `d`** (never a private key). **A shape/import FAILURE of a fetched-or-cached
   key is OUR infra fault, not proof of a forged delivery → `unverifiable`/503, NOT quarantine or
   negative-cache (finding #3).** (Only an exact HTTP-400 `INVALID_WEBHOOK_VERIFICATION_KEY_ID`
   negative-caches; a signature failure against a VALID imported key stays `invalid`/401.)
5. `jose.jwtVerify(jwt, importJWK(jwk,'ES256'), {algorithms:['ES256'], maxTokenAge:'300s',
   clockTolerance:'5s'})`. Explicit **future-iat** guard: `payload.iat*1000 > Date.now()+5000 → invalid`.
   Verify fail → `invalid`. (Effective replay window ≈ 305 s; replay defense is dedup, not iat —
   Claude B3/Codex #14.)
6. `request_body_sha256`: require a 64-char lowercase-hex string (`invalid` otherwise, BEFORE
   compare — Claude m1), then **constant-time** equal to `sha256Hex(bodyBytes)` (fixed-64-length
   XOR-accumulate; never `!==`). Mismatch → `invalid`.
7. Parse JSON (`invalid` if not). Return `verified` + parsed body + the JWT fingerprint
   `sha256Hex(utf8(verificationHeader))`.

### 2b. Handler flow (`auth:'none'`, `/health`, `POST /plaid`)
0. **Bounded read** (Content-Length gate, §2a step 1). Then **early environment ack-drop
   (finding #12):** attempt a cheap `JSON.parse` of the raw bytes purely to read `environment`;
   if it parses AND `environment` is a string `!== 'sandbox'` → **200 ack, NO store, NO key
   fetch, NO quarantine** (a wrong-environment kid would 400 at fetch and get mis-quarantined
   with real prod data otherwise). This is a non-action on unverified data (safe: acking a
   forgery that claims `environment:'production'` just declines to log it — no ingestion). If it
   doesn't parse or `environment` is sandbox/absent, proceed to verify.
1. `verifyPlaidWebhook(...)` →
- **`verified`** (implies `environment==='sandbox'`): dedup+record via
  `keel_webhook_record_delivery` with `provider_event_id = 'plaid:webhook:' || jwtFingerprint`
  (Claude M1/Codex #7). **If it returns `{unroutable:true}` (unknown item — finding #19):**
  quarantine `'unroutable'` (bounded, below) → **200 `{received:true, routed:false}`** (NOT a 5xx —
  matches the deployed handler `index.ts:141-145`; a verified-but-unroutable notification must not
  make Plaid retry forever). Else → 200 `{received:true, routed:true, rawEventId}`.
- **`invalid`:** `quarantine(reason, bodyBytes, headers)` → **401**. **Bounded (finding #6):** add
  `body_sha256` to `webhook_rejections` and skip the insert if an identical `(reason, body_sha256)`
  row exists within a recent window (dedupe a forgery flood); check the insert `{error}` (Codex
  #15). A hard global quarantine-rate cap → C6 breakers (noted).
- **`unverifiable`:** do NOT quarantine, do NOT record → **503** `{code:'verification_unavailable'}`
  (fetch_failures already bumped for observability — Codex #6/M3).

### 2c. Live key fetch — `_shared/plaid-webhook-key.ts` (with hermetic seam — finding #14)
`fetchWebhookVerificationKey(admin, keyId) : Promise<{status:'ok', key} | {status:'invalid_kid'} |
{status:'outage'}>` — a DEDICATED fetch that **preserves HTTP status + exact `error_code`**
(do NOT route through the C3 `PlaidClientError` normalizer, which collapses unknown codes to
`provider_error` — Codex #3).
- **Hermetic injection FIRST (finding #14 — the C3 `plaid_test_responses` carries only body text,
  not an HTTP status):** atomic-consume from `plaid_webhook_key_test_responses` via
  `keel_consume_webhook_key_response(p_kid)` returning `{httpStatus, bodyText}` (null if none). A
  200 with a valid `{key}` → `ok`; a 400 with `error_code==='INVALID_WEBHOOK_VERIFICATION_KEY_ID'`
  → `invalid_kid`; any other status/shape → `outage`. Tests seed rows + assert the consumption
  count (one fetch, then negative-cache short-circuits — fixes Codex #12).
- else **live:** bounded timeout (e.g. 4 s), POST `/webhook_verification_key/get` with
  `PLAID_CLIENT_ID`/`SECRET`; classify by HTTP status + exact code. `PLAID_ENV!=='sandbox'` or
  missing creds → `outage` (config → unverifiable, never verify-skip). Never log request body/creds/full key.

---

## 3. Tests

### 3a. `tests/integration/05-webhook.test.ts` — keep 3 existing green, add kid + cases
`signBody` adds a `kid` to the protected header; tests seed that kid's PUBLIC JWK via the
production RPC `keel_webhook_key_put_positive` (NOT a direct insert — Codex #13). **Remove the
`nonce`** from `webhookBody` and add a real-Plaid-shape (nonce-free) case (Claude H1/M1):
- **valid + kid cache hit** → 200 recorded; **exact-JWT redelivery** → deduped.
- **nonce-free distinct notifications** (two deliveries, different `iat`/JWT, identical body) →
  BOTH record (distinct fingerprints) + both enqueue sync (idempotent) — proves M1 fixed.
- **unknown kid + invalid_kid fetch** (seed `plaid_webhook_key_test_responses` with one
  `{httpStatus:400, INVALID_WEBHOOK_VERIFICATION_KEY_ID}` — the hermetic seam #14) → 401 + one
  negative-cache write; **redeliver same kid → zero further fetches** (assert the injection
  consumption count is 1; negative cache short-circuits — Codex #12).
- **verified but unroutable** (valid signature+kid but `item_id` maps to no connection) →
  **200 `{routed:false}`**, quarantined 'unroutable', NOT a 5xx (finding #19).
- **bad-JWK-shape from fetch → unverifiable** (seed a 200 whose key has wrong `crv`/missing `y`) →
  **503**, NOT 401, NOT negative-cached (finding #3).
- **unknown kid + fetch outage** (stub throws / missing creds) → **503**, NOT quarantined, NOT
  recorded; then seed key + redeliver → 200 (Codex #3/Claude H3 — MANDATORY: unverifiable never ingests).
- **safe-stale** : seed a positive key with `refresh_after` in the past + stub fetch outage →
  still 200 verified via stale key (Codex #5).
- **alg-confusion**: explicit `alg:'none'`, `HS256` (HMAC with the public JWK bytes), `RS256`,
  `ES384` → each 401 (Codex #13/Claude H2).
- **kid/curve mismatch**: JWT kid=K but signed with K2 → 401; seeded JWK with wrong `crv` → 401.
- **future iat** (`now+10m`) → 401; **expired iat** (`now-1h`) → 401; **tamper body** → 401.
- **environment≠sandbox** (validly signed, `environment:'production'`) → **200 ack, NO raw event,
  NO quarantine row** (Claude B1).
- **oversized body** (`Content-Length` > 1 MiB) → 401, not fully read.
- **negative-does-not-clobber-positive** (Codex #10): seed positive, attempt negative put → positive survives.
- **public-RPC denial** (Codex #1): anon/authenticated calling the 5 RPCs → denied (pgTAP 005 + an integration assert).
- **Law 12 canary**: `PLAID_SECRET`/`PLAID_CLIENT_ID` and the raw verification header absent from
  webhook_rejections, raw_provider_events, audit_log, plaid_webhook_keys — AND from captured
  logs when the live client is exercised with a mocked `fetch` (Codex #16).

### 3b. Unit tests for `verifyPlaidWebhook` + `plaid-webhook-key` (inject `keyResolver`/`fetch`):
constant-time compare (equal/unequal/bad-length), outcome routing (verified/invalid/unverifiable)
across hit / stale-refresh-ok / stale-outage-safe-stale / miss-fetch-ok / miss-invalid-kid /
miss-outage / bad-JWK-shape / no-`d` enforcement, alg/kid/iat/env guards.

## 4. Gate (ALL green; do NOT commit until dual post-build review)
`pnpm -w typecheck && lint && test`, `supabase test db` (incl. 005), `scripts/dev/itest.sh`
(05 extended + NO regression on 04/06/08/09). Update NOTES.md + PROGRESS.md.

## 5. Out of scope → later: live Plaid Dashboard webhook URL config (⚑ human); global Plaid-call
budget/breaker + pg_cron key pre-warm/rotation sweep → C6 (C4 does bounded kid + negative-cache
rate-limit only); prod (non-sandbox) webhooks → later ⚑.
