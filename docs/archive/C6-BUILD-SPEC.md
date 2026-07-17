# C6 Build Spec v2 — Metering + breakers + pg_cron (Stage 1C, PLAN-1C D-G / INFRA §14)

Close Stage 1C's operational loop: **meter** every live Plaid call into `usage_events`
(no secrets); enforce **breakers** (atomic global daily Plaid-call budget + atomic
per-item sync-cadence claim; per-item concurrency already = the C5b lease); and **schedule**
active-item sync enqueue via `pg_cron` as pure-SQL orchestration. Also lands the C4-deferred
quarantine rate cap.

> **v2** reworked after a dual pre-build review (Claude BUILD-WITH-FIXES / Codex NEEDS REWORK).
> Key shifts: **atomic reserve-then-confirm budget** (not check-then-call TOCTOU); **atomic
> `next_sync_eligible_at` cadence claim** excluding live leases/outstanding generations (not
> `last_successful_sync_at`, which wedges failing items and doesn't reserve); **counter-based
> quarantine cap** (not count(*)); **meter whitelist hardening** (closed kind set, uuid item
> ref, normalized error_code); **only the pure-SQL enqueue cron in the migration** — the
> HTTP/secret-bearing drain + reaper crons are deploy-time ⚑ (a secret in `cron.command`
> would leak per Law 12; a bare `create extension pg_cron` would brick `db reset` if not
> preloaded → guard both); single owner `keel_worker` + explicit grants + definer policies.

Read first: `CLAUDE.md` (Laws 2, 12), `PLAN-1C.md` D-G, `INFRA.md` §8/§14, and:
`usage_events`/`connections` (C2a), `keel_enqueue`/pgmq, `keel_webhook_quarantine` (C4),
`plaid-client.ts`/`plaid-webhook-key.ts`/`plaid-meter` call sites, the C5c live sync call site.

## Invariants
- **Law 12:** `usage_events` + meter params carry ONLY `{provider, kind (closed set),
  latencyMs, ok, errorCode (already normalized by PlaidClientError), requestId (bounded
  ^[A-Za-z0-9_-]{1,64}$), itemRef (uuid or null), quantity}`. NEVER a token/secret/JWK/body.
  **No secret in any `cron.command`** — HTTP-invoking crons (needing the automations secret)
  are deploy-time config, not migrations.
- **INFRA §8:** cron functions only enqueue/claim — no posting, ledger math, or crypto.
- **Law 2 (operational-telemetry exception, documented):** budget counters + cron enqueue
  are operational telemetry recorded in `usage_events`/`provider_call_budget`, NOT economic
  events → they do NOT write `audit_log` (which requires a household + models economic
  mutations). Stated explicitly here.
- **Breakers only REFUSE/DELAY, never mutate the ledger; never verify-skip** (a budget-open
  webhook stays 503, never ingests).

## 1. Migration `supabase/migrations/20260711160000_c6_metering_cron.sql`

### 1a. Meter schema
`alter table public.usage_events alter column household_id drop not null,
 add column provider text, add column kind text, add column latency_ms int,
 add column ok boolean, add column error_code text, add column request_id text,
 add column quantity int;` (system rows have null household — hidden from the member-read
 RLS since `keel_is_household_member(null)` is false; service_role-only). Index
 `usage_events_provider_time (provider, occurred_at)`. `kind` CHECK ∈ a closed set
 {link_token_create, sandbox_public_token_create, item_public_token_exchange, accounts_get,
 item_remove, webhook_key_get, transactions_sync, cron_enqueue_syncs, quarantine_capped,
 budget_refused}.
The meter RPC (security definer, owner keel_worker, execute→service_role, REVOKE
public/anon/authenticated): `keel_meter_provider_call(p_provider text, p_kind text,
p_household_id uuid, p_latency_ms int, p_ok boolean, p_error_code text, p_request_id text,
p_item_ref uuid, p_quantity int) returns void` — validate `p_kind` ∈ the closed set and
`p_request_id ~ '^[A-Za-z0-9_-]{1,64}$'` (or null); insert one `usage_events` row
(event_type='provider_call'). It accepts NO token/secret param.

### 1b. Budget breaker (atomic reserve)
```
create table public.provider_call_budget (
  budget_date date not null, provider text not null, call_count int not null default 0,
  primary key (budget_date, provider));
```
RLS on; server-only (no anon/authenticated). RPCs (security definer, owner keel_worker,
execute→service_role, REVOKE public/anon/authenticated):
- `keel_provider_budget_reserve(p_provider text, p_daily_limit int) returns boolean` —
  **atomic reserve:** `insert into provider_call_budget(budget_date, provider, call_count)
  values (current_date, p_provider, 1) on conflict (budget_date, provider) do update
  set call_count = provider_call_budget.call_count + 1 where provider_call_budget.call_count
  < p_daily_limit returning true`. Returns `true` (slot granted) iff a row was written/updated;
  `false` (breaker OPEN) when the guard failed. Closes the TOCTOU + lost-update (Claude/Codex).
- `keel_provider_budget_refund(p_provider text) returns void` — `call_count = greatest(0,
  call_count - 1)` for today (refund an injected/skipped call so tests + no-op paths don't
  consume budget).

### 1c. Sync-cadence claim (per-item rate breaker, atomic)
`alter table public.connections add column next_sync_eligible_at timestamptz;`
- `keel_cron_enqueue_active_syncs(p_min_interval_seconds int default 900) returns int` —
  **atomic claim + enqueue, pure SQL:**
  ```
  with claimed as (
    update public.connections c set next_sync_eligible_at = now() + make_interval(secs => p_min_interval_seconds)
     where c.provider='plaid' and c.status='active'
       and (c.next_sync_eligible_at is null or c.next_sync_eligible_at <= now())
       and c.sync_lease_owner is null                       -- not mid-sync
       and c.sync_committed_generation = c.sync_desired_generation  -- no outstanding work
     returning c.id, c.household_id)
  ... for each claimed: keel_enqueue('sync_events', {jobType:'sync_notification',
      economicEventKey: format('cron:sync:%s:%s', id, extract(epoch from now())::bigint),
      refs:{connectionId:id}}) ...
  ```
  The `update ... returning` atomically advances `next_sync_eligible_at` so concurrent ticks
  / duplicate calls claim each connection AT MOST ONCE per window (Codex #5/#7, Claude #4/#6);
  excludes leased/outstanding items. Meter one `usage_events` row
  (kind='cron_enqueue_syncs', quantity=count, null household). Owner keel_worker; execute→service_role.
  (No business logic — pure claim+enqueue, INFRA §8.)

### 1d. Quarantine cap (C4-deferred) — counter, not count(*)
```
create table public.webhook_rejection_counters (
  provider text not null, hour_bucket timestamptz not null, count int not null default 0,
  primary key (provider, hour_bucket));
```
Extend `keel_webhook_quarantine` (C4): after the advisory lock + dedupe check, before insert,
atomically `insert ... (provider, date_trunc('hour', now()), 1) on conflict do update set
count = count + 1 where count < p_hourly_cap returning true`; if the cap guard fails → do NOT
insert the rejection, meter `usage_events` kind='quarantine_capped', return false (Codex #8,
Claude #3). O(1), race-safe (same advisory lock + atomic counter).

### 1e. pg_cron (guarded; pure-SQL cron ONLY)
- **CONFIRMED: `pg_cron` (and `pg_net`) are ALREADY in the Supabase local image's
  `shared_preload_libraries`; `create extension pg_cron` succeeds. Do NOT touch `config.toml`
  `[db.settings]` — that key is UNSUPPORTED by this CLI and breaks `db reset` config parsing
  (proven). No config change is needed.**
- Migration: guard everything so a missing pg_cron degrades (does NOT brick db reset):
  ```
  do $$ begin
    create extension if not exists pg_cron;
    perform cron.schedule('keel-active-syncs', '*/15 * * * *',
      $c$ select public.keel_cron_enqueue_active_syncs(); $c$);  -- idempotent: unschedule-if-exists first
  exception when others then raise notice 'pg_cron unavailable; enqueue callable via /scheduled/tick'; end $$;
  ```
  Only the PURE-SQL enqueue cron (no secret) is registered here. **The `/worker/drain`,
  `/worker/reap-links`, and any Edge-invoking crons need the automations secret → they are
  DEPLOY-TIME ⚑ (Supabase Cron dashboard / pg_net with a vaulted secret), NOT in a migration**
  (secret in cron.command = Law 12 leak — Codex #1). Documented in §5 + NOTES.

### 1f. Grants/ownership/policies
All C6 RPCs owned by keel_worker via the ownership block; REVOKE public/anon/authenticated;
execute→service_role. `grant insert on usage_events to keel_worker` + a definer all-policy;
`grant select,insert,update on provider_call_budget, webhook_rejection_counters to keel_worker`
+ definer all-policies (RLS is on; keel_worker is non-BYPASSRLS — mirror C4/C5b `*_worker_all`).

### 1g. pgTAP `supabase/tests/007_c6_metering_cron.sql`
usage_events.household_id nullable; provider_call_budget + webhook_rejection_counters RLS deny
anon/auth; all C6 RPCs revoke public/anon/authenticated + grant service_role; reserve grants a
slot then flips false at the limit; refund decrements; cadence claim advances
next_sync_eligible_at + excludes leased/generation-outstanding; **conditional** cron.job
assertion (`if exists(select 1 from pg_extension where extname='pg_cron')`).

## 2. Edge — wire metering + budget
- `_shared/plaid-meter.ts`: `meterCall(admin, {provider, kind, householdId?, start, ok,
  errorCode?, requestId?, itemRef?, quantity?})` → `keel_meter_provider_call` (RPC that inserts
  usage_events; strict-typed params, no token). Compute latency from `start`.
- Wrap EVERY live Plaid call site (C3 link/exchange/accounts/remove + reaper item_remove,
  C4 webhook_key_get, C5c transactions_sync) so after the call (ok OR error) meterCall runs
  with the normalized errorCode + requestId + itemRef. The injected/test paths meter with
  kind unchanged but are budget-exempt (below) — keep CI hermetic.
- **Budget reserve at the network boundary ONLY** (Claude #5, Codex #3): before a LIVE Plaid
  fetch (link exchange, webhook key fetch, transactions_sync), call
  `keel_provider_budget_reserve('plaid', DAILY_LIMIT)`; if false → link route 503
  `provider_budget_exhausted`; webhook key fetch → `outage` (⇒ the resolver's 503/unverifiable,
  **never verify-skip**, and a cached-fresh-key webhook must still verify — do NOT gate the
  accept boundary); transactions_sync → treat as a transient (no cursor advance). Injected/test
  paths + no-op paths skip reserve (or reserve+refund) so hermetic CI is unaffected. Meter a
  `budget_refused` row on refusal (no budget consumed).
- `scheduled/index.ts` `/tick`: replace the stub → `keel_cron_enqueue_active_syncs()` + return
  the count (drivable by an external scheduler). Keep `auth:'secret:automations'`.

## 3. Tests
### 3a. Integration `tests/integration/10-metering-cron.test.ts`
- **meter on a metered call:** a C3 link (injected) meters its provider calls → `usage_events`
  rows exist, Law-12 canary (no token/secret/JWK/request-body substring anywhere), latency/ok set.
- **budget reserve/flip:** low test limit → `keel_provider_budget_reserve` grants then flips
  false; a link at the limit → 503 provider_budget_exhausted; refund decrements. **Concurrent
  reserves** (Promise.all N>limit) → exactly `limit` grants (atomic, no overshoot).
- **cadence claim:** a connection just-claimed (next_sync_eligible_at future) → excluded; an
  idle one → claimed once; **two concurrent `keel_cron_enqueue_active_syncs`** → each connection
  enqueued at most once (no dup); a leased/outstanding-generation connection → excluded; drain
  the enqueued syncs.
- **/tick:** POST `/scheduled/tick` → count; jobs drain.
- **quarantine cap:** seed the counter at the cap → an over-cap invalid webhook is dropped
  (metered quarantine_capped), not inserted; distinct-hash concurrent rejections still bounded.
- **webhook budget-open:** budget exhausted + a cache-MISS webhook → 503 unverifiable, zero
  ingest/quarantine; a cache-FRESH-key webhook → still 200 verified (budget not gated at accept).
- No regression on 04/05/06/08/09.
### 3b. Unit: `plaid-meter` (latency, strict whitelist rejects extra keys); reserve/refund/claim pure logic.

## 4. Gate (ALL green; do NOT commit until dual post-build review)
`pnpm -w typecheck && pnpm -w lint && pnpm -w test`, `supabase test db` (incl. 007 — **verify
pg_cron loads under `db reset`; if it can't, the guard must degrade, NOT fail the migration**),
`scripts/dev/itest.sh` (10 + no regression). Update NOTES.md + PROGRESS.md.

## 5. Out of scope / deploy-time ⚑: the `/worker/drain`, `/worker/reap-links`, and
`/scheduled/tick` HTTP cron schedules (need the vaulted automations secret — Supabase Cron
dashboard / pg_net at deploy); AI/storage/export breakers → 1D+; per-user webhook rate-limit
beyond the cap → future; real cloud pg_cron/pg_net wiring.
