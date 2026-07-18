-- Docket item (disconnect+relink UX, flagged 2026-07-17): generalizes the
-- one-off admin dedup (keel_admin_void_relink_duplicate, 20260717233000)
-- into a self-service pair: keel_list_reconnect_matches (read) surfaces a
-- candidate old/new account pair for the Connections page, and
-- keel_cmd_dedupe_reconnect_account (write, user-triggered) voids only the
-- NEW account's transactions that duplicate ones already on the OLD
-- (disconnected) account. Privileged direct inserts here are pgTAP-only
-- scaffolding.
begin;select no_plan();

select has_function('public','keel_list_reconnect_matches', array['uuid'],
  'reconnect-matches read exists');
select has_function('public','keel_cmd_dedupe_reconnect_account',
  array['uuid','text','jsonb','uuid','jsonb'], 'dedupe-reconnect command exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_cmd_dedupe_reconnect_account(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','dedupe-reconnect command owned by keel_api');

-- ---------------------------------------------------------------------------
-- Fixtures: alpha household. Old (disconnected) connection/account at
-- ins_chase with 3 real transactions (T1/T2 also on the new account -- true
-- duplicates; T3 old-only). New (active) connection/account, same
-- institution + same mask, with dup-T1/dup-T2 plus a genuinely new T4.
-- ---------------------------------------------------------------------------
insert into public.connections (id, household_id, provider, external_ref, status, institution_id)
values
  ('c9000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   'plaid', 'pgtap:reconnect:old-item', 'disconnected', 'ins_chase'),
  ('c9000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   'plaid', 'pgtap:reconnect:new-item', 'active', 'ins_chase');

insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category)
values
  ('c9000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Reconnect Test Checking (old)', 'asset', 'USD', false),
  ('c9000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Reconnect Test Checking (new)', 'asset', 'USD', false);

insert into public.accounts (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, mask)
values
  ('c9000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000001',
   'c9000000-0000-4000-8000-000000000011', 'Reconnect Test Checking', 'checking', 'USD', '9876'),
  ('c9000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000002',
   'c9000000-0000-4000-8000-000000000012', 'Reconnect Test Checking', 'checking', 'USD', '9876');

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('c9000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'RECONNECT COSTCO', '2026-06-01', 'pgtap:reconnect:old:t1'),
  ('c9000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'RECONNECT TJ', '2026-06-02', 'pgtap:reconnect:old:t2'),
  ('c9000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'RECONNECT OLD ONLY', '2026-06-03', 'pgtap:reconnect:old:t3'),
  ('c9000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000022',
   'posted', 'sync', 'RECONNECT COSTCO', '2026-06-01', 'pgtap:reconnect:new:n1'),
  ('c9000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000022',
   'posted', 'sync', 'RECONNECT TJ', '2026-06-02', 'pgtap:reconnect:new:n2'),
  ('c9000000-0000-4000-8000-000000000036', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000022',
   'posted', 'sync', 'RECONNECT NEW ONLY', '2026-06-04', 'pgtap:reconnect:new:n4');

insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c9000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000031', 'RECONNECT COSTCO', '2026-06-01', 'c9000000-0000-4000-8000-0000000000d1'),
  ('c9000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000032', 'RECONNECT TJ', '2026-06-02', 'c9000000-0000-4000-8000-0000000000d2'),
  ('c9000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000033', 'RECONNECT OLD ONLY', '2026-06-03', 'c9000000-0000-4000-8000-0000000000d3'),
  ('c9000000-0000-4000-8000-000000000044', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000034', 'RECONNECT COSTCO', '2026-06-01', 'c9000000-0000-4000-8000-0000000000d4'),
  ('c9000000-0000-4000-8000-000000000045', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000035', 'RECONNECT TJ', '2026-06-02', 'c9000000-0000-4000-8000-0000000000d5'),
  ('c9000000-0000-4000-8000-000000000046', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000036', 'RECONNECT NEW ONLY', '2026-06-04', 'c9000000-0000-4000-8000-0000000000d6');

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000041', 'c9000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -4300, 'USD'),
  ('c9000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 4300, 'USD'),
  ('c9000000-0000-4000-8000-000000000042', 'c9000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -2200, 'USD'),
  ('c9000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 2200, 'USD'),
  ('c9000000-0000-4000-8000-000000000043', 'c9000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -900, 'USD'),
  ('c9000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 900, 'USD'),
  ('c9000000-0000-4000-8000-000000000044', 'c9000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a101', -4300, 'USD'),
  ('c9000000-0000-4000-8000-000000000044', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 4300, 'USD'),
  ('c9000000-0000-4000-8000-000000000045', 'c9000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a101', -2200, 'USD'),
  ('c9000000-0000-4000-8000-000000000045', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 2200, 'USD'),
  ('c9000000-0000-4000-8000-000000000046', 'c9000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a101', -1500, 'USD'),
  ('c9000000-0000-4000-8000-000000000046', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 1500, 'USD');

-- Unrelated account at a DIFFERENT institution, active, whose transaction
-- coincidentally matches the old account's by date/amount/description --
-- review finding r3606990724 (P1): the write path must reject this pair
-- even though currency/kind/status all superficially line up, since it is
-- not a real reconnect match (keel_list_reconnect_matches would never
-- surface it).
insert into public.connections (id, household_id, provider, external_ref, status, institution_id)
values ('c9000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
        'plaid', 'pgtap:reconnect:unrelated-item', 'active', 'ins_wells_fargo');
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category)
values ('c9000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a101', 'Reconnect Test Unrelated', 'asset', 'USD', false);
insert into public.accounts (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, mask)
values ('c9000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000003',
        'c9000000-0000-4000-8000-000000000013', 'Wells Savings', 'savings', 'USD', '9999');
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values ('c9000000-0000-4000-8000-000000000037', '00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a101', 'c9000000-0000-4000-8000-000000000023',
        'posted', 'sync', 'RECONNECT COSTCO', '2026-06-01', 'pgtap:reconnect:unrelated:u1');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values ('c9000000-0000-4000-8000-000000000047', '00000000-0000-4000-8000-00000000a001',
        'c9000000-0000-4000-8000-000000000037', 'RECONNECT COSTCO', '2026-06-01', 'c9000000-0000-4000-8000-0000000000d7');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000047', 'c9000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-00000000a101', -4300, 'USD'),
  ('c9000000-0000-4000-8000-000000000047', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 4300, 'USD');

-- ---------------------------------------------------------------------------
-- Match detection: as alex (household member).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
create temporary table _matches on commit drop as
  select elem from jsonb_array_elements(
    public.keel_list_reconnect_matches('00000000-0000-4000-8000-00000000a001')->'rows') as t(elem);
select is(
  (select count(*)::int from _matches
    where elem->>'newAccountId' = 'c9000000-0000-4000-8000-000000000022'
      and elem->>'oldAccountId' = 'c9000000-0000-4000-8000-000000000021'),
  1, 'the new/old test accounts are detected as a reconnect match');
select is(
  (select count(*)::int from _matches
    where elem->>'newAccountId' = 'c9000000-0000-4000-8000-000000000023'),
  0, 'the unrelated (different institution) account is never surfaced as a match');

-- P1 fix: dedupe rejects an unrelated account pair even though
-- currency/kind/status all superficially line up.
select throws_ok($$
  select public.keel_cmd_dedupe_reconnect_account(
    'c9000000-0000-4000-8000-0000000000e4', 'pgtap:reconnect:unrelated:reject', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('new_account_id', 'c9000000-0000-4000-8000-000000000023',
      'old_account_id', 'c9000000-0000-4000-8000-000000000021'))
$$, 'P0009', null, 'dedupe rejects an unrelated (different institution) account pair');
select is(
  (select voided_at is null from public.canonical_transactions
    where id = 'c9000000-0000-4000-8000-000000000037'),
  true, 'the unrelated account''s transaction is untouched');

-- Guard: old account's connection must be disconnected. The status flips are
-- pgTAP-only fixture scaffolding (like the privileged inserts above): in
-- production `authenticated` has NO update grant on connections (status moves
-- only via keel_api/keel_worker SECURITY DEFINER procs), so drop back to the
-- privileged test role for the flip, then re-assume alex for the assertion.
reset role;
update public.connections set status = 'active' where id = 'c9000000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$
  select public.keel_cmd_dedupe_reconnect_account(
    'c9000000-0000-4000-8000-0000000000e1', 'pgtap:reconnect:guard', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('new_account_id', 'c9000000-0000-4000-8000-000000000022',
      'old_account_id', 'c9000000-0000-4000-8000-000000000021'))
$$, 'P0009', null, 'dedupe is rejected when the old account''s connection is not disconnected');
reset role;
update public.connections set status = 'disconnected' where id = 'c9000000-0000-4000-8000-000000000001';
set local role authenticated;

-- Happy path: exactly the two duplicates are voided.
select is(
  (select (public.keel_cmd_dedupe_reconnect_account(
    'c9000000-0000-4000-8000-0000000000e2', 'pgtap:reconnect:dedupe:1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('new_account_id', 'c9000000-0000-4000-8000-000000000022',
      'old_account_id', 'c9000000-0000-4000-8000-000000000021')
  )->'effects'->>'voidedCount')::int),
  2, 'exactly 2 duplicate transactions were voided');

select is(
  (select voided_at is not null from public.canonical_transactions
    where id = 'c9000000-0000-4000-8000-000000000034'),
  true, 'the new account''s COSTCO duplicate is voided');
select is(
  (select voided_at is not null from public.canonical_transactions
    where id = 'c9000000-0000-4000-8000-000000000035'),
  true, 'the new account''s TJ duplicate is voided');
select is(
  (select voided_at is null from public.canonical_transactions
    where id = 'c9000000-0000-4000-8000-000000000036'),
  true, 'the new account''s genuinely-new transaction is untouched');
select is(
  (select voided_at is null from public.canonical_transactions
    where id = 'c9000000-0000-4000-8000-000000000031'),
  true, 'the old account''s original COSTCO is untouched (stays authoritative)');
select is(
  (select voided_at is null from public.canonical_transactions
    where id = 'c9000000-0000-4000-8000-000000000033'),
  true, 'the old account''s old-only transaction is untouched');

select is(
  (select sum(p.amount_minor)::bigint from public.journal_postings p
    join public.journal_batches jb on jb.id = p.batch_id
    where jb.canonical_transaction_id in (
      'c9000000-0000-4000-8000-000000000034', 'c9000000-0000-4000-8000-000000000035')),
  0::bigint, 'voided duplicates net to zero (Law 3)');

-- Re-run: safe no-op (fresh key -- a real user clicking the button again).
select is(
  (select (public.keel_cmd_dedupe_reconnect_account(
    'c9000000-0000-4000-8000-0000000000e3', 'pgtap:reconnect:dedupe:2', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('new_account_id', 'c9000000-0000-4000-8000-000000000022',
      'old_account_id', 'c9000000-0000-4000-8000-000000000021')
  )->'effects'->>'voidedCount')::int),
  0, 're-running after a full dedupe finds nothing new');
reset role;

select * from finish();rollback;
