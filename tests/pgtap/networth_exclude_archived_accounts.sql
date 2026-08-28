-- pgTAP: balance read models count ONLY active (non-archived) accounts
-- (20260719130000_networth_exclude_archived_accounts.sql).
--
-- The Supabase local Docker stack is unavailable this session (same constraint
-- as finalize_link_entity.sql), so this suite builds a MINIMAL real schema with
-- the columns the read models read, then loads the ACTUAL shipped function
-- bodies verbatim (sliced out of the migration by the runner at the
-- __READMODEL_BODIES__ marker). That means these tests exercise the exact SQL
-- that ships, not a paraphrase.
--
-- Scenario mirrors the live Fidelity triple-count: one ACTIVE account and one
-- ARCHIVED duplicate with an identical opening anchor, plus an equity
-- ("Opening Balances") leg with NO accounts row for its ledger account.
--
-- Invariants proven:
--   (1) archived contributes 0        -> net_worth_as_of / net_worth_daily /
--                                         trial_balance / latest_balances /
--                                         investments_value_daily
--   (2) reconnect invariant           -> archive old + create equal-anchor new
--                                         leaves net worth unchanged
--   (3) equity leg preserved          -> the LEFT-JOIN-safe NOT EXISTS never
--                                         drops the account-less equity leg

begin;
select plan(25);

-- Roles referenced by the shipped grant/owner statements ---------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
grant keel_api to current_user;

-- Minimal schema (only the columns the read models read) ---------------------
create schema if not exists public;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ledger_account_kind') then
    create type public.ledger_account_kind as enum
      ('asset','liability','equity','income','expense');
  end if;
end $$;

create table public.household_memberships (
  household_id uuid not null,
  user_id uuid not null
);
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  kind public.ledger_account_kind not null,
  -- 20260813140000 bodies exclude pfc_key='investments' cost-basis ledgers.
  pfc_key text,
  archived_at timestamptz
);
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  ledger_account_id uuid,
  subtype text,
  archived_at timestamptz
);
create table public.journal_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  canonical_transaction_id uuid,
  reverses_batch_id uuid,
  effective_date date not null
);
create table public.journal_postings (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  ledger_account_id uuid not null,
  amount_minor bigint not null,
  currency text not null default 'USD'
);
create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  account_id uuid not null,
  as_of timestamptz not null,
  current_minor bigint not null,
  available_minor bigint,
  limit_minor bigint,
  currency text not null default 'USD',
  -- 20260813140000 bodies value investment accounts from source='plaid' rows.
  source text not null default 'plaid'
);
create table public.holdings_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  account_id uuid not null,
  snapshot_date date not null,
  value_minor bigint not null,
  currency text not null default 'USD'
);

-- keel_is_investment_subtype dependency (real body is trivial + immutable).
create or replace function public.keel_is_investment_subtype(p_subtype text)
returns boolean language sql immutable as $$
  select case when p_subtype is null then false
    else lower(p_subtype) similar to
      '%(investment|brokerage|ira|401k|403b|roth|hsa|mutual fund|529|pension|retirement|annuity|stock plan|cash management)%'
  end;
$$;

-- The read models are SECURITY DEFINER owned by keel_api; in production keel_api
-- holds table privileges. Grant it read access to the test tables so the
-- definer body can read them in this throwaway cluster.
grant select on all tables in schema public to keel_api;

-- __READMODEL_BODIES__  (replaced by the runner with the real function DDL)

-- Fixtures -------------------------------------------------------------------
-- One household, one member. An ACTIVE cash account (anchor 4824), an ARCHIVED
-- duplicate cash account (identical anchor 4824), and an equity "Opening
-- Balances" ledger account with NO accounts row (the leg that must survive).
do $seed$
declare
  v_hh    uuid := '11111111-1111-1111-1111-111111111111';
  v_user  uuid := '22222222-2222-2222-2222-222222222222';
  v_la_active   uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_la_archived uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  v_la_equity   uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  v_acct_active   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_acct_archived uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_b_active   uuid;
  v_b_archived uuid;
