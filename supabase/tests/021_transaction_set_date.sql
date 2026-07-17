-- Task #24 (docket): transactions.set_date → keel_cmd_set_date. Same
-- house-correction model as 018_set_splits.sql: reversal batch (old date) +
-- replacement batch (new date, postings copied verbatim) + revision record.
-- Privileged direct inserts here are pgTAP-only scaffolding (this layer runs
-- as the migration role by design); every runtime surface goes through the
-- command under test.
begin;select no_plan();

-- Surface + ownership (keel_api, non-BYPASSRLS — the established ritual).
select has_function('public','keel_cmd_set_date',
  array['uuid','text','jsonb','uuid','jsonb'],'set-date command exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_cmd_set_date(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','set-date command owned by keel_api');
select ok(has_column_privilege('keel_api', 'public.canonical_transactions', 'effective_date', 'update'),
  'keel_api may update canonical_transactions.effective_date');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: entity a101, checking ledger a301 (account a401),
-- category a311 Groceries.
-- T1: happy-path + no-op guard. T2: voided (immutability). T3: dated INSIDE
-- the locked period (old-date guard). T4: dated OUTSIDE it (new-date guard).
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('c7000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'manual', 'TRADER JOES', '2026-06-01', 'pgtap:setdate:t1'),
  ('c7000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'manual', 'VOIDED ROW', '2026-06-02', 'pgtap:setdate:t2'),
  ('c7000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'manual', 'ALREADY LOCKED', '2026-05-15', 'pgtap:setdate:t3'),
  ('c7000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'manual', 'MOVING INTO LOCK', '2026-06-20', 'pgtap:setdate:t4');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c7000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000001', 'TRADER JOES', '2026-06-01',
   'c7000000-0000-4000-8000-0000000000c1'),
  ('c7000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000002', 'VOIDED ROW', '2026-06-02',
   'c7000000-0000-4000-8000-0000000000c2'),
  ('c7000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000003', 'ALREADY LOCKED', '2026-05-15',
   'c7000000-0000-4000-8000-0000000000c3'),
  ('c7000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000004', 'MOVING INTO LOCK', '2026-06-20',
   'c7000000-0000-4000-8000-0000000000c4');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c7000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -4300, 'USD'),
  ('c7000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 4300, 'USD'),
  ('c7000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1500, 'USD'),
  ('c7000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 1500, 'USD'),
  ('c7000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -2000, 'USD'),
  ('c7000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 2000, 'USD'),
  ('c7000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -900, 'USD'),
  ('c7000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 900, 'USD');
update public.canonical_transactions
   set status = 'voided', voided_at = now()
 where id = 'c7000000-0000-4000-8000-000000000002';
insert into public.period_locks (household_id, entity_id, start_date, end_date, locked_by)
values ('00000000-0000-4000-8000-00000000a001', null, '2026-05-01', '2026-05-31',
        '00000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Happy path: alex moves T1 from 2026-06-01 to 2026-06-15.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d1', 'pgtap:setdate:set:t1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'c7000000-0000-4000-8000-000000000001',
      'effective_date', '2026-06-15'))
$$, 'owner moves a transaction to a new date');

select is(
  (select effective_date from public.canonical_transactions
    where id = 'c7000000-0000-4000-8000-000000000001'),
  '2026-06-15'::date, 'canonical_transactions.effective_date reflects the new date');

-- Law 9: replaying the same economic event key is a no-op replay.
select is(
  (select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d2', 'pgtap:setdate:set:t1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'c7000000-0000-4000-8000-000000000001',
      'effective_date', '2026-06-15')) ->> 'idempotentReplay'),
  'true', 'replaying the same economic event key is a no-op replay');
reset role;

-- Correction model (Law 2 / invariant 5): original untouched, reversal on
-- the OLD date, replacement on the NEW date, revision recorded.
select is(
  (select count(*)::int from public.journal_postings
    where batch_id = 'c7000000-0000-4000-8000-000000000021'),
  2, 'original batch postings are preserved verbatim');
select is(
  (select count(*)::int from public.journal_revisions
    where original_batch_id = 'c7000000-0000-4000-8000-000000000021'
      and replacement_batch_id is not null),
  1, 'revision row links original to its replacement');
select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id = 'c7000000-0000-4000-8000-000000000001'),
  3, 'exactly one reversal + one replacement were added (replay added nothing)');
select is(
  (select sum(p.amount_minor)::bigint from public.journal_postings p
    join public.journal_batches jb on jb.id = p.batch_id
    where jb.canonical_transaction_id = 'c7000000-0000-4000-8000-000000000001'),
  0::bigint, 'all batches for the transaction net to zero (Law 3)');

create temporary table _live on commit drop as
  select jb.id, jb.effective_date from public.journal_batches jb
   where jb.canonical_transaction_id = 'c7000000-0000-4000-8000-000000000001'
     and jb.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions rev
                      where rev.original_batch_id = jb.id);
select is((select count(*)::int from _live), 1, 'exactly one live batch after the date move');
select is((select effective_date from _live), '2026-06-15'::date,
  'the live batch is dated at the new date');
select is(
  (select count(*)::int from public.journal_postings where batch_id = (select id from _live)),
  2, 'live batch carries both postings, copied verbatim');
select is(
  (select amount_minor from public.journal_postings
    where batch_id = (select id from _live)
      and ledger_account_id = '00000000-0000-4000-8000-00000000a301'),
  -4300::bigint, 'cash posting amount is untouched by the date move');

-- The reversal batch stays dated on the OLD date — the old date nets to
-- zero rather than the entry vanishing outright.
select is(
  (select effective_date from public.journal_batches
    where canonical_transaction_id = 'c7000000-0000-4000-8000-000000000001'
      and reverses_batch_id = 'c7000000-0000-4000-8000-000000000021'),
  '2026-06-01'::date, 'the reversal batch stays dated at the ORIGINAL date');

-- Law 2: the mutation is on the append-only audit trail exactly once.
select is(
  (select count(*)::int from public.audit_log
    where action = 'transactions.set_date'
      and object_id = 'c7000000-0000-4000-8000-000000000001'),
  1, 'the date move is audited exactly once (replay added nothing)');

-- ---------------------------------------------------------------------------
-- Typed failure lattice (all as alex, fresh keys; nothing may mutate).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Malformed date payload.
select throws_ok($$
  select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d3', 'pgtap:setdate:badfmt', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'c7000000-0000-4000-8000-000000000001',
      'effective_date', 'not-a-date'))
$$, 'P0009', null, 'a malformed effective_date is rejected');

