-- 20261104200000: voiding a transaction rejects the transfer suggestions that
-- involve it (KEEL's own decision, audited); confirmed pairings are untouched.
-- Privileged direct writes are pgTAP scaffolding; every runtime void path sets
-- canonical_transactions.status = 'voided', which is what the trigger watches.
begin;select no_plan();

select has_trigger('public', 'canonical_transactions', 'keel_expire_transfer_suggestions_on_void',
  'void trigger exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.keel_expire_transfer_suggestions_on_void()'::regprocedure),
  true, 'trigger function is security definer');

-- Fixtures (alpha seed: entity a101, accounts a401 checking / a402 card).
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('c7000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a401', 'posted', 'sync', 'CARD PAYMENT', '2026-07-10', 'pgtap:xfer-expiry:1'),
  ('c7000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a402', 'pending', 'sync', 'PAYMENT THANK YOU', '2026-07-10', 'pgtap:xfer-expiry:2'),
  ('c7000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a401', 'posted', 'sync', 'CARD PAYMENT 2', '2026-07-11', 'pgtap:xfer-expiry:3'),
  ('c7000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a402', 'posted', 'sync', 'PAYMENT THANK YOU 2', '2026-07-11', 'pgtap:xfer-expiry:4'),
  ('c7000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a401', 'pending', 'sync', 'CARD PAYMENT 3', '2026-07-12', 'pgtap:xfer-expiry:5'),
  ('c7000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a402', 'posted', 'sync', 'PAYMENT THANK YOU 3', '2026-07-12', 'pgtap:xfer-expiry:6');
insert into public.transfer_links (id, household_id, txn_out, txn_in, status, decided_by, decided_at) values
  ('c7000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000002', 'suggested', null, null),
  ('c7000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000004', 'confirmed',
   '00000000-0000-4000-8000-000000000001', now()),
  ('c7000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000005', 'c7000000-0000-4000-8000-000000000006', 'suggested', null, null);

-- Voiding one side (a removed pending charge) rejects the suggestion.
update public.canonical_transactions set status = 'voided', voided_at = now()
 where id = 'c7000000-0000-4000-8000-000000000002';
select is((select status::text from public.transfer_links where id = 'c7000000-0000-4000-8000-0000000000a1'),
  'rejected', 'a suggestion whose transaction is voided is rejected');
select ok((select decided_by is null and decided_at is not null from public.transfer_links
            where id = 'c7000000-0000-4000-8000-0000000000a1'),
  'rejected by KEEL itself: no person, a decision time');
select is(
  (select count(*)::int from public.audit_log
    where action = 'transfers.suggestion_expired'
      and object_id = 'c7000000-0000-4000-8000-0000000000a1'
      and actor ->> 'kind' = 'system'
      and after ->> 'transactionId' = 'c7000000-0000-4000-8000-000000000002'),
  1, 'the expiry is audited with the voided transaction');

-- A confirmed pairing is left for the user to undo.
update public.canonical_transactions set status = 'voided', voided_at = now()
 where id = 'c7000000-0000-4000-8000-000000000004';
select is((select status::text from public.transfer_links where id = 'c7000000-0000-4000-8000-0000000000a2'),
  'confirmed', 'a confirmed pairing is untouched');

-- Pending → posted is not a void.
update public.canonical_transactions set status = 'posted'
 where id = 'c7000000-0000-4000-8000-000000000005';
select is((select status::text from public.transfer_links where id = 'c7000000-0000-4000-8000-0000000000a3'),
  'suggested', 'a status change that is not a void leaves the suggestion open');

-- The decision shape still holds where a person is required.
select throws_ok($$
  update public.transfer_links set status = 'confirmed', decided_by = null, decided_at = now()
   where id = 'c7000000-0000-4000-8000-0000000000a3'
$$, '23514', null, 'a confirmation still needs the person who confirmed it');
select throws_ok($$
  update public.transfer_links set decided_at = now()
   where id = 'c7000000-0000-4000-8000-0000000000a3'
$$, '23514', null, 'an open suggestion carries no decision time');

select * from finish();rollback;
