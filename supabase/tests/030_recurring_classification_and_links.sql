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

-- Classification: utility series → 'utility' (from PFC). The inflow fixture's
-- counterparty_key is 'Payroll Inc' — a payroll token — so under the
-- 20260719090000 paycheck classifier it is 'paycheck' (payroll/wages), not plain
-- income.
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000401'),
  'utility','utility PFC classifies the outflow series as utility');
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000402'),
  'paycheck','a payroll inflow (counterparty carries a payroll token) classifies as paycheck');

-- C (migration 20260719010000): a personal P2P inflow series whose matched
-- transaction carries Plaid TRANSFER_IN classifies as 'excluded' — NOT income —
-- so the Recurring page offers it on neither lane. Same shape as the utility
-- fixture, a fresh '…403/203/603' set carrying pfc_primary = TRANSFER_IN.
reset role;
insert into public.canonical_transactions(id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key) values
('d9000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','Venmo payment from Casey','2026-05-10','pgtap:f028:p2p');
insert into public.normalized_source_records(id,raw_event_id,household_id,account_id,provider_transaction_id,amount_minor,currency,effective_date,description,pending,pfc_primary) values
('d9000000-0000-4000-8000-000000000203','d9000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','pgtap-f028-p2p-txn',5000,'USD','2026-05-10','Venmo payment from Casey',false,'TRANSFER_IN');
insert into public.transaction_source_links(canonical_transaction_id,normalized_source_record_id) values
('d9000000-0000-4000-8000-000000000003','d9000000-0000-4000-8000-000000000203');
insert into public.recurring_series(id,household_id,series_key,account_id,ledger_account_id,counterparty_key,currency,sign,status,current_candidate_version_id) values
('d9000000-0000-4000-8000-000000000403','00000000-0000-4000-8000-00000000a001','pgtap-f028-p2p','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','Venmo payment from casey','USD','inflow','confirmed',null);
insert into public.recurring_candidate_versions(id,household_id,series_id,detector_run_id,candidate_hash,input_fingerprint,detector_version,confidence_version,normalizer_version,as_of,score_bps,evidence,candidate) values
('d9000000-0000-4000-8000-000000000503','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000403','d9000000-0000-4000-8000-000000000301',repeat('9',64),repeat('7',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),'{}'::jsonb);
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000503' where id='d9000000-0000-4000-8000-000000000403';
insert into public.recurring_occurrences(household_id,id,series_id,candidate_version_id,occurrence_key,expected_date,expected_amount_minor,currency,amount_kind,status,matched_txn_id,score_bps,evidence,input_fingerprint,detector_version,confidence_version,as_of) values
('00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000603','d9000000-0000-4000-8000-000000000403','d9000000-0000-4000-8000-000000000503',repeat('e',24),'2026-05-10',5000,'USD','fixed','matched','d9000000-0000-4000-8000-000000000003',9000,
  jsonb_build_array(jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000003'),jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000003'),jsonb_build_object('txnId','d9000000-0000-4000-8000-000000000003')),repeat('b',24),'v1','v1','2026-05-20');
set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000403'),
  'excluded','a P2P (TRANSFER_IN) inflow series is excluded, not shown as income');
select is(
  (public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->>'formulaVersion'),
  'recurring-classification-v4-outflow-buckets','classification formula version bumped to v4 (outflow buckets)');

-- 20260719090000: PAYCHECK vs plain-INCOME split. A non-payroll inflow series
-- (a money-market dividend — no payroll token, carries a 'dividend' term) stays
-- 'income', NOT 'paycheck', so it never appears in the Paychecks "detected
-- paychecks" section. Fresh '…404' inflow series, no matched txn (mirrors the
-- live data where inflow occurrences are unmatched — the rule is token-driven).
reset role;
insert into public.recurring_series(id,household_id,series_key,account_id,ledger_account_id,counterparty_key,currency,sign,status,current_candidate_version_id) values
('d9000000-0000-4000-8000-000000000404','00000000-0000-4000-8000-00000000a001','pgtap-paycheck-dividend','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','dividend received fidelity government money market spaxx cash','USD','inflow','suggested',null);
insert into public.recurring_candidate_versions(id,household_id,series_id,detector_run_id,candidate_hash,input_fingerprint,detector_version,confidence_version,normalizer_version,as_of,score_bps,evidence,candidate) values
('d9000000-0000-4000-8000-000000000504','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000404','d9000000-0000-4000-8000-000000000301',repeat('4',64),repeat('4',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),'{}'::jsonb);
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000504' where id='d9000000-0000-4000-8000-000000000404';
insert into public.recurring_occurrences(household_id,id,series_id,candidate_version_id,occurrence_key,expected_date,expected_amount_minor,currency,amount_kind,status,matched_txn_id,score_bps,evidence,input_fingerprint,detector_version,confidence_version,as_of) values
('00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000604','d9000000-0000-4000-8000-000000000404','d9000000-0000-4000-8000-000000000504',repeat('4',24),'2026-06-01',461,'USD','fixed','expected',null,9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),repeat('4',24),'v1','v1','2026-05-20');
set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000404'),
  'income','a dividend inflow (no payroll token) stays plain income, not paycheck');

