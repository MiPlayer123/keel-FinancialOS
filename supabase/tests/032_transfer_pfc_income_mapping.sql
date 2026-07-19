-- fix(categorization) 20260719020000: Plaid TRANSFER_IN / TRANSFER_OUT /
-- LOAN_PAYMENTS inflows must map to a transfer category (income-kind
-- "Transfers In"), not "Other Income", and a transaction categorized as a
-- transfer must drop out of cash-flow income even when it has no paired leg.
-- Deterministic (Law 1); the mapping surfaces to the user as suggest→approve
-- category_suggestions (Laws 2/10 class B).
begin; select no_plan();

-- ---------------------------------------------------------------------------
-- 1. Mapper unit truth table. INCOME→income, TRANSFER_IN/OUT/LOAN_PAYMENTS
-- (income kind)→transfers_in, everything else income→other_income; the expense
-- branch is unchanged (TRANSFER_IN/OUT→transfers, FOOD_AND_DRINK→food_drink).
-- ---------------------------------------------------------------------------
select is(public.keel_pfc_to_category_key('INCOME','income'::public.ledger_account_kind),
  'income','INCOME (income) stays income');
select is(public.keel_pfc_to_category_key('TRANSFER_IN','income'::public.ledger_account_kind),
  'transfers_in','TRANSFER_IN (income) maps to transfers_in, not other_income');
select is(public.keel_pfc_to_category_key('TRANSFER_OUT','income'::public.ledger_account_kind),
  'transfers_in','TRANSFER_OUT (income) maps to transfers_in');
select is(public.keel_pfc_to_category_key('LOAN_PAYMENTS','income'::public.ledger_account_kind),
  'transfers_in','LOAN_PAYMENTS credit-card-payment received (income) maps to transfers_in');
select is(public.keel_pfc_to_category_key('OTHER','income'::public.ledger_account_kind),
  'other_income','OTHER (income) is genuinely ambiguous and stays other_income');
select is(public.keel_pfc_to_category_key('TRANSFER_IN','expense'::public.ledger_account_kind),
  'transfers','expense branch unchanged: TRANSFER_IN→transfers');
select is(public.keel_pfc_to_category_key('FOOD_AND_DRINK','expense'::public.ledger_account_kind),
  'food_drink','expense branch unchanged: FOOD_AND_DRINK→food_drink');

-- The seed proc now emits the income-kind transfers_in landing category.
select ok(
  pg_get_functiondef('public.keel_seed_entity_categories(uuid,uuid)'::regprocedure)
    like '%transfers_in%',
  'keel_seed_entity_categories seeds the transfers_in category');

