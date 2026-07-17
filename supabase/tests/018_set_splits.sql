-- Split editor write path (teardown C7): transactions.set_splits →
-- keel_cmd_set_splits. Privileged direct inserts here are pgTAP-only
-- scaffolding (this layer runs as the migration role by design); every
-- runtime surface goes through the command under test. The RPC happy path is
-- also covered by tests/integration/19-set-splits.test.ts.
begin;select no_plan();

-- Surface + ownership (keel_api, non-BYPASSRLS — the established ritual).
select has_function('public','keel_cmd_set_splits',
  array['uuid','text','jsonb','uuid','jsonb'],'set-splits command exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_cmd_set_splits(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','set-splits command owned by keel_api');
-- Multi-split re-splits DELETE the overlay row; without this grant the
-- command 42501s mid-flight.
select ok(has_table_privilege('keel_api', 'public.transaction_categories', 'delete'),
  'keel_api may delete overlay rows (multi-split coherence)');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: entity a101, checking ledger a301 (account a401),
-- categories a311 Groceries / a314 Coffee Shops / a317 Uncategorized Expense.
-- T1: a synced single-offset transaction parked on the landing pad, carrying
-- a plaid_pfc overlay (Groceries) — the multi-split must delete that overlay.
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('c6000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'COSTCO WHOLESALE #482', '2026-07-10', 'pgtap:splits:t1'),
  ('c6000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'VOIDED ROW', '2026-07-11', 'pgtap:splits:t2'),
  ('c6000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'LOCKED PERIOD ROW', '2026-05-15', 'pgtap:splits:t3');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c6000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c6000000-0000-4000-8000-000000000001', 'COSTCO WHOLESALE #482', '2026-07-10',
   'c6000000-0000-4000-8000-0000000000c1'),
  ('c6000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   'c6000000-0000-4000-8000-000000000002', 'VOIDED ROW', '2026-07-11',
   'c6000000-0000-4000-8000-0000000000c2'),
  ('c6000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a001',
   'c6000000-0000-4000-8000-000000000003', 'LOCKED PERIOD ROW', '2026-05-15',
   'c6000000-0000-4000-8000-0000000000c3');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c6000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -4300, 'USD'),
  ('c6000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 4300, 'USD'),
  ('c6000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1500, 'USD'),
  ('c6000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 1500, 'USD'),
  ('c6000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -2000, 'USD'),
  ('c6000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 2000, 'USD');
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('c6000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a311', 'plaid_pfc');
update public.canonical_transactions
   set status = 'voided', voided_at = now()
 where id = 'c6000000-0000-4000-8000-000000000002';
insert into public.period_locks (household_id, entity_id, start_date, end_date, locked_by)
values ('00000000-0000-4000-8000-00000000a001', null, '2026-05-01', '2026-05-31',
        '00000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Happy path: alex re-splits T1 into Groceries 3000 + Coffee Shops 1300.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d1', 'pgtap:splits:set:t1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a311', 'amount_minor', '3000'),
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a314', 'amount_minor', '1300'))))
$$, 'owner re-splits a synced transaction into two categories');

-- Law 9: replaying the same economic event key is a no-op replay.
select is(
  (select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d2', 'pgtap:splits:set:t1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a311', 'amount_minor', '3000'),
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a314', 'amount_minor', '1300')))) ->> 'idempotentReplay'),
  'true', 'replaying the same economic event key is a no-op replay');
reset role;

-- Correction model (Law 2 / invariant 5): original untouched, reversal exact,
-- replacement live, revision recorded with the replacement pointer.
select is(
  (select count(*)::int from public.journal_postings
    where batch_id = 'c6000000-0000-4000-8000-000000000021'),
  2, 'original batch postings are preserved verbatim');
select is(
  (select count(*)::int from public.journal_revisions
    where original_batch_id = 'c6000000-0000-4000-8000-000000000021'
      and replacement_batch_id is not null),
  1, 'revision row links original to its replacement');
select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  3, 'exactly one reversal + one replacement were added (replay added nothing)');
select is(
  (select sum(p.amount_minor)::bigint from public.journal_postings p
    join public.journal_batches jb on jb.id = p.batch_id
    where jb.canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  0::bigint, 'all batches for the transaction net to zero (Law 3)');

-- The LIVE batch is the replacement: cash unchanged, two split offsets.
create temporary table _live on commit drop as
  select jb.id from public.journal_batches jb
   where jb.canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'
     and jb.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions rev
                      where rev.original_batch_id = jb.id);
select is((select count(*)::int from _live), 1, 'exactly one live batch after the re-split');
select is(
  (select count(*)::int from public.journal_postings where batch_id = (select id from _live)),
  3, 'live batch carries cash + two split postings');
select is(
  (select amount_minor from public.journal_postings
    where batch_id = (select id from _live)
      and ledger_account_id = '00000000-0000-4000-8000-00000000a301'),
  -4300::bigint, 'cash posting is untouched by the re-split');
select is(
  (select amount_minor from public.journal_postings
    where batch_id = (select id from _live)
      and ledger_account_id = '00000000-0000-4000-8000-00000000a311'),
  3000::bigint, 'Groceries split posted exactly');
select is(
  (select amount_minor from public.journal_postings
    where batch_id = (select id from _live)
      and ledger_account_id = '00000000-0000-4000-8000-00000000a314'),
  1300::bigint, 'Coffee Shops split posted exactly');

-- Multi-split coherence: the stale plaid_pfc overlay is gone (splits ARE the
-- categorization — 20260713100000 §5).
select is(
  (select count(*)::int from public.transaction_categories
    where canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  0, 'multi-split re-split deletes the overlay row');

-- Law 2: the mutation is on the append-only audit trail exactly once.
select is(
  (select count(*)::int from public.audit_log
    where action = 'transactions.set_splits'
      and object_id = 'c6000000-0000-4000-8000-000000000001'),
  1, 'the re-split is audited exactly once (replay added nothing)');

-- Read model: one row, categorized by its splits.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
create temporary table _rich on commit drop as
  select elem from jsonb_array_elements(
    public.keel_list_transactions_rich('00000000-0000-4000-8000-00000000a001')->'rows') as t(elem);
select is(
  (select count(*)::int from _rich
    where elem->>'transactionId' = 'c6000000-0000-4000-8000-000000000001'),
  1, 'rich list still renders ONE row for the re-split transaction');
select is(
  (select jsonb_array_length(elem->'splits') from _rich
    where elem->>'transactionId' = 'c6000000-0000-4000-8000-000000000001'),
  2, 'rich list reports both splits');
select is(
  (select elem->>'categoryName' from _rich
    where elem->>'transactionId' = 'c6000000-0000-4000-8000-000000000001'),
  'Split', 'rich list labels the row Split');

-- ---------------------------------------------------------------------------
-- Typed failure lattice (all as alex, fresh keys; nothing may mutate).
-- ---------------------------------------------------------------------------
-- Stale-view guard: client amount disagrees with the live cash posting.
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d3', 'pgtap:splits:stale', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-9999',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000a311', 'amount_minor', '9999'))))
$$, 'P0009', null, 'a stale client amount fails typed instead of rebalancing');

-- Law 3 at the proc layer: unbalanced splits are rejected.
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d4', 'pgtap:splits:unbalanced', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000a311', 'amount_minor', '4200'))))
$$, 'P0002', null, 'unbalanced splits are rejected (KEEL_UNBALANCED)');

