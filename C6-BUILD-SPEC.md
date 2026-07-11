# C6 Build Spec — Metering + breakers + pg_cron (Stage 1C, PLAN-1C D-G / INFRA §14)

Close Stage 1C's operational loop: **meter** every external Plaid call into
`usage_events` (no secrets); enforce **breakers** (global daily Plaid-call budget +
per-item sync-rate; per-item concurrency already enforced by the C5b lease); and
**schedule** active-item syncs + the orphan-link reaper via `pg_cron` as pure-SQL
orchestration (INFRA §8: cron holds NO financial business logic). Also lands the
C4-deferred global quarantine-rate cap.

Read first: `CLAUDE.md` (Laws 2, 12), `PLAN-1C.md` D-G, `INFRA.md` §8/§14.
Deterministic + hermetic CI: tests call the cron/breaker SQL FUNCTIONS directly and
assert enqueue/refusal + the `cron.job` rows exist — they never wait for a real tick.

## Non-negotiable invariants
- **Law 12:** `usage_events.metadata` carries only `{kind, latencyMs, ok, errorCode,
  requestId, itemRef}` — NEVER a token, client_id/secret, JWK private material, or a
  raw body. `errorCode` is already allowlist-normalized (C4/C3).
- **INFRA §8:** cron jobs call ONLY thin enqueue/orchestration SQL — no posting, no
  ledger math, no crypto. They enqueue to `pgmq` (workers do the work) or `net.http_post`
  the existing authenticated Edge routes.
- **INFRA §14 "no claim a job ran until its result is recorded":** each cron function
  records what it enqueued/attempted; a breaker-open refusal is itself metered.
- **No new economic effect:** breakers only REFUSE or DELAY; they never mutate the ledger.

## What already exists
- `usage_events` (C2a): `(id, household_id NOT NULL, actor_user_id, event_type,
  resource_type, resource_id, metadata jsonb, occurred_at)` + member-read RLS.
- Per-item concurrency = the C5b durable lease (`keel_worker_acquire_sync_lease` — one
  open attempt per connection). C6 does NOT re-implement it; it documents it as the
  concurrency breaker and adds a pgTAP note.
- `pgmq` enabled; `sync_events` queue; `keel_enqueue`. `scheduled` Edge function
  (`auth:'secret:automations'`, `/tick`) currently a stub.
- Plaid call sites to meter: C3 `/connections/link` (sandbox_public_token_create,
  item_public_token_exchange, accounts_get), `/connections/disconnect` (item_remove),
  `/worker/reap-links` (item_remove), C4 webhook key fetch (webhook_verification_key_get).

## 1. Migration `supabase/migrations/20260711160000_c6_metering_cron.sql`

### 1a. Meter schema
- `alter table public.usage_events alter column household_id drop not null;` — system
  calls (JWK fetch, reaper) have no household. Add
  `add column provider text, add column latency_ms int, add column ok boolean,
   add column error_code text, add column request_id text` (explicit columns for the
  metered fields; `metadata` stays for anything extra). Member-read RLS already filters
  by household; a NULL-household row is system-only (service_role reads it).
- Index `usage_events_provider_time on (provider, occurred_at)` for budget counting.

### 1b. Breaker state
```
create table public.provider_call_budget (
  budget_date date not null,
  provider text not null,
  call_count int not null default 0,
  primary key (budget_date, provider)
);
```
RLS on; server-only (no anon/authenticated). Daily counter per provider.

### 1c. Metering + breaker RPCs (security definer, owned keel_api, execute→service_role
via the c5b/c3 ownership block; REVOKE from public/anon/authenticated):
1. `keel_meter_provider_call(p_provider text, p_kind text, p_household_id uuid,
   p_latency_ms int, p_ok boolean, p_error_code text, p_request_id text, p_item_ref text)
   returns void` — insert a `usage_events` row (event_type='provider_call', metadata =
   `{kind, itemRef}`, columns for provider/latency/ok/error_code/request_id). Whitelist —
   never accepts a token/secret param. Also `insert ... on conflict (budget_date, provider)
   do update set call_count = provider_call_budget.call_count + 1` when `p_ok is not null`
   (count every attempted call).
2. `keel_provider_budget_check(p_provider text, p_daily_limit int) returns boolean` —
   `true` if today's `call_count < p_daily_limit` (breaker CLOSED, ok to call), else
   `false` (OPEN). Read-only.
3. `keel_sync_rate_check(p_connection_id uuid, p_min_interval_seconds int) returns boolean`
   — `true` if the connection's `last_successful_sync_at` is null or older than the
   interval (ok to enqueue a sync), else `false`. Per-item sync-rate breaker.

### 1d. Cron orchestration functions (pure SQL — enqueue only; NO business logic)
- `keel_cron_enqueue_active_syncs(p_min_interval_seconds int default 900) returns int` —
  for each `connections` row with `provider='plaid'` and `status='active'` where
  `keel_sync_rate_check` passes, `keel_enqueue('sync_events', {jobType:'sync_notification',
  economicEventKey:'cron:sync:'||id||':'||floor(extract(epoch from now())/900),
  refs:{connectionId:id}})`; return the count enqueued. Metered: one `usage_events`
  row `event_type='cron_enqueue_syncs'` with the count (system household null). Idempotent
  within a window via the economicEventKey bucket + the worker's provider_event dedup.