begin
  insert into public.household_memberships(household_id, user_id) values (v_hh, v_user);

  insert into public.ledger_accounts(id, household_id, kind) values
    (v_la_active,   v_hh, 'asset'),
    (v_la_archived, v_hh, 'asset'),
    (v_la_equity,   v_hh, 'equity');

  insert into public.accounts(id, household_id, ledger_account_id, subtype, archived_at) values
    (v_acct_active,   v_hh, v_la_active,   'cash management', null),
    (v_acct_archived, v_hh, v_la_archived, 'cash management', now());

  -- Opening-balance batch for the ACTIVE account: +4824 asset, -4824 equity.
  insert into public.journal_batches(household_id, canonical_transaction_id, reverses_batch_id, effective_date)
    values (v_hh, null, null, current_date - 10) returning id into v_b_active;
  insert into public.journal_postings(batch_id, ledger_account_id, amount_minor) values
    (v_b_active, v_la_active,  4824),
    (v_b_active, v_la_equity, -4824);

  -- Opening-balance batch for the ARCHIVED duplicate: identical anchor.
  insert into public.journal_batches(household_id, canonical_transaction_id, reverses_batch_id, effective_date)
    values (v_hh, null, null, current_date - 5) returning id into v_b_archived;
  insert into public.journal_postings(batch_id, ledger_account_id, amount_minor) values
    (v_b_archived, v_la_archived, 4824),
    (v_b_archived, v_la_equity,  -4824);

  -- Latest provider balances for both accounts.
  insert into public.balance_snapshots(household_id, account_id, as_of, current_minor, available_minor, limit_minor)
    values
      (v_hh, v_acct_active,   now(), 4824, 4824, null),
      (v_hh, v_acct_archived, now(), 4824, 4824, null);

  -- Holdings snapshots for both accounts (today), USD.
  insert into public.holdings_snapshots(household_id, account_id, snapshot_date, value_minor)
    values
      (v_hh, v_acct_active,   current_date, 4824),
      (v_hh, v_acct_archived, current_date, 4824);
end
$seed$;

-- Authenticate as the household member for the security-definer read models.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

-- (1a) NET WORTH AS-OF counts the active anchor only (4824), not 2x4824.
select is(
  (public.keel_net_worth_as_of('11111111-1111-1111-1111-111111111111', current_date)
     -> 'rows' -> 0 ->> 'netWorthMinor'),
  '4824',
  'net_worth_as_of counts active account only (archived anchor excluded)'
);

-- (1b) NET WORTH DAILY latest point = 4824 (archived excluded).
select is(
  (select (elem ->> 'balanceMinor')
     from jsonb_array_elements(
       public.keel_net_worth_daily('11111111-1111-1111-1111-111111111111',
                                    current_date - 3, current_date) -> 'rows') elem
    order by (elem ->> 'date') desc limit 1),
  '4824',
  'net_worth_daily latest point counts active account only'
);

-- (1c) TRIAL BALANCE: exactly ONE asset ledger row (the active one) + the
--      equity row survive; the archived asset ledger row is dropped.
select is(
  (select count(*)::text from jsonb_array_elements(
     public.keel_trial_balance('11111111-1111-1111-1111-111111111111') -> 'rows')),
  '2',
  'trial_balance drops the archived ledger-account row (active asset + equity remain)'
);

-- (1d) LATEST BALANCES: exactly ONE row (active account) — archived filtered.
select is(
  (select count(*)::text from jsonb_array_elements(
     public.keel_latest_balances('11111111-1111-1111-1111-111111111111'))),
  '1',
  'latest_balances excludes the archived account by account_id'
);

-- (1e) INVESTMENTS VALUE DAILY today's point = 4824 (archived holdings dropped).
select is(
  (select (elem ->> 'valueMinor')
     from jsonb_array_elements(
       public.keel_investments_value_daily('11111111-1111-1111-1111-111111111111',
                                            current_date - 1, current_date) -> 'points') elem
    order by (elem ->> 'date') desc limit 1),
  '4824',
  'investments_value_daily counts active investment account only'
);

-- (3) EQUITY LEG PRESERVED: the equity "Opening Balances" ledger account has
--     NO accounts row, so its -4824 legs must NOT be dropped. Net worth is
--     asset+liability only (equity excluded by kind), so verify the equity leg
--     survives via trial_balance, which spans all ledger accounts: the equity
--     row must be present with balance -9648 (two -4824 legs, one per anchor).
select is(
  (select (elem ->> 'balanceMinor')
     from jsonb_array_elements(
       public.keel_trial_balance('11111111-1111-1111-1111-111111111111') -> 'rows') elem
     where elem ->> 'ledgerAccountId' = 'aaaaaaaa-0000-0000-0000-000000000003'),
  '-9648',
  'equity (account-less) leg is preserved by the NOT EXISTS filter, never over-excluded'
);