-- Voided transactions are immutable.
select throws_ok($$
  select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d4', 'pgtap:setdate:voided', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'c7000000-0000-4000-8000-000000000002',
      'effective_date', '2026-06-20'))
$$, 'P0001', null, 'a voided transaction cannot have its date changed');

-- Old-date guard: T3 already sits inside the locked period.
select throws_ok($$
  select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d5', 'pgtap:setdate:oldlocked', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'c7000000-0000-4000-8000-000000000003',
      'effective_date', '2026-06-25'))
$$, 'P0003', null, 'moving OUT of a locked period is blocked (the old date is locked)');

-- New-date guard: T4 sits outside the lock but the target date is inside it.
select throws_ok($$
  select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d6', 'pgtap:setdate:newlocked', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'c7000000-0000-4000-8000-000000000004',
      'effective_date', '2026-05-20'))
$$, 'P0003', null, 'moving INTO a locked period is blocked (the new date is locked)');

-- Cross-household transaction id is a scope violation.
select throws_ok($$
  select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d7', 'pgtap:setdate:xhh', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'b6000000-0000-4000-8000-000000000001',
      'effective_date', '2026-06-20'))
$$, 'P0006', null, 'a cross-household transaction id is a scope violation');
reset role;

-- Nothing mutated by the failure lattice.
select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id in (
      'c7000000-0000-4000-8000-000000000002',
      'c7000000-0000-4000-8000-000000000003',
      'c7000000-0000-4000-8000-000000000004')),
  3, 'failed attempts appended no batches to T2/T3/T4');

-- ---------------------------------------------------------------------------
-- Scope safety: casey (beta owner) cannot re-date alpha's transaction.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$
  select public.keel_cmd_set_date(
    'c7000000-0000-4000-8000-0000000000d8', 'pgtap:setdate:xhh:2', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'c7000000-0000-4000-8000-000000000001',
      'effective_date', '2026-06-20'))
$$, 'P0006', null, 'non-member cannot command against alpha at all');
reset role;

select * from finish();rollback;
