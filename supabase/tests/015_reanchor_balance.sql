-- Opening-balance auto-anchor deferral gate + re-anchor command surface.
-- The deferral behavior lives inside keel_apply_account_balance and needs an
-- UNSYNCED connection (last_successful_sync_at is null), which the append-only,
-- proc-only financial tables forbid the service_role from creating directly
-- (Law 7). pgTAP runs with full privileges, so it is the correct layer for
-- this proc-internal behavior; the re-anchor command's auth/RPC happy path is
-- covered by tests/integration/16-reanchor-balance.test.ts.
begin;select no_plan();

-- Command surface + ownership (keel_api, non-BYPASSRLS — the established ritual).
select has_function('public','keel_cmd_reanchor_balance',
  array['uuid','text','jsonb','uuid','jsonb'],'reanchor command exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_cmd_reanchor_balance(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','reanchor command owned by keel_api');

-- Setup: an asset ledger account, an unsynced plaid connection, an account
-- linking them. Entity a101 already has an 'Opening Balances' equity account.
insert into public.ledger_accounts(id,household_id,entity_id,name,kind,currency,is_category,created_at,archived_at)
values('a9000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001',
       '00000000-0000-4000-8000-00000000a101','Reanchor Gate Checking','asset','USD',false,now(),null);
insert into public.connections(id,household_id,provider,external_ref,status,last_successful_sync_at)
values('a9000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001',
       'plaid','pgtap-reanchor-gate','active',null);
insert into public.accounts(id,household_id,entity_id,connection_id,ledger_account_id,name,subtype,currency)
values('a9000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-00000000a001',
       '00000000-0000-4000-8000-00000000a101','a9000000-0000-4000-8000-000000000002',
       'a9000000-0000-4000-8000-000000000001','Reanchor Gate','checking','USD');

-- First balance refresh BEFORE the first full sync completes: snapshot only,
-- no anchor (the backfilled window is not yet in Σ(postings)).
select lives_ok(
  $$select public.keel_apply_account_balance('00000000-0000-4000-8000-00000000a001',
      'a9000000-0000-4000-8000-000000000003',250000,250000,'USD',now())$$,
  'apply_account_balance runs on an unsynced connection');
select is(
  (select coalesce(sum(amount_minor),0)::bigint from public.journal_postings
     where ledger_account_id = 'a9000000-0000-4000-8000-000000000001'),
  0::bigint,'deferred: no opening booked while the connection is unsynced');
select ok(
  (select count(*) from public.balance_snapshots
     where account_id = 'a9000000-0000-4000-8000-000000000003') >= 1,
  'provider snapshot recorded every cycle, even while the anchor is deferred');

-- First full sync completes → the next refresh anchors to provider truth.
update public.connections set last_successful_sync_at = now()
  where id = 'a9000000-0000-4000-8000-000000000002';
select lives_ok(
  $$select public.keel_apply_account_balance('00000000-0000-4000-8000-00000000a001',
      'a9000000-0000-4000-8000-000000000003',250000,250000,'USD',now())$$,
  'apply_account_balance runs after the first full sync');
select is(
  (select coalesce(sum(amount_minor),0)::bigint from public.journal_postings
     where ledger_account_id = 'a9000000-0000-4000-8000-000000000001'),
  250000::bigint,'anchored to the provider balance once the first full sync completed');
-- The opening is a proper both-legs equity marker (account ledger + Opening
-- Balances), the same shape the deferral gate detects to avoid double-booking.
select ok(exists(
  select 1 from public.journal_batches b
   where b.household_id = '00000000-0000-4000-8000-00000000a001'
     and b.canonical_transaction_id is null and b.reverses_batch_id is null
     and exists(select 1 from public.journal_postings p
                  where p.batch_id = b.id
                    and p.ledger_account_id = 'a9000000-0000-4000-8000-000000000001')
     and exists(select 1 from public.journal_postings p2
                  join public.ledger_accounts la on la.id = p2.ledger_account_id
                  where p2.batch_id = b.id and la.name = 'Opening Balances'
                    and la.entity_id = '00000000-0000-4000-8000-00000000a101')
),'opening batch touches both the account ledger and the Opening Balances equity account');

-- Idempotent: a second post-sync refresh at the same provider balance books
-- nothing further (the both-legs marker already exists).
select lives_ok(
  $$select public.keel_apply_account_balance('00000000-0000-4000-8000-00000000a001',
      'a9000000-0000-4000-8000-000000000003',250000,250000,'USD',now())$$,
  'a second post-sync refresh runs');
select is(
  (select coalesce(sum(amount_minor),0)::bigint from public.journal_postings
     where ledger_account_id = 'a9000000-0000-4000-8000-000000000001'),
  250000::bigint,'no double-anchor: balance stays at provider truth');

select * from finish();rollback;
