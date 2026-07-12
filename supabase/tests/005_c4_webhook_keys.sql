-- pgTAP: C4 Plaid webhook key cache, delivery recorder, and ACL posture.
begin;
select plan(25);

select has_table('public', 'plaid_webhook_keys', 'plaid_webhook_keys exists');
select has_table(
  'public', 'plaid_webhook_key_test_responses',
  'plaid_webhook_key_test_responses exists'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.plaid_webhook_keys'::regclass),
  'plaid_webhook_keys has RLS enabled'
);
select ok(
  (select relrowsecurity
     from pg_class
    where oid = 'public.plaid_webhook_key_test_responses'::regclass),
  'plaid_webhook_key_test_responses has RLS enabled'
);

select ok(
  not has_table_privilege('anon', 'public.plaid_webhook_keys', 'SELECT'),
  'anon cannot select plaid_webhook_keys'
);
select ok(
  not has_table_privilege('authenticated', 'public.plaid_webhook_keys', 'SELECT'),
  'authenticated cannot select plaid_webhook_keys'
);
select ok(
  not has_table_privilege('service_role', 'public.plaid_webhook_keys', 'SELECT'),
  'service_role has no direct cache-table access'
);

create temporary table c4_expected_procs(
  signature text primary key,
  expected_owner text not null
) on commit drop;

insert into c4_expected_procs(signature, expected_owner) values
  ('public.keel_webhook_key_get(text)', 'keel_api'),
  ('public.keel_webhook_key_put_positive(text,jsonb,timestamp with time zone,timestamp with time zone)', 'keel_api'),
  ('public.keel_webhook_key_put_negative(text)', 'keel_api'),
  ('public.keel_webhook_key_bump_failure(text)', 'keel_api'),
  ('public.keel_webhook_record_delivery(text,text,jsonb,text,text,timestamp with time zone)', 'keel_worker'),
  ('public.keel_consume_webhook_key_response(text)', 'keel_api'),
  ('public.keel_webhook_quarantine(text,text,text,jsonb,integer,integer)', 'keel_worker');

select is(
  (select count(*)::int from c4_expected_procs where to_regprocedure(signature) is not null),
  7,
  'all seven C4 procedures exist with exact signatures'
);
select is(
  (select count(*)::int
     from c4_expected_procs expected
     join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
    where proc.prosecdef),
  7,
  'all C4 procedures are SECURITY DEFINER'
);
select is(
  (select count(*)::int
     from c4_expected_procs expected
     join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
     join pg_roles owner_role on owner_role.oid = proc.proowner
    where owner_role.rolname = expected.expected_owner),
  7,
  'all C4 procedures have the intended non-bypass owner'
);
select is(
  (select count(*)::int
     from c4_expected_procs expected
     join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
     cross join lateral aclexplode(
       coalesce(proc.proacl, acldefault('f', proc.proowner))
     ) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC cannot execute any C4 procedure'
);
select is(
  (select count(*)::int from c4_expected_procs
    where has_function_privilege('anon', signature, 'EXECUTE')),
  0,
  'anon cannot execute any C4 procedure'
);
select is(
  (select count(*)::int from c4_expected_procs
    where has_function_privilege('authenticated', signature, 'EXECUTE')),
  0,
  'authenticated cannot execute any C4 procedure'
);
select is(
  (select count(*)::int from c4_expected_procs
    where has_function_privilege('service_role', signature, 'EXECUTE')),
  7,
  'service_role can execute every C4 procedure'
);

select public.keel_webhook_key_put_positive(
  'c4-positive',
  '{"kty":"EC","crv":"P-256","alg":"ES256","use":"sig","kid":"c4-positive","x":"x","y":"y"}'::jsonb,
  to_timestamp(100),
  null
);
select is(
  public.keel_webhook_key_get('c4-positive')->'jwk'->>'kid',
  'c4-positive',
  'positive key put/get round-trips through the production RPCs'
);
select is(
  public.keel_webhook_key_get('c4-positive')->>'notFound',
  'false',
  'positive cache entry is not a negative entry'
);

select public.keel_webhook_key_put_negative('c4-positive');
select is(
  public.keel_webhook_key_get('c4-positive')->'jwk'->>'kid',
  'c4-positive',
  'negative put cannot clobber a fresh positive entry'
);

update public.plaid_webhook_keys
   set refresh_after = now() - interval '1 second'
 where kid = 'c4-positive';
select is(
  public.keel_webhook_key_get('c4-positive')->>'stale',
  'true',
  'cache getter reports an expired refresh window as stale'
);

select public.keel_webhook_key_put_negative('c4-positive');
select is(
  public.keel_webhook_key_get('c4-positive')->>'notFound',
  'true',
  'negative put replaces a stale positive entry'
);

select is(
  public.keel_webhook_key_get('c4-absent'),
  null::jsonb,
  'cache miss returns SQL null'
);

select is(
  public.keel_webhook_record_delivery(
    'plaid-item-alpha',
    'plaid:webhook:c4-pgtap-delivery',
    '{"item_id":"plaid-item-alpha","environment":"sandbox"}'::jsonb,
    '{"item_id":"plaid-item-alpha","environment":"sandbox"}',
    repeat('a', 64),
    now()
  )->>'duplicate',
  'false',
  'first verified delivery is recorded'
);
select is(
  public.keel_webhook_record_delivery(
    'plaid-item-alpha',
    'plaid:webhook:c4-pgtap-delivery',
    '{"item_id":"plaid-item-alpha","environment":"sandbox"}'::jsonb,
    '{"item_id":"plaid-item-alpha","environment":"sandbox"}',
    repeat('a', 64),
    now()
  )->>'duplicate',
  'true',
  'repeated provider_event_id is deduplicated'
);
select is(
  public.keel_webhook_record_delivery(
    'missing-plaid-item',
    'plaid:webhook:c4-pgtap-unroutable',
    '{"item_id":"missing-plaid-item","environment":"sandbox"}'::jsonb,
    '{"item_id":"missing-plaid-item","environment":"sandbox"}',
    repeat('b', 64),
    now()
  )->>'unroutable',
  'true',
  'unknown item returns a typed unroutable result'
);

select has_column(
  'public', 'webhook_rejections', 'body_sha256',
  'webhook_rejections stores a bounded-quarantine digest'
);

insert into public.plaid_webhook_key_test_responses
  (kid, ordinal, http_status, body_text)
values
  ('c4-injected', 2, 503, '{"second":true}'),
  ('c4-injected', 1, 400, '{"first":true}');
select is(
  public.keel_consume_webhook_key_response('c4-injected'),
  '{"bodyText":"{\"first\":true}","httpStatus":400}'::jsonb,
  'injected key response is atomically consumed in ordinal order'
);

select * from finish();
rollback;
