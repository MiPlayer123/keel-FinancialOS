-- pgTAP: Plaid update-mode account reconcile
-- (20260811120000_connection_reconcile_accounts.sql).
--
-- keel_reconcile_connection_accounts inserts ONLY the accounts an existing
-- connection is missing (a reissued card re-surfaced by update mode), leaving
-- existing accounts untouched, and is idempotent on replay. Privileged direct
-- inserts here are pgTAP-only scaffolding; the runtime surface goes through the
-- api edge function over the user's JWT.
begin;select no_plan();

-- Surface + ownership + grant (the established ritual).
select has_function('public','keel_reconcile_connection_accounts',
  array['uuid','uuid','jsonb'], 'reconcile-accounts command exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_reconcile_connection_accounts(uuid,uuid,jsonb)'::regprocedure),
  'keel_api','reconcile-accounts owned by keel_api');
select ok(
  has_function_privilege('authenticated',
    'public.keel_reconcile_connection_accounts(uuid,uuid,jsonb)', 'execute'),
  'authenticated may execute reconcile-accounts');
select ok(
  not has_function_privilege('anon',
    'public.keel_reconcile_connection_accounts(uuid,uuid,jsonb)', 'execute'),
  'anon may NOT execute reconcile-accounts');

-- ---------------------------------------------------------------------------
-- Fixtures: Alpha household (a001, seeded) Chase connection with ONE existing
-- checking account (mask 1223) and NO card. Update mode will re-surface a
-- reissued credit card (mask 8311) that must be inserted under the SAME
-- connection.
-- ---------------------------------------------------------------------------
insert into public.connections (id, household_id, provider, external_ref, status, institution_id)
values
  ('ca000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   'plaid', 'pgtap:reconcile:chase-item', 'active', 'ins_chase');

insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category)
values
  ('ca000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Reconcile Checking', 'asset', 'USD', false);

insert into public.accounts (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref, mask)
values
  ('ca000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'ca000000-0000-4000-8000-000000000001',
   'ca000000-0000-4000-8000-000000000011', 'Reconcile Checking', 'checking', 'USD',
   'pgtap:reconcile:acct-checking', '1223');

-- ---------------------------------------------------------------------------
-- Reconcile with [existing checking (skip) + reissued card (add)]. Runs over
-- the owner's JWT so keel_actor_from_jwt / keel_assert_member_write resolve.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select (public.keel_reconcile_connection_accounts(
    '00000000-0000-4000-8000-00000000a001',
    'ca000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object('external_ref','pgtap:reconcile:acct-checking','name','Reconcile Checking',
                         'subtype','checking','currency','USD','kind','asset','mask','1223'),
      jsonb_build_object('external_ref','pgtap:reconcile:acct-card','name','SAPPHIRE RESERVE',
                         'subtype','credit card','currency','USD','kind','liability','mask','8311')
    )
  ))->>'addedCount'),
  '1', 'reconcile adds exactly the one missing (card) account');

-- The card row now exists under THIS connection, as a liability, mask 8311.
select is(
  (select count(*)::text from public.accounts
     where connection_id = 'ca000000-0000-4000-8000-000000000001'
       and external_ref = 'pgtap:reconcile:acct-card' and mask = '8311'),
  '1', 'reissued card inserted under the existing connection');
select is(
  (select la.kind::text from public.accounts a
     join public.ledger_accounts la on la.id = a.ledger_account_id
    where a.connection_id = 'ca000000-0000-4000-8000-000000000001'
      and a.external_ref = 'pgtap:reconcile:acct-card'),
  'liability', 'card ledger account is a liability');

-- Entity resolved to the household's personal entity (default path).
select is(
  (select a.entity_id from public.accounts a
    where a.connection_id = 'ca000000-0000-4000-8000-000000000001'
      and a.external_ref = 'pgtap:reconcile:acct-card'),
  (select id from public.entities
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and kind = 'personal' and archived_at is null order by created_at, id limit 1),
  'card lands in the household personal entity');

-- The existing checking account is UNTOUCHED (same id, same ledger account).
select is(
  (select count(*)::text from public.accounts
     where connection_id = 'ca000000-0000-4000-8000-000000000001'
       and external_ref = 'pgtap:reconcile:acct-checking'
       and id = 'ca000000-0000-4000-8000-000000000021'
       and ledger_account_id = 'ca000000-0000-4000-8000-000000000011'),
  '1', 'existing checking account is left exactly as-is');

-- Exactly two accounts on the connection now (no duplication of checking).
select is(
  (select count(*)::text from public.accounts
     where connection_id = 'ca000000-0000-4000-8000-000000000001'),
  '2', 'connection has exactly checking + card (no duplicate checking)');

-- IDEMPOTENT: a second identical reconcile adds nothing.
select is(
  (select (public.keel_reconcile_connection_accounts(
    '00000000-0000-4000-8000-00000000a001',
    'ca000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object('external_ref','pgtap:reconcile:acct-checking','name','Reconcile Checking',
                         'subtype','checking','currency','USD','kind','asset','mask','1223'),
      jsonb_build_object('external_ref','pgtap:reconcile:acct-card','name','SAPPHIRE RESERVE',
                         'subtype','credit card','currency','USD','kind','liability','mask','8311')
    )
  ))->>'addedCount'),
  '0', 'replay adds nothing (idempotent)');
select is(
  (select count(*)::text from public.accounts
     where connection_id = 'ca000000-0000-4000-8000-000000000001'),
  '2', 'still exactly two accounts after replay');

-- A summary audit row was written for the reconcile action.
select ok(
  exists(select 1 from public.audit_log
     where household_id = '00000000-0000-4000-8000-00000000a001'
       and action = 'connections.accounts_reconciled'
       and object_id = 'ca000000-0000-4000-8000-000000000001'),
  'reconcile writes a summary audit_log row');

-- SCOPE: a connection id not in the caller's household raises P0006 (here a
-- non-existent id — the household-scoped lookup finds no row).
select throws_ok($$
  select public.keel_reconcile_connection_accounts(
    '00000000-0000-4000-8000-00000000a001',
    'ca000000-0000-4000-8000-0000000000ff',
    '[]'::jsonb)
$$, 'P0006', null, 'unknown/foreign connection raises scope violation');

select * from finish();
rollback;
