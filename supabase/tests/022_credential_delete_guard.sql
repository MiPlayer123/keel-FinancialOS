-- Guard against a repeat of the 2026-07-17 incident (NOTES.md): a raw SQL
-- DELETE on connection_credentials bypassed keel_disconnect_complete
-- entirely, so Plaid's /item/remove was never called and the Items were
-- orphaned. keel_guard_credential_delete (20260718050000) makes
-- keel_disconnect_complete's sanctioned delete the ONLY way a row can be
-- removed. Privileged direct inserts here are pgTAP-only scaffolding.
begin;select no_plan();

select has_function('public','keel_guard_credential_delete', array[]::text[],
  'the credential-delete guard function exists');
select is(
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.connection_credentials'::regclass
      and tgname = 'connection_credentials_guard_delete'),
  1, 'the guard trigger is installed on connection_credentials');

insert into public.connections (id, household_id, provider, external_ref, status)
values ('c8000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
        'plaid', 'pgtap:guard:item:1', 'active');
insert into public.connection_credentials
  (id, household_id, connection_id, credential_owner_user_id, ciphertext, iv, wrapped_dek, wrap_iv, kek_version)
values
  ('c8000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   gen_random_bytes(32), gen_random_bytes(12), gen_random_bytes(48), gen_random_bytes(12), 1);

-- A raw delete, exactly the shape of the incident, is rejected.
select throws_ok($$
  delete from public.connection_credentials
   where id = 'c8000000-0000-4000-8000-000000000002'
$$, 'P0011', null, 'a raw DELETE without acknowledgement is rejected');

select is(
  (select count(*)::int from public.connection_credentials
    where id = 'c8000000-0000-4000-8000-000000000002'),
  1, 'the row survives the blocked delete');

-- The one sanctioned path: acknowledge for this statement, then it succeeds.
select lives_ok($$
  select set_config('keel.credential_delete_acknowledged', 'true', true)
$$, 'acknowledging the delete is itself allowed');
select lives_ok($$
  delete from public.connection_credentials
   where id = 'c8000000-0000-4000-8000-000000000002'
$$, 'an acknowledged DELETE succeeds');
select is(
  (select count(*)::int from public.connection_credentials
    where id = 'c8000000-0000-4000-8000-000000000002'),
  0, 'the row is gone after the acknowledged delete');

-- SET LOCAL semantics: the acknowledgement does not leak into a later,
-- unrelated delete attempt within the same test transaction.
insert into public.connections (id, household_id, provider, external_ref, status)
values ('c8000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
        'plaid', 'pgtap:guard:item:2', 'active');
insert into public.connection_credentials
  (id, household_id, connection_id, credential_owner_user_id, ciphertext, iv, wrapped_dek, wrap_iv, kek_version)
values
  ('c8000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   gen_random_bytes(32), gen_random_bytes(12), gen_random_bytes(48), gen_random_bytes(12), 1);
select is(pg_catalog.current_setting('keel.credential_delete_acknowledged', true), 'true',
  'sanity: the GUC is still true from the prior statement (not yet reset)');

select * from finish();rollback;