- Owned keel_api/keel_worker; execute→service_role (called by the Edge `scheduled/tick`
  AND/OR directly by pg_cron).

### 1e. Bounded quarantine cap (C4-deferred): extend `keel_webhook_quarantine` (or add a
guard) so a global per-`(provider, hour)` cap (e.g. 10k rows/hour) short-circuits inserts
once exceeded (count via an index) — returns false (dropped) and meters a
`quarantine_capped` usage_event. Prevents unbounded quarantine growth under a forgery flood.

### 1f. pg_cron schedules
```
create extension if not exists pg_cron;
```
Then `cron.schedule(...)`:
- `'keel-active-syncs'` — every 15 min → `select public.keel_cron_enqueue_active_syncs();`
  (pure SQL, no HTTP — enqueues to pgmq; the worker drains).
- `'keel-reap-links'` — hourly → `net.http_post(<scheduled or worker /reap-links URL>,
  headers:=automations-secret)` IF `pg_net` is available; the reaper MUST run in Edge (it
  decrypts + calls Plaid /item/remove). **If `pg_net`/`net.http_post` is NOT available in
  the local stack, register the SQL-enqueue cron only, and record the reaper-cron as a
  documented deploy-time ⚑ (the reaper endpoint exists from C3; wiring the scheduled HTTP
  trigger is a Supabase-dashboard/Cron config step).** Do NOT block C6 on pg_net.
- Guard all `cron.schedule` calls to be idempotent (`cron.unschedule` if exists, or check
  `cron.job`), since `db reset` re-runs migrations.

### 1g. pgTAP `supabase/tests/006_c6_metering_cron.sql`
Assert: `usage_events.household_id` nullable; `provider_call_budget` + RLS deny anon/auth;
the C6 RPCs revoke public/anon/authenticated + grant service_role; `pg_cron` extension
present; the `keel-active-syncs` cron job row exists in `cron.job`; a
`keel_meter_provider_call` insert bumps the daily budget; `keel_provider_budget_check`
flips at the limit; `keel_sync_rate_check` respects the interval.

## 2. Edge — wire metering + breakers into the Plaid call sites
- `_shared/plaid-meter.ts`: `meterCall(admin, {provider:'plaid', kind, householdId?,
  start, ok, errorCode?, requestId?, itemRef?})` — computes latency from `start`, calls
  `keel_meter_provider_call`. Never receives tokens.
- Wrap each live Plaid call in `plaid-client.ts` / `plaid-webhook-key.ts` /
  disconnect/reaper so that after the call (success OR error) `meterCall` runs (latency +
  ok + normalized errorCode + requestId + itemRef=attemptId/connectionId). The injection
  (test) path may skip metering or meter with `kind:'injected'` — keep CI hermetic.
- **Budget breaker at the call sites that INITIATE Plaid work:** before a live
  `/connections/link` exchange and before a webhook key fetch, call
  `keel_provider_budget_check('plaid', DAILY_LIMIT)`; if OPEN → the link route returns
  503 `{code:'provider_budget_exhausted'}` and the webhook path returns `unverifiable`
  (503, never verify-skip). The injected/test path bypasses the budget (hermetic).
- `scheduled/index.ts` `/tick`: replace the stub — call
  `keel_cron_enqueue_active_syncs()` and return the enqueued count (so the endpoint is
  drivable by an external scheduler too). Keep `auth:'secret:automations'`.

## 3. Tests
### 3a. Integration `tests/integration/10-metering-cron.test.ts`
- **meter on link:** run a C3 link (injected) with metering enabled on the injected path
  (`kind:'injected'`) → assert `usage_events` rows for the link's provider calls exist
  with NO token/secret substring (Law 12 canary), latency/ok populated.
- **budget breaker:** seed `provider_call_budget` at the limit → `keel_provider_budget_check`
  false; a link attempt returns 503 provider_budget_exhausted (drive via a low test limit).
- **sync-rate breaker:** a connection synced <15m ago → `keel_sync_rate_check` false →
  `keel_cron_enqueue_active_syncs` skips it; an idle/never-synced connection → enqueued;
  drain `sync_events` → the enqueued sync runs.
- **cron enqueue via /tick:** POST `/scheduled/tick` → returns enqueued count; the jobs drain.
- **quarantine cap:** seed the cap and assert an over-cap invalid webhook is dropped
  (metered `quarantine_capped`) not inserted.
- No regression on 04/05/06/08/09.
### 3b. Unit: `plaid-meter` latency/whitelist; the budget/rate check pure logic.

## 4. Gate (ALL green; do NOT commit until dual post-build review)
`pnpm -w typecheck && lint && test`, `supabase test db` (incl. 006 — verify `pg_cron`
actually enables under `db reset`; if the extension can't load locally, STOP and note it
as a C6 build blocker rather than faking it), `scripts/dev/itest.sh` (10 + no regression).
Update NOTES.md + PROGRESS.md.

## 5. Out of scope → later: AI/storage/export breakers → 1D+ (D-G says storage/export move
to 1D); real cloud pg_cron/pg_net wiring + the reaper HTTP trigger → deploy-time ⚑;
per-user/global rate-limit on the public webhook beyond the quarantine cap → future.
