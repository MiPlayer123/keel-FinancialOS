-- Stage 1C C4: Plaid webhook verification-key cache, verified-delivery
-- recording, bounded quarantine metadata, and hermetic key-fetch injection.

-- ---------------------------------------------------------------------------
-- Server-only Plaid JWK cache. Runtime access is exclusively through the
-- SECURITY DEFINER procedures below; service_role receives no table grant.
-- ---------------------------------------------------------------------------
create table public.plaid_webhook_keys (
  kid text primary key,
  jwk jsonb,
  fetched_at timestamptz not null default now(),
  refresh_after timestamptz not null,
  key_created_at timestamptz,
  key_expired_at timestamptz,
  not_found boolean not null default false,
  fetch_failures int not null default 0,
  updated_at timestamptz not null default now(),
  constraint plaid_webhook_keys_kid_len check (char_length(kid) <= 128)
);

alter table public.plaid_webhook_keys enable row level security;
revoke all on public.plaid_webhook_keys from public, anon, authenticated, service_role;
grant select, insert, update on public.plaid_webhook_keys to keel_api;
create policy plaid_webhook_keys_api_all on public.plaid_webhook_keys
  for all to keel_api using (true) with check (true);

create function public.keel_webhook_key_get(p_kid text) returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'jwk', cache.jwk,
    'notFound', cache.not_found,
    'fetchedAt', cache.fetched_at,
    'keyExpiredAt', cache.key_expired_at,
    'stale', cache.refresh_after <= now()
  )
  from public.plaid_webhook_keys cache
  where cache.kid = p_kid;
$$;

