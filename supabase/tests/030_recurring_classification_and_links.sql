-- WS-I / FEEDBACK.md F-028: recurring classification + manual-schedule linking.
-- Proves the deterministic bucket classifier, the link/unlink commands
-- (reversible soft-detach), scope/idempotency, and the export/allowlist.
begin; select no_plan();

-- Schema + procs.
select has_table('public','recurring_series_schedule_links','link table exists');
select has_column('public','recurring_series_schedule_links','detached_at','link soft-deletes via detached_at');
select has_function('public','keel_recurring_link_schedule',array['uuid','text','jsonb','uuid','jsonb'],'link command exists');
select has_function('public','keel_recurring_unlink_schedule',array['uuid','text','jsonb','uuid','jsonb'],'unlink command exists');
select has_function('public','keel_recurring_classification',array['uuid'],'classification read exists');
select has_function('public','keel_list_recurring_schedule_links',array['uuid'],'link list read exists');
select is((select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
  where p.oid='public.keel_recurring_link_schedule(uuid,text,jsonb,uuid,jsonb)'::regprocedure),'keel_api','link command owned by keel_api');
select ok(not has_function_privilege('anon','public.keel_recurring_link_schedule(uuid,text,jsonb,uuid,jsonb)','EXECUTE'),'anon cannot link');

-- ---------------------------------------------------------------------------
-- Fixtures (fictional, deterministic 'd9…' prefix). A utility outflow series
-- matched to a real transaction carrying a RENT_AND_UTILITIES PFC primary, plus
-- an inflow (income) series, plus a matching manual schedule.
-- ---------------------------------------------------------------------------
-- Matched outflow transaction + its source record (pfc_primary = utility).
insert into public.canonical_transactions(id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key) values
('d9000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','Utility Co','2026-05-15','pgtap:f028:util');
insert into public.raw_provider_events(id,household_id,connection_id,provider,provider_event_id,account_external_ref,body,received_at) values
('d9000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a201','plaid','pgtap-f028-evt','sim-acct-checking','{}'::jsonb,now());
insert into public.normalized_source_records(id,raw_event_id,household_id,account_id,provider_transaction_id,amount_minor,currency,effective_date,description,pending,pfc_primary) values
('d9000000-0000-4000-8000-000000000201','d9000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','pgtap-f028-txn',-5000,'USD','2026-05-15','Utility Co',false,'RENT_AND_UTILITIES');
insert into public.transaction_source_links(canonical_transaction_id,normalized_source_record_id) values
('d9000000-0000-4000-8000-000000000001','d9000000-0000-4000-8000-000000000201');

-- Detector run + two series (utility outflow, income inflow) + candidates.
insert into public.recurring_detector_runs(id,household_id,run_key,as_of,detector_version,confidence_version,normalizer_version,candidate_snapshot_hash) values
('d9000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-00000000a001','pgtap-f028-run','2026-05-20','v1','v1','v1',repeat('a',64));
insert into public.recurring_series(id,household_id,series_key,account_id,ledger_account_id,counterparty_key,currency,sign,status,current_candidate_version_id) values
('d9000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-00000000a001','pgtap-f028-util','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','Utility Co','USD','outflow','confirmed',null),
('d9000000-0000-4000-8000-000000000402','00000000-0000-4000-8000-00000000a001','pgtap-f028-income','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','Payroll Inc','USD','inflow','confirmed',null);
insert into public.recurring_candidate_versions(id,household_id,series_id,detector_run_id,candidate_hash,input_fingerprint,detector_version,confidence_version,normalizer_version,as_of,score_bps,evidence,candidate) values
('d9000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000401','d9000000-0000-4000-8000-000000000301',repeat('b',64),repeat('c',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000001'),jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000001'),jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000001')),'{}'::jsonb),
('d9000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000402','d9000000-0000-4000-8000-000000000301',repeat('d',64),repeat('e',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),'{}'::jsonb);
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000501' where id='d9000000-0000-4000-8000-000000000401';
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000502' where id='d9000000-0000-4000-8000-000000000402';
-- Utility series has a MATCHED occurrence pointing at the categorized txn.
insert into public.recurring_occurrences(household_id,id,series_id,candidate_version_id,occurrence_key,expected_date,expected_amount_minor,currency,amount_kind,status,matched_txn_id,score_bps,evidence,input_fingerprint,detector_version,confidence_version,as_of) values
('00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000601','d9000000-0000-4000-8000-000000000401','d9000000-0000-4000-8000-000000000501',repeat('f',24),'2026-05-15',5000,'USD','fixed','matched','d9000000-0000-4000-8000-000000000001',9000,
  jsonb_build_array(jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000001'),jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000001'),jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000001')),repeat('a',24),'v1','v1','2026-05-20');

set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Classification: utility series → 'utility' (from PFC); income series → 'income' (from sign).
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000401'),
  'utility','utility PFC classifies the outflow series as utility');
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000402'),
  'income','inflow series classifies as income');

