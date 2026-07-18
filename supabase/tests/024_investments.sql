-- WS-C / FEEDBACK.md F-013/F-014/F-015 — investments workstream pgTAP.
-- Covers: investment-transactions ingestion (canonical + balanced postings +
-- idempotency + sign), holdings snapshots, holdings error record/clear, the
-- subtype classifier, and the two read models. Fictional data only;
-- deterministic UUIDs in the 'de' fixture band on the shared alpha household
-- (its uncategorized_* offset ledger accounts are supplied by supabase/seed.sql).
begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Function existence + ownership/grant shape.
-- ---------------------------------------------------------------------------
select has_function('public','keel_worker_ingest_investment_txn',
  array['uuid','uuid','text','text','bigint','text','date','text','text'],
  'investment-txn ingest proc exists');
select has_function('public','keel_worker_snapshot_holdings', array['uuid','uuid'],
  'holdings snapshot proc exists');
select has_function('public','keel_worker_record_holdings_error',
  array['uuid','uuid','text','text'], 'holdings error record proc exists');
select has_function('public','keel_worker_clear_holdings_error', array['uuid','uuid'],
  'holdings error clear proc exists');
select has_function('public','keel_investments_overview', array['uuid'],
  'investments overview read model exists');
select has_function('public','keel_investments_value_daily', array['uuid','date','date'],
  'investments value-daily read model exists');
select has_function('public','keel_is_investment_subtype', array['text'],
  'investment subtype classifier exists');

-- Worker procs are service_role-only (a missing revoke was a real hole).
select ok(
  not has_function_privilege('authenticated',
    'public.keel_worker_ingest_investment_txn(uuid,uuid,text,text,bigint,text,date,text,text)',
    'EXECUTE'),
  'authenticated cannot execute the ingest proc');
select ok(
  has_function_privilege('service_role',
    'public.keel_worker_ingest_investment_txn(uuid,uuid,text,text,bigint,text,date,text,text)',
    'EXECUTE'),
  'service_role can execute the ingest proc');

-- ---------------------------------------------------------------------------
-- Subtype classifier: keyword set incl. the cash-management broadening.
-- ---------------------------------------------------------------------------
select ok(public.keel_is_investment_subtype('brokerage'), 'brokerage is investment');
select ok(public.keel_is_investment_subtype('401k'), '401k is investment');
select ok(public.keel_is_investment_subtype('cash management'),
  'cash management is investment (broadened)');
select ok(not public.keel_is_investment_subtype('checking'), 'checking is not investment');
select ok(not public.keel_is_investment_subtype(null), 'null subtype is not investment');

-- ---------------------------------------------------------------------------
-- Fixtures: a plaid brokerage connection + investment account on alpha.
-- ---------------------------------------------------------------------------
insert into public.connections (id, household_id, provider, external_ref, status, institution_id)
values
  ('de000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   'plaid', 'pgtap:inv:item', 'active', 'ins_fidelity');

insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category)
values
  ('de000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Brokerage Ledger', 'asset', 'USD', false);

insert into public.accounts
  (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref)
values
  ('de000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'de000000-0000-4000-8000-000000000001',
   'de000000-0000-4000-8000-000000000011', 'Fidelity Brokerage', 'brokerage', 'USD',
   'pgtap:inv:acct');

-- ---------------------------------------------------------------------------
-- Ingest a dividend (money IN, +12345 minor). Creates a posted canonical txn.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001',
    'de000000-0000-4000-8000-000000000001',
    'pgtap:inv:acct', 'plaid-itx-div-1', 12345, 'USD',
    '2026-07-10'::date, 'DIVIDEND', 'dividend_interest')
$$, 'ingest a dividend cash-flow');

select is(
  (select count(*)::int from public.canonical_transactions
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and economic_event_key = 'inv:pgtap:inv:item:plaid-itx-div-1'),
  1,
  'dividend produced exactly one canonical transaction');

-- Postings balance to zero and the account ledger got +12345.
select is(
  (select sum(p.amount_minor)::bigint
     from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:inv:item:plaid-itx-div-1'),
  0::bigint,
  'dividend postings sum to zero (balanced)');
select is(
  (select p.amount_minor from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:inv:item:plaid-itx-div-1'
      and p.ledger_account_id = 'de000000-0000-4000-8000-000000000011'),
  12345::bigint,
  'account ledger posting is +12345 for money in');

-- ---------------------------------------------------------------------------
-- Idempotency: replay the SAME event -> no duplicate, same canonical id.
-- ---------------------------------------------------------------------------
select is(
  public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001',
    'de000000-0000-4000-8000-000000000001',
    'pgtap:inv:acct', 'plaid-itx-div-1', 12345, 'USD',
    '2026-07-10'::date, 'DIVIDEND', 'dividend_interest'),
  (select id from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:inv:item:plaid-itx-div-1'),
  'replay returns the same canonical id');
select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:inv:item:plaid-itx-div-1'),
  1,
  'replay did not create a second canonical transaction');
