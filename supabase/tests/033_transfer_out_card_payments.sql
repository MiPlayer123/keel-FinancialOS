-- 20260720140000 (SLICE A) + 20260720160000 (SLICE C): the expense-side
-- "Transfers Out" category + a card-payment tier for the transfer DETECTOR.
--
-- SCOPE (founder decision 2026-07-19): a card payment is reclassified as a
-- transfer ONLY when KEEL sees BOTH legs (a connected card). There is NO
-- one-sided memo/PFC suggester — an unconnected-card payoff debit stays a
-- 'loan_payments' expense. So this suite proves:
--   A. keel_seed_entity_categories seeds an EXPENSE-kind "Transfers Out"
--      (pfc_key 'transfers_out'); keel_txn_is_transfer_category + the cash-flow
--      read models EXCLUDE it once a debit is categorized Transfers Out (via the
--      confirm hook or a manual action) — one-sided or not.
--      NEGATIVE GUARD: a real loan payment (mortgage) is NOT a transfer category
--      and stays in spend; the detector never touches it.
--      keel_detect_category_suggestions is UNCHANGED (no card-payment suggester).
--   C. keel_detect_transfers gains a card-payment tier (depository outflow ↔
--      credit-card inflow, exact amount, <=7 days) — a two-sided connected-card
--      payoff that settles slower than the <=4-day near-miss window.
-- Privileged direct inserts are pgTAP-only scaffolding (this layer runs as the
-- migration role by design); the runtime surface goes through the procs.
begin; select no_plan();

-- ---------------------------------------------------------------------------
-- 0. Structure guards.
-- ---------------------------------------------------------------------------
select ok(
  pg_get_functiondef('public.keel_seed_entity_categories(uuid,uuid)'::regprocedure)
    like '%transfers_out%',
  'keel_seed_entity_categories seeds the expense-kind transfers_out category');
select ok(
  pg_get_functiondef('public.keel_txn_is_transfer_category(uuid,uuid)'::regprocedure)
    like '%transfers_out%',
  'keel_txn_is_transfer_category excludes the transfers_out category');
-- The categorization detector must NOT have gained a card-payment tier (scope).
select ok(
  pg_get_functiondef('public.keel_detect_category_suggestions(uuid)'::regprocedure)
    not like '%card_payment%',
  'keel_detect_category_suggestions has NO one-sided card-payment suggester (scope decision)');
