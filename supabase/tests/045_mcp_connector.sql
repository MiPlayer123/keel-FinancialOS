-- 20261104100000 MCP connector: connected-app grants (first-party only, soft
-- revoke, audited), audit attribution of connected-app writes, the PostgREST
-- gateway guard, and the filtered transaction query. Privileged direct inserts
-- are pgTAP-only scaffolding (established ritual); fixtures are fictional.
begin; select no_plan();

-- ---------------------------------------------------------------------------
-- Structure + grants
-- ---------------------------------------------------------------------------
select has_table('public', 'mcp_client_grants', 'grants table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.mcp_client_grants'::regclass),
  'grants table has RLS on');
select ok(not has_table_privilege('authenticated', 'public.mcp_client_grants', 'INSERT'),
  'clients cannot insert grants directly');
select ok(not has_table_privilege('authenticated', 'public.mcp_client_grants', 'UPDATE'),
  'clients cannot update grants directly');
select ok(not has_function_privilege('anon', 'public.keel_mcp_grant_set(text,uuid,public.mcp_access_level)', 'execute'),
  'anon cannot set grants');
select ok(not has_function_privilege('authenticated',
  'public.keel_transactions_page(uuid,integer,date,uuid,uuid,uuid,text,date,date,uuid[],text,bigint,bigint,text,uuid,uuid,boolean)',
  'execute'), 'the internal page builder is not client-callable');
select ok(has_function_privilege('authenticated', 'public.keel_query_transactions(uuid,jsonb,integer,date,uuid)', 'execute'),
  'authenticated may run the filtered query');
select ok(not has_function_privilege('anon', 'public.keel_query_transactions(uuid,jsonb,integer,date,uuid)', 'execute'),
  'anon may not run the filtered query');
select is((select r.rolname::text from pg_proc p join pg_roles r on r.oid = p.proowner
            where p.oid = 'public.keel_mcp_grant_set(text,uuid,public.mcp_access_level)'::regprocedure),
  'keel_api', 'grant writes run as the unprivileged keel_api role');
select ok((select 'pgrst.db_pre_request=public.keel_pre_request' = any (rolconfig)
             from pg_roles where rolname = 'authenticator'),
  'PostgREST runs the gateway guard before every request');

-- Gateway key in vault (test-only value; replaces any configured key inside
-- this transaction and is rolled back with it).
delete from vault.secrets where name = 'keel_mcp_gateway_key';
select vault.create_secret('test-gateway-key-0001', 'keel_mcp_gateway_key');