-- (2) RECONNECT INVARIANT: net worth with (active + archived-duplicate) equals
--     net worth would be with the active account ALONE. We already proved the
--     archived contributes 0; assert the load-bearing counterfactual in a
--     SEPARATE household where the duplicate is NOT archived — net worth there
--     DOUBLES (9648), proving the filter (not some other quirk) is what
--     single-counts household 1. Using a distinct household avoids mutating or
--     rolling back the primary fixture.
do $hh2$
declare
  v_hh   uuid := '33333333-3333-3333-3333-333333333333';
  v_user uuid := '22222222-2222-2222-2222-222222222222';
  v_la1  uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_la2  uuid := 'cccccccc-0000-0000-0000-000000000002';
  v_laeq uuid := 'cccccccc-0000-0000-0000-000000000003';
  v_b uuid;
begin
  insert into public.household_memberships(household_id, user_id) values (v_hh, v_user);
  insert into public.ledger_accounts(id, household_id, kind) values
    (v_la1, v_hh, 'asset'), (v_la2, v_hh, 'asset'), (v_laeq, v_hh, 'equity');
  -- TWO active (un-archived) cash accounts, each with an equal anchor.
  insert into public.accounts(id, household_id, ledger_account_id, subtype, archived_at) values
    ('dddddddd-0000-0000-0000-000000000001', v_hh, v_la1, 'cash management', null),
    ('dddddddd-0000-0000-0000-000000000002', v_hh, v_la2, 'cash management', null);
  insert into public.journal_batches(household_id, canonical_transaction_id, reverses_batch_id, effective_date)
    values (v_hh, null, null, current_date - 5) returning id into v_b;
  insert into public.journal_postings(batch_id, ledger_account_id, amount_minor) values
    (v_b, v_la1, 4824), (v_b, v_laeq, -4824);
  insert into public.journal_batches(household_id, canonical_transaction_id, reverses_batch_id, effective_date)
    values (v_hh, null, null, current_date - 5) returning id into v_b;
  insert into public.journal_postings(batch_id, ledger_account_id, amount_minor) values
    (v_b, v_la2, 4824), (v_b, v_laeq, -4824);
end
$hh2$;
grant select on all tables in schema public to keel_api;

select is(
  (public.keel_net_worth_as_of('33333333-3333-3333-3333-333333333333', current_date)
     -> 'rows' -> 0 ->> 'netWorthMinor'),
  '9648',
  'counterfactual: two UN-archived duplicates DOUBLE net worth (proves the filter is load-bearing)'
);

-- Household 1 stays single-count (unchanged by the counterfactual household).
select is(
  (public.keel_net_worth_as_of('11111111-1111-1111-1111-111111111111', current_date)
     -> 'rows' -> 0 ->> 'netWorthMinor'),
  '4824',
  'reconnect invariant: archived duplicate keeps conserved single-count net worth'
);

-- (2b) Reconnect conservation directly: replace the ACTIVE account with a fresh
--      one carrying an equal anchor (archive old active, create new active with
--      identical +4824/-equity anchor). Net worth must be UNCHANGED (4824).
do $reconn$
declare
  v_hh uuid := '11111111-1111-1111-1111-111111111111';
  v_la_new uuid := 'aaaaaaaa-0000-0000-0000-000000000004';
  v_acct_new uuid := 'bbbbbbbb-0000-0000-0000-000000000004';
  v_la_equity uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  v_b uuid;
begin
  -- archive the previously-active account (supersession)
  update public.accounts set archived_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  -- new active account with an equal opening anchor
  insert into public.ledger_accounts(id, household_id, kind) values (v_la_new, v_hh, 'asset');
  insert into public.accounts(id, household_id, ledger_account_id, subtype, archived_at)
    values (v_acct_new, v_hh, v_la_new, 'cash management', null);
  insert into public.journal_batches(household_id, canonical_transaction_id, reverses_batch_id, effective_date)
    values (v_hh, null, null, current_date) returning id into v_b;
  insert into public.journal_postings(batch_id, ledger_account_id, amount_minor) values
    (v_b, v_la_new,    4824),
    (v_b, v_la_equity, -4824);