-- ---------------------------------------------------------------------------
-- 20260719210000 (GAP-2): full outflow PFC taxonomy + neutral 'recurring'.
-- The old classifier fell through `else 'subscription'` — a recurring rideshare
-- (TRANSPORTATION) or a series with NO matched occurrences (null dominant PFC)
-- wore the subscription label with zero evidence. Fixtures (all fictional):
--   …405 outflow, matched txn PFC TRANSPORTATION  -> 'recurring'
--   …406 outflow, matched txn PFC ENTERTAINMENT   -> 'subscription'
--   …407 outflow, matched txn PFC LOAN_PAYMENTS   -> 'bill'
--   …408 outflow, NO matched txn (null PFC)       -> 'recurring'
-- (RENT_AND_UTILITIES -> 'utility' is the …401 fixture above.)
-- ---------------------------------------------------------------------------
reset role;
insert into public.canonical_transactions(id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key) values
('d9000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','City Rideshare','2026-05-12','pgtap:f028:ride'),
('d9000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','StreamFlix','2026-05-13','pgtap:f028:stream'),
('d9000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','AutoLoan Servicing','2026-05-14','pgtap:f028:loan');
insert into public.normalized_source_records(id,raw_event_id,household_id,account_id,provider_transaction_id,amount_minor,currency,effective_date,description,pending,pfc_primary) values
('d9000000-0000-4000-8000-000000000204','d9000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','pgtap-f028-ride-txn',-1850,'USD','2026-05-12','City Rideshare',false,'TRANSPORTATION'),
('d9000000-0000-4000-8000-000000000205','d9000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','pgtap-f028-stream-txn',-1299,'USD','2026-05-13','StreamFlix',false,'ENTERTAINMENT'),
('d9000000-0000-4000-8000-000000000206','d9000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','pgtap-f028-loan-txn',-35000,'USD','2026-05-14','AutoLoan Servicing',false,'LOAN_PAYMENTS');
insert into public.transaction_source_links(canonical_transaction_id,normalized_source_record_id) values
('d9000000-0000-4000-8000-000000000004','d9000000-0000-4000-8000-000000000204'),
('d9000000-0000-4000-8000-000000000005','d9000000-0000-4000-8000-000000000205'),
('d9000000-0000-4000-8000-000000000006','d9000000-0000-4000-8000-000000000206');
insert into public.recurring_series(id,household_id,series_key,account_id,ledger_account_id,counterparty_key,currency,sign,status,current_candidate_version_id) values
('d9000000-0000-4000-8000-000000000405','00000000-0000-4000-8000-00000000a001','pgtap-gap2-ride','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','City Rideshare','USD','outflow','confirmed',null),
('d9000000-0000-4000-8000-000000000406','00000000-0000-4000-8000-00000000a001','pgtap-gap2-stream','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','StreamFlix','USD','outflow','confirmed',null),
('d9000000-0000-4000-8000-000000000407','00000000-0000-4000-8000-00000000a001','pgtap-gap2-loan','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','AutoLoan Servicing','USD','outflow','confirmed',null),
('d9000000-0000-4000-8000-000000000408','00000000-0000-4000-8000-00000000a001','pgtap-gap2-nopfc','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a301','Corner Grocer','USD','outflow','suggested',null);
insert into public.recurring_candidate_versions(id,household_id,series_id,detector_run_id,candidate_hash,input_fingerprint,detector_version,confidence_version,normalizer_version,as_of,score_bps,evidence,candidate) values
('d9000000-0000-4000-8000-000000000505','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000405','d9000000-0000-4000-8000-000000000301',repeat('1',64),repeat('1',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),'{}'::jsonb),
('d9000000-0000-4000-8000-000000000506','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000406','d9000000-0000-4000-8000-000000000301',repeat('2',64),repeat('2',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),'{}'::jsonb),
('d9000000-0000-4000-8000-000000000507','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000407','d9000000-0000-4000-8000-000000000301',repeat('3',64),repeat('3',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),'{}'::jsonb),
('d9000000-0000-4000-8000-000000000508','00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000408','d9000000-0000-4000-8000-000000000301',repeat('5',64),repeat('5',32),'v1','v1','v1','2026-05-20',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),'{}'::jsonb);
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000505' where id='d9000000-0000-4000-8000-000000000405';
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000506' where id='d9000000-0000-4000-8000-000000000406';
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000507' where id='d9000000-0000-4000-8000-000000000407';
update public.recurring_series set current_candidate_version_id='d9000000-0000-4000-8000-000000000508' where id='d9000000-0000-4000-8000-000000000408';
insert into public.recurring_occurrences(household_id,id,series_id,candidate_version_id,occurrence_key,expected_date,expected_amount_minor,currency,amount_kind,status,matched_txn_id,score_bps,evidence,input_fingerprint,detector_version,confidence_version,as_of) values
('00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000605','d9000000-0000-4000-8000-000000000405','d9000000-0000-4000-8000-000000000505',repeat('1',24),'2026-05-12',1850,'USD','fixed','matched','d9000000-0000-4000-8000-000000000004',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),repeat('1',24),'v1','v1','2026-05-20'),
('00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000606','d9000000-0000-4000-8000-000000000406','d9000000-0000-4000-8000-000000000506',repeat('2',24),'2026-05-13',1299,'USD','fixed','matched','d9000000-0000-4000-8000-000000000005',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),repeat('2',24),'v1','v1','2026-05-20'),
('00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000607','d9000000-0000-4000-8000-000000000407','d9000000-0000-4000-8000-000000000507',repeat('3',24),'2026-05-14',35000,'USD','fixed','matched','d9000000-0000-4000-8000-000000000006',9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),repeat('3',24),'v1','v1','2026-05-20'),
-- …408: expected only, matched_txn_id null — the classifier sees NO PFC at all.
('00000000-0000-4000-8000-00000000a001','d9000000-0000-4000-8000-000000000608','d9000000-0000-4000-8000-000000000408','d9000000-0000-4000-8000-000000000508',repeat('5',24),'2026-06-05',4200,'USD','fixed','expected',null,9000,
  jsonb_build_array(jsonb_build_object('x',1),jsonb_build_object('x',1),jsonb_build_object('x',1)),repeat('5',24),'v1','v1','2026-05-20');
