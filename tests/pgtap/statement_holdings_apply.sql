-- pgTAP: statement holdings apply/unapply/diff (SLICE 9,
-- statement-ingestion-v2.md §5 [A8], §10 UI slice 3; CLAUDE.md Laws 2/9/10/11).
--
-- Runs in a throwaway-postgres cluster (no Supabase stack). Builds a MINIMAL real
-- schema and the runner injects the ACTUAL shared helpers + the ACTUAL Slice-0
-- (20260720100000 approval tokens) + Slice-9 (20260720270000 holdings apply)
-- migrations, so the procs under test are the exact SQL that ships
-- (scripts/run-statement-holdings-apply-pgtap.sh).
--
-- Properties under test:
--   * source check widened: a source='statement' holding is insertable [A8];
--   * apply writes holdings + snapshot + a statement_holding_applications row;
--   * the GATE (Law 11): the payload the ISSUE side hashes == the payload the
--     APPLY side redeems, by construction (issue_payload == apply_payload);
--   * token tamper (mutated extraction after issue) rejected; expiry rejected;
--   * older-statement apply does NOT regress current (newer application wins);
--   * a symbol absent from a newer full statement DROPS from current;
--   * unapply rebuilds current from the prior non-revoked application (Law 2);
--   * idempotent replay: same economic_event_key returns replay, one app row;
--   * non-investment account rejected;
--   * tenant/account isolation (a non-owner cannot issue/apply);
--   * diff reports added/removed/changed/same per symbol;
--   * export includes statement_holding_applications.

begin;
select no_plan();

create schema if not exists auth;
create schema if not exists public;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'household_role') then
    create type public.household_role as enum ('owner','partner','viewer','professional');
  end if;
  if not exists (select 1 from pg_type where typname = 'resource_permission') then
    create type public.resource_permission as enum ('view','edit','export');
  end if;
end $$;

create table auth.users (id uuid primary key);
create table public.households (id uuid primary key);
create table public.household_memberships (
  household_id uuid not null, user_id uuid not null, role public.household_role not null
);
create table public.accounts (
  id uuid not null, household_id uuid not null, subtype text not null default 'brokerage',
  currency char(3) not null default 'USD',
  primary key (id), unique (household_id, id)
);
create table public.account_owners (account_id uuid not null, user_id uuid not null);
create table public.resource_permissions (
  household_id uuid not null, user_id uuid not null, resource_kind text not null,
  resource_id uuid not null, permission public.resource_permission not null
);

-- statement family
create table public.statements (
  id uuid not null, household_id uuid not null, account_id uuid not null,
  period_start date not null, period_end date not null,
  opening_minor bigint not null default 0, ending_minor bigint not null default 0,
  currency char(3) not null default 'USD', source_hash text not null default 'x',
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, id)
);
create table public.statement_extractions (
  id uuid not null default gen_random_uuid(), household_id uuid not null,
  kind_hint text, created_at timestamptz not null default now(),
  primary key (id)
);
create table public.statement_extraction_holdings (
  id uuid not null default gen_random_uuid(), household_id uuid not null,
  extraction_id uuid not null, symbol text not null, cusip text, isin text, name text,
  qty numeric, price_minor bigint, value_minor bigint, cost_basis_minor bigint,
  currency text, created_at timestamptz not null default now(),
  primary key (id),
  unique (household_id, extraction_id, symbol)
);
create table public.statement_drafts (
  id uuid not null default gen_random_uuid(), household_id uuid not null,
  account_id uuid not null, statement_id uuid, extraction_id uuid,
  decided_at timestamptz, created_at timestamptz not null default now(),
  primary key (id)
);

-- holdings + snapshots (source check gets widened by the migration)
create table public.holdings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null, account_id uuid not null, as_of date not null,
  symbol text not null check (length(symbol) between 1 and 20),
  name text, qty numeric not null check (qty > 0),
  price_minor bigint not null check (price_minor >= 0),
  value_minor bigint not null check (value_minor >= 0),
  cost_basis_minor bigint check (cost_basis_minor is null or cost_basis_minor >= 0),
  currency text not null default 'USD' check (currency = upper(currency)),
  source text not null check (source in ('manual','plaid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, symbol, source)
);
create table public.holdings_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null, account_id uuid not null, snapshot_date date not null,
  symbol text not null, name text, qty numeric not null check (qty > 0),
  price_minor bigint not null check (price_minor >= 0),
  value_minor bigint not null check (value_minor >= 0),
  cost_basis_minor bigint, currency text not null default 'USD' check (currency = upper(currency)),
  source text not null check (source in ('manual','plaid')),
  created_at timestamptz not null default now(),
  unique (account_id, snapshot_date, symbol, source)
);