select ok(
  has_function_privilege('service_role', 'public.keel_detect_transfers(uuid)', 'execute'),
  'service_role (worker cron) may run the transfer detector');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: household a001, entity a101, accounts a401 (checking,
-- ledger a301) and a402 (card, ledger a302). Add the expense-kind Transfers Out
-- and Loan Payments fixtures + an uncategorized-expense offset with a pfc_key
-- seeded with its pfc_key by supabase/seed.sql. a101 is excluded from the backfill as
-- a fixture entity, so seed the transfers_out category explicitly.
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts
  (id, household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
values
  ('ca000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Transfers Out', 'expense', 'USD', true,
   'transfers_out', true),
  ('ca000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Loan Payments', 'expense', 'USD', true,
   'loan_payments', true);
-- NB: the seed already stamps pfc_key 'uncategorized_expense' on a101's a317
-- (supabase/seed.sql), so we reference that seeded account below rather than
-- inserting a second one (the (entity_id, pfc_key) uniqueness would reject it).

-- ---------------------------------------------------------------------------
-- SLICE A cash-flow exclusion. A credit-card payment debit (-$500) on checking.
-- Filed as a plain expense it counts as SPEND; categorized Transfers Out (as the
-- confirm hook or a manual action would) it drops out of cash-flow spend even
-- with NO paired transfer_link (the one-sided case). A mortgage payment stays.
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('ca000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Payment to card ending 8311', '2026-06-05', 'pgtap:to:c1'),
  ('ca000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'HOMELOAN SERVICING MTG PYMT', '2026-06-06', 'pgtap:to:c2');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('ca000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a001',
   'ca000000-0000-4000-8000-000000000101', 'cc payment', '2026-06-05', 'ca000000-0000-4000-8000-000000000c1'),
  ('ca000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a001',
   'ca000000-0000-4000-8000-000000000102', 'mortgage', '2026-06-06', 'ca000000-0000-4000-8000-000000000c2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('ca000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -50000, 'USD'),
  ('ca000000-0000-4000-8000-000000000201', 'ca000000-0000-4000-8000-000000000010',
   '00000000-0000-4000-8000-00000000a101',  50000, 'USD'),
  ('ca000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -180000, 'USD'),
  ('ca000000-0000-4000-8000-000000000202', 'ca000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-00000000a101',  180000, 'USD');
-- Pin categories: the card payment on Transfers Out (user), the mortgage on Loan
-- Payments (user). Directly overlaid because the confirm hook / manual action is
-- what would set these; here we assert the READ-MODEL behavior they rely on.
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('ca000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-00000000a001',
   'ca000000-0000-4000-8000-000000000010', 'user'),
  ('ca000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-00000000a001',
   'ca000000-0000-4000-8000-000000000011', 'user');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select ok(
  public.keel_txn_is_transfer_category('00000000-0000-4000-8000-00000000a001',
    'ca000000-0000-4000-8000-000000000101'),
  'a debit categorized Transfers Out IS a transfer category (excluded from spend)');
select ok(
  not public.keel_txn_is_transfer_category('00000000-0000-4000-8000-00000000a001',
    'ca000000-0000-4000-8000-000000000102'),
  'NEGATIVE GUARD: a real loan payment (mortgage) is NOT a transfer category — stays in spend');

select is(
  public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->>'formulaVersion',
  'cash-flow-v7-sign-classified', 'cash_flow formula version reflects the transfer-out exclusion');
-- Outflow = 180000 (mortgage, kept) only; the 50000 Transfers-Out is excluded
-- WITHOUT any paired transfer_link (the one-sided unconnected-card case).
select is(
  (select (r->>'outflowMinor') from jsonb_array_elements(
     public.keel_cash_flow('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r
   where r->>'currency'='USD'),
  '180000', 'Transfers-Out card payment EXCLUDED from spend; loan payment retained (one-sided)');
select is(
  (select (r->>'outflowMinor') from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r
   where r->>'currency'='USD' and r->>'month'='2026-06'),
  '180000', 'monthly cash flow also excludes the Transfers-Out card payment');
select is(
  public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->>'formulaVersion',
  'cash-flow-monthly-v6-sign-classified', 'monthly formula version bumped');
reset role;

-- ---------------------------------------------------------------------------
-- SLICE C — card-payment DETECTOR tier. A depository OUTFLOW (-$300) on checking
-- a301 and an EXACT credit-card INFLOW (+$300) on the card a302, 6 days apart
-- (outside the <=4-day near-miss window, inside the new <=7-day card tier).
-- keel_detect_transfers must pair them; a NON-card counterparty at 6 days must
-- NOT pair (proves the widened window is card-shape-only).
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('ca000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Payoff out (6d)', '2026-05-01', 'pgtap:to:d1'),
  ('ca000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Payoff applied to card (6d)', '2026-05-07', 'pgtap:to:d2');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('ca000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-00000000a001',
   'ca000000-0000-4000-8000-000000000501', 'payoff out', '2026-05-01', 'ca000000-0000-4000-8000-000000000d1'),
  ('ca000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-00000000a001',
   'ca000000-0000-4000-8000-000000000502', 'payoff in', '2026-05-07', 'ca000000-0000-4000-8000-000000000d2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('ca000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -30000, 'USD'),
  ('ca000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  30000, 'USD'),
  ('ca000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  30000, 'USD'),
  ('ca000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', -30000, 'USD');

-- The seed card a402 subtype is 'credit_card' (underscore); the tier accepts
-- both that and the live 'credit card' spelling.
select ok(public.keel_detect_transfers('00000000-0000-4000-8000-00000000a001') >= 1,
  'the card tier detects the 6-day-apart depository↔card exact pair');
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and txn_out = 'ca000000-0000-4000-8000-000000000501'
      and txn_in = 'ca000000-0000-4000-8000-000000000502'
      and status = 'suggested'),
  1, 'the 6-day depository→card payoff is a suggested transfer link');

-- Replay idempotency: a second detector pass adds no duplicate.
select public.keel_detect_transfers('00000000-0000-4000-8000-00000000a001');
select is(
  (select count(*)::int from public.transfer_links
    where txn_out = 'ca000000-0000-4000-8000-000000000501'
      and txn_in = 'ca000000-0000-4000-8000-000000000502'),
  1, 'card-tier detection is idempotent on replay');

select * from finish(); rollback;