set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000405'),
  'recurring','a recurring rideshare (TRANSPORTATION) is a generic recurring expense, not a subscription');
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000406'),
  'subscription','ENTERTAINMENT still classifies as subscription');
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000407'),
  'bill','LOAN_PAYMENTS still classifies as bill');
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000408'),
  'recurring','an outflow with no matched occurrences (null dominant PFC) is recurring, never claimed as subscription');

-- Decline (dismiss) one detected-paycheck occurrence: soft-state, idempotent,
-- and it does NOT mute the series (the paycheck series itself is untouched).
select lives_ok($$select public.keel_cmd_dismiss_detected_paycheck('d9000000-0000-4000-8000-000000000801','pgtap:dpd:1','{}','00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','d9000000-0000-4000-8000-000000000402','occurrence_date','2026-06-15'))$$,'a detected paycheck occurrence is declined');
select is((select jsonb_array_length(public.keel_list_detected_paycheck_dismissals('00000000-0000-4000-8000-00000000a001')->'rows')),1,'the dismissal is listed');
-- Idempotent: declining the same (employer, date) again is a no-op (one row).
select lives_ok($$select public.keel_cmd_dismiss_detected_paycheck('d9000000-0000-4000-8000-000000000802','pgtap:dpd:2','{}','00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','d9000000-0000-4000-8000-000000000402','occurrence_date','2026-06-15'))$$,'re-declining the same occurrence is a no-op');
select is((select count(*)::int from public.detected_paycheck_dismissals where household_id='00000000-0000-4000-8000-00000000a001'),1,'still exactly one dismissal row (idempotent)');
-- The paycheck series itself is untouched — it still classifies as 'paycheck'.
select is(
  (select r->>'bucket' from jsonb_array_elements(public.keel_recurring_classification('00000000-0000-4000-8000-00000000a001')->'rows') r where r->>'seriesId'='d9000000-0000-4000-8000-000000000402'),
  'paycheck','declining an occurrence does not mute the paycheck series');
-- An OUTFLOW series cannot be a detected paycheck.
select throws_ok($$select public.keel_cmd_dismiss_detected_paycheck('d9000000-0000-4000-8000-000000000803','pgtap:dpd:3','{}','00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','d9000000-0000-4000-8000-000000000401','occurrence_date','2026-06-15'))$$,'P0009',null,'declining an outflow series is rejected');
-- A hard DELETE / UPDATE on the dismissal table is blocked (append-only).
set local role postgres;
select throws_ok($$delete from public.detected_paycheck_dismissals where household_id='00000000-0000-4000-8000-00000000a001'$$,'P0010',null,'hard delete of a dismissal is blocked');
select throws_ok($$update public.detected_paycheck_dismissals set occurrence_date='2026-07-01' where household_id='00000000-0000-4000-8000-00000000a001'$$,'P0010',null,'update of a dismissal is blocked');
select ok(has_table_privilege('keel_export','public.detected_paycheck_dismissals','SELECT'),'export role can read the dismissal table');
set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

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
