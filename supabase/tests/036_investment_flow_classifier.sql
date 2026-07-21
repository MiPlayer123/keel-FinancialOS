-- F-013 part 3/4 — Investment Flow Classifier pgTAP.
-- Proves the flow-routed offset + core-sweep suppression + same-account transfer
-- guard from 20260721060000. Fictional, deterministic UUIDs in the 'df' band on
-- the shared alpha household (00000000-…-a001 / entity a101).
begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- The ingest proc now carries the p_is_cash_equivalent boolean.
-- ---------------------------------------------------------------------------
select has_function('public','keel_worker_ingest_investment_txn',
  array['uuid','uuid','text','text','bigint','text','date','text','text','boolean'],
  'ingest proc carries the cash-equivalent flag');
select ok(
  has_function_privilege('service_role',
    'public.keel_worker_ingest_investment_txn(uuid,uuid,text,text,bigint,text,date,text,text,boolean)',
    'EXECUTE'),
  'service_role can execute the 10-arg ingest proc');

-- ---------------------------------------------------------------------------
-- Seed the three investment ledger accounts on entity a101 (the seed proc skips
-- fixture entities, so supply them here with stable ids), plus a plaid
-- brokerage connection + cash-management account.
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system) values
  ('df000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','Investments','asset','USD',false,'investments',true),
  ('df000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','Investment Income','income','USD',true,'investment_income',true),
  ('df000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','Investment Fees','expense','USD',true,'investment_fees',true);

-- The account's OWN ledger (the cash side of the brokerage/cash-management acct).
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category) values
  ('df000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','Cash Mgmt Ledger','asset','USD',false);

insert into public.connections (id, household_id, provider, external_ref, status, institution_id) values
  ('df000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001','plaid','pgtap:flow:item','active','ins_fidelity');

insert into public.accounts (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref) values
  ('df000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','df000000-0000-4000-8000-000000000001','df000000-0000-4000-8000-000000000021','Fidelity Cash Mgmt','cash management','USD','pgtap:flow:acct');

-- ===========================================================================
-- Buy -> investments ASSET offset, EXCLUDED from cash-flow.
-- ===========================================================================
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-buy-1', -35000, 'USD',
    '2026-06-05'::date, 'YOU BOUGHT FSKAX', 'buy', false)
$$, 'ingest a real equity buy');

-- The offset leg targets the investments asset ledger account.
select is(
  (select p.amount_minor from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-buy-1'
      and p.ledger_account_id = 'df000000-0000-4000-8000-000000000011'),
  35000::bigint,
  'buy offset posts +35000 to the investments ASSET account');
-- Balanced.
select is(
  (select sum(p.amount_minor)::bigint from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-buy-1'),
  0::bigint, 'buy postings balance to zero');
-- The investments account is is_category=false, so cash-flow (income/expense
-- only) never sees it. Assert directly: no income/expense posting exists.
select is(
  (select count(*)::int from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
     join public.ledger_accounts la on la.id = p.ledger_account_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-buy-1'
      and la.kind in ('income','expense')),
  0, 'a buy touches NO income/expense category (excluded from cash-flow)');

-- ===========================================================================
-- Dividend -> investment_income category, COUNTED as income.
-- ===========================================================================
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-div-1', 5000, 'USD',
    '2026-06-06'::date, 'DIVIDEND FSKAX', 'dividend_interest', false)
$$, 'ingest a dividend');
select is(
  (select p.amount_minor from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-div-1'
      and p.ledger_account_id = 'df000000-0000-4000-8000-000000000012'),
  -5000::bigint,
  'dividend offset posts -5000 to the investment_income category (income credit)');
select is(
  (select la.kind::text from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
     join public.ledger_accounts la on la.id = p.ledger_account_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-div-1'
      and la.id = 'df000000-0000-4000-8000-000000000012'),
  'income', 'dividend offset is an INCOME-kind category (counts in cash-flow)');

-- Cash-flow monthly picks up the dividend as income (+5000) and NOT the buy.
set local role authenticated;
set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select (r->>'inflowMinor') from jsonb_array_elements(
     public.keel_cash_flow_monthly('00000000-0000-4000-8000-00000000a001','2026-06-01','2026-06-30')->'rows') r
    where r->>'currency'='USD' and r->>'month'='2026-06'),
  '5000',
  'cash-flow June income = the dividend only (buy excluded, no other June income)');
reset role;