end
$reconn$;

select is(
  (public.keel_net_worth_as_of('11111111-1111-1111-1111-111111111111', current_date)
     -> 'rows' -> 0 ->> 'netWorthMinor'),
  '4824',
  'reconnect invariant: disconnect->reconnect (archive old + equal-anchor new) conserves net worth'
);

do $currency_fixture$
declare
  v_hh uuid := '44444444-4444-4444-4444-444444444444';
  v_user uuid := '22222222-2222-2222-2222-222222222222';
  v_la_a uuid := 'eeeeeeee-0000-0000-0000-000000000001';
  v_la_b uuid := 'eeeeeeee-0000-0000-0000-000000000002';
  v_eq uuid := 'eeeeeeee-0000-0000-0000-000000000003';
  v_a uuid := 'ffffffff-0000-0000-0000-000000000001';
  v_b uuid := 'ffffffff-0000-0000-0000-000000000002';
  v_batch uuid;
begin
  insert into public.household_memberships(household_id, user_id)
  values (v_hh, v_user);

  insert into public.ledger_accounts(id, household_id, kind)
  values
    (v_la_a, v_hh, 'asset'),
    (v_la_b, v_hh, 'asset'),
    (v_eq, v_hh, 'equity');

  insert into public.accounts(id, household_id, ledger_account_id, subtype, archived_at)
  values
    (v_a, v_hh, v_la_a, 'brokerage', null),
    (v_b, v_hh, v_la_b, 'brokerage', null);

  insert into public.journal_batches(
    household_id,
    canonical_transaction_id,
    reverses_batch_id,
    effective_date
  )
  values (v_hh, null, null, current_date - 10)
  returning id into v_batch;

  insert into public.journal_postings(
    batch_id,
    ledger_account_id,
    amount_minor,
    currency
  )
  values
    (v_batch, v_la_a, 7000, 'USD'),
    (v_batch, v_la_b, 8000, 'USD'),
    (v_batch, v_eq, -15000, 'USD');

  insert into public.balance_snapshots(
    id,
    household_id,
    account_id,
    as_of,
    current_minor,
    currency,
    source
  )
  values
    (
      '90000000-0000-0000-0000-000000000000',
      v_hh,
      v_a,
      (current_date - 2)::timestamp + interval '12 hours',
      100,
      'CAD',
      'plaid'
    ),
    (
      '90000000-0000-0000-0000-000000000002',
      v_hh,
      v_a,
      (current_date - 1)::timestamp + interval '12 hours',
      200,
      'EUR',
      'plaid'
    ),
    (
      '90000000-0000-0000-0000-000000000001',
      v_hh,
      v_a,
      (current_date - 1)::timestamp + interval '12 hours',
      999,
      'CAD',
      'plaid'
    ),
    (
      '90000000-0000-0000-0000-000000000100',
      v_hh,
      v_b,
      (current_date - 2)::timestamp + interval '12 hours',
      300,
      'CAD',
      'plaid'
    );
end
$currency_fixture$;

select is(
  (
    public.keel_net_worth_as_of(
      '44444444-4444-4444-4444-444444444444',
      current_date
    )->'rows'
  )::text,
  jsonb_build_array(
    jsonb_build_object('currency', 'CAD', 'netWorthMinor', '300'),
    jsonb_build_object('currency', 'EUR', 'netWorthMinor', '200')
  )::text,
  'as_of groups latest investment snapshots by their stored currencies'
);

select is(
  public.keel_net_worth_as_of(
    '44444444-4444-4444-4444-444444444444',
    current_date
  )->>'formulaVersion',
  'net-worth-market-v2',
  'as_of formula version records snapshot-currency semantics'
);