-- Create a matching manual schedule (a monthly bill, negative amount).
select lives_ok($$select public.keel_schedule_save('00000000-0000-4000-8000-00000000a001',null,'00000000-0000-4000-8000-00000000a401','Utility Co bill',-5000,null,'monthly','2026-06-15',null)$$,'schedule created');

-- Link the utility series to that schedule.
select lives_ok($$select public.keel_recurring_link_schedule('d9000000-0000-4000-8000-000000000701','pgtap:f028:link','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('series_id','d9000000-0000-4000-8000-000000000401','schedule_id',(select id from public.scheduled_transactions where household_id='00000000-0000-4000-8000-00000000a001' and description='Utility Co bill')))$$,'series links to schedule');
select is((select jsonb_array_length(public.keel_list_recurring_schedule_links('00000000-0000-4000-8000-00000000a001')->'rows')),1,'one active link is listed');

-- Direction mismatch is rejected: an inflow series cannot link a bill schedule.
select throws_ok($$select public.keel_recurring_link_schedule('d9000000-0000-4000-8000-000000000702','pgtap:f028:link-bad','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('series_id','d9000000-0000-4000-8000-000000000402','schedule_id',(select id from public.scheduled_transactions where household_id='00000000-0000-4000-8000-00000000a001' and description='Utility Co bill')))$$,'P0009',null,'direction mismatch rejected');

-- Duplicate active link rejected.
select throws_ok($$select public.keel_recurring_link_schedule('d9000000-0000-4000-8000-000000000703','pgtap:f028:link-dup','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('series_id','d9000000-0000-4000-8000-000000000401','schedule_id',(select id from public.scheduled_transactions where household_id='00000000-0000-4000-8000-00000000a001' and description='Utility Co bill')))$$,'P0009',null,'duplicate active link rejected');

-- Unlink is a reversible soft-detach (row persists, detached_at set).
select lives_ok($$select public.keel_recurring_unlink_schedule('d9000000-0000-4000-8000-000000000704','pgtap:f028:unlink','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('link_id',(select id from public.recurring_series_schedule_links where household_id='00000000-0000-4000-8000-00000000a001' and series_id='d9000000-0000-4000-8000-000000000401' and detached_at is null)))$$,'link unlinks');
select is((select jsonb_array_length(public.keel_list_recurring_schedule_links('00000000-0000-4000-8000-00000000a001')->'rows')),0,'no active links after unlink');
select is((select count(*)::int from public.recurring_series_schedule_links where household_id='00000000-0000-4000-8000-00000000a001'),1,'the detached link row persists (soft delete, not hard delete)');

-- After unlinking the same series+schedule can be re-linked (partial unique frees the slot).
select lives_ok($$select public.keel_recurring_link_schedule('d9000000-0000-4000-8000-000000000705','pgtap:f028:relink','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('series_id','d9000000-0000-4000-8000-000000000401','schedule_id',(select id from public.scheduled_transactions where household_id='00000000-0000-4000-8000-00000000a001' and description='Utility Co bill')))$$,'re-link after detach succeeds');

-- A hard DELETE on the link table is blocked (soft-delete only).
set local role postgres;
select throws_ok($$delete from public.recurring_series_schedule_links where household_id='00000000-0000-4000-8000-00000000a001'$$,'P0010',null,'hard delete of link rows is blocked');

-- Export allowlist covers the new table.
select ok(has_table_privilege('keel_export','public.recurring_series_schedule_links','SELECT'),'export role can read link table');

select * from finish(); rollback;