-- ===========================================================================
-- Fee -> investment_fees expense category.
-- ===========================================================================
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-fee-1', -200, 'USD',
    '2026-06-07'::date, 'ADVISORY FEE', 'fee', false)
$$, 'ingest a fee');
select is(
  (select la.pfc_key from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
     join public.ledger_accounts la on la.id = p.ledger_account_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-fee-1'
      and la.is_category = true),
  'investment_fees', 'fee offset lands on the investment_fees expense category');

-- ===========================================================================
-- CORE SWEEP -> NO canonical (cash-equivalent buy), and the description-labelled
-- variant too.
-- ===========================================================================
select is(
  public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-sweep-cash', -25000, 'USD',
    '2026-06-08'::date, 'PURCHASE INTO SPAXX', 'buy', true),
  null::uuid, 'a cash-equivalent buy (core sweep) creates NO canonical (returns null)');
select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:flow:item:flow-sweep-cash'),
  0, 'the cash-equivalent core sweep left no canonical row');

select is(
  public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-sweep-desc', 25000, 'USD',
    '2026-06-08'::date, 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', 'sell', false),
  null::uuid, 'a CORE ACCOUNT-described sell (core sweep) creates NO canonical');
select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:flow:item:flow-sweep-desc'),
  0, 'the description-labelled core sweep left no canonical row');

-- ===========================================================================
-- Restatement to a core sweep VOIDS the prior canonical (not a stale row).
-- Ingest a normal buy, then re-ingest the SAME provider txn id as a cash-equiv
-- sweep -> the canonical is voided.
-- ===========================================================================
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-flip', -10000, 'USD',
    '2026-06-09'::date, 'BUY (initial)', 'buy', false)
$$, 'ingest the initial non-sweep buy');
select is(
  (select voided_at is null from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:flow:item:flow-flip'),
  true, 'the initial buy is live (not voided)');
select is(
  public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-flip', -10000, 'USD',
    '2026-06-09'::date, 'PURCHASE INTO CORE ACCOUNT', 'buy', true),
  null::uuid, 'restating the buy as a core sweep returns null');
select is(
  (select voided_at is not null from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:flow:item:flow-flip'),
  true, 'the flipped-to-sweep canonical is now VOIDED (no stale offset row)');
-- Net ledger effect of the voided canonical is zero (reversal cancels the buy).
select is(
  (select coalesce(sum(p.amount_minor),0)::bigint from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-flip'
      and p.ledger_account_id = 'df000000-0000-4000-8000-000000000011'),
  0::bigint, 'the voided sweep nets to zero on the investments account');

-- ===========================================================================
-- SWEEP -> REAL flip: a provider restatement flips a VOIDED (suppressed) sweep
-- back to a real economic event. Regression for the Codex-review bug where
-- this unconditionally raised KEEL_IMMUTABLE (the voided canonical has no
-- "live batch" by construction — see the suppression branch — so the un-void
-- path could never be reached). Reuses 'flow-flip', now voided above.
-- ===========================================================================
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
    'pgtap:flow:acct','flow-flip', -15000, 'USD',
    '2026-06-09'::date, 'BUY (restated real)', 'buy', false)
