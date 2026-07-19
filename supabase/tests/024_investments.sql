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
-- Subtype classifier (canonical, 20260719210000): full Plaid investment
-- subtype set ∪ keyword fallback ∪ the cash-management broadening. Mirrors
-- apps/web/src/lib/investment-subtype.ts and _shared/investment-subtype.ts.
-- ---------------------------------------------------------------------------
select ok(public.keel_is_investment_subtype('brokerage'), 'brokerage is investment');
select ok(public.keel_is_investment_subtype('401k'), '401k is investment');
select ok(public.keel_is_investment_subtype('cash management'),
  'cash management is investment (broadened)');
-- Exact Plaid subtypes the old keyword list missed.
select ok(public.keel_is_investment_subtype('crypto exchange'), 'crypto exchange is investment');
select ok(public.keel_is_investment_subtype('trust'), 'trust is investment');
select ok(public.keel_is_investment_subtype('401a'), '401a is investment');
select ok(public.keel_is_investment_subtype('457b'), '457b is investment');
select ok(public.keel_is_investment_subtype('sep ira'), 'sep ira is investment');
select ok(public.keel_is_investment_subtype('tfsa'), 'tfsa is investment');
select ok(public.keel_is_investment_subtype('education savings account'),
  'education savings account is investment');
select ok(public.keel_is_investment_subtype('thrift savings plan'),
  'thrift savings plan is investment');
select ok(public.keel_is_investment_subtype('ugma'), 'ugma is investment');
select ok(public.keel_is_investment_subtype('HSA'), 'classifier is case-insensitive');
select ok(not public.keel_is_investment_subtype('checking'), 'checking is not investment');
select ok(not public.keel_is_investment_subtype('money market'),
  'depository money market is not investment');
select ok(not public.keel_is_investment_subtype('other'),
  'subtype-only other stays unclassified (ambiguous across Plaid types)');
select ok(not public.keel_is_investment_subtype(null), 'null subtype is not investment');

-- Holdings-sync stats plumbing (Item 2, 20260719210000): the 3-arg
-- keel_worker_sync_holdings signature was DROPPED (no ambiguous overload);
-- the 4-arg shape with the optional per-account stats payload replaces it.
select has_function('public','keel_worker_sync_holdings',
  array['uuid','uuid','jsonb','jsonb'], 'sync-holdings proc has the stats param');
select hasnt_function('public','keel_worker_sync_holdings',
  array['uuid','uuid','jsonb'], 'old 3-arg sync-holdings signature is gone');
select has_column('public','accounts','holdings_provider_count',
  'accounts carries the provider holdings count');
select has_column('public','accounts','holdings_cash_equivalent_count',
  'accounts carries the cash-equivalent skip count');
select has_column('public','accounts','holdings_synced_at',
  'accounts carries holdings-synced-at');

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
-- Raw events are versioned by the economic hash ('inv-txn:<id>:<hash>'); an
-- unchanged replay reuses the same version row, so exactly one exists.
select is(
  (select count(*)::int from public.raw_provider_events
    where connection_id = 'de000000-0000-4000-8000-000000000001'
      and provider_event_id like 'inv-txn:plaid-itx-div-1:%'),
  1,
  'replay did not duplicate the raw source event version');

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
-- Read models FAIL CLOSED on a null subject (Finding 4): no JWT claim must
-- raise KEEL_NOT_AUTHENTICATED (P0004), never silently return the household's
-- data. This mirrors keel_list_holdings.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')$$,
  'P0004', null, 'overview requires authentication (fail closed on null subject)');
select throws_ok(
  $$select public.keel_investments_value_daily('00000000-0000-4000-8000-00000000a001')$$,
  'P0004', null, 'value-daily requires authentication (fail closed on null subject)');

-- As a real member of Alpha household (seed owner uid), the read models resolve.
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);

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
  'investments-overview-v3',
  'overview carries a formula version (reproducible numbers)');
-- v3 stat fields exist per account and are JSON null until a sync reports
-- them (Law 9: unknown is null, never a fabricated 0).
select is(
  (select a->>'holdingsProviderCount' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'accounts') a
    where a->>'accountId' = 'de000000-0000-4000-8000-000000000021'),
  null,
  'holdingsProviderCount is JSON null before any holdings sync reports it');

