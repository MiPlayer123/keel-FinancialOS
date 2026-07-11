-- pgTAP: RLS + grant posture (TASK-000 tests 5, 6). Simulates the
-- `authenticated` role with request.jwt.claims (PLAN §3.5.11).
begin;
select plan(18);

-- Fixture (as superuser, before any role switch): a canonical transaction in
-- household beta, so the Finding-1 cross-household link probe has a real
-- foreign target to attempt.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('92000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b401',
   'posted', 'manual', 'beta fixture txn', '2026-07-01', 'pgtap:beta:fixture:0001');

-- Test 6: authenticated holds ZERO DML privileges on canonical tables.
select is(
  (select count(*)::int from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
      and table_name in
        ('canonical_transactions','journal_batches','journal_postings',
         'journal_revisions','raw_provider_events','normalized_source_records',
         'audit_log','domain_events','command_executions','period_locks',
         'accounts','ledger_accounts','households','household_memberships')),
  0,
  'authenticated has no INSERT/UPDATE/DELETE grant on any canonical table'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'),
  0,
  'anon has no grants at all on public tables'
);

-- No write policies exist for authenticated anywhere.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and 'authenticated' = any (roles)
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')),
  0,
  'no RLS write policy exists for authenticated'
);

-- Runtime roles never bypass RLS and own nothing.
select is(
  (select count(*)::int from pg_roles
    where rolname in ('keel_api','keel_worker','keel_readonly') and rolbypassrls),
  0, 'keel roles do not have BYPASSRLS');
select is(
  (select count(*)::int from pg_class c join pg_roles r on r.oid = c.relowner
    where r.rolname in ('keel_api','keel_worker','keel_readonly')
      and c.relkind = 'r'),
  0, 'keel roles own no tables');

-- Test 5: cross-household reads fail closed through RLS.
-- Casey (household beta owner) must not see alpha rows.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select count(*)::int from public.households where id = '00000000-0000-4000-8000-00000000a001'),
  0, 'RLS: other household row is invisible');
select is(
  (select count(*)::int from public.accounts where household_id = '00000000-0000-4000-8000-00000000a001'),
  0, 'RLS: other household accounts invisible');
select is(
  (select count(*)::int from public.canonical_transactions
    where household_id = '00000000-0000-4000-8000-00000000a001'),
  0, 'RLS: other household transactions invisible');

-- Direct writes as authenticated fail even against own household (test 6).
select throws_ok($$
  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
  values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000b101',
          '00000000-0000-4000-8000-00000000b401', 'posted', 'manual', 'smuggled', '2026-07-01',
          'smuggle:direct:0001')
$$, '42501', null, 'authenticated cannot insert canonical transactions');

select throws_ok($$
  insert into public.journal_batches (household_id, description, effective_date, command_id)
  values ('00000000-0000-4000-8000-00000000b001', 'smuggled batch', '2026-07-01', gen_random_uuid())
$$, '42501', null, 'authenticated cannot insert journal batches');

select throws_ok($$
  update public.period_locks set reopened_at = now(), reopen_reason = 'x' where true
$$, '42501', null, 'authenticated cannot touch period locks');

-- The user-facing command proc enforces cross-household denial in-database:
-- casey attempting a post into alpha raises scope violation.
select throws_ok($$
  select public.keel_cmd_post_batch(
    gen_random_uuid(), 'pgtap:casey:alpha:0001',
    '{"kind":"user","userId":"00000000-0000-4000-8000-000000000003"}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    '{"description":"x","effective_date":"2026-07-01","postings":[]}'::jsonb)
$$, 'P0006', null, 'command proc rejects cross-household actor (fail closed)');

-- ---------------------------------------------------------------------------
-- Stage-exit findings: within-tenant integrity guards (act as alex, alpha
-- owner/member — an AUTHORIZED member must still not smuggle references,
-- forge the actor, or violate currency/reversal invariants).
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Finding 2: the audit actor is the JWT identity, not caller input.
select lives_ok($$
  select public.keel_cmd_post_batch(
    '92000000-0000-4000-8000-000000000001', 'pgtap:actor:0001',
    '{"kind":"system","processName":"forged"}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    '{"description":"actor test","effective_date":"2026-07-02","postings":[
       {"ledger_account_id":"00000000-0000-4000-8000-00000000a311","amount_minor":"100","currency":"USD"},
       {"ledger_account_id":"00000000-0000-4000-8000-00000000a301","amount_minor":"-100","currency":"USD"}]}'::jsonb)
$$, 'post_batch with forged actor payload runs');
select is(
  (select actor->>'kind' from public.audit_log where command_id='92000000-0000-4000-8000-000000000001'),
  'user', 'audit actor kind is forced to user (forgery ignored)');
select is(
  (select actor->>'userId' from public.audit_log where command_id='92000000-0000-4000-8000-000000000001'),
  '00000000-0000-4000-8000-000000000001', 'audit actor is the JWT subject');

-- Finding 7: posting currency must match the ledger account currency.
select throws_ok($$
  select public.keel_cmd_post_batch(
    gen_random_uuid(), 'pgtap:currency:0001',
    '{}'::jsonb, '00000000-0000-4000-8000-00000000a001',
    '{"description":"eur","effective_date":"2026-07-02","postings":[
       {"ledger_account_id":"00000000-0000-4000-8000-00000000a311","amount_minor":"100","currency":"EUR"},
       {"ledger_account_id":"00000000-0000-4000-8000-00000000a301","amount_minor":"-100","currency":"EUR"}]}'::jsonb)
$$, 'P0010', null, 'EUR posting on USD account is rejected');

-- Finding 3 (create_account) + probe: cross-household connection is refused.
select throws_ok($$
  select public.keel_cmd_create_account(
    gen_random_uuid(), 'pgtap:xconn:0001',
    '{}'::jsonb, '00000000-0000-4000-8000-00000000a001',
    '{"entity_id":"00000000-0000-4000-8000-00000000a101","connection_id":"00000000-0000-4000-8000-00000000b201","external_ref":"x","name":"x","kind":"asset","subtype":"checking","currency":"USD"}'::jsonb)
$$, 'P0006', null, 'account cannot link another household connection');

-- Finding 1: post_batch cannot attach a foreign canonical transaction.
select throws_ok($$
  select public.keel_cmd_post_batch(
    gen_random_uuid(), 'pgtap:xtxn:0001',
    '{}'::jsonb, '00000000-0000-4000-8000-00000000a001',
    format('{"canonical_transaction_id":"%s","description":"x","effective_date":"2026-07-02","postings":[{"ledger_account_id":"00000000-0000-4000-8000-00000000a311","amount_minor":"100","currency":"USD"},{"ledger_account_id":"00000000-0000-4000-8000-00000000a301","amount_minor":"-100","currency":"USD"}]}',
      (select id from public.canonical_transactions where household_id='00000000-0000-4000-8000-00000000b001' limit 1))::jsonb)
$$, 'P0006', null, 'batch cannot link a foreign-household transaction');

reset role;
select * from finish();
rollback;
