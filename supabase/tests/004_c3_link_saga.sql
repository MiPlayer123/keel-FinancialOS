-- pgTAP: C3 Plaid link/disconnect saga, trust boundary, and definer posture.
begin;
select plan(17);

select ok(
  exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'connection_status'
      and e.enumlabel = 'disconnecting'
  ),
  'connection_status includes disconnecting'
);

create temporary table c3_expected_procs(signature text primary key) on commit drop;
insert into c3_expected_procs(signature) values
  ('public.keel_begin_link(uuid,uuid,uuid,text,text)'),
  ('public.keel_disconnect_begin(uuid,uuid,text)'),
  ('public.keel_record_link_exchange(uuid,uuid,uuid,text,text,text,text,text,integer)'),
  ('public.keel_finalize_link(uuid,uuid,text,timestamp with time zone,jsonb)'),
  ('public.keel_fail_link_attempt(uuid,uuid,text,boolean)'),
  ('public.keel_disconnect_complete(uuid,uuid,uuid,boolean,text)'),
  ('public.keel_set_connection_reauth(uuid,text,boolean)'),
  ('public.keel_get_connection_credential_envelope(uuid)'),
  ('public.keel_reap_orphan_link_attempts(timestamp with time zone,integer)'),
  ('public.keel_mark_link_attempt_reaped(uuid,uuid,boolean,text)');

select is(
  (select count(*)::int from c3_expected_procs where to_regprocedure(signature) is not null),
  10,
  'all 10 C3 saga procedures exist with exact signatures'
);

select is(
  (select count(*)::int
     from c3_expected_procs expected
     join pg_proc p on p.oid = to_regprocedure(expected.signature)
    where p.prosecdef),
  10,
  'all C3 saga procedures are SECURITY DEFINER'
);

select is(
  (select count(*)::int
     from c3_expected_procs expected
     join pg_proc p on p.oid = to_regprocedure(expected.signature)
     join pg_roles r on r.oid = p.proowner
    where r.rolname = 'keel_api'),
  10,
  'all C3 saga procedures are owned by keel_api'
);

select ok(
  has_function_privilege('authenticated',
    'public.keel_begin_link(uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'authenticated can execute keel_begin_link'
);

select ok(
  has_function_privilege('authenticated',
    'public.keel_disconnect_begin(uuid,uuid,text)', 'EXECUTE'),
  'authenticated can execute keel_disconnect_begin'
);

select is(
  (select count(*)::int
     from c3_expected_procs
    where signature not in (
      'public.keel_begin_link(uuid,uuid,uuid,text,text)',
      'public.keel_disconnect_begin(uuid,uuid,text)'
    ) and has_function_privilege('authenticated', signature, 'EXECUTE')),
  0,
  'authenticated cannot execute any internal C3 saga procedure'
);

select is(
  (select count(*)::int from c3_expected_procs
    where has_function_privilege('anon', signature, 'EXECUTE')),
  0,
  'anon cannot execute any C3 saga procedure'
);

select ok(not has_table_privilege('anon', 'public.plaid_test_responses', 'SELECT'),
  'anon cannot select plaid_test_responses');
select ok(not has_table_privilege('authenticated', 'public.plaid_test_responses', 'SELECT'),
  'authenticated cannot select plaid_test_responses');
select ok(not has_table_privilege('anon', 'public.connection_credentials', 'SELECT'),
  'anon cannot select connection_credentials');
select ok(not has_table_privilege('authenticated', 'public.connection_credentials', 'SELECT'),
  'authenticated cannot select connection_credentials');
select ok(not has_table_privilege('anon', 'public.link_attempts', 'SELECT'),
  'anon cannot select link_attempts');
select ok(not has_table_privilege('authenticated', 'public.link_attempts', 'SELECT'),
  'authenticated cannot select link_attempts');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and policyname in (
        'connection_credentials_api_all',
        'link_attempts_api_all',
        'removal_attempts_api_all',
        'connection_health_events_api_all'
      )
      and cmd = 'ALL'
      and 'keel_api' = any(roles)),
  4,
  'all four C2a satellite tables have keel_api definer policies'
);

select ok(
  exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.connection_credentials'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(c.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      ) = array['household_id', 'connection_id']
  ),
  'connection_credentials is unique by household and connection'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok($$
  select public.keel_begin_link(
    gen_random_uuid(),
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a101',
    'plaid',
    null)
$$, 'P0006', null, 'non-member begin_link fails closed with a scope violation');

reset role;
select * from finish();
rollback;
