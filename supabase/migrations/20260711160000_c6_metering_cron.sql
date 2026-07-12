-- Stage 1C C6: provider metering, atomic operational breakers, and guarded
-- pure-SQL sync scheduling. These counters are operational telemetry, not
-- economic mutations: by the documented Law-2 exception they do not write
-- audit_log (whose household_id is intentionally NOT NULL).

-- ---------------------------------------------------------------------------
-- Typed, system-safe provider metering (Law 12: no token/secret/JWK/body).
-- ---------------------------------------------------------------------------
alter table public.usage_events
  alter column household_id drop not null,
  add column provider text,
  add column kind text,
  add column latency_ms int,
  add column ok boolean,
  add column error_code text,
  add column request_id text,
  add column quantity int,
  add constraint usage_events_provider_kind_check check (
    kind is null or kind in (
      'link_token_create',
      'sandbox_public_token_create',
      'item_public_token_exchange',
      'accounts_get',
      'item_remove',
      'webhook_key_get',
      'transactions_sync',
      'cron_enqueue_syncs',
      'quarantine_capped',
      'budget_refused'
    )
  );

create index usage_events_provider_time
  on public.usage_events (provider, occurred_at);

create function public.keel_meter_provider_call(
  p_provider text,
  p_kind text,
  p_household_id uuid,
  p_latency_ms int,
  p_ok boolean,
  p_error_code text,
  p_request_id text,
  p_item_ref uuid,
  p_quantity int
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_error_code text;
begin
  if p_provider is distinct from 'plaid' then
    raise exception 'KEEL_INVALID_COMMAND: provider meter provider is not allowed'
      using errcode = 'P0009';
  end if;
  if p_kind is null or p_kind not in (
    'link_token_create',
    'sandbox_public_token_create',
    'item_public_token_exchange',
    'accounts_get',
    'item_remove',
    'webhook_key_get',
    'transactions_sync',
    'cron_enqueue_syncs',
    'quarantine_capped',
    'budget_refused'
  ) then
    raise exception 'KEEL_INVALID_COMMAND: provider meter kind is not allowed'
      using errcode = 'P0009';
  end if;
  if p_request_id is not null
     and p_request_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'KEEL_INVALID_COMMAND: provider request id is not allowed'
      using errcode = 'P0009';
  end if;
  v_error_code := case
    when p_error_code is null or p_error_code in (
      'ITEM_LOGIN_REQUIRED', 'ITEM_NOT_FOUND', 'ITEM_ERROR',
      'INVALID_ACCESS_TOKEN', 'INVALID_CREDENTIALS', 'INVALID_REQUEST',
      'INVALID_INPUT', 'INVALID_FIELD', 'INTERNAL_SERVER_ERROR',
      'RATE_LIMIT_EXCEEDED', 'PLANNED_MAINTENANCE', 'PRODUCT_NOT_READY',
      'INSTITUTION_DOWN', 'INSTITUTION_NOT_RESPONDING', 'ITEM_LOCKED',
      'USER_SETUP_REQUIRED', 'ACCESS_NOT_GRANTED',
      'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
      'provider_budget_exhausted', 'provider_error'
    ) then p_error_code
    else 'provider_error'
  end;

  insert into public.usage_events
    (household_id, event_type, resource_type, resource_id,
     provider, kind, latency_ms, ok, error_code, request_id, quantity)
  values
    (p_household_id, 'provider_call',
     case when p_item_ref is null then null else 'provider_item' end,
     p_item_ref, p_provider, p_kind, p_latency_ms, p_ok, v_error_code,
     p_request_id, p_quantity);
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic global daily provider-call reserve/refund.
-- ---------------------------------------------------------------------------
create table public.provider_call_budget (
  budget_date date not null,
  provider text not null,
  call_count int not null default 0,
  primary key (budget_date, provider)
);

alter table public.provider_call_budget enable row level security;
revoke all on public.provider_call_budget from public, anon, authenticated;

create function public.keel_provider_budget_reserve(
  p_provider text,
  p_daily_limit int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved boolean;
begin
  if p_daily_limit is null or p_daily_limit <= 0 then
    return false;
  end if;
  with reserved as (
    insert into public.provider_call_budget (budget_date, provider, call_count)
    values (current_date, p_provider, 1)
    on conflict (budget_date, provider) do update
      set call_count = public.provider_call_budget.call_count + 1
      where public.provider_call_budget.call_count < p_daily_limit
    returning true as granted
  )
  select granted into v_reserved from reserved;

  return coalesce(v_reserved, false);
end;
$$;

create function public.keel_provider_budget_refund(p_provider text) returns void
language sql
security definer
set search_path = public
as $$
  update public.provider_call_budget
     set call_count = greatest(0, call_count - 1)
   where budget_date = current_date and provider = p_provider;
$$;

-- ---------------------------------------------------------------------------
-- Per-item cadence breaker: one atomic update claim, then enqueue only.
-- No ledger math, posting, crypto, or provider I/O lives here (INFRA §8).
-- ---------------------------------------------------------------------------
alter table public.connections
  add column next_sync_eligible_at timestamptz;

create function public.keel_cron_enqueue_active_syncs(
  p_min_interval_seconds int default 900
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enqueued int;
begin
  if p_min_interval_seconds is null or p_min_interval_seconds <= 0 then
    return 0;
  end if;
  with claimed as (
    update public.connections connection_row
       set next_sync_eligible_at = now() + make_interval(secs => p_min_interval_seconds)
     where connection_row.provider = 'plaid'
       and connection_row.status = 'active'
       and (
         connection_row.next_sync_eligible_at is null
         or connection_row.next_sync_eligible_at <= now()
       )
       and connection_row.sync_lease_owner is null
       and connection_row.sync_committed_generation = connection_row.sync_desired_generation
    returning connection_row.id, connection_row.household_id
  ), enqueued as materialized (
    select public.keel_enqueue(
      'sync_events',
      jsonb_build_object(
        'jobType', 'sync_notification',
        'economicEventKey', format(
          'cron:sync:%s:%s', claimed.id, extract(epoch from now())::bigint
        ),
        'refs', jsonb_build_object('connectionId', claimed.id::text)
      )
    ) as message_id
    from claimed
  )
  select count(*)::int into v_enqueued from enqueued;

  perform public.keel_meter_provider_call(
    'plaid', 'cron_enqueue_syncs', null, 0, true, null, null, null, v_enqueued
  );
  return v_enqueued;
end;
$$;

-- ---------------------------------------------------------------------------
-- C4-deferred O(1) quarantine cap. The existing per-hash advisory lock keeps
-- dedupe race-free; the shared hourly counter independently bounds distinct
-- hashes through an atomic ON CONFLICT ... WHERE reserve.
-- ---------------------------------------------------------------------------
create table public.webhook_rejection_counters (
  provider text not null,
  hour_bucket timestamptz not null,
  count int not null default 0,
  primary key (provider, hour_bucket)
);

alter table public.webhook_rejection_counters enable row level security;
revoke all on public.webhook_rejection_counters from public, anon, authenticated;

drop function public.keel_webhook_quarantine(text, text, text, jsonb, integer);

create function public.keel_webhook_quarantine(
  p_reason text,
  p_body_sha256 text,
  p_body_hex text,
  p_headers jsonb,
  p_window_seconds int default 3600,
  p_hourly_cap int default 10000
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
  v_counter_reserved boolean;
begin
  if p_hourly_cap is null or p_hourly_cap <= 0 then
    return false;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_reason || ':' || coalesce(p_body_sha256, ''), 0)
  );
  select exists (
    select 1 from public.webhook_rejections
     where body_sha256 = p_body_sha256 and reason = p_reason
       and received_at >= now() - make_interval(secs => p_window_seconds)
  ) into v_exists;
  if v_exists then
    return false;
  end if;

  with reserved as (
    insert into public.webhook_rejection_counters (provider, hour_bucket, count)
    values ('plaid', date_trunc('hour', now()), 1)
    on conflict (provider, hour_bucket) do update
      set count = public.webhook_rejection_counters.count + 1
      where public.webhook_rejection_counters.count < p_hourly_cap
    returning true as granted
  )
  select granted into v_counter_reserved from reserved;

  if not coalesce(v_counter_reserved, false) then
    perform public.keel_meter_provider_call(
      'plaid', 'quarantine_capped', null, 0, false, null, null, null, 1
    );
    return false;
  end if;

  insert into public.webhook_rejections
    (provider, reason, body, body_sha256, headers)
  values
    ('plaid', p_reason, decode(p_body_hex, 'hex'), p_body_sha256, p_headers);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Non-BYPASSRLS owner privileges and all-policies. service_role receives the
-- direct diagnostic/test access required by the server-only integration gate.
-- ---------------------------------------------------------------------------
grant insert on public.usage_events to keel_worker;
grant select, insert, update on
  public.provider_call_budget,
  public.webhook_rejection_counters
to keel_worker;
grant update (next_sync_eligible_at) on public.connections to keel_worker;

grant select, insert, update on
  public.provider_call_budget,
  public.webhook_rejection_counters
to service_role;

create policy usage_events_worker_all on public.usage_events
  for all to keel_worker using (true) with check (true);
create policy provider_call_budget_worker_all on public.provider_call_budget
  for all to keel_worker using (true) with check (true);
create policy webhook_rejection_counters_worker_all on public.webhook_rejection_counters
  for all to keel_worker using (true) with check (true);

grant create on schema public to keel_worker;
do $$
declare
  f text;
begin
  foreach f in array array[
    'keel_meter_provider_call(text, text, uuid, integer, boolean, text, text, uuid, integer)',
    'keel_provider_budget_reserve(text, integer)',
    'keel_provider_budget_refund(text)',
    'keel_cron_enqueue_active_syncs(integer)',
    'keel_webhook_quarantine(text, text, text, jsonb, integer, integer)'
  ] loop
    execute format('alter function public.%s owner to keel_worker', f);
    execute format(
      'revoke all on function public.%s from public, anon, authenticated', f
    );
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
revoke create on schema public from keel_worker;

-- ---------------------------------------------------------------------------
-- Guarded pg_cron: local images without a loadable extension keep resetting
-- successfully and can drive the same claim/enqueue RPC through /scheduled/tick.
-- The sole registered command is pure SQL and contains no HTTP credential.
-- ---------------------------------------------------------------------------
do $$
declare
  v_job_id bigint;
begin
  create extension if not exists pg_cron;

  for v_job_id in
    select jobid from cron.job where jobname = 'keel-active-syncs'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'keel-active-syncs',
    '*/15 * * * *',
    $command$ select public.keel_cron_enqueue_active_syncs(); $command$
  );
exception
  when others then
    raise notice 'pg_cron unavailable; enqueue callable via /scheduled/tick';
end
$$;