create function public.keel_webhook_key_put_positive(
  p_kid text,
  p_jwk jsonb,
  p_key_created_at timestamptz,
  p_key_expired_at timestamptz
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.plaid_webhook_keys
    (kid, jwk, fetched_at, refresh_after, key_created_at, key_expired_at,
     not_found, fetch_failures, updated_at)
  values
    (p_kid, p_jwk, now(),
     least(now() + interval '24 hours',
           coalesce(p_key_expired_at, 'infinity'::timestamptz)),
     p_key_created_at, p_key_expired_at, false, 0, now())
  on conflict (kid) do update
    set jwk = excluded.jwk,
        fetched_at = excluded.fetched_at,
        refresh_after = excluded.refresh_after,
        key_created_at = excluded.key_created_at,
        key_expired_at = excluded.key_expired_at,
        not_found = false,
        fetch_failures = 0,
        updated_at = excluded.updated_at;
$$;

create function public.keel_webhook_key_put_negative(p_kid text) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.plaid_webhook_keys
    (kid, jwk, fetched_at, refresh_after, key_created_at, key_expired_at,
     not_found, fetch_failures, updated_at)
  values
    (p_kid, null, now(), now() + interval '10 minutes', null, null,
     true, 0, now())
  on conflict (kid) do update
    set jwk = null,
        fetched_at = excluded.fetched_at,
        refresh_after = excluded.refresh_after,
        key_created_at = null,
        key_expired_at = null,
        not_found = true,
        fetch_failures = 0,
        updated_at = excluded.updated_at
  where public.plaid_webhook_keys.not_found
     or public.plaid_webhook_keys.refresh_after <= now();
$$;

create function public.keel_webhook_key_bump_failure(p_kid text) returns void
language sql
security definer
set search_path = public
as $$
  update public.plaid_webhook_keys
     set fetch_failures = fetch_failures + 1,
         updated_at = now()
   where kid = p_kid;
$$;

-- ---------------------------------------------------------------------------
-- Record one verified Plaid delivery verbatim and enqueue its sync trigger in
-- the same transaction. Unknown item ids return a typed non-error result.
-- ---------------------------------------------------------------------------
create function public.keel_webhook_record_delivery(
  p_connection_external_ref text,
  p_provider_event_id text,
  p_body jsonb,
  p_body_text text,
  p_body_sha256 text,
  p_received_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_raw_id uuid;
  v_duplicate boolean := false;
begin
  begin
    select * into strict v_conn
      from public.connections connection_row
     where connection_row.provider = 'plaid'
       and connection_row.external_ref = p_connection_external_ref;
  exception
    when no_data_found then
      return jsonb_build_object('unroutable', true);
    when too_many_rows then
      raise exception 'KEEL_SCOPE_VIOLATION: ambiguous Plaid connection ref'
        using errcode = 'P0006';
  end;

  insert into public.raw_provider_events
    (household_id, connection_id, provider, provider_event_id,
     account_external_ref, body, body_text, body_sha256, received_at)
  values
    (v_conn.household_id, v_conn.id, 'plaid', p_provider_event_id,
     'item-notification', p_body, p_body_text, p_body_sha256, p_received_at)
  on conflict (connection_id, provider, provider_event_id) do nothing
  returning id into v_raw_id;

  if v_raw_id is null then
    v_duplicate := true;
    select event_row.id into v_raw_id
      from public.raw_provider_events event_row
     where event_row.connection_id = v_conn.id
       and event_row.provider = 'plaid'
       and event_row.provider_event_id = p_provider_event_id;
  else
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, before, after)
    values
      (v_conn.household_id,
       jsonb_build_object('kind', 'system', 'processName', 'webhook-provider'),
       'ingest.webhook_recorded', 'raw_provider_event', v_raw_id,
       gen_random_uuid(), null,
       jsonb_build_object('providerEventId', p_provider_event_id));

    perform public.keel_enqueue('sync_events', jsonb_build_object(
      'jobType', 'sync_notification',
      'economicEventKey', 'plaid:webhook:' || v_raw_id::text,
      'refs', jsonb_build_object('connectionId', v_conn.id::text)
    ));
  end if;

  return jsonb_build_object(
    'rawEventId', v_raw_id,
    'duplicate', v_duplicate,
    'householdId', v_conn.household_id,
    'unroutable', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Quarantine dedupe metadata and network-free key-fetch injection.
-- ---------------------------------------------------------------------------
alter table public.webhook_rejections add column body_sha256 text;
create index webhook_rejections_dedupe
  on public.webhook_rejections (body_sha256, reason, received_at);

create table public.plaid_webhook_key_test_responses (
  id uuid primary key default gen_random_uuid(),
  kid text not null,
  ordinal int not null default 0,
  http_status int not null,
  body_text text not null,
  created_at timestamptz not null default now()
);

create index plaid_webhook_key_test_responses_lookup
  on public.plaid_webhook_key_test_responses (kid, ordinal, created_at, id);

alter table public.plaid_webhook_key_test_responses enable row level security;
revoke all on public.plaid_webhook_key_test_responses from public, anon, authenticated;
grant select, insert, delete on public.plaid_webhook_key_test_responses to service_role;
grant select, delete on public.plaid_webhook_key_test_responses to keel_api;
create policy plaid_webhook_key_test_responses_api_all
  on public.plaid_webhook_key_test_responses
  for all to keel_api using (true) with check (true);

create function public.keel_consume_webhook_key_response(p_kid text) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_response jsonb;
begin
  delete from public.plaid_webhook_key_test_responses response_row
   where response_row.id = (
     select candidate.id
       from public.plaid_webhook_key_test_responses candidate
      where candidate.kid = p_kid
      order by candidate.ordinal, candidate.created_at, candidate.id
      limit 1
   )
  returning jsonb_build_object(
    'httpStatus', response_row.http_status,
    'bodyText', response_row.body_text
  ) into v_response;
  return v_response;
end;
$$;

-- Atomic bounded quarantine (post-build review, Codex #2): the Edge
-- select-then-insert dedupe races under a concurrent forgery flood (all
-- observe zero rows, all insert). Serialize per (reason, body_sha256) with a
-- transaction advisory lock, then dedupe-insert inside the same transaction.
-- Returns whether a NEW row was written (false = deduped or noop).
create function public.keel_webhook_quarantine(
  p_reason text,
  p_body_sha256 text,
  p_body_hex text,
  p_headers jsonb,
  p_window_seconds int default 3600
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  -- Serialize concurrent identical rejections; lock auto-releases at commit.
  perform pg_advisory_xact_lock(hashtextextended(p_reason || ':' || coalesce(p_body_sha256, ''), 0));
  select exists (
    select 1 from public.webhook_rejections
     where body_sha256 = p_body_sha256 and reason = p_reason
       and received_at >= now() - make_interval(secs => p_window_seconds)
  ) into v_exists;
  if v_exists then
    return false;
  end if;
  insert into public.webhook_rejections (provider, reason, body, body_sha256, headers)
  values ('plaid', p_reason, decode(p_body_hex, 'hex'), p_body_sha256, p_headers);
  return true;
end;
$$;

-- Ownership + grants follow the deployed C5b/C3 temporary-CREATE pattern.
-- Cache/injection procs run as keel_api; verified ingestion runs as worker.
grant create on schema public to keel_api, keel_worker;

do $$
declare f text;
begin
  foreach f in array array[
    'keel_webhook_key_get(text)',
    'keel_webhook_key_put_positive(text, jsonb, timestamptz, timestamptz)',
    'keel_webhook_key_put_negative(text)',
    'keel_webhook_key_bump_failure(text)',
    'keel_consume_webhook_key_response(text)',
    'keel_webhook_quarantine(text, text, text, jsonb, integer)'
  ] loop
    execute format('alter function public.%s owner to keel_api', f);
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;

  alter function public.keel_webhook_record_delivery(
    text, text, jsonb, text, text, timestamptz
  ) owner to keel_worker;
  revoke all on function public.keel_webhook_record_delivery(
    text, text, jsonb, text, text, timestamptz
  ) from public, anon, authenticated;
  grant execute on function public.keel_webhook_record_delivery(
    text, text, jsonb, text, text, timestamptz
  ) to service_role;
end
$$;

revoke create on schema public from keel_api, keel_worker;