-- ---------------------------------------------------------------------------
-- Investment depth v1: per-holding cost basis + unrealized gain/loss +
-- portfolio totals. At this point the only holding is the plaid VTI with a
-- NULL cost basis, so it must be EXCLUDED from the aggregates and its per-row
-- gain/bps must be JSON null (never fabricated to 0).
-- ---------------------------------------------------------------------------
-- The single null-basis holding: gain and bps are JSON null (not 0).
select is(
  (select h->>'unrealizedGainMinor' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'VTI'),
  null,
  'null-basis holding reports unrealizedGainMinor as JSON null');
select is(
  (select h->>'unrealizedGainBps' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'VTI'),
  null,
  'null-basis holding reports unrealizedGainBps as JSON null');
-- The null-basis row is excluded from BOTH sums: gain/cost totals are 0.
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'totalUnrealizedGainMinor'),
  '0',
  'null-basis holding is excluded from the total unrealized gain');
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'totalCostBasisMinor'),
  '0',
  'null-basis holding is excluded from the total cost basis');
-- With-basis count is one LESS than the total count (surfaced exclusion, Law 9).
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'holdingsWithBasisCount')::int,
  0,
  'with-basis count excludes the null-basis holding');
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'holdingsCount')::int,
  1,
  'holdings count includes the null-basis holding');
select ok(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'holdingsWithBasisCount')::int
    < (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'holdingsCount')::int,
  'a null-basis holding leaves with-basis count strictly below total count');

-- Add three WITH-basis holdings on the same account/day:
--   GAINR: value 1_500_000, cost 1_200_000  -> gain +300000, bps +2500
--   LOSSR: value  800_000,  cost 1_000_000  -> gain -200000  (a real loss)
--   ZEROB: value    5_000,  cost 0          -> bps NULL (no divide-by-zero)
insert into public.holdings
  (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor, cost_basis_minor, currency, source)
values
  ('00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000021',
   current_date, 'GAINR', 'Gain Fixture', 1, 1500000, 1500000, 1200000, 'USD', 'manual'),
  ('00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000021',
   current_date, 'LOSSR', 'Loss Fixture', 1, 800000, 800000, 1000000, 'USD', 'manual'),
  ('00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000021',
   current_date, 'ZEROB', 'Zero-Basis Fixture', 1, 5000, 5000, 0, 'USD', 'manual');

-- Known value+cost -> known gain and bps.
select is(
  (select h->>'unrealizedGainMinor' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'GAINR'),
  '300000',
  'GAINR: unrealizedGainMinor = value − cost = 300000');
select is(
  (select h->>'unrealizedGainBps' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'GAINR'),
  '2500',
  'GAINR: unrealizedGainBps = 2500 (25%)');
-- A LOSS row (value < cost) -> NEGATIVE gain.
select is(
  (select h->>'unrealizedGainMinor' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'LOSSR'),
  '-200000',
  'LOSSR: unrealizedGainMinor is negative for a loss');
select is(
  (select h->>'unrealizedGainBps' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'LOSSR'),
  '-2000',
  'LOSSR: unrealizedGainBps is negative (−2000 = −20%)');
-- cost_basis = 0 -> bps NULL (no divide-by-zero raise), but gain is still defined.
select lives_ok(
  $$select public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')$$,
  'a zero cost-basis holding does not raise a divide-by-zero');
select is(
  (select h->>'unrealizedGainBps' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'ZEROB'),
  null,
  'ZEROB: zero cost basis yields NULL bps (guarded divide-by-zero)');
select is(
  (select h->>'unrealizedGainMinor' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->'holdings') h
    where h->>'symbol' = 'ZEROB'),
  '5000',
  'ZEROB: gain is still defined for a zero-basis holding (value − 0)');

-- Aggregates now cover the three with-basis rows (VTI still excluded, null basis).
-- cost = 1_200_000 + 1_000_000 + 0 = 2_200_000; gain = 300000 − 200000 + 5000 = 105000.
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'totalCostBasisMinor'),
  '2200000',
  'total cost basis sums the with-basis subset only');
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'totalUnrealizedGainMinor'),
  '105000',
  'total unrealized gain sums the with-basis subset only');
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'holdingsWithBasisCount')::int,
  3,
  'with-basis count is the three cost-carrying holdings');