-- ---------------------------------------------------------------------------
-- 2. Detection proposes "Transfers In" for a TRANSFER_IN inflow currently
-- parked in Other Income (overlay source plaid_pfc). Uses alpha entity a101
-- (account a301, Uncategorized Income a318). Add the income-kind Transfers In
-- and Other Income fixtures the mapper resolves against (a101's seed set has
-- neither).
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts
  (id, household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
values
  ('c9000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Other Income', 'income', 'USD', true,
   'other_income', true),
  ('c9000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Transfers In', 'income', 'USD', true,
   'transfers_in', true);

-- An INFLOW (+50.00): cash on checking a301, offset on Other Income (the
-- plaid_pfc landing today). The overlay carries source plaid_pfc pointing at
-- Other Income — the exact "misfiled as income" state of the live 881.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('c9000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'VENMO CASHOUT', '2026-06-15', 'pgtap:xfer:t1');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c9000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000001', 'VENMO CASHOUT', '2026-06-15',
   'c9000000-0000-4000-8000-0000000000c1');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', 5000, 'USD'),
  ('c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000010',
   '00000000-0000-4000-8000-00000000a101', -5000, 'USD');
-- Current effective category is Other Income via a plaid_pfc overlay.
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('c9000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000010', 'plaid_pfc');
-- Plaid evidence: this inflow's PFC primary is TRANSFER_IN (Venmo).
insert into public.raw_provider_events
  (id, household_id, connection_id, provider, provider_event_id, account_external_ref,
   body, body_text, received_at)
values
  ('c9000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a202', 'plaid', 'pgtap-xfer-sync-1', 'sim-acct-checking',
   '{}'::jsonb,
   '{"added":[{"transaction_id":"pgtap-xfer-pt1","personal_finance_category":{"primary":"TRANSFER_IN"}}]}',
   now());
insert into public.normalized_source_records
  (id, raw_event_id, household_id, account_id, provider_transaction_id,
   amount_minor, currency, effective_date, description, pending, pfc_primary)
values
  ('c9000000-0000-4000-8000-000000000031', 'c9000000-0000-4000-8000-000000000030',
   '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a401',
   'pgtap-xfer-pt1', 5000, 'USD', '2026-06-15', 'VENMO CASHOUT', false, 'TRANSFER_IN');
insert into public.transaction_source_links
  (canonical_transaction_id, normalized_source_record_id, household_id)
values
  ('c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000031',
   '00000000-0000-4000-8000-00000000a001');

-- Detection proposes exactly one suggestion for this transaction, sourced from
-- PFC, pointing at Transfers In — suggest→approve, no overlay overwrite.
select is(public.keel_detect_category_suggestions('00000000-0000-4000-8000-00000000a001'),
  1, 'detection proposes one Transfers-In suggestion for the misfiled inflow');
select is(
  (select suggested_category_ledger_account_id from public.category_suggestions
    where canonical_transaction_id = 'c9000000-0000-4000-8000-000000000001'),
  'c9000000-0000-4000-8000-000000000011'::uuid,
  'the suggestion routes the TRANSFER_IN inflow to Transfers In');
select is(
  (select source from public.category_suggestions
    where canonical_transaction_id = 'c9000000-0000-4000-8000-000000000001'),
  'pfc', 'the Transfers-In proposal is a PFC-sourced suggestion');
-- The overlay is untouched until the user approves (Law 2 suggest→approve).
select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'c9000000-0000-4000-8000-000000000001'),
  'c9000000-0000-4000-8000-000000000010'::uuid,
  'detection never overwrites the overlay — the inflow stays where it was until approval');

-- ---------------------------------------------------------------------------
-- 3. Cash-flow income exclusion. BEFORE recategorization the +50 inflow counts
-- as income; after the overlay is set to Transfers In (as an approval would),
-- it drops out of income WITHOUT any paired transfer_link (the one-sided case).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select (r->>'inflowMinor') from jsonb_array_elements(
     public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r
   where r->>'currency'='USD'),
  '5000', 'while filed as Other Income the inflow counts as income');
select ok(
  not public.keel_txn_is_transfer_category('00000000-0000-4000-8000-00000000a001',
    'c9000000-0000-4000-8000-000000000001'),
  'Other-Income inflow is not yet a transfer category');
reset role;

-- Simulate the user approving the Transfers-In categorization (overlay→user).
update public.transaction_categories
   set category_ledger_account_id = 'c9000000-0000-4000-8000-000000000011', source = 'user'
 where canonical_transaction_id = 'c9000000-0000-4000-8000-000000000001';

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select ok(
  public.keel_txn_is_transfer_category('00000000-0000-4000-8000-00000000a001',
    'c9000000-0000-4000-8000-000000000001'),
  'once categorized Transfers In, the inflow is a transfer category');
-- The +50 inflow was the ONLY USD income/expense posting in range, so once it
-- is excluded there is no USD row at all — coalesce the whole subquery to '0'.
select is(
  coalesce((select (r->>'inflowMinor') from jsonb_array_elements(
     public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r
   where r->>'currency'='USD'), '0'),
  '0', 'a Transfers-In inflow is EXCLUDED from cash-flow income with no paired link');
select is(
  public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->>'formulaVersion',
  'cash-flow-v4-transfer-category-excluded', 'cash_flow formula version reflects the transfer-category exclusion');
select is(
  coalesce((select (r->>'inflowMinor') from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r
   where r->>'currency'='USD' and r->>'month'='2026-06'), '0'),
  '0', 'monthly cash flow also excludes the Transfers-In inflow');
reset role;

select * from finish(); rollback;