select is(
  (
    public.keel_net_worth_daily(
      '44444444-4444-4444-4444-444444444444',
      current_date - 2,
      current_date
    )->'rows'
  )::text,
  jsonb_build_array(
    jsonb_build_object(
      'date', to_char(current_date - 2, 'YYYY-MM-DD'),
      'currency', 'CAD',
      'balanceMinor', '400'
    ),
    jsonb_build_object(
      'date', to_char(current_date - 2, 'YYYY-MM-DD'),
      'currency', 'EUR',
      'balanceMinor', '0'
    ),
    jsonb_build_object(
      'date', to_char(current_date - 1, 'YYYY-MM-DD'),
      'currency', 'CAD',
      'balanceMinor', '300'
    ),
    jsonb_build_object(
      'date', to_char(current_date - 1, 'YYYY-MM-DD'),
      'currency', 'EUR',
      'balanceMinor', '200'
    ),
    jsonb_build_object(
      'date', to_char(current_date, 'YYYY-MM-DD'),
      'currency', 'CAD',
      'balanceMinor', '300'
    ),
    jsonb_build_object(
      'date', to_char(current_date, 'YYYY-MM-DD'),
      'currency', 'EUR',
      'balanceMinor', '200'
    )
  )::text,
  'daily keeps each day and account latest snapshot in its stored currency'
);

select is(
  public.keel_net_worth_daily(
    '44444444-4444-4444-4444-444444444444',
    current_date - 2,
    current_date
  )->>'formulaVersion',
  'net-worth-daily-market-v2',
  'daily formula version records snapshot-currency semantics'
);

select is(
  (
    position(
      'order by b.as_of desc, b.id desc'
      in lower(pg_get_functiondef(
        'public.keel_net_worth_as_of(uuid,date)'::regprocedure
      ))
    ) > 0
    and position(
      'b.as_of < v_cutoff'
      in lower(pg_get_functiondef(
        'public.keel_net_worth_as_of(uuid,date)'::regprocedure
      ))
    ) > 0
  )::text,
  'true',
  'as_of retains deterministic ordering and a sargable cutoff'
);

select is(
  (
    position(
      'order by b.as_of desc, b.id desc'
      in lower(pg_get_functiondef(
        'public.keel_net_worth_daily(uuid,date,date)'::regprocedure
      ))
    ) > 0
    and position(
      'b.as_of < ((days.d + 1)::timestamp at time zone ''utc'')'
      in lower(pg_get_functiondef(
        'public.keel_net_worth_daily(uuid,date,date)'::regprocedure
      ))
    ) > 0
  )::text,
  'true',
  'daily retains deterministic ordering and an index-compatible UTC bound'
);

select is(
  (
    select role.rolname
      from pg_proc p
      join pg_roles role on role.oid = p.proowner
     where p.oid = 'public.keel_net_worth_as_of(uuid,date)'::regprocedure
  ),
  'keel_api',
  'as_of owner remains keel_api'
);

select is(
  (
    select role.rolname
      from pg_proc p
      join pg_roles role on role.oid = p.proowner
     where p.oid = 'public.keel_net_worth_daily(uuid,date,date)'::regprocedure
  ),
  'postgres',
  'daily owner remains postgres'
);

select is(
  has_function_privilege(
    'public',
    'public.keel_net_worth_as_of(uuid,date)',
    'EXECUTE'
  )::text,
  'false',
  'PUBLIC cannot execute as_of'
);

select is(
  has_function_privilege(
    'anon',
    'public.keel_net_worth_as_of(uuid,date)',
    'EXECUTE'
  )::text,
  'false',
  'anon cannot execute as_of'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.keel_net_worth_as_of(uuid,date)',
    'EXECUTE'
  )::text,
  'true',
  'authenticated can execute as_of'
);

select is(
  has_function_privilege(
    'service_role',
    'public.keel_net_worth_as_of(uuid,date)',
    'EXECUTE'
  )::text,
  'true',
  'service_role can execute as_of'
);

select is(
  has_function_privilege(
    'public',
    'public.keel_net_worth_daily(uuid,date,date)',
    'EXECUTE'
  )::text,
  'false',
  'PUBLIC cannot execute daily'
);

select is(
  has_function_privilege(
    'anon',
    'public.keel_net_worth_daily(uuid,date,date)',
    'EXECUTE'
  )::text,
  'false',
  'anon cannot execute daily'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.keel_net_worth_daily(uuid,date,date)',
    'EXECUTE'
  )::text,
  'true',
  'authenticated can execute daily'
);

select is(
  has_function_privilege(
    'service_role',
    'public.keel_net_worth_daily(uuid,date,date)',
    'EXECUTE'
  )::text,
  'true',
  'service_role can execute daily'
);

select * from finish();
rollback;