$$, 'restating the voided sweep back to a real buy does NOT raise KEEL_IMMUTABLE');
select is(
  (select voided_at is null from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:flow:item:flow-flip'),
  true, 'the sweep-to-real-flipped canonical is un-voided (live again)');
select is(
  (select p.amount_minor from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-flip'
      and b.reverses_batch_id is null
      and not exists (select 1 from public.journal_revisions r where r.original_batch_id = b.id)
      and p.ledger_account_id = 'df000000-0000-4000-8000-000000000021'),
  -15000::bigint, 'the live batch reflects the restated (real) amount on the cash ledger');
select is(
  (select count(*)::int from public.journal_batches b
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:flow:item:flow-flip'
      and b.reverses_batch_id is null
      and not exists (select 1 from public.journal_revisions r where r.original_batch_id = b.id)),
  1, 'exactly one live (non-reversed, non-superseded) batch exists after the flip');

-- ===========================================================================
-- BALANCE CONSERVATION: deposit -> sweep -> buy. The account's cash ledger
-- balance after a deposit, a (suppressed) sweep, and a buy equals deposit - buy.
--   deposit +40000 (cash in)      -> account +40000
--   sweep buy -40000 (cash-equiv) -> SUPPRESSED (no ledger effect)
--   buy -15000                    -> account -15000, investments +15000
-- Account cash ledger net = +40000 - 15000 = +25000. Investments = +15000.
-- Total across the account + investments ledgers = 40000 (the deposited cash,
-- now split between remaining cash and the held position). Nothing lost.
-- ===========================================================================
select lives_ok($$ select public.keel_worker_ingest_investment_txn(
  '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
  'pgtap:flow:acct','cons-dep', 40000, 'USD', '2026-05-01'::date, 'EFT DEPOSIT', 'deposit', false) $$,
  'conservation: deposit');
select lives_ok($$ select public.keel_worker_ingest_investment_txn(
  '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
  'pgtap:flow:acct','cons-sweep', -40000, 'USD', '2026-05-01'::date, 'PURCHASE INTO SPAXX', 'buy', true) $$,
  'conservation: core sweep (suppressed)');
select lives_ok($$ select public.keel_worker_ingest_investment_txn(
  '00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000001',
  'pgtap:flow:acct','cons-buy', -15000, 'USD', '2026-05-02'::date, 'BUY VTI', 'buy', false) $$,
  'conservation: buy');

-- Account cash ledger net across these three econ events.
select is(
  (select coalesce(sum(p.amount_minor),0)::bigint from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key in
        ('inv:pgtap:flow:item:cons-dep','inv:pgtap:flow:item:cons-sweep','inv:pgtap:flow:item:cons-buy')
      and p.ledger_account_id = 'df000000-0000-4000-8000-000000000021'),
  25000::bigint, 'deposit->sweep->buy leaves +25000 on the account cash ledger');
select is(
  (select coalesce(sum(p.amount_minor),0)::bigint from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key in
        ('inv:pgtap:flow:item:cons-dep','inv:pgtap:flow:item:cons-sweep','inv:pgtap:flow:item:cons-buy')
      and p.ledger_account_id = 'df000000-0000-4000-8000-000000000011'),
  15000::bigint, 'the buy moved +15000 onto the investments account');
-- Every batch of every one of these still balances to zero (invariant).
select is(
  (select coalesce(sum(p.amount_minor),0)::bigint from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key like 'inv:pgtap:flow:item:cons-%'),
  0::bigint, 'all conservation-sequence postings sum to zero (Law 3 held throughout)');

-- ===========================================================================
-- SELF-TRANSFER NEVER PAIRED: two canonicals on the SAME account with exact
-- opposite amounts must NOT be linked by keel_detect_transfers.
-- ===========================================================================
-- Two opposite legs on the SAME cash-management account (df…31), 1 day apart.
insert into public.canonical_transactions(id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key) values
  ('df000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','df000000-0000-4000-8000-000000000031','posted','manual','same-acct out','2026-04-10','pgtap:flow:self-out'),
  ('df000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','df000000-0000-4000-8000-000000000031','posted','manual','same-acct in','2026-04-11','pgtap:flow:self-in');
insert into public.journal_batches(id,household_id,canonical_transaction_id,description,effective_date,command_id) values
  ('df000000-0000-4000-8000-000000000111','00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000101','same-acct out','2026-04-10','df000000-0000-4000-8000-000000000121'),
  ('df000000-0000-4000-8000-000000000112','00000000-0000-4000-8000-00000000a001','df000000-0000-4000-8000-000000000102','same-acct in','2026-04-11','df000000-0000-4000-8000-000000000122');
insert into public.journal_postings(id,batch_id,ledger_account_id,entity_id,amount_minor,currency) values
  ('df000000-0000-4000-8000-000000000131','df000000-0000-4000-8000-000000000111','df000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a101',-9900,'USD'),
  ('df000000-0000-4000-8000-000000000132','df000000-0000-4000-8000-000000000111','df000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a101',9900,'USD'),
  ('df000000-0000-4000-8000-000000000133','df000000-0000-4000-8000-000000000112','df000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a101',9900,'USD'),
  ('df000000-0000-4000-8000-000000000134','df000000-0000-4000-8000-000000000112','df000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a101',-9900,'USD');

select lives_ok($$ select public.keel_detect_transfers('00000000-0000-4000-8000-00000000a001') $$,
  'transfer detection runs without aborting on the same-account pair');
select is(
  (select count(*)::int from public.transfer_links
    where household_id='00000000-0000-4000-8000-00000000a001'
      and (txn_out in ('df000000-0000-4000-8000-000000000101','df000000-0000-4000-8000-000000000102')
        or txn_in  in ('df000000-0000-4000-8000-000000000101','df000000-0000-4000-8000-000000000102'))),
  0, 'two opposite legs on the SAME account are never paired (self-transfer guard)');

select * from finish();
rollback;
