-- 20261102180000: cash-flow read models net out reversed/superseded batches.
-- A re-dated transaction (keel_cmd_set_date = reversal at the old date +
-- replacement at the new date) must appear ONCE, in its new month, and must
-- not inflate the old month's money-in AND money-out bars. Privileged direct
-- inserts are pgTAP-only scaffolding; the correction goes through the command.
begin; select no_plan();

-- Fixtures (fictional, cd… prefix). Alpha seed: entity a101, checking ledger
-- a301 (account a401), Groceries a311, Salary a315.
--  T1: grocery expense 6000 on 2026-03-10, re-dated to 2026-04-10.
--  T2: salary income 9000 on 2026-03-20, left alone (control).
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('cd000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'manual', 'CORNER GROCER', '2026-03-10', 'pgtap:cfrev:t1'),
  ('cd000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'manual', 'PAYROLL', '2026-03-20', 'pgtap:cfrev:t2');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('cd000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   'cd000000-0000-4000-8000-000000000001', 'CORNER GROCER', '2026-03-10',
   'cd000000-0000-4000-8000-0000000000c1'),
  ('cd000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a001',
   'cd000000-0000-4000-8000-000000000002', 'PAYROLL', '2026-03-20',
   'cd000000-0000-4000-8000-0000000000c2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('cd000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -6000, 'USD'),
  ('cd000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 6000, 'USD'),
  ('cd000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', 9000, 'USD'),
  ('cd000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a315',
   '00000000-0000-4000-8000-00000000a101', -9000, 'USD');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Baseline: March = 9000 in / 6000 out.
select is(
  (select r->>'outflowMinor' from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->'rows') r
   where r->>'month'='2026-03' and r->>'currency'='USD'),
  '6000', 'baseline: March outflow is the grocery expense');

-- Re-date the grocery expense into April through the sanctioned command.
select lives_ok($$
  select public.keel_cmd_set_date(
    'cd000000-0000-4000-8000-0000000000d1', 'pgtap:cfrev:set:t1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('transaction_id', 'cd000000-0000-4000-8000-000000000001',
      'effective_date', '2026-04-10'))
$$, 're-date grocery expense from March to April');

-- March: the reversed original + its reversal both drop out. Only payroll stays.
select is(
  (select r->>'inflowMinor' from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->'rows') r
   where r->>'month'='2026-03' and r->>'currency'='USD'),
  '9000', 'March inflow is payroll only (reversal credit is NOT counted as money in)');
select is(
  (select r->>'outflowMinor' from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->'rows') r
   where r->>'month'='2026-03' and r->>'currency'='USD'),
  '0', 'March outflow is 0 (superseded original is NOT counted as money out)');

-- April: the replacement counts once.
select is(
  (select r->>'outflowMinor' from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->'rows') r
   where r->>'month'='2026-04' and r->>'currency'='USD'),
  '6000', 'April outflow is the replacement, counted once');
select is(
  (select r->>'inflowMinor' from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->'rows') r
   where r->>'month'='2026-04' and r->>'currency'='USD'),
  '0', 'April has no phantom inflow');

-- Range total agrees: 9000 in / 6000 out / net 3000.
select is(
  (public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->'rows'->0)
    - 'currency',
  '{"inflowMinor":"9000","outflowMinor":"6000","netMinor":"3000"}'::jsonb,
  'keel_cash_flow range total nets the correction too');

select is(public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->>'formulaVersion',
  'cash-flow-v8-net-reversals', 'cash_flow formula version bumped');
select is(public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-03-01','2026-04-30')->>'formulaVersion',
  'cash-flow-monthly-v7-net-reversals', 'monthly formula version bumped');
reset role;

select * from finish(); rollback;
