-- WS-I / FEEDBACK.md F-029: per-account statement cadence + due reminder.
-- Proves the set/clear command, derived-vs-manual close day, next-expected-close
-- computation, overdue flag, scope/ownership, and export coverage.
begin; select no_plan();

select has_table('public','account_statement_cadence','cadence override table exists');
select has_function('public','keel_statement_set_cadence',array['uuid','text','jsonb','uuid','jsonb'],'set cadence command exists');
select has_function('public','keel_statement_cadence',array['uuid'],'cadence read model exists');
select is((select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
  where p.oid='public.keel_statement_set_cadence(uuid,text,jsonb,uuid,jsonb)'::regprocedure),'keel_api','set command owned by keel_api');
select ok(not has_function_privilege('anon','public.keel_statement_set_cadence(uuid,text,jsonb,uuid,jsonb)','EXECUTE'),'anon cannot set cadence');

-- Two prior statements on the seed checking account, both closing on the 5th
-- (so the derived cadence is day 5). Deterministic 'ea…' prefix.
insert into public.statements(id,household_id,account_id,period_start,period_end,opening_minor,ending_minor,currency,source_hash,created_by) values
('ea000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','2026-03-06','2026-04-05',0,10000,'USD',repeat('a',64),'00000000-0000-4000-8000-000000000001'),
('ea000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','2026-04-06','2026-05-05',10000,20000,'USD',repeat('b',64),'00000000-0000-4000-8000-000000000001');

set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Derived cadence: day 5, source 'derived'. Last period end 2026-05-05.
select is(
  (select r->>'closeDay' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  '5','close day derived from prior statements is 5');
select is(
  (select r->>'closeDaySource' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  'derived','source is derived when no manual override');
select is(
  (select r->>'lastPeriodEnd' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  '2026-05-05','last covered period end reported');
-- Next expected close is the first day-5 strictly after 2026-05-05 → 2026-06-05.
select is(
  (select r->>'nextExpectedClose' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  '2026-06-05','next expected close is one cycle after the last statement');
-- Today is well past 2026-06-05, so it is overdue.
select is(
  (select r->>'overdue' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  'true','a missed cycle marks the account overdue');

-- Set a manual override to day 20; source flips to 'manual', close day 20.
select lives_ok($$select public.keel_statement_set_cadence('ea000000-0000-4000-8000-000000000011','pgtap:f029:set','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401','close_day',20))$$,'manual cadence set');
select is(
  (select r->>'closeDay' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  '20','manual override wins over derived');
select is(
  (select r->>'closeDaySource' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  'manual','source is manual once set');

-- Out-of-range close day is rejected.
select throws_ok($$select public.keel_statement_set_cadence('ea000000-0000-4000-8000-000000000012','pgtap:f029:bad','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401','close_day',40))$$,'P0009',null,'close day > 31 rejected');

-- Clear the override → back to derived day 5.
select lives_ok($$select public.keel_statement_set_cadence('ea000000-0000-4000-8000-000000000013','pgtap:f029:clear','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401','close_day',null))$$,'manual cadence cleared');
select is(
  (select r->>'closeDaySource' from jsonb_array_elements(public.keel_statement_cadence('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'accountId'='00000000-0000-4000-8000-00000000a401'),
  'derived','clearing the override reverts to derived');

-- Cross-tenant account is rejected (Beta checking under Alpha household).
select throws_ok($$select public.keel_statement_set_cadence('ea000000-0000-4000-8000-000000000014','pgtap:f029:scope','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('account_id','00000000-0000-4000-8000-00000000b401','close_day',10))$$,'P0006',null,'cross-tenant account rejected');

-- Export allowlist covers the new table.
select ok(has_table_privilege('keel_export','public.account_statement_cadence','SELECT'),'export role can read cadence table');

select * from finish(); rollback;