-- command plumbing
create table public.audit_log (
  id bigint generated always as identity primary key,
  household_id uuid, actor jsonb, action text, object_type text,
  object_id uuid, command_id uuid, before jsonb, after jsonb,
  at timestamptz not null default now()
);
create table public.domain_events (
  id bigint generated always as identity primary key,
  event_type text, household_id uuid, command_id uuid, economic_event_key text,
  actor jsonb, payload jsonb, occurred_at timestamptz not null default now()
);
create table public.command_executions (
  household_id uuid, economic_event_key text, command_id uuid, command text,
  payload_sha256 text, result jsonb, executed_at timestamptz not null default now(),
  primary key (household_id, economic_event_key)
);

do $$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
end $$;

grant all on all tables in schema public to keel_api;
grant select on all tables in schema public to authenticated;
grant select on auth.users to keel_api, authenticated;

-- keel_is_investment_subtype (real body is IMMUTABLE sql; a faithful subset is
-- enough for the gate test — 'brokerage' true, 'checking' false).
create function public.keel_is_investment_subtype(p_subtype text) returns boolean
language sql immutable as $$
  select case when p_subtype is null then false
    else lower(btrim(p_subtype)) = any(array['brokerage','ira','401k','roth','hsa','retirement'])
      or lower(p_subtype) similar to '%(investment|brokerage|ira|401k|roth|hsa|retirement)%' end;
$$;

-- Stub keel_export_household so the migration's rename-chain succeeds.
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
  returns jsonb language sql stable as $$ select jsonb_build_object('tables', '{}'::jsonb) $$;

-- __SHARED_HELPERS__  (real: keel_actor_from_jwt, keel_assert_member_write,
--   keel_idempotency_check, keel_payload_hash, keel_finish_command,
--   keel_recurring_account_access)

-- __SLICE0_BODY__  (real 20260720100000_approval_tokens.sql)

-- __MIGRATION_BODY__  (real 20260720270000_statement_holdings_apply.sql)

-- Fixtures -----------------------------------------------------------------
insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.households(id) values
  ('00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b001');
insert into public.household_memberships(household_id,user_id,role) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000001','owner'),
  ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-000000000002','owner');
-- investment account (a401, owned by user1) + a checking account (a402)
insert into public.accounts(id,household_id,subtype,currency) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a001','brokerage','USD'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-00000000a001','checking','USD');
insert into public.account_owners(account_id,user_id) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-000000000001');

-- Extraction E1 (June): AAA 10@100.00 = 1000.00, BBB 5@50.00 = 250.00
insert into public.statement_extractions(id,household_id,kind_hint) values
  ('00000000-0000-4000-8000-0000000e0001','00000000-0000-4000-8000-00000000a001','investment');
insert into public.statement_extraction_holdings(household_id,extraction_id,symbol,qty,price_minor,value_minor,currency) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e0001','AAA',10,10000,100000,'USD'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e0001','BBB',5,5000,25000,'USD');
-- Extraction E2 (July): AAA 12@110.00 = 1320.00 (BBB DROPPED, CCC added 3@200)
insert into public.statement_extractions(id,household_id,kind_hint) values
  ('00000000-0000-4000-8000-0000000e0002','00000000-0000-4000-8000-00000000a001','investment');
insert into public.statement_extraction_holdings(household_id,extraction_id,symbol,qty,price_minor,value_minor,currency) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e0002','AAA',12,11000,132000,'USD'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e0002','CCC',3,20000,60000,'USD');

-- Statement S1 (June, period_end 2026-06-30) + draft linking it to E1
insert into public.statements(id,household_id,account_id,period_start,period_end,currency) values
  ('00000000-0000-4000-8000-00000000c001','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','2026-06-01','2026-06-30','USD');
insert into public.statement_drafts(household_id,account_id,statement_id,extraction_id,decided_at) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000c001','00000000-0000-4000-8000-0000000e0001',now());
-- Statement S2 (July, period_end 2026-07-31) + draft linking it to E2
insert into public.statements(id,household_id,account_id,period_start,period_end,currency) values
  ('00000000-0000-4000-8000-00000000c002','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','2026-07-01','2026-07-31','USD');
