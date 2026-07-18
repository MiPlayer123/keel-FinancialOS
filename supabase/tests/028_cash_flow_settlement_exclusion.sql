-- WS-I / FEEDBACK.md X-003 + F-026: a settled reimbursement deposit must NOT
-- count as income in cash-flow read models. Proves keel_is_non_income_settlement
-- is now wired into keel_cash_flow and keel_cash_flow_monthly.
begin; select no_plan();

select has_function('public','keel_cash_flow',array['uuid','date','date'],'cash flow read model exists');
select has_function('public','keel_cash_flow_monthly',array['uuid','date','date'],'monthly cash flow read model exists');

-- Fixtures (fictional, deterministic UUIDs under the c8… prefix):
--  * an ordinary paycheck-style income deposit (+8000 into checking, income leg)
--  * a reimbursement expense (-10000 checking, +10000 Groceries)
--  * a reimbursement settlement deposit (+4000 checking, income leg) that will
--    be settled and therefore must be EXCLUDED from income.
insert into public.canonical_transactions(id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key) values
('c8000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','ordinary income','2026-06-10','pgtap:xflow:income'),
('c8000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','shared dinner','2026-06-11','pgtap:xflow:expense'),
('c8000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','manual','Venmo from Dana','2026-06-12','pgtap:xflow:settlement');

insert into public.journal_batches(id,household_id,canonical_transaction_id,description,effective_date,command_id) values
('c8000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a001','c8000000-0000-4000-8000-000000000001','ordinary income','2026-06-10','c8000000-0000-4000-8000-000000000021'),
('c8000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a001','c8000000-0000-4000-8000-000000000002','shared dinner','2026-06-11','c8000000-0000-4000-8000-000000000022'),
('c8000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-00000000a001','c8000000-0000-4000-8000-000000000003','settlement deposit','2026-06-12','c8000000-0000-4000-8000-000000000023');

-- income leg is credit-negative; checking asset is debit-positive.
insert into public.journal_postings(id,batch_id,ledger_account_id,entity_id,amount_minor,currency) values
-- ordinary income: +8000 checking / -8000 Salary(income)
('c8000000-0000-4000-8000-000000000031','c8000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',8000,'USD'),
('c8000000-0000-4000-8000-000000000032','c8000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a315','00000000-0000-4000-8000-00000000a101',-8000,'USD'),
-- expense: -10000 checking / +10000 Groceries(expense)
('c8000000-0000-4000-8000-000000000033','c8000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-10000,'USD'),
('c8000000-0000-4000-8000-000000000034','c8000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a311','00000000-0000-4000-8000-00000000a101',10000,'USD'),
-- settlement deposit: +4000 checking / -4000 Uncategorized Income
('c8000000-0000-4000-8000-000000000035','c8000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',4000,'USD'),
('c8000000-0000-4000-8000-000000000036','c8000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-00000000a318','00000000-0000-4000-8000-00000000a101',-4000,'USD');

set local role authenticated; set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- BEFORE settling: the deposit is not yet a settlement, so it DOES count as income.
-- Income = 8000 (ordinary) + 4000 (deposit not yet settled) = 12000.
select is(
  (select (r->>'inflowMinor') from jsonb_array_elements(public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r where r->>'currency'='USD'),
  '12000','before settling, the deposit still counts as income');

-- Create the claim on the expense, then settle it from the deposit.
select lives_ok($$select public.keel_reimbursement_create_claim('c8000000-0000-4000-8000-000000000041','pgtap:xflow:claim','{}','00000000-0000-4000-8000-00000000a001',
jsonb_build_object('original_transaction_id','c8000000-0000-4000-8000-000000000002','counterparty_name','Dana','kind','friend','amount_minor','4000','currency','USD','description','Dana dinner share'))$$,'claim created on the expense');
select lives_ok($$select public.keel_reimbursement_settle('c8000000-0000-4000-8000-000000000042','pgtap:xflow:settle','{}','00000000-0000-4000-8000-00000000a001',jsonb_build_object(
'transaction_id','c8000000-0000-4000-8000-000000000003','allocations',jsonb_build_array(jsonb_build_object('claim_id',(select id from public.reimbursement_claims where household_id='00000000-0000-4000-8000-00000000a001' and original_transaction_id='c8000000-0000-4000-8000-000000000002'),'amount_minor','4000')),'note','Venmo received'))$$,'deposit settles the claim');

select ok(public.keel_is_non_income_settlement('00000000-0000-4000-8000-00000000a001','c8000000-0000-4000-8000-000000000003'),'classifier flags the settled deposit');

-- AFTER settling: income excludes the settled deposit. Income = 8000 only.
select is(
  (select (r->>'inflowMinor') from jsonb_array_elements(public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r where r->>'currency'='USD'),
  '8000','settled reimbursement deposit is EXCLUDED from cash_flow income');

-- Outflow is unaffected (expense leg still counts): 10000.
select is(
  (select (r->>'outflowMinor') from jsonb_array_elements(public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r where r->>'currency'='USD'),
  '10000','expense outflow is unaffected by settlement exclusion');

-- Monthly variant applies the same exclusion.
select is(
  (select (r->>'inflowMinor') from jsonb_array_elements(public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r where r->>'currency'='USD' and r->>'month'='2026-06'),
  '8000','monthly cash flow also excludes the settled deposit');

-- Formula version is bumped so reproducibility stays honest.
select is(public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->>'formulaVersion','cash-flow-v3-transfer-and-settlement-excluded','cash_flow formula version reflects the exclusion');

-- Reversing the settlement restores the deposit as income.
select lives_ok($$select public.keel_reimbursement_reverse_settlement('c8000000-0000-4000-8000-000000000043','pgtap:xflow:reverse','{}','00000000-0000-4000-8000-00000000a001',jsonb_build_object('settlement_id',(select id from public.settlements where household_id='00000000-0000-4000-8000-00000000a001' and transaction_id='c8000000-0000-4000-8000-000000000003'),'reason','wrong payment'))$$,'settlement reversed');
select is(
  (select (r->>'inflowMinor') from jsonb_array_elements(public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r where r->>'currency'='USD'),
  '12000','reversing the settlement restores the deposit as income');

select * from finish(); rollback;
