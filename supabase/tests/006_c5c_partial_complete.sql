-- pgTAP: C5c completion signature, partial health semantics, and live-failure cleanup.
begin;
select plan(21);

select is(
  to_regprocedure('public.keel_worker_complete_attempt(uuid,uuid,text)'),
  null::regprocedure,
  'the legacy three-argument completion overload is absent'
);

select ok(
  to_regprocedure('public.keel_worker_complete_attempt(uuid,uuid,text,boolean)') is not null,
  'the four-argument completion function exists'
);

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'keel_worker_complete_attempt'),
  1::int,
  'completion has exactly one SQL overload'
);

select is(
  (select p.pronargdefaults
     from pg_proc p
    where p.oid = 'public.keel_worker_complete_attempt(uuid,uuid,text,boolean)'::regprocedure),
  1::smallint,
  'p_fully_synced is the sole defaulted completion argument'
);

select is(
  (select r.rolname
     from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_worker_complete_attempt(uuid,uuid,text,boolean)'::regprocedure),
  'keel_worker',
  'completion remains owned by keel_worker'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.keel_worker_abandon_and_release(uuid,uuid)',
    'EXECUTE'
  ),
  'service_role can execute owner-fenced abandon-and-release'
);

select ok(
  has_function_privilege('service_role', 'public.keel_enqueue(text,jsonb)', 'EXECUTE'),
  'service-role worker can enqueue the fresh partial-sync notification'
);

insert into public.connections
  (id, household_id, provider, external_ref, status, sync_desired_generation,
   sync_committed_generation, last_successful_sync_at)
values
  ('96000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000a001',
   'plaid', 'pgtap-c5c-partial', 'active', 0, 0, '2026-07-01T00:00:00Z');

create temporary table c5c_ids(
  label text primary key,
  value uuid not null
) on commit drop;

insert into c5c_ids values
  ('owner_partial', '96000000-0000-4000-8000-000000000011'),
  ('owner_failure', '96000000-0000-4000-8000-000000000012'),
  ('owner_retry', '96000000-0000-4000-8000-000000000013'),
  ('owner_wrong', '96000000-0000-4000-8000-000000000014');

select ok(
  (public.keel_worker_acquire_sync_lease(
    '96000000-0000-4000-8000-000000000001',
    (select value from c5c_ids where label = 'owner_partial'),
    30
  )->>'acquired')::boolean,
  'partial attempt acquires its lease'
);

insert into c5c_ids(label, value)
select 'attempt_partial', public.keel_worker_open_attempt(
  '96000000-0000-4000-8000-000000000001',
  (select value from c5c_ids where label = 'owner_partial'),
  ''
);

select lives_ok($$
  select public.keel_worker_complete_attempt(
    (select value from c5c_ids where label = 'attempt_partial'),
    (select value from c5c_ids where label = 'owner_partial'),
    'cursor-partial',
    false
  )
$$, 'partial completion commits normally');

select is(
  (select cursor from public.sync_checkpoints
    where connection_id = '96000000-0000-4000-8000-000000000001'),
  'cursor-partial',
  'partial completion advances the durable cursor'
);

select is(
  (select last_successful_sync_at from public.connections
    where id = '96000000-0000-4000-8000-000000000001'),
  '2026-07-01T00:00:00Z'::timestamptz,
  'partial completion does not claim a fully successful sync'
);

select is(
  (select sync_committed_generation from public.connections
    where id = '96000000-0000-4000-8000-000000000001'),
  0::int,
  'partial completion still commits its attempt generation'
);

select public.keel_worker_bump_generation('96000000-0000-4000-8000-000000000001');
select ok(
  (public.keel_worker_acquire_sync_lease(
    '96000000-0000-4000-8000-000000000001',
    (select value from c5c_ids where label = 'owner_failure'),
    30
  )->>'acquired')::boolean,
  'failure probe acquires a fresh-generation lease'
);

insert into c5c_ids(label, value)
select 'attempt_failure', public.keel_worker_open_attempt(
  '96000000-0000-4000-8000-000000000001',
  (select value from c5c_ids where label = 'owner_failure'),
  'cursor-partial'
);

select throws_ok($$
  select public.keel_worker_abandon_and_release(
    (select value from c5c_ids where label = 'attempt_failure'),
    (select value from c5c_ids where label = 'owner_wrong')
  )
$$, 'P0011', null, 'a non-owner cannot abandon or release another worker lease');

select lives_ok($$
  select public.keel_worker_abandon_and_release(
    (select value from c5c_ids where label = 'attempt_failure'),
    (select value from c5c_ids where label = 'owner_failure')
  )
$$, 'matching owner abandons the live attempt and releases its lease');

select is(
  (select state::text from public.sync_attempts
    where attempt_id = (select value from c5c_ids where label = 'attempt_failure')),
  'abandoned',
  'failure cleanup marks the attempt abandoned'
);

select ok(
  (select sync_lease_owner is null and sync_leased_until is null
     from public.connections
    where id = '96000000-0000-4000-8000-000000000001'),
  'failure cleanup clears the lease atomically'
);

select ok(
  (public.keel_worker_acquire_sync_lease(
    '96000000-0000-4000-8000-000000000001',
    (select value from c5c_ids where label = 'owner_retry'),
    30
  )->>'acquired')::boolean,
  'the abandoned attempt can be retried immediately by a new owner'
);

insert into c5c_ids(label, value)
select 'attempt_terminal', public.keel_worker_open_attempt(
  '96000000-0000-4000-8000-000000000001',
  (select value from c5c_ids where label = 'owner_retry'),
  'cursor-partial'
);

select lives_ok($$
  select public.keel_worker_complete_attempt(
    (select value from c5c_ids where label = 'attempt_terminal'),
    (select value from c5c_ids where label = 'owner_retry'),
    'cursor-terminal',
    true
  )
$$, 'terminal completion commits normally');

select ok(
  (select last_successful_sync_at > '2026-07-01T00:00:00Z'::timestamptz
          and sync_committed_generation = 1
     from public.connections
    where id = '96000000-0000-4000-8000-000000000001'),
  'terminal completion sets health and commits the fresh generation'
);

select is(
  (select cursor from public.sync_checkpoints
    where connection_id = '96000000-0000-4000-8000-000000000001'),
  'cursor-terminal',
  'terminal retry advances the cursor from the partial checkpoint'
);

select * from finish();
rollback;
