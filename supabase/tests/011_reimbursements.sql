-- Stage 1D mandatory gate 7: claims settle without fake income.
begin; select no_plan();
select has_table('public','counterparties','counterparties exist');
select has_table('public','expense_shares','expense shares exist');
select has_table('public','reimbursement_claims','claims exist');
select has_table('public','settlements','settlements exist');
select has_table('public','settlement_matches','settlement matches exist');
select has_table('public','refund_expectations','refund expectations exist');
select has_table('public','refund_matches','refund matches exist');
select has_table('public','settlement_status_events','settlement reversal history exists');
select has_table('public','reimbursement_claim_status_events','claim reversal history exists');
select has_function('public','keel_reimbursement_create_claim',array['uuid','text','jsonb','uuid','jsonb','uuid'],'claim command exists');
select has_function('public','keel_reimbursement_settle',array['uuid','text','jsonb','uuid','jsonb','uuid'],'settle command exists');
select has_function('public','keel_reimbursement_reverse_settlement',array['uuid','text','jsonb','uuid','jsonb','uuid'],'settlement reversal exists');
select has_function('public','keel_reimbursement_reverse_claim',array['uuid','text','jsonb','uuid','jsonb','uuid'],'claim reversal exists');
select has_function('public','keel_list_reimbursements',array['uuid'],'claim read exists');
select has_function('public','keel_is_non_income_settlement',array['uuid','uuid'],'income exclusion classifier exists');
select is((select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb,uuid)'::regprocedure),'keel_api','command owner is keel_api');
select ok(not has_function_privilege('anon','public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb,uuid)','EXECUTE'),'anon cannot settle');

insert into public.canonical_transactions(id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key) values
('a7000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','shared dinner','2026-07-01','pgtap:reimburse:expense'),
('a7000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','Venmo from Sam','2026-07-05','pgtap:reimburse:settlement');
insert into public.journal_batches(id,household_id,canonical_transaction_id,description,effective_date,command_id) values
('a7000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a001','a7000000-0000-4000-8000-000000000001','expense','2026-07-01','a7000000-0000-4000-8000-000000000021'),
('a7000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a001','a7000000-0000-4000-8000-000000000002','settlement','2026-07-05','a7000000-0000-4000-8000-000000000022');
insert into public.journal_postings(id,batch_id,ledger_account_id,entity_id,amount_minor,currency) values
('a7000000-0000-4000-8000-000000000031','a7000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-10000,'USD'),
('a7000000-0000-4000-8000-000000000032','a7000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a312','00000000-0000-4000-8000-00000000a101',10000,'USD'),
('a7000000-0000-4000-8000-000000000033','a7000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',4000,'USD'),
('a7000000-0000-4000-8000-000000000034','a7000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a318','00000000-0000-4000-8000-00000000a101',-4000,'USD');

set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.keel_reimbursement_create_claim('a7000000-0000-4000-8000-000000000040','pgtap:reimburse:malformed','{}','00000000-0000-4000-8000-00000000a001',jsonb_build_object('original_transaction_id','not-a-uuid','counterparty_name','Sam','kind','friend','amount_minor','1','currency','USD','description','bad id'))$$,'P0009',null,'direct RPC rejects malformed evidence as a command error');
select lives_ok($$select public.keel_reimbursement_create_claim('a7000000-0000-4000-8000-000000000041','pgtap:reimburse:claim:1','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('original_transaction_id','a7000000-0000-4000-8000-000000000001','counterparty_name','Sam','kind','friend','amount_minor','4000','currency','USD','description','Sam dinner share'))$$,'creates first-class claim preserving original expense');
select ok((select public.keel_reimbursement_create_claim('a7000000-0000-4000-8000-000000000041','pgtap:reimburse:claim:1','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('original_transaction_id','a7000000-0000-4000-8000-000000000001','counterparty_name','Sam','kind','friend','amount_minor','4000','currency','USD','description','Sam dinner share'))->>'idempotentReplay')::boolean,'claim replay is a no-op');
select lives_ok($$select public.keel_reimbursement_settle('a7000000-0000-4000-8000-000000000042','pgtap:reimburse:settle:1','{}','00000000-0000-4000-8000-00000000a001',jsonb_build_object(
'transaction_id','a7000000-0000-4000-8000-000000000002','allocations',jsonb_build_array(jsonb_build_object('claim_id',(select id from public.reimbursement_claims limit 1),'amount_minor','4000')),'note','Venmo received'))$$,'settlement reduces claim');
select is(public.keel_list_reimbursements('00000000-0000-4000-8000-00000000a001')->'rows'->0->>'remainingMinor','0','claim is fully settled');
select is(public.keel_list_reimbursements('00000000-0000-4000-8000-00000000a001')->'rows'->0->>'incomeImpactMinor','0','settlement creates no income');
select ok(public.keel_is_non_income_settlement('00000000-0000-4000-8000-00000000a001','a7000000-0000-4000-8000-000000000002'),'settlement transaction is explicitly excluded from income');
select is((select count(*)::int from public.journal_postings where batch_id='a7000000-0000-4000-8000-000000000011'),2,'original expense postings remain unchanged');
select lives_ok($$select public.keel_reimbursement_reverse_settlement('a7000000-0000-4000-8000-000000000043','pgtap:reimburse:reverse-settle','{}','00000000-0000-4000-8000-00000000a001',jsonb_build_object('settlement_id',(select id from public.settlements limit 1),'reason','wrong payment'))$$,'settlement is reversible');
select is(public.keel_list_reimbursements('00000000-0000-4000-8000-00000000a001')->'rows'->0->>'remainingMinor','4000','reversal restores claim balance');
select lives_ok($$select public.keel_reimbursement_reverse_claim('a7000000-0000-4000-8000-000000000044','pgtap:reimburse:reverse-claim','{}','00000000-0000-4000-8000-00000000a001',jsonb_build_object('claim_id',(select id from public.reimbursement_claims limit 1),'reason','not owed'))$$,'claim creation is reversible');
select is(public.keel_list_reimbursements('00000000-0000-4000-8000-00000000a001')->'rows'->0->>'status','reversed','claim reads reversed');
set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select public.keel_reimbursement_create_claim('a7000000-0000-4000-8000-000000000045','pgtap:reimburse:smuggle','{}','00000000-0000-4000-8000-00000000b001',jsonb_build_object('original_transaction_id','a7000000-0000-4000-8000-000000000001','counterparty_name','Sam','kind','friend','amount_minor','1','currency','USD','description','smuggle'))$$,'P0006',null,'cross-tenant reference fails closed'); reset role;
select throws_ok($$update public.expense_shares set amount_minor=1$$,'P0001',null,'expense share is immutable');
select throws_ok($$delete from public.settlement_matches$$,'P0001',null,'settlement match is immutable');
select ok((select before is not null and after is not null from public.audit_log where action='reimbursements.reverse_settlement'),'reversal audit has before/after');
select * from finish(); rollback;
