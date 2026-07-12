-- Stage 1D gate 6: typed paycheck decomposition and destination reconciliation.
begin;
select no_plan();

select has_table('public','employers','employers exist');
select has_table('public','paychecks','paychecks exist');
select has_table('public','paycheck_components','typed components exist');
select has_table('public','paycheck_templates','templates exist');
select has_table('public','paycheck_sources','source links exist');
select has_table('public','paycheck_transaction_matches','many-to-many destinations exist');
select has_table('public','payroll_provider_imports','immutable payroll imports exist');
select has_table('public','paycheck_status_events','reversible status history exists');
select has_function('public','keel_paycheck_create',array['uuid','text','jsonb','uuid','jsonb'],'create command exists');
select has_function('public','keel_paycheck_reverse',array['uuid','text','jsonb','uuid','jsonb'],'reverse command exists');
select has_function('public','keel_paycheck_restore',array['uuid','text','jsonb','uuid','jsonb'],'restore command exists');
select has_function('public','keel_list_paychecks',array['uuid'],'reproducible read exists');
select is((select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
  where p.oid='public.keel_paycheck_create(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','command owner is keel_api');
select ok(not has_function_privilege('anon','public.keel_paycheck_create(uuid,text,jsonb,uuid,jsonb)','EXECUTE'),
  'anon cannot create paychecks');
select ok(has_function_privilege('authenticated','public.keel_paycheck_create(uuid,text,jsonb,uuid,jsonb)','EXECUTE'),
  'authenticated invokes command proc');

insert into public.canonical_transactions
  (id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key)
values
  ('a6000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','manual','paycheck deposit','2026-07-12','pgtap:paycheck:deposit'),
  ('a6000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','manual','retirement contribution','2026-07-12','pgtap:paycheck:retirement');
insert into public.journal_batches(id,household_id,canonical_transaction_id,description,effective_date,command_id)
values
  ('a6000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a001','a6000000-0000-4000-8000-000000000001','deposit','2026-07-12','a6000000-0000-4000-8000-000000000021'),
  ('a6000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a001','a6000000-0000-4000-8000-000000000002','retirement','2026-07-12','a6000000-0000-4000-8000-000000000022');
insert into public.journal_postings(id,batch_id,ledger_account_id,entity_id,amount_minor,currency) values
  ('a6000000-0000-4000-8000-000000000031','a6000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',70000,'USD'),
  ('a6000000-0000-4000-8000-000000000032','a6000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a312','00000000-0000-4000-8000-00000000a101',-70000,'USD'),
  ('a6000000-0000-4000-8000-000000000033','a6000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',15000,'USD'),
  ('a6000000-0000-4000-8000-000000000034','a6000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a312','00000000-0000-4000-8000-00000000a101',-15000,'USD');

create temporary table paycheck_payload(payload jsonb);
insert into paycheck_payload values (jsonb_build_object(
  'employer_name','Keel Labs','pay_date','2026-07-12','gross_minor','100000','net_minor','70000','currency','USD',
  'components',jsonb_build_array(
    jsonb_build_object('key','salary','kind','gross_salary','amount_minor','100000'),
    jsonb_build_object('key','federal','kind','federal_withholding','amount_minor','20000'),
    jsonb_build_object('key','401k','kind','retirement_401k','amount_minor','10000'),
    jsonb_build_object('key','match','kind','employer_match','amount_minor','5000'),
    jsonb_build_object('key','deposit','kind','direct_deposit','amount_minor','70000')),
  'matches',jsonb_build_array(
    jsonb_build_object('transaction_id','a6000000-0000-4000-8000-000000000001','component_key','deposit','amount_minor','70000'),
    jsonb_build_object('transaction_id','a6000000-0000-4000-8000-000000000002','component_key','401k','amount_minor','10000'),
    jsonb_build_object('transaction_id','a6000000-0000-4000-8000-000000000002','component_key','match','amount_minor','5000')),
  'source',jsonb_build_object('kind','paystub','ref','stub-2026-07-12','content_hash',repeat('a',64))));
grant select on paycheck_payload to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$select public.keel_paycheck_create(
  'a6000000-0000-4000-8000-000000000041','pgtap:paycheck:create:1','{}',
  '00000000-0000-4000-8000-00000000a001',(select payload from paycheck_payload))$$,
  'typed paycheck reconciles gross, net, and two destination transactions');
