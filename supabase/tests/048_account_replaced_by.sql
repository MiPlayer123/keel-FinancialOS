-- 20261104210000: an account replaced by another (a reissued card) reads as
-- part of its successor's register. The link is one audited column; nothing
-- in the ledger moves. Privileged inserts are pgTAP scaffolding.
begin;select no_plan();

select has_column('public', 'accounts', 'replaced_by_account_id', 'accounts.replaced_by_account_id exists');
select has_function('public', 'keel_set_account_replacement', array['uuid', 'uuid', 'uuid'], 'link command exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_set_account_replacement(uuid,uuid,uuid)'::regprocedure),
  'keel_api', 'link command owned by keel_api');

-- Fixtures (alpha seed: entity a101, checking a401/a301, card a402/a302,
-- Groceries a311). The old card number: archived, its own liability ledger,
-- one purchase. The new card (a402) gets one purchase too.
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category, created_at, archived_at)
values ('c8000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a101', 'Simulator Card (old)', 'liability', 'USD', false, now(), null);
insert into public.accounts (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref, created_at, archived_at)
values ('c8000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a101', null, 'c8000000-0000-4000-8000-0000000000b1',
        'Simulator Card', 'credit_card', 'USD', null, now(), now());
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('c8000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   'c8000000-0000-4000-8000-0000000000b2', 'posted', 'sync', 'OLD CARD GROCERIES', '2026-07-01', 'pgtap:replaced-by:1'),
  ('c8000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a402', 'posted', 'sync', 'NEW CARD GROCERIES', '2026-09-01', 'pgtap:replaced-by:2');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c8000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000001', 'OLD CARD GROCERIES', '2026-07-01', 'c8000000-0000-4000-8000-0000000000c1'),
  ('c8000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000002', 'NEW CARD GROCERIES', '2026-09-01', 'c8000000-0000-4000-8000-0000000000c2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c8000000-0000-4000-8000-000000000021', 'c8000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a101', -2500, 'USD'),
  ('c8000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a311', '00000000-0000-4000-8000-00000000a101', 2500, 'USD'),
  ('c8000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a302', '00000000-0000-4000-8000-00000000a101', -4000, 'USD'),
  ('c8000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a311', '00000000-0000-4000-8000-00000000a101', 4000, 'USD');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select jsonb_path_query_array(
     public.keel_list_transactions_rich_page('00000000-0000-4000-8000-00000000a001', 200, null, null,
       '00000000-0000-4000-8000-00000000a402'),
     '$.rows[*] ? (@.transactionId == "c8000000-0000-4000-8000-000000000001").transactionId')),
  '[]'::jsonb, 'before the link, the new card''s register has no old-card rows');

-- Link the old number to the new card.
select is(
  (public.keel_set_account_replacement('00000000-0000-4000-8000-00000000a001',
     'c8000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a402') ->> 'changed'),
  'true', 'owner links the closed card to its successor');
select is(
  (public.keel_set_account_replacement('00000000-0000-4000-8000-00000000a001',
     'c8000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a402') ->> 'changed'),
  'false', 'linking again is a no-op');

select is(
  (select jsonb_path_query_array(
     public.keel_list_transactions_rich_page('00000000-0000-4000-8000-00000000a001', 200, null, null,
       '00000000-0000-4000-8000-00000000a402'),
     '$.rows[*] ? (@.transactionId == "c8000000-0000-4000-8000-000000000001" || @.transactionId == "c8000000-0000-4000-8000-000000000002").amountMinor')),
  '["-4000", "-2500"]'::jsonb, 'the new card''s register shows both numbers, each on its own cash row');
select is(
  (select jsonb_path_query_first(
     public.keel_list_transactions_rich_page('00000000-0000-4000-8000-00000000a001', 200, null, null,
       '00000000-0000-4000-8000-00000000a402'),
     '$.rows[*] ? (@.transactionId == "c8000000-0000-4000-8000-000000000001").accountId') #>> '{}'),
  'c8000000-0000-4000-8000-0000000000b2', 'an old-number row still names the account it was booked on');

-- Guards.
select throws_ok($$
  select public.keel_set_account_replacement('00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a401', '00000000-0000-4000-8000-00000000a402')
$$, 'P0009', null, 'a live account cannot be marked replaced');
select throws_ok($$
  select public.keel_set_account_replacement('00000000-0000-4000-8000-00000000a001',
    'c8000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a401')
$$, 'P0009', null, 'a card cannot be replaced by a checking account');
select throws_ok($$
  select public.keel_set_account_replacement('00000000-0000-4000-8000-00000000b001',
    'c8000000-0000-4000-8000-0000000000b2', null)
$$, 'P0006', null, 'not a member of that household');
reset role;

select is(
  (select count(*)::int from public.audit_log
    where action = 'account.set_replacement' and object_id = 'c8000000-0000-4000-8000-0000000000b2'),
  1, 'the link is audited once');
select is(
  (select sum(p.amount_minor)::bigint from public.journal_postings p
    where p.ledger_account_id = 'c8000000-0000-4000-8000-0000000000b1'),
  -2500::bigint, 'nothing in the ledger moved');

-- Clearing the link restores two registers.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (public.keel_set_account_replacement('00000000-0000-4000-8000-00000000a001',
     'c8000000-0000-4000-8000-0000000000b2', null) ->> 'changed'),
  'true', 'the link can be cleared');
select is(
  (select jsonb_path_query_array(
     public.keel_list_transactions_rich_page('00000000-0000-4000-8000-00000000a001', 200, null, null,
       '00000000-0000-4000-8000-00000000a402'),
     '$.rows[*] ? (@.transactionId == "c8000000-0000-4000-8000-000000000001").transactionId')),
  '[]'::jsonb, 'after clearing, the old-card rows leave the new card''s register');
reset role;

select * from finish();rollback;
