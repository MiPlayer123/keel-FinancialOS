-- pgTAP: C6 provider metering, atomic breakers, cadence claims, and guarded cron.
begin;
select plan(57);

select ok(
  not (select attnotnull from pg_attribute
        where attrelid = 'public.usage_events'::regclass and attname = 'household_id'),
  'usage_events.household_id permits system telemetry'
);
select has_table('public', 'provider_call_budget', 'provider_call_budget exists');
select has_table('public', 'webhook_rejection_counters', 'webhook_rejection_counters exists');
select has_column('public', 'connections', 'next_sync_eligible_at',
  'connections has an atomic cadence-claim timestamp');
select has_column('public', 'usage_events', 'kind', 'usage_events has a typed provider kind');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.provider_call_budget'::regclass),
  'provider_call_budget has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.webhook_rejection_counters'::regclass),
  'webhook_rejection_counters has RLS enabled'
);
select ok(not has_table_privilege('anon', 'public.provider_call_budget', 'SELECT'),
  'anon cannot read provider_call_budget');
select ok(not has_table_privilege('authenticated', 'public.provider_call_budget', 'SELECT'),
  'authenticated cannot read provider_call_budget');
select ok(not has_table_privilege('anon', 'public.webhook_rejection_counters', 'SELECT'),
  'anon cannot read webhook_rejection_counters');
select ok(not has_table_privilege('authenticated', 'public.webhook_rejection_counters', 'SELECT'),
  'authenticated cannot read webhook_rejection_counters');

create temporary table c6_expected_procs(signature text primary key) on commit drop;
insert into c6_expected_procs(signature) values
  ('public.keel_meter_provider_call(text,text,uuid,integer,boolean,text,text,uuid,integer)'),
  ('public.keel_provider_budget_reserve(text,integer)'),
  ('public.keel_provider_budget_refund(text)'),
  ('public.keel_cron_enqueue_active_syncs(integer)');