select is(
  (public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')->>'holdingsCount')::int,
  4,
  'holdings count includes the null-basis VTI too');

-- Clean up the depth-v1 fixtures so downstream assertions (Finding 6, which
-- counts VTI rows) see the pre-existing holdings only.
delete from public.holdings
 where account_id = 'de000000-0000-4000-8000-000000000021'
   and symbol in ('GAINR', 'LOSSR', 'ZEROB');

-- Finding 7: totals are grouped by currency; USD headline is USD-only, and a
-- per-currency array carries the rest honestly (no fabricated FX). The one
-- USD holding shows up under holdingsValueByCurrency as USD.
select is(
  (select value->>'currency' from jsonb_array_elements(
     public.keel_investments_overview('00000000-0000-4000-8000-00000000a001')
       ->'holdingsValueByCurrency') value
    where value->>'currency' = 'USD'),
  'USD',
  'overview reports a USD holdings-value-by-currency group');

-- Cross-tenant: a household the caller is not a member of -> P0006.
select throws_ok(
  $$select public.keel_investments_overview('00000000-0000-4000-8000-0000000000ff')$$,
  'P0006', null, 'overview blocks cross-tenant access');

select is(
  (select count(*)::int from jsonb_array_elements(
    public.keel_investments_value_daily(
      '00000000-0000-4000-8000-00000000a001', current_date - 30, current_date)->'points')),
  1,
  'value-daily returns one snapshot day');

select set_config('request.jwt.claim.sub', '', true);

-- ---------------------------------------------------------------------------
-- Finding 6: a manual holding and a Plaid holding sharing a symbol on the same
-- account must BOTH snapshot without an ON CONFLICT collision (the unique key
-- includes `source`).
-- ---------------------------------------------------------------------------
insert into public.holdings
  (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor, currency, source)
values
  ('00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000021',
   current_date, 'VTI', 'Vanguard Total (manual lot)', 2, 25000, 50000, 'USD', 'manual');
select lives_ok($$
  select public.keel_worker_snapshot_holdings(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001')
$$, 'snapshot with a manual + plaid holding on the same symbol does not collide');
select is(
  (select count(*)::int from public.holdings_snapshots
    where account_id = 'de000000-0000-4000-8000-000000000021'
      and snapshot_date = current_date and symbol = 'VTI'),
  2,
  'both source variants of the shared symbol are snapshotted');

-- ---------------------------------------------------------------------------
-- Finding 1: resumable pagination completeness. Simulate a window whose total
-- exceeds one invocation's page cap by driving the state procs directly:
-- opening a window freezes it; a continuation persists the resume offset WITHOUT
-- advancing the date checkpoint; only a full advance moves last_pulled_through.
-- ---------------------------------------------------------------------------
-- Open a fresh window (first pull => 730-day reach-back, offset 0, frozen).
select is(
  (public.keel_worker_investment_sync_window(
     '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001',
     '2026-07-18'::date, 14) ->> 'offset')::int,
  0,
  'first window opens at offset 0');
select is(
  (select window_to from public.investment_sync_state
    where connection_id = 'de000000-0000-4000-8000-000000000001'),
  '2026-07-18'::date,
  'the window is frozen with a stable end date');
-- Hit the page cap mid-window: persist a resume offset. Checkpoint must NOT move.
select lives_ok($$
  select public.keel_worker_investment_sync_continue(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001',
    '2026-07-18'::date - 730, '2026-07-18'::date, 500)
$$, 'persist a mid-window continuation offset');
-- Re-resolving the window returns the SAME frozen window and the saved offset,
-- so the next cycle resumes at 500 (rows past the cap are NOT skipped).
select is(
  (public.keel_worker_investment_sync_window(
     '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001',
     '2026-07-19'::date, 14) ->> 'offset')::int,
  500,
  'a capped window resumes at the saved offset next cycle');
select is(
  (select last_pulled_through from public.investment_sync_state
    where connection_id = 'de000000-0000-4000-8000-000000000001'),
  null,
  'the date checkpoint does NOT advance while a window is only partially paginated');
-- Fully consuming the window advances the checkpoint and clears the frozen window.
select lives_ok($$
  select public.keel_worker_investment_sync_advance(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001',
    '2026-07-18'::date - 730, '2026-07-18'::date)
$$, 'advance a fully-consumed window');
select is(
  (select last_pulled_through from public.investment_sync_state
    where connection_id = 'de000000-0000-4000-8000-000000000001'),
  '2026-07-18'::date,
  'the date checkpoint advances only once the window is fully consumed');
select is(
  (select window_from from public.investment_sync_state
    where connection_id = 'de000000-0000-4000-8000-000000000001'),
  null,
  'the frozen window is cleared after a full advance');

-- ---------------------------------------------------------------------------
-- Finding 3: changed-body correction. Re-ingesting the SAME provider txn id
-- with CHANGED economics (amount) must reverse the prior journal batch and
-- post a fresh corrected one (compensating reversal, not a duplicate, not a
-- silent no-op). Net account-ledger effect equals the corrected amount.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001',
    'de000000-0000-4000-8000-000000000001',
    'pgtap:inv:acct', 'plaid-itx-restate', 10000, 'USD',
    '2026-07-12'::date, 'DIVIDEND (initial)', 'dividend_interest')
$$, 'ingest the initial version of a restatable txn');
select lives_ok($$
  select public.keel_worker_ingest_investment_txn(
    '00000000-0000-4000-8000-00000000a001',
    'de000000-0000-4000-8000-000000000001',
    'pgtap:inv:acct', 'plaid-itx-restate', 15000, 'USD',
    '2026-07-12'::date, 'DIVIDEND (restated)', 'dividend_interest')
$$, 'restate the same txn with a changed amount (correction, not conflict)');
-- Still exactly one canonical transaction for that economic key.
select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'inv:pgtap:inv:item:plaid-itx-restate'),
  1,
  'restatement keeps exactly one canonical transaction');