select is(
  (select count(*)::int from public.raw_provider_events
    where connection_id = 'de000000-0000-4000-8000-000000000001'
      and provider_event_id = 'inv-txn:plaid-itx-div-1'),
  1,
  'replay did not duplicate the raw source event');

-- ---------------------------------------------------------------------------
-- A buy (money OUT) posts a NEGATIVE account-ledger amount.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001',
    'de000000-0000-4000-8000-000000000001',
    'pgtap:inv:acct', 'plaid-itx-buy-1', -50000, 'USD',
    '2026-07-11'::date, 'BUY VTI', 'buy')
$$, 'ingest a buy cash-flow');
select is(
  (select p.amount_minor from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:inv:item:plaid-itx-buy-1'
      and p.ledger_account_id = 'de000000-0000-4000-8000-000000000011'),
  -50000::bigint,
  'buy account posting is -50000 for money out');

-- Unknown account ref -> null (skip), not an error.
select is(
  public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001',
    'de000000-0000-4000-8000-000000000001',
    'pgtap:inv:UNKNOWN', 'plaid-itx-x', 100, 'USD',
    '2026-07-11'::date, 'X', 'other'),
  null::uuid,
  'unknown account ref returns null (skipped)');

-- Zero amount is rejected.
select throws_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001',
    'de000000-0000-4000-8000-000000000001',
    'pgtap:inv:acct', 'plaid-itx-zero', 0, 'USD',
    '2026-07-11'::date, 'ZERO', 'other')
$$, 'P0009', null, 'zero-amount investment txn is rejected');

-- ---------------------------------------------------------------------------
-- Holdings snapshot + error record/clear.
-- ---------------------------------------------------------------------------
insert into public.holdings
  (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor, currency, source)
values
  ('00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000021',
   current_date, 'VTI', 'Vanguard Total', 3, 25000, 75000, 'USD', 'plaid');

select is(
  public.keel_worker_snapshot_holdings(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001'),
  1,
  'snapshot captured the one holding');
select is(
  (select value_minor from public.holdings_snapshots
    where account_id = 'de000000-0000-4000-8000-000000000021'
      and snapshot_date = current_date and symbol = 'VTI'),
  75000::bigint,
  'snapshot value matches the holding');
-- Re-snapshot same day = last-write-wins, no duplicate row.
select is(
  public.keel_worker_snapshot_holdings(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001'),
  1,
  're-snapshot returns 1 (upsert, not insert-again)');
select is(
  (select count(*)::int from public.holdings_snapshots
    where account_id = 'de000000-0000-4000-8000-000000000021' and snapshot_date = current_date),
  1,
  'same-day re-snapshot did not create a duplicate row');

select lives_ok($$
  select public.keel_worker_record_holdings_error(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001',
    'ACCESS_NOT_GRANTED', 'holdings unavailable')
$$, 'record a holdings error');
select is(
  (select holdings_last_error_code from public.connections
    where id = 'de000000-0000-4000-8000-000000000001'),
  'ACCESS_NOT_GRANTED',
  'holdings error code persisted on the connection');
select lives_ok($$
  select public.keel_worker_clear_holdings_error(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001')
$$, 'clear the holdings error');
select is(
  (select holdings_last_error_code from public.connections
    where id = 'de000000-0000-4000-8000-000000000001'),
  null,
  'holdings error cleared, success stamped');
select isnt(
  (select holdings_last_success_at from public.connections
    where id = 'de000000-0000-4000-8000-000000000001'),
  null,
  'holdings_last_success_at stamped on clear');

-- ---------------------------------------------------------------------------
-- Read models (service path, no JWT claim -> membership check skipped).
-- ---------------------------------------------------------------------------
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'totalHoldingsValueMinor'),
  '75000',
  'overview totals the tracked holdings value');
select is(
  (select count(*)::int from jsonb_array_elements(
    public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'accounts')),
  1,
  'overview surfaces the one investment account');
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'formulaVersion'),
  'investments-overview-v1',
  'overview carries a formula version (reproducible numbers)');

select is(
  (select count(*)::int from jsonb_array_elements(
    public.keel_investments_value_daily(
      '00000000-0000-4000-8000-00000000a001', current_date - 30, current_date)->'points')),
  1,
  'value-daily returns one snapshot day');

select * from finish();
rollback;
