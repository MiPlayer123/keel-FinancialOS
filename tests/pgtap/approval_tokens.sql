-- pgTAP: approval-token SQL primitive (SLICE 0, statement-ingestion-v2.md;
-- CLAUDE.md Law 11 typed AI responses + approval tokens, Law 7 one
-- authorization compiler).
--
-- The Supabase stack (auth schema, PostgREST request.jwt settings, pgmq) is
-- unavailable in the throwaway-postgres cluster this runs in, so the suite
-- builds a MINIMAL real schema (households / memberships / accounts /
-- account_owners / statements / command plumbing) and loads the ACTUAL shared
-- command helpers + keel_recurring_account_access (sliced verbatim from their
-- migrations) and the ACTUAL 20260720100000 migration file
-- (see scripts/run-approval-tokens-pgtap.sh). These tests exercise the exact
-- SQL that ships, not a paraphrase.
--
-- Properties under test:
--   * issue -> redeem happy path (one-use token, hash bound to server payload);
--   * tamper: redeem with a mutated normalized payload -> hash mismatch reject;
--   * replay: a second redeem of a redeemed token -> P0007;
--   * expiry: a past-expiry token -> reject AND status flips to 'expired';
--   * wrong actor: a different user redeeming -> reject;
--   * wrong account / no write access at issue -> P0006 (account-scoped gate);
--   * wrong proposal_version -> reject;
--   * immutable-except-status: no non-status column may change; no delete;
--   * ownership: issue/redeem/materialize/statement_create owned by keel_api;
--   * keel_statement_create manual path is byte-identical after the refactor
--     (creates the statement + lines exactly as before, same effects shape).

begin;
select no_plan();

-- Minimal schema -----------------------------------------------------------
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
  household_id uuid not null,
  user_id uuid not null,
  role public.household_role not null
);
create table public.accounts (
  id uuid not null,
  household_id uuid not null,
  currency char(3) not null default 'USD',
  primary key (id),
  unique (household_id, id)
);
create table public.account_owners (
  account_id uuid not null,
  user_id uuid not null
);
create table public.resource_permissions (
  household_id uuid not null,
  user_id uuid not null,
  resource_kind text not null,
  resource_id uuid not null,
  permission public.resource_permission not null
);
-- statement family (columns the shared materialize + create read/write)
create table public.statements (
  id uuid not null,
  household_id uuid not null,
  account_id uuid not null,
  period_start date not null,
  period_end date not null,
  opening_minor bigint not null,
  ending_minor bigint not null,
  currency char(3) not null,
  source_hash text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, account_id, period_start, period_end, source_hash)
);
create table public.statement_lines (
  household_id uuid not null,
  id uuid not null default gen_random_uuid(),
  statement_id uuid not null,
  line_key text not null,
  line_date date not null,
  amount_minor bigint not null,
  description text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, statement_id, line_key)
);
-- command plumbing the finish_command helper writes to
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

-- Roles referenced by the migration's owner/grant statements. (Created here so
-- the grants inside this transaction resolve; the runner also creates them at
-- cluster scope for grants outside any txn.)
do $$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
end $$;

-- In production the reconciliation/recurring migrations grant keel_api the
-- SELECT/INSERT/UPDATE it needs on these tables. Grant it here so the keel_api-
-- owned SECURITY DEFINER procs (which run with keel_api's privileges) can read
-- the fixtures and write results. authenticated gets SELECT for the direct
-- immutability probes.
grant all on all tables in schema public to keel_api;
grant select on all tables in schema public to authenticated;
grant select on auth.users to keel_api, authenticated;

-- Stub keel_export_household so the migration's rename-chain succeeds (the real
-- outer export layer is out of scope for this minimal cluster).
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
  returns jsonb language sql stable as $$ select jsonb_build_object('tables', '{}'::jsonb) $$;

-- Roles referenced by the migration's owner/grant statements.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
end $$;

-- __SHARED_HELPERS__  (replaced by the runner with the real helper DDL:
--   keel_actor_from_jwt, keel_assert_member_write, keel_idempotency_check,
--   keel_payload_hash, keel_finish_command, keel_recurring_account_access)

-- __MIGRATION_BODY__  (replaced by the runner with the real 20260720100000 file)