select is(
  (select count(*)::int from c6_expected_procs where to_regprocedure(signature) is not null),
  4,
  'all four C6 procedures exist with exact signatures'
);
select is(
  (select count(*)::int
     from c6_expected_procs expected
     join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
    where proc.prosecdef),
  4,
  'all C6 procedures are SECURITY DEFINER'
);
select is(
  (select count(*)::int
     from c6_expected_procs expected
     join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
     join pg_roles owner_role on owner_role.oid = proc.proowner
    where owner_role.rolname = 'keel_worker'),
  4,
  'all C6 procedures are owned by keel_worker'
);
select is(
  (select count(*)::int
     from c6_expected_procs expected
     join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
     cross join lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC cannot execute any C6 procedure'
);
select is(
  (select count(*)::int from c6_expected_procs
    where has_function_privilege('anon', signature, 'EXECUTE')),
  0,
  'anon cannot execute any C6 procedure'
);
select is(
  (select count(*)::int from c6_expected_procs
    where has_function_privilege('authenticated', signature, 'EXECUTE')),
  0,
  'authenticated cannot execute any C6 procedure'
);
select is(
  (select count(*)::int from c6_expected_procs
    where has_function_privilege('service_role', signature, 'EXECUTE')),
  4,
  'service_role can execute every C6 procedure'
);
select is(
  (select proargnames::text
     from pg_proc
    where oid = 'public.keel_meter_provider_call(text,text,uuid,integer,boolean,text,text,uuid,integer)'::regprocedure),
  '{p_provider,p_kind,p_household_id,p_latency_ms,p_ok,p_error_code,p_request_id,p_item_ref,p_quantity}',
  'meter arguments are the exact Law-12-safe whitelist'
);

select lives_ok($$
  select public.keel_meter_provider_call(
    'plaid', 'accounts_get', null, 7, true, null, 'req_C6-01',
    '97000000-0000-4000-8000-000000000001', 1)
$$, 'a valid provider call is metered');
select ok(
  exists (
    select 1 from public.usage_events
     where event_type = 'provider_call' and provider = 'plaid' and kind = 'accounts_get'
       and household_id is null and latency_ms = 7 and ok
       and request_id = 'req_C6-01'
       and resource_id = '97000000-0000-4000-8000-000000000001'
       and quantity = 1
  ),
  'meter persists only typed operational fields'
);
select throws_ok($$
  select public.keel_meter_provider_call(
    'plaid', 'not_allowed', null, 0, false, null, null, null, 1)
$$, 'P0009', null, 'meter rejects a kind outside the closed set');
select throws_ok($$
  select public.keel_meter_provider_call(
    'plaid', null, null, 0, false, null, null, null, 1)
$$, 'P0009', null, 'meter rejects a null kind');
select throws_ok($$
  select public.keel_meter_provider_call(
    'not-plaid', 'accounts_get', null, 0, false, null, null, null, 1)
$$, 'P0009', null, 'meter rejects a non-Plaid provider');
select throws_ok($$
  select public.keel_meter_provider_call(
    'plaid', 'accounts_get', null, 0, false, null, repeat('x', 65), null, 1)
$$, 'P0009', null, 'meter rejects an oversized request id');
select lives_ok($$
  select public.keel_meter_provider_call(
    'plaid', 'accounts_get', null, 0, false, 'token-shaped-unknown-code',
    'req_C6_coerce', null, 1)
$$, 'meter coerces an unknown error code instead of persisting it');
select is(
  (select error_code from public.usage_events
    where event_type = 'provider_call' and request_id = 'req_C6_coerce'),
  'provider_error',
  'meter stores only the normalized error-code set'
);

select ok(not public.keel_provider_budget_reserve('pgtap-c6-zero', 0),
  'zero daily limit refuses the first reserve');
select ok(
  not exists(select 1 from public.provider_call_budget where provider = 'pgtap-c6-zero'),
  'zero daily limit does not mutate the budget table'
);
select ok(not public.keel_provider_budget_reserve('pgtap-c6-negative', -1),
  'negative daily limit refuses the first reserve');
select ok(not public.keel_provider_budget_reserve('pgtap-c6-null', null),
  'null daily limit refuses the first reserve');

select ok(public.keel_provider_budget_reserve('pgtap-c6', 2),
  'first budget slot is atomically reserved');
select ok(public.keel_provider_budget_reserve('pgtap-c6', 2),
  'second budget slot is atomically reserved');
select ok(not public.keel_provider_budget_reserve('pgtap-c6', 2),
  'reserve flips false at the daily limit');
select is(
  (select call_count from public.provider_call_budget
    where budget_date = current_date and provider = 'pgtap-c6'),
  2,
  'failed reserve does not overshoot the budget'
);
select lives_ok($$select public.keel_provider_budget_refund('pgtap-c6')$$,
  'budget refund succeeds');
select is(
  (select call_count from public.provider_call_budget
    where budget_date = current_date and provider = 'pgtap-c6'),
  1,
  'budget refund decrements without going below zero'
);

-- Isolate the cadence probe from seed connections that are legitimately active.
update public.connections
   set next_sync_eligible_at = now() + interval '1 day'
 where provider = 'plaid' and status = 'active';

insert into public.connections
  (id, household_id, provider, external_ref, status,
   sync_desired_generation, sync_committed_generation,
   sync_lease_owner, sync_leased_until, next_sync_eligible_at)
values
  ('97000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-00000000a001', 'plaid', 'pgtap-c6-idle', 'active',
   0, 0, null, null, null),
  ('97000000-0000-4000-8000-000000000102',
   '00000000-0000-4000-8000-00000000a001', 'plaid', 'pgtap-c6-leased', 'active',
   0, 0, '97000000-0000-4000-8000-000000000202', now() + interval '1 hour', null),
  ('97000000-0000-4000-8000-000000000103',
   '00000000-0000-4000-8000-00000000a001', 'plaid', 'pgtap-c6-outstanding', 'active',
   1, 0, null, null, null);

select is(public.keel_cron_enqueue_active_syncs(0), 0,
  'zero cadence interval safely refuses before claiming');
select is(public.keel_cron_enqueue_active_syncs(-1), 0,
  'negative cadence interval safely refuses before claiming');
select is(public.keel_cron_enqueue_active_syncs(null), 0,
  'null cadence interval safely refuses before claiming');
select ok(
  (select next_sync_eligible_at is null from public.connections
    where id = '97000000-0000-4000-8000-000000000101'),
  'invalid cadence intervals do not mutate an eligible connection'
);
select is(public.keel_cron_enqueue_active_syncs(900), 1,
  'cadence claim enqueues exactly the eligible idle connection');
select ok(
  (select next_sync_eligible_at > now() from public.connections
    where id = '97000000-0000-4000-8000-000000000101'),
  'cadence claim advances next_sync_eligible_at atomically'
);
select ok(
  (select next_sync_eligible_at is null from public.connections
    where id = '97000000-0000-4000-8000-000000000102'),
  'cadence claim excludes a leased connection'
);
select ok(
  (select next_sync_eligible_at is null from public.connections
    where id = '97000000-0000-4000-8000-000000000103'),
  'cadence claim excludes an outstanding generation'
);
select is(public.keel_cron_enqueue_active_syncs(900), 0,
  'a duplicate cadence call cannot claim the same connection twice');
select ok(
  exists (
    select 1 from public.usage_events
     where kind = 'cron_enqueue_syncs' and quantity = 1 and household_id is null
  ),
  'cron claim records operational telemetry without audit_log'
);

select ok(
  to_regprocedure(
    'public.keel_webhook_quarantine(text,text,text,jsonb,integer,integer)'
  ) is not null,
  'quarantine exposes the C6 hourly-cap parameter'
);
delete from public.webhook_rejection_counters
 where provider = 'plaid' and hour_bucket = date_trunc('hour', now());
select ok(not public.keel_webhook_quarantine(
  'c6-cap-zero', repeat('0', 64), '', '{}'::jsonb, 3600, 0
), 'zero quarantine cap safely refuses the first rejection');
delete from public.webhook_rejection_counters
 where provider = 'plaid' and hour_bucket = date_trunc('hour', now());
select ok(not public.keel_webhook_quarantine(
  'c6-cap-negative', repeat('9', 64), '', '{}'::jsonb, 3600, -1
), 'negative quarantine cap safely refuses the first rejection');
delete from public.webhook_rejection_counters
 where provider = 'plaid' and hour_bucket = date_trunc('hour', now());
select ok(not public.keel_webhook_quarantine(
  'c6-cap-null', repeat('8', 64), '', '{}'::jsonb, 3600, null
), 'null quarantine cap safely refuses the first rejection');
select ok(
  not exists(select 1 from public.webhook_rejections
    where reason in ('c6-cap-zero', 'c6-cap-negative', 'c6-cap-null')),
  'invalid quarantine caps do not persist rejected bodies'
);
select ok(public.keel_webhook_quarantine(
  'c6-cap-first', repeat('1', 64), '', '{}'::jsonb, 3600, 1
), 'the first distinct rejection reserves the hourly slot');
select ok(not public.keel_webhook_quarantine(
  'c6-cap-second', repeat('2', 64), '', '{}'::jsonb, 3600, 1
), 'a distinct rejection over the hourly cap is refused');
select ok(
  exists (
    select 1 from public.usage_events
     where kind = 'quarantine_capped' and quantity = 1 and household_id is null
  ),
  'an over-cap quarantine refusal is metered'
);

select case
  when exists(select 1 from pg_extension where extname = 'pg_cron') then
    ok(exists(select 1 from cron.job where jobname = 'keel-active-syncs'),
      'guarded pg_cron install registers keel-active-syncs')
  else pass('pg_cron unavailable locally; guarded migration degraded to /scheduled/tick')
end;
select case
  when exists(select 1 from pg_extension where extname = 'pg_cron') then
    ok(not exists(
      select 1 from cron.job
       where jobname = 'keel-active-syncs'
         and command ~* '(secret|authorization|apikey|http_post)'
    ), 'keel-active-syncs cron.command contains no secret or HTTP invocation')
  else pass('pg_cron unavailable locally; there is no cron.command secret surface')
end;

select * from finish();
rollback;