-- Net posting to the account ledger for that txn equals the CORRECTED amount
-- (original +10000 reversed, corrected +15000 posted => net +15000).
select is(
  (select coalesce(sum(p.amount_minor), 0)::bigint
     from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
     join public.canonical_transactions ct on ct.id = b.canonical_transaction_id
    where ct.economic_event_key = 'inv:pgtap:inv:item:plaid-itx-restate'
      and p.ledger_account_id = 'de000000-0000-4000-8000-000000000011'),
  15000::bigint,
  'restatement reverses the old amount and posts the corrected one');

-- ---------------------------------------------------------------------------
-- Item 2 (20260719210000): per-account holdings-sync stats. A sync whose
-- provider reported one all-cash-equivalent holding (all-SPAXX brokerage)
-- persists providerCount=1 / cashEquivalentCount=1 on the account — the
-- stored fact that lets the UI present the balance as cash instead of an
-- empty portfolio. Runs LAST: the empty p_holdings full-replace removes the
-- plaid VTI row, which earlier sections still need.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_worker_sync_holdings(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001',
    '[]'::jsonb,
    '[{"externalRef":"pgtap:inv:acct","providerCount":1,"cashEquivalentCount":1}]'::jsonb)
$$, 'sync-holdings accepts the per-account stats payload');
select is(
  (select holdings_provider_count from public.accounts
    where id = 'de000000-0000-4000-8000-000000000021'),
  1,
  'provider holdings count persisted on the account');
select is(
  (select holdings_cash_equivalent_count from public.accounts
    where id = 'de000000-0000-4000-8000-000000000021'),
  1,
  'cash-equivalent skip count persisted on the account');
select isnt(
  (select holdings_synced_at from public.accounts
    where id = 'de000000-0000-4000-8000-000000000021'),
  null,
  'holdings_synced_at stamped with the stats');
-- Omitting the stats payload leaves the stored stats untouched (no reset).
select lives_ok($$
  select public.keel_worker_sync_holdings(
    '00000000-0000-4000-8000-00000000a001', 'de000000-0000-4000-8000-000000000001',
    '[]'::jsonb)
$$, 'sync-holdings still accepts calls without a stats payload');
select is(
  (select holdings_provider_count from public.accounts
    where id = 'de000000-0000-4000-8000-000000000021'),
  1,
  'a stats-less sync does not clobber the stored stats');

select * from finish();
rollback;