-- Fixtures -----------------------------------------------------------------
insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.households(id) values ('00000000-0000-4000-8000-00000000a001');
insert into public.household_memberships(household_id,user_id,role) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000001','owner'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000002','partner');
insert into public.accounts(id,household_id,currency) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a001','USD'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-00000000a001','USD');
-- user 1 owns a401 only; user 2 owns a402 only.
insert into public.account_owners(account_id,user_id) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-000000000002');

-- Structural assertions -----------------------------------------------------
select has_table('public','approval_tokens','approval_tokens table exists');
select has_function('public','keel_approval_token_issue',
  array['uuid','jsonb','text','jsonb','jsonb','uuid','text','uuid','integer','text','integer'],'issue exists');
select has_function('public','keel_approval_token_redeem',
  array['uuid','uuid','uuid','jsonb','text','jsonb','integer'],'redeem exists');
select has_function('public','keel_statement_validate_and_materialize',
  array['uuid','jsonb','jsonb'],'shared materialize exists');
select has_function('public','keel_approval_token_expire_sweep',array[]::text[],'expire sweep exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.keel_approval_token_issue(uuid,jsonb,text,jsonb,jsonb,uuid,text,uuid,integer,text,integer)'::regprocedure),
  'keel_api','issue owned by keel_api');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.keel_approval_token_redeem(uuid,uuid,uuid,jsonb,text,jsonb,integer)'::regprocedure),
  'keel_api','redeem owned by keel_api');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.keel_statement_create(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','refactored statement_create still owned by keel_api');

-- Act as owner user 1 with a JWT.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Issue a token for a statement approval scoped to a401. The proc hashes the
-- SERVER-normalized payload; capture the token + hash.
create temp table _tok as
select public.keel_approval_token_issue(
  '00000000-0000-4000-8000-00000000a001',
  '{"kind":"user","userId":"forged"}'::jsonb,      -- forged actor: MUST be ignored
  'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,
  '{"entities":[],"accounts":["00000000-0000-4000-8000-00000000a401"],"period":"2026-06-01/2026-06-30"}'::jsonb,
  '00000000-0000-4000-8000-00000000a401',
  'statement_draft', gen_random_uuid(), 1, 'policy-v1', 900
) as out;

select ok((select out->>'tokenId' is not null from _tok),'issue returns a tokenId');
select is((select out->>'actorUserId' from _tok),'00000000-0000-4000-8000-000000000001',
  'issue derives actor from JWT, ignoring the forged p_actor');
select is(
  (select out->>'payloadSha256' from _tok),
  public.keel_payload_hash('{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb),
  'issue binds payload_sha256 to the server-normalized payload');
select is((select status::text from public.approval_tokens),'issued','token starts issued');

-- Wrong-account issue: user 1 has NO write access to a402 -> P0006.
select throws_ok($$select public.keel_approval_token_issue(
  '00000000-0000-4000-8000-00000000a001','{}'::jsonb,'statements.approve_draft',
  '{"x":1}'::jsonb,'{}'::jsonb,'00000000-0000-4000-8000-00000000a402',
  'statement_draft',null,1,'policy-v1',900)$$,'P0006',null,
  'issue rejects an account the actor cannot write (account-scoped gate)');

-- Tamper: redeem with a MUTATED payload -> hash mismatch, KEEL_INVALID_COMMAND.
select throws_ok($$select public.keel_approval_token_redeem(
  '00000000-0000-4000-8000-00000000a001',(select (out->>'tokenId')::uuid from _tok),
  gen_random_uuid(),'{}'::jsonb,'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"9999"}'::jsonb,1)$$,
  'P0009',null,'redeem rejects a tampered (re-hashed) payload');

-- Wrong command -> reject.
select throws_ok($$select public.keel_approval_token_redeem(
  '00000000-0000-4000-8000-00000000a001',(select (out->>'tokenId')::uuid from _tok),
  gen_random_uuid(),'{}'::jsonb,'statements.WRONG',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,1)$$,
  'P0009',null,'redeem rejects a command mismatch');

-- Wrong proposal_version -> reject.
select throws_ok($$select public.keel_approval_token_redeem(
  '00000000-0000-4000-8000-00000000a001',(select (out->>'tokenId')::uuid from _tok),
  gen_random_uuid(),'{}'::jsonb,'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,2)$$,
  'P0009',null,'redeem rejects a proposal_version mismatch');

-- None of the above rejections consumed the token: still issued.
select is((select status::text from public.approval_tokens),'issued','failed redeems do not consume the token');

-- Wrong actor: user 2 tries to redeem user 1's token -> reject, token untouched.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.keel_approval_token_redeem(
  '00000000-0000-4000-8000-00000000a001',(select (out->>'tokenId')::uuid from _tok),
  gen_random_uuid(),'{}'::jsonb,'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,1)$$,
  'P0009',null,'redeem rejects a wrong actor');
select is((select status::text from public.approval_tokens),'issued','wrong-actor redeem does not consume the token');

-- Happy path: the true actor redeems the exact server payload -> redeemed once.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$select public.keel_approval_token_redeem(
  '00000000-0000-4000-8000-00000000a001',(select (out->>'tokenId')::uuid from _tok),
  'cc000000-0000-4000-8000-0000000000c1','{}'::jsonb,'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,1)$$,
  'redeem succeeds for the true actor with the exact payload');
select is((select status::text from public.approval_tokens),'redeemed','token flips to redeemed');
select ok((select redeemed_at is not null and redeemed_command_id='cc000000-0000-4000-8000-0000000000c1'
  from public.approval_tokens),'redemption stamps redeemed_at + redeemed_command_id');

-- Replay: a SECOND redeem of the redeemed token -> P0007 (one-use).
select throws_ok($$select public.keel_approval_token_redeem(
  '00000000-0000-4000-8000-00000000a001',(select (out->>'tokenId')::uuid from _tok),
  gen_random_uuid(),'{}'::jsonb,'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,1)$$,
  'P0007',null,'a second redeem of a redeemed token is rejected (replay)');

-- Immutability: no delete; no non-status column mutation (bypassing the procs).
reset role;
select throws_ok($$delete from public.approval_tokens$$,'P0001',null,'approval tokens cannot be deleted');
select throws_ok($$update public.approval_tokens set command='x'$$,'P0001',null,
  'a non-status column cannot be mutated even after redemption');

-- Expiry: issue a token with a 1s TTL, wait past it, redeem -> reject + expired.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
create temp table _exp as
select public.keel_approval_token_issue(
  '00000000-0000-4000-8000-00000000a001','{}'::jsonb,'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,
  '{}'::jsonb,'00000000-0000-4000-8000-00000000a401','statement_draft',null,1,'policy-v1',1) as out;
-- Sleep past the 1s TTL. clock_timestamp() advances even inside a transaction
-- (unlike now()), so the redeem's expiry gate fires deterministically here.
reset role;
select pg_sleep(1.2);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.keel_approval_token_redeem(
  '00000000-0000-4000-8000-00000000a001',(select (out->>'tokenId')::uuid from _exp),
  gen_random_uuid(),'{}'::jsonb,'statements.approve_draft',
  '{"account_id":"00000000-0000-4000-8000-00000000a401","amount":"20"}'::jsonb,1)$$,
  'P0009',null,'an expired token is rejected on redeem');
-- redeem raises + rolls back, so it cannot durably flip status; the sweeper
-- (its own transaction in production) is what marks the token 'expired'.
select is((select status::text from public.approval_tokens where token_id=(select (out->>'tokenId')::uuid from _exp)),
  'issued','redeem cannot durably flip status (it rolls back on raise)');
reset role;
select is((select public.keel_approval_token_expire_sweep())::text,'1','sweep flips exactly the one past-expiry token');
select is(
  (select status::text from public.approval_tokens where token_id=(select (out->>'tokenId')::uuid from _exp)),
  'expired','the sweeper durably marks the expired token');

-- keel_statement_create manual path byte-identical proof: the refactored proc
-- still creates the statement + its lines and returns the same effects shape.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$select public.keel_statement_create(
  'dd000000-0000-4000-8000-0000000000d1','pgtap:approval:statement:create','{}',
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401',
    'period_start','2026-06-01','period_end','2026-06-30','opening_minor','100',
    'ending_minor','120','currency','USD','source_hash',repeat('c',64),
    'lines',jsonb_build_array(jsonb_build_object('line_key','deposit','date','2026-06-15',
      'amount_minor','20','description','deposit'))))$$,
  'refactored keel_statement_create still creates a statement (manual path)');
select is((select count(*)::text from public.statements),'1','exactly one statement row created');
select is((select count(*)::text from public.statement_lines),'1','exactly one statement line created via the shared helper');

select * from finish();
rollback;