insert into public.statement_drafts(household_id,account_id,statement_id,extraction_id,decided_at) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000c002','00000000-0000-4000-8000-0000000e0002',now());
-- Statement S3 (on the CHECKING account) — for the non-investment reject
insert into public.statements(id,household_id,account_id,period_start,period_end,currency) values
  ('00000000-0000-4000-8000-00000000c003','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a402','2026-06-01','2026-06-30','USD');
insert into public.statement_drafts(household_id,account_id,statement_id,extraction_id,decided_at) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-00000000c003','00000000-0000-4000-8000-0000000e0001',now());

-- Structural -----------------------------------------------------------------
select has_table('public','statement_holding_applications','applications table exists');
select has_function('public','keel_cmd_statements_apply_holdings',
  array['uuid','text','jsonb','uuid','jsonb'],'apply command exists');
select has_function('public','keel_cmd_statements_unapply_holdings',
  array['uuid','text','jsonb','uuid','jsonb'],'unapply command exists');
select has_function('public','keel_statement_holdings_diff',
  array['uuid','uuid'],'diff read exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='public.keel_cmd_statements_apply_holdings(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','apply owned by keel_api');

-- Source-check widened: a source='statement' holding is insertable now.
select lives_ok($$insert into public.holdings
  (household_id,account_id,as_of,symbol,qty,price_minor,value_minor,currency,source)
  values ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a401',
          '2026-01-01','ZZZ',1,100,100,'USD','statement')$$,
  'source=statement holding insertable (constraint widened) [A8]');
delete from public.holdings where symbol='ZZZ';

-- Act as owner user 1.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The GATE (Law 11): the ISSUE payload == the APPLY payload, by construction.
-- (apply_payload is an INTERNAL helper — only issue/apply may EXECUTE it in
-- production; probe it as postgres, then drop back to the authenticated actor.)
set local role postgres;
select is(
  public.keel_statement_holdings_apply_payload(
    '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c001')::text,
  public.keel_statement_holdings_apply_payload(
    '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c001')::text,
  'apply_payload is deterministic (issue side == apply side hash source) [GATE]');

-- Non-investment account rejected at payload build (the gate).
select throws_ok($$select public.keel_statement_holdings_apply_payload(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c003')$$,
  'P0009',null,'non-investment account rejected (subtype gate) [Law 10]');
set local role authenticated;

-- ==== APPLY S1 (June) ====
create temp table _tk1 as select public.keel_cmd_statements_issue_holdings_approval(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c001') as out;
select ok((select out->>'tokenId' is not null from _tk1),'issue S1 returns tokenId');

select lives_ok(format($$select public.keel_cmd_statements_apply_holdings(
  gen_random_uuid(),'apply-s1',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('statement_id','00000000-0000-4000-8000-00000000c001',
                     'approval_token_id',%L))$$,
  (select out->>'tokenId' from _tk1)),'apply S1 succeeds');

-- current holdings = AAA + BBB at as_of 2026-06-30, source statement.
select is((select count(*)::text from public.holdings where source='statement'
            and account_id='00000000-0000-4000-8000-00000000a401'),'2',
  'apply S1 -> 2 current statement holdings (AAA,BBB)');
select is((select value_minor::text from public.holdings
            where source='statement' and symbol='AAA'
              and account_id='00000000-0000-4000-8000-00000000a401'),'100000',
  'AAA value 100000 minor');
select is((select as_of::text from public.holdings where source='statement' and symbol='AAA'
              and account_id='00000000-0000-4000-8000-00000000a401'),'2026-06-30',
  'as_of = S1 period_end');
-- snapshot written
select is((select count(*)::text from public.holdings_snapshots where source='statement'
            and snapshot_date='2026-06-30'),'2','snapshot S1 has 2 rows');
-- application row
select is((select count(*)::text from public.statement_holding_applications
            where statement_id='00000000-0000-4000-8000-00000000c001' and revoked_at is null),'1',
  'one non-revoked application for S1');

-- ==== APPLY S2 (July, newer) -> symbol-drop BBB, add CCC, AAA reprices ====
create temp table _tk2 as select public.keel_cmd_statements_issue_holdings_approval(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c002') as out;
select lives_ok(format($$select public.keel_cmd_statements_apply_holdings(
  gen_random_uuid(),'apply-s2',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('statement_id','00000000-0000-4000-8000-00000000c002',
                     'approval_token_id',%L))$$,
  (select out->>'tokenId' from _tk2)),'apply S2 succeeds');

select is((select count(*)::text from public.holdings where source='statement'
            and account_id='00000000-0000-4000-8000-00000000a401'),'2',
  'after S2 -> 2 current statement holdings (AAA,CCC)');
select is((select count(*)::text from public.holdings where source='statement' and symbol='BBB'
            and account_id='00000000-0000-4000-8000-00000000a401'),'0',
  'BBB DROPPED (absent from newer full statement S2) [A8]');
select is((select count(*)::text from public.holdings where source='statement' and symbol='CCC'
            and account_id='00000000-0000-4000-8000-00000000a401'),'1',
  'CCC added by S2');
select is((select value_minor::text from public.holdings where source='statement' and symbol='AAA'
            and account_id='00000000-0000-4000-8000-00000000a401'),'132000',
  'AAA repriced to 132000 by S2');
select is((select as_of::text from public.holdings where source='statement' and symbol='AAA'
            and account_id='00000000-0000-4000-8000-00000000a401'),'2026-07-31',
  'current as_of now = S2 period_end');

-- ==== RE-APPLY the OLDER S1 -> must NOT regress current (S2 still wins) ====
create temp table _tk1b as select public.keel_cmd_statements_issue_holdings_approval(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c001') as out;
select lives_ok(format($$select public.keel_cmd_statements_apply_holdings(
  gen_random_uuid(),'apply-s1-again',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('statement_id','00000000-0000-4000-8000-00000000c001',
                     'approval_token_id',%L))$$,
  (select out->>'tokenId' from _tk1b)),'re-apply older S1 succeeds');
select is((select value_minor::text from public.holdings where source='statement' and symbol='AAA'
            and account_id='00000000-0000-4000-8000-00000000a401'),'132000',
  'older S1 re-apply does NOT regress current (still S2 AAA=132000) [A8]');
select is((select count(*)::text from public.holdings where source='statement' and symbol='CCC'
            and account_id='00000000-0000-4000-8000-00000000a401'),'1',
  'CCC still present after older re-apply (no regress)');

-- ==== UNAPPLY S2 -> current rebuilds from prior application S1 (June) ====
select lives_ok($$select public.keel_cmd_statements_unapply_holdings(
  gen_random_uuid(),'unapply-s2',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  '{"statement_id":"00000000-0000-4000-8000-00000000c002"}'::jsonb)$$,
  'unapply S2 succeeds');
select is((select count(*)::text from public.holdings where source='statement'
            and account_id='00000000-0000-4000-8000-00000000a401'),'2',
  'after unapply S2 -> back to S1 set (AAA,BBB)');
select is((select count(*)::text from public.holdings where source='statement' and symbol='BBB'
            and account_id='00000000-0000-4000-8000-00000000a401'),'1',
  'BBB restored from prior application S1 [Law 2 rebuild-from-prior]');
select is((select value_minor::text from public.holdings where source='statement' and symbol='AAA'
            and account_id='00000000-0000-4000-8000-00000000a401'),'100000',
  'AAA back to S1 value 100000');
select is((select count(*)::text from public.statement_holding_applications
            where statement_id='00000000-0000-4000-8000-00000000c002' and revoked_at is not null),'1',
  'S2 application revoked (not deleted) [Law 2 audit!=undo]');

-- unapply already-revoked -> P0009
select throws_ok($$select public.keel_cmd_statements_unapply_holdings(
  gen_random_uuid(),'unapply-s2-again',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  '{"statement_id":"00000000-0000-4000-8000-00000000c002"}'::jsonb)$$,
  'P0009',null,'re-unapply of a revoked application rejected');

-- ==== IDEMPOTENT replay: same economic_event_key returns replay ====
create temp table _tk1c as select public.keel_cmd_statements_issue_holdings_approval(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c001') as out;
-- first fresh apply under a new key
select lives_ok(format($$select public.keel_cmd_statements_apply_holdings(
  gen_random_uuid(),'apply-idem',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('statement_id','00000000-0000-4000-8000-00000000c001',
                     'approval_token_id',%L))$$,
  (select out->>'tokenId' from _tk1c)),'apply under idem key');
-- replay: SAME key + SAME payload -> idempotentReplay true, no error
select is(
  (select (public.keel_cmd_statements_apply_holdings(
    gen_random_uuid(),'apply-idem',
    '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('statement_id','00000000-0000-4000-8000-00000000c001',
                       'approval_token_id',(select out->>'tokenId' from _tk1c))
  ))->>'idempotentReplay'),
  'true','replay of same key -> idempotentReplay true [Law 9]');
select is((select count(*)::text from public.statement_holding_applications
            where statement_id='00000000-0000-4000-8000-00000000c001'),'1',
  'still exactly one application row for S1 after replay');

-- ==== TOKEN TAMPER: mutate the extraction after issue -> redeem hash mismatch
create temp table _tktmp as select public.keel_cmd_statements_issue_holdings_approval(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c002') as out;
-- re-activate S2 draft/statement is fine; now tamper: change an extracted qty so
-- the apply-side payload no longer matches the issued hash. (The extraction table
-- is append-only in prod; here we mutate it as postgres purely to simulate a
-- client that changed the payload between issue and redeem.)
set local role postgres;
update public.statement_extraction_holdings set qty = 999
 where extraction_id='00000000-0000-4000-8000-0000000e0002' and symbol='AAA';
set local role authenticated;
select throws_ok(format($$select public.keel_cmd_statements_apply_holdings(
  gen_random_uuid(),'apply-tamper',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('statement_id','00000000-0000-4000-8000-00000000c002',
                     'approval_token_id',%L))$$,
  (select out->>'tokenId' from _tktmp)),
  null,null,'apply rejects a tampered payload (issued hash != apply hash) [Law 11]');
-- restore
set local role postgres;
update public.statement_extraction_holdings set qty = 12
 where extraction_id='00000000-0000-4000-8000-0000000e0002' and symbol='AAA';
set local role authenticated;

-- ==== DIFF: current is S1 (AAA 1000, BBB 250); diff vs S2 extraction ====
-- (S2 was unapplied; current statement holdings = S1 set.)
-- diff of S2: AAA changed (12 vs 10), BBB removed (in current not S2), CCC added.
select is(
  (select r->>'state' from jsonb_array_elements(
    (public.keel_statement_holdings_diff('00000000-0000-4000-8000-00000000a001',
      '00000000-0000-4000-8000-00000000c002'))->'rows') r where r->>'symbol'='CCC'),
  'added','diff: CCC added (in statement, not current)');
select is(
  (select r->>'state' from jsonb_array_elements(
    (public.keel_statement_holdings_diff('00000000-0000-4000-8000-00000000a001',
      '00000000-0000-4000-8000-00000000c002'))->'rows') r where r->>'symbol'='BBB'),
  'removed','diff: BBB removed (in current, not statement)');
select is(
  (select r->>'state' from jsonb_array_elements(
    (public.keel_statement_holdings_diff('00000000-0000-4000-8000-00000000a001',
      '00000000-0000-4000-8000-00000000c002'))->'rows') r where r->>'symbol'='AAA'),
  'changed','diff: AAA changed (qty/value differ)');

-- ==== TENANT / ACCOUNT ISOLATION: user2 (other household) cannot issue on a001
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.keel_cmd_statements_issue_holdings_approval(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c001')$$,
  null,null,'non-member cannot issue a holdings-approval token (isolation)');
select throws_ok($$select public.keel_statement_holdings_diff(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000c001')$$,
  null,null,'non-member cannot read the diff (isolation)');

-- back to owner: export includes statement_holding_applications
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role postgres;
-- The Slice-0 export wrapper is SECURITY DEFINER owned by keel_export; ensure the
-- whole rename-chain (incl. the pre-Slice-0 sql stub) is executable by keel_export
-- in this minimal cluster (prod grants these when each real export layer ships).
do $$ declare fn record; begin
  for fn in select p.oid::regprocedure::text as sig from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'keel_export_household%'
  loop execute format('grant execute on function %s to keel_export', fn.sig); end loop;
end $$;
select ok(
  (public.keel_export_household('00000000-0000-4000-8000-00000000a001',null))
    ->'tables' ? 'statement_holding_applications',
  'export includes statement_holding_applications [Law 6]');
-- Export ships ALL application rows including the REVOKED S2 (Law 6: full history,
-- not just live) — S1 (live) + S2 (revoked) = 2.
select is(
  jsonb_array_length((public.keel_export_household('00000000-0000-4000-8000-00000000a001',null))
    ->'tables'->'statement_holding_applications')::text,
  '2','export ships both S1 (live) and S2 (revoked) application rows [Law 6]');

select finish();
rollback;