-- Duplicate categories are rejected deterministically.
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d5', 'pgtap:splits:dup', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a311', 'amount_minor', '2150'),
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a311', 'amount_minor', '2150'))))
$$, 'P0009', null, 'duplicate split categories are rejected');

-- Zero split amounts are meaningless economics.
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d6', 'pgtap:splits:zero', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a311', 'amount_minor', '4300'),
        jsonb_build_object('category_ledger_account_id',
          '00000000-0000-4000-8000-00000000a314', 'amount_minor', '0'))))
$$, 'P0008', null, 'zero split amounts are rejected');

-- Direction rule (code review r3603509629): an income category on a
-- money-out transaction is rejected — direction is sign(cash), the same
-- convention as the promoter's landing pads and keel_apply_rules' kind guard.
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000de', 'pgtap:splits:direction', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000a318', 'amount_minor', '4300'))))
$$, 'P0009', null, 'an income category on a cash-out transaction is rejected (direction rule)');

-- Cross-household category smuggling (beta Groceries on an alpha txn).
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d7', 'pgtap:splits:xcat', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000b311', 'amount_minor', '4300'))))
$$, 'P0006', null, 'a cross-household split category is a scope violation');

-- Voided transactions are immutable.
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d8', 'pgtap:splits:voided', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000002',
      'amount_minor', '-1500',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000a311', 'amount_minor', '1500'))))
$$, 'P0001', null, 'a voided transaction cannot be re-split');

-- Locked periods block the correction (Law 2: reopen first, with reason).
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000d9', 'pgtap:splits:locked', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000003',
      'amount_minor', '-2000',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000a311', 'amount_minor', '2000'))))
$$, 'P0003', null, 'a transaction in a locked period cannot be re-split');
reset role;

-- ---------------------------------------------------------------------------
-- Scope safety: casey (beta owner) cannot re-split alpha's transaction.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000da', 'pgtap:splits:xhh:1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000b001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000b311', 'amount_minor', '4300'))))
$$, 'P0006', null, 'cross-household transaction id is a scope violation');
select throws_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000db', 'pgtap:splits:xhh:2', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000a311', 'amount_minor', '4300'))))
$$, 'P0006', null, 'non-member cannot command against alpha at all');
reset role;

-- Nothing mutated by the failure lattice: still one live batch of 3 postings.
select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  3, 'failed attempts appended no batches');

-- ---------------------------------------------------------------------------
-- Collapse back to a single category: overlay pinned as a USER classification
-- (no rule/PFC pass may silently re-file what the user just posted).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  select public.keel_cmd_set_splits(
    'c6000000-0000-4000-8000-0000000000dc', 'pgtap:splits:single', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id', 'c6000000-0000-4000-8000-000000000001',
      'amount_minor', '-4300',
      'splits', jsonb_build_array(jsonb_build_object('category_ledger_account_id',
        '00000000-0000-4000-8000-00000000a311', 'amount_minor', '4300'))))
$$, 'owner collapses the split back to one category');
reset role;

select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  5, 'the second revision added its own reversal + replacement pair');
select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  '00000000-0000-4000-8000-00000000a311'::uuid,
  'single-split collapse pins the overlay to the chosen category');
select is(
  (select source from public.transaction_categories
    where canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  'user', 'the pinned overlay is a USER classification');
select is(
  (select sum(p.amount_minor)::bigint from public.journal_postings p
    join public.journal_batches jb on jb.id = p.batch_id
    where jb.canonical_transaction_id = 'c6000000-0000-4000-8000-000000000001'),
  0::bigint, 'the full revision history still nets to zero (Law 3)');

select * from finish();rollback;