-- ---------------------------------------------------------------------------
-- Fixtures (d9… prefix). Alpha seed: household a001, owner user …0001, entity
-- a101, checking a401/a301, card a402/a302, Groceries a311, Salary a315,
-- Uncategorized Expense a317.
--   T1 2026-05-10 checking   -1000 uncategorized
--   T2 2026-05-20 checking +250000 Salary
--   T3 2026-06-05 card       -3000 Groceries, tagged "Vacation"
--   T4 2026-06-15 checking  -50000 Groceries, pending
--   T5 2026-04-02 checking   -2000 posted uncategorized, user recategorized to Groceries
--   T6 2026-04-01 checking  -70000 filed under a Transfers category (left out of cash flow)
-- ---------------------------------------------------------------------------
update public.ledger_accounts set pfc_key = 'uncategorized_expense'
 where id = '00000000-0000-4000-8000-00000000a317';
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category, pfc_key)
values ('d9000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a101','Transfers Out','expense','USD',true,'transfers_out');
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('d9000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','CORNER KIOSK','2026-05-10','pgtap:mcp:t1'),
  ('d9000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','PAYROLL','2026-05-20','pgtap:mcp:t2'),
  ('d9000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a402','posted','manual','HARBOR MARKET','2026-06-05','pgtap:mcp:t3'),
  ('d9000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','pending','manual','BULK FOODS','2026-06-15','pgtap:mcp:t4'),
  ('d9000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','MYSTERY SHOP','2026-04-02','pgtap:mcp:t5'),
  ('d9000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','CARD PAYMENT','2026-04-01','pgtap:mcp:t6');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('d9000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000001','CORNER KIOSK','2026-05-10','d9000000-0000-4000-8000-0000000000c1'),
  ('d9000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000002','PAYROLL','2026-05-20','d9000000-0000-4000-8000-0000000000c2'),
  ('d9000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000003','HARBOR MARKET','2026-06-05','d9000000-0000-4000-8000-0000000000c3'),
  ('d9000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000004','BULK FOODS','2026-06-15','d9000000-0000-4000-8000-0000000000c4'),
  ('d9000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000005','MYSTERY SHOP','2026-04-02','d9000000-0000-4000-8000-0000000000c5'),
  ('d9000000-0000-4000-8000-000000000026','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000006','CARD PAYMENT','2026-04-01','d9000000-0000-4000-8000-0000000000c6');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('d9000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-1000,'USD'),
  ('d9000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a317','00000000-0000-4000-8000-00000000a101',1000,'USD'),
  ('d9000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',250000,'USD'),
  ('d9000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-00000000a315','00000000-0000-4000-8000-00000000a101',-250000,'USD'),
  ('d9000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-00000000a302','00000000-0000-4000-8000-00000000a101',-3000,'USD'),
  ('d9000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-00000000a311','00000000-0000-4000-8000-00000000a101',3000,'USD'),
  ('d9000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-50000,'USD'),
  ('d9000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-00000000a311','00000000-0000-4000-8000-00000000a101',50000,'USD'),
  ('d9000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-2000,'USD'),
  ('d9000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-00000000a317','00000000-0000-4000-8000-00000000a101',2000,'USD'),
  ('d9000000-0000-4000-8000-000000000026','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-70000,'USD'),
  ('d9000000-0000-4000-8000-000000000026','d9000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-00000000a101',70000,'USD');
insert into public.transaction_categories (canonical_transaction_id, household_id, category_ledger_account_id, source)
values ('d9000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a311','user');
insert into public.tags (id, household_id, name) values
  ('d9000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-00000000a001','Vacation');
insert into public.transaction_tags (canonical_transaction_id, tag_id, household_id) values
  ('d9000000-0000-4000-8000-000000000003','d9000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-00000000a001');

-- Helper: the fixture ids a filtered query returns, in page order.
create function pg_temp.ids(p_filters jsonb) returns text language sql as $$
  select coalesce(string_agg(right(e->>'transactionId', 1), ',' order by ord), '')
    from jsonb_array_elements(
      public.keel_query_transactions('00000000-0000-4000-8000-00000000a001', p_filters, 200)->'rows'
    ) with ordinality as t(e, ord)
   where e->>'transactionId' like 'd9000000-%';
$$;

-- ===========================================================================
-- As Alex's own KEEL session (no client_id): set + revoke grants.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select isnt(public.keel_mcp_grant_set('client-test-1', '00000000-0000-4000-8000-00000000a001', 'read'), null,
  'a user can grant an app read access to their household');
select is(public.keel_mcp_grant_set('client-test-1', '00000000-0000-4000-8000-00000000a001', 'read'),
          (select id from public.mcp_client_grants where client_id = 'client-test-1' and revoked_at is null),
  'setting the same grant again is idempotent');
select lives_ok($$ select public.keel_mcp_grant_set('client-test-1', '00000000-0000-4000-8000-00000000a001', 'write') $$,
  'a user can raise the access level');
select is((select count(*)::int from public.mcp_client_grants where client_id = 'client-test-1'), 1,
  'changing access updates the one live grant');
select throws_ok($$ select public.keel_mcp_grant_set('client-test-1', '00000000-0000-4000-8000-00000000c001', 'read') $$,
  'P0006', null, 'cannot grant access to a household the user is not in');
select is((select count(*)::int from public.audit_log where action = 'mcp_grant.set'
            and after->>'client_id' = 'client-test-1'), 2,
  'grant changes are audited (set + raise; the idempotent repeat is not)');
select is((select actor->'via' from public.audit_log where action = 'mcp_grant.set' order by id desc limit 1), null,
  'first-party writes carry no connected-app stamp');

-- ===========================================================================
-- As the connected app (same user, client_id claim).
-- ===========================================================================
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"client-test-1"}';

select is(public.keel_mcp_grant_current()->>'access', 'write', 'the app sees its live grant');
select is(public.keel_mcp_grant_current()->>'householdId', '00000000-0000-4000-8000-00000000a001',
  'the grant pins the household');
select throws_ok($$ select public.keel_mcp_grant_set('client-test-1', '00000000-0000-4000-8000-00000000a001', 'write') $$,
  'P0005', null, 'a connected app cannot change its own access');
select throws_ok($$ select public.keel_mcp_grant_revoke('client-test-1') $$,
  'P0005', null, 'a connected app cannot revoke (or touch) grants');

-- Audit attribution: a write made under the app token is stamped.
select lives_ok($$ select public.keel_note_save('00000000-0000-4000-8000-00000000a001', null, 'Check the insurance renewal', false) $$,
  'a note write under the app token succeeds (Alex is owner)');
select is((select actor->'via'->>'clientId' from public.audit_log
            where household_id = '00000000-0000-4000-8000-00000000a001' order by id desc limit 1),
  'client-test-1', 'the audit row names the connected app');
select is((select actor->>'userId' from public.audit_log
            where household_id = '00000000-0000-4000-8000-00000000a001' order by id desc limit 1),
  '00000000-0000-4000-8000-000000000001', 'and still names the user it acted for');

-- Gateway guard.
set local request.headers to '{}';
select throws_ok($$ select public.keel_pre_request() $$, '42501', null,
  'an app token without the gateway header is refused');
set local request.headers to '{"x-keel-mcp-gateway":"wrong"}';
select throws_ok($$ select public.keel_pre_request() $$, '42501', null, 'a wrong gateway key is refused');
set local request.headers to '{"x-keel-mcp-gateway":"test-gateway-key-0001"}';
select lives_ok($$ select public.keel_pre_request() $$, 'the gateway key lets the app token through');

-- ===========================================================================
-- Filtered transaction query (as the user; claims do not change reads).
-- ===========================================================================
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local request.headers to '{}';
select lives_ok($$ select public.keel_pre_request() $$, 'requests without a client_id pass the guard untouched');

select is(pg_temp.ids('{}'), '4,3,2,1,5,6', 'no filters: every fixture, newest first');
select is(pg_temp.ids('{"from":"2026-05-15","to":"2026-06-10"}'), '3,2', 'date range: from inclusive, to exclusive');
select is(pg_temp.ids('{"direction":"in"}'), '2', 'direction in');
select is(pg_temp.ids('{"direction":"out"}'), '4,3,1,5,6', 'direction out');
select is(pg_temp.ids('{"minAmountMinor":3000,"maxAmountMinor":50000}'), '4,3', 'absolute amount range');
select is(pg_temp.ids('{"transactionIds":[]}'), '', 'an empty id list matches nothing');
select is(pg_temp.ids('{"status":"pending"}'), '4', 'status');
select is(pg_temp.ids('{"tagId":"d9000000-0000-4000-8000-0000000000f1"}'), '3', 'tag');
select is(pg_temp.ids('{"uncategorized":true}'), '1',
  'uncategorized: the user''s recategorization (T5, custom category) wins over the bank posting');
select is(pg_temp.ids('{"accountId":"00000000-0000-4000-8000-00000000a402"}'), '3', 'account');
select is(pg_temp.ids('{"categoryId":"00000000-0000-4000-8000-00000000a311"}'), '4,3,5', 'category');
select is(pg_temp.ids('{"search":"harbor"}'), '3', 'search');
reset role;
update public.accounts set entity_id = '00000000-0000-4000-8000-00000000a102'
 where id = '00000000-0000-4000-8000-00000000a402';
set local role authenticated;
select is(pg_temp.ids('{"entityId":"00000000-0000-4000-8000-00000000a102"}'), '3',
  'entity filter follows the account''s current entity (moved card → its history moves too)');
select is(pg_temp.ids('{"transactionIds":["d9000000-0000-4000-8000-000000000002","d9000000-0000-4000-8000-000000000004"]}'),
  '4,2', 'explicit ids');

select is(
  (select jsonb_array_length(public.keel_query_transactions('00000000-0000-4000-8000-00000000a001',
     '{"from":"2026-05-01","to":"2026-07-01"}', 2)->'rows')), 2, 'page size is honoured');
select is(
  (select (r->'rows'->0) - 'cashFlowExcluded' from (select public.keel_query_transactions('00000000-0000-4000-8000-00000000a001',
     '{"transactionIds":["d9000000-0000-4000-8000-000000000003"]}') as r) q),
  (select e from jsonb_array_elements(
     public.keel_list_transactions_rich_page('00000000-0000-4000-8000-00000000a001', 200)->'rows') e
    where e->>'transactionId' = 'd9000000-0000-4000-8000-000000000003'),
  'filtered rows are byte-identical to the rich page rows (plus cashFlowExcluded)');
select is(
  (select string_agg(right(e->>'transactionId', 1), ',' order by e->>'transactionId')
     from jsonb_array_elements(public.keel_query_transactions('00000000-0000-4000-8000-00000000a001',
       '{"from":"2026-01-01"}', 200)->'rows') e
    where (e->>'cashFlowExcluded')::boolean and e->>'transactionId' like 'd9000000-%'),
  '6', 'cashFlowExcluded flags exactly what KEEL cash flow leaves out (Transfers category)');

select throws_ok($$ select public.keel_query_transactions('00000000-0000-4000-8000-00000000a001', '{"bogus":1}') $$,
  'P0009', null, 'unknown filter keys are rejected');
select throws_ok($$ select public.keel_query_transactions('00000000-0000-4000-8000-00000000a001', '{"from":"not-a-date"}') $$,
  'P0009', null, 'malformed filters are rejected');
select throws_ok($$ select public.keel_query_transactions('00000000-0000-4000-8000-00000000a001', '{"direction":"sideways"}') $$,
  'P0009', null, 'bad direction is rejected');
select throws_ok($$ select public.keel_query_transactions('00000000-0000-4000-8000-00000000a001', '{"minAmountMinor":10,"maxAmountMinor":5}') $$,
  'P0009', null, 'inverted amount range is rejected');

-- A non-member cannot read the household.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select public.keel_query_transactions('00000000-0000-4000-8000-00000000a001', '{}') $$,
  'P0006', null, 'non-members are refused');

-- Revoke is a soft delete and ends the app's access at once.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.keel_mcp_grant_revoke('client-test-1') $$, 'the user revokes the app');
select isnt((select revoked_at from public.mcp_client_grants where client_id = 'client-test-1'), null,
  'the grant row is kept with revoked_at (soft delete)');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"client-test-1"}';
select is(public.keel_mcp_grant_current(), null, 'a revoked app has no live grant');

select * from finish();
rollback;