select ok((select public.keel_paycheck_create(
  'a6000000-0000-4000-8000-000000000041','pgtap:paycheck:create:1','{}',
  '00000000-0000-4000-8000-00000000a001',(select payload from paycheck_payload))->>'idempotentReplay')::boolean,
  'identical replay is economic no-op');
select throws_ok($$select public.keel_paycheck_create(
  'a6000000-0000-4000-8000-000000000046','pgtap:paycheck:duplicate-source','{}',
  '00000000-0000-4000-8000-00000000a001',(select payload from paycheck_payload))$$,
  'P0007',null,'same source under a new economic key cannot duplicate a paycheck');
select throws_ok($$select public.keel_paycheck_create(
  'a6000000-0000-4000-8000-000000000047','pgtap:paycheck:overallocation','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'employer_name','Other','pay_date','2026-07-12','gross_minor','1','net_minor','1','currency','USD',
    'components',jsonb_build_array(
      jsonb_build_object('key','salary','kind','gross_salary','amount_minor','1'),
      jsonb_build_object('key','deposit','kind','direct_deposit','amount_minor','1')),
    'matches',jsonb_build_array(jsonb_build_object('transaction_id','a6000000-0000-4000-8000-000000000001','component_key','deposit','amount_minor','1')),
    'source',jsonb_build_object('kind','manual','ref','other','content_hash',repeat('b',64))))$$,
  'P0009',null,'destination capacity is enforced across existing paycheck allocations');
select is(jsonb_array_length(public.keel_list_paychecks('00000000-0000-4000-8000-00000000a001')->'rows'),1,
  'owner reads one paycheck');
select is(public.keel_list_paychecks('00000000-0000-4000-8000-00000000a001')->'rows'->0->>'grossMinor','100000',
  'gross is returned as exact string');
select is(public.keel_list_paychecks('00000000-0000-4000-8000-00000000a001')->>'formulaVersion','paycheck-reconciliation-v1',
  'read pins formula version');
select throws_ok($$select public.keel_paycheck_create(
  'a6000000-0000-4000-8000-000000000042','pgtap:paycheck:bad-net','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_set(jsonb_set((select payload from paycheck_payload),'{net_minor}','"70001"'),'{source,ref}','"bad-net"'))$$,
  'P0009',null,'gross-to-net mismatch is rejected');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select public.keel_paycheck_create(
  'a6000000-0000-4000-8000-000000000043','pgtap:paycheck:cross-tenant','{}',
  '00000000-0000-4000-8000-00000000b001',(select payload from paycheck_payload))$$,
  'P0006',null,'cross-tenant destination smuggling fails closed');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$select public.keel_paycheck_reverse(
  'a6000000-0000-4000-8000-000000000044','pgtap:paycheck:reverse:1','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'paycheck_id',(select id from public.paychecks limit 1),'reason','duplicate stub'))$$,
  'reverse appends correction event');
select lives_ok($$select public.keel_paycheck_restore(
  'a6000000-0000-4000-8000-000000000045','pgtap:paycheck:restore:1','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'paycheck_id',(select id from public.paychecks limit 1),'reason','stub verified'))$$,
  'restore reverses the correction');
reset role;

select is((select status::text from public.paychecks limit 1),'active','restored paycheck is active');
select is((select count(*)::int from public.paycheck_status_events),3,'create/reverse/restore history is append-only');
select throws_ok($$update public.paycheck_components set amount_minor=1$$,'P0001',null,'components are immutable');
select throws_ok($$delete from public.paycheck_transaction_matches$$,'P0001',null,'matches are immutable');
select ok((select before is not null and after is not null from public.audit_log where action='paychecks.reverse'),
  'reversal audit has before and after');

select * from finish();
rollback;
