-- pgTAP: statement extraction staging + token-bound draft approval (SLICE 3,
-- statement-ingestion-v2.md §5; CLAUDE.md Laws 5/9/11/7/2).
--
-- Runs in a throwaway-postgres cluster (no Supabase stack), so this file builds a
-- MINIMAL real schema (households/memberships/accounts/account_owners/statements/
-- statement_lines/documents/document_versions/document_attachments/journal_* and
-- the command plumbing) and the runner loads the ACTUAL shared command helpers +
-- keel_recurring_account_access + keel_forbid_mutation (sliced verbatim from
-- their migrations), the ACTUAL Slice-0 20260720100000 migration, and the ACTUAL
-- Slice-3 migrations 20260720180000 + 20260720190000. It exercises the exact SQL
-- that ships (see scripts/run-statement-extraction-pgtap.sh).
--
-- Properties under test:
--   * persist is idempotent per (household, version, extractor, version): a
--     replayed job returns the same id and does NOT duplicate children;
--   * draft terminal-lock: no transition OUT of approved/dismissed; no DELETE;
--   * account-scope isolation on the drafts list: a viewer with no access to an
--     account never sees that account's draft [A10];
--   * anchor coalesce: a zero-line STRICT statement no longer NULL-bypasses —
--     opening<>ending is rejected (the empty-array bug is dead);
--   * anchor mode: zero-line anchor statement on a brokerage account materializes
--     with typed reason+gap; a checking account is refused anchor;
--   * THE GATE: keel_cmd_statements_approve_draft binds ONE v_payload and passes
--     it to BOTH redeem AND materialize — a tampered body (token approved body A,
--     client submits body B) is impossible by construction (hash mismatch);
--   * source_hash is bound from the SERVER content_sha256, never the payload;
--   * expired / replayed / tampered / wrong-version token rejected at approve;
--   * tenant isolation on persist (cross-household version refused).

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
  if not exists (select 1 from pg_type where typname = 'extraction_status') then
    create type public.extraction_status as enum ('pending','extracted','failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'reconciliation_resolution') then
    create type public.reconciliation_resolution as enum ('matched_transaction','stale_balance','missing_event','duplicate','pending_posting','opening_balance','adjustment');
  end if;
end $$;

create table auth.users (id uuid primary key);
create table public.households (id uuid primary key);
create table public.household_memberships (
  household_id uuid not null, user_id uuid not null, role public.household_role not null
);
create table public.ledger_accounts (id uuid primary key, household_id uuid not null);
create table public.accounts (
  id uuid not null, household_id uuid not null, ledger_account_id uuid,
  name text not null default 'acct', subtype text, currency char(3) not null default 'USD',
  primary key (id), unique (household_id, id)
);
create table public.account_owners (account_id uuid not null, user_id uuid not null);
create table public.resource_permissions (
  household_id uuid not null, user_id uuid not null, resource_kind text not null,
  resource_id uuid not null, permission public.resource_permission not null
);
create table public.statements (
  id uuid not null, household_id uuid not null, account_id uuid not null,
  period_start date not null, period_end date not null,
  opening_minor bigint not null, ending_minor bigint not null, currency char(3) not null,
  source_hash text not null, created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, account_id, period_start, period_end, source_hash)
);
create table public.statement_lines (
  household_id uuid not null, id uuid not null default gen_random_uuid(),
  statement_id uuid not null, line_key text not null, line_date date not null,
  amount_minor bigint not null, description text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id), unique (household_id, statement_id, line_key)
);
create table public.documents (
  id uuid primary key, household_id uuid not null, entity_id uuid,
  original_filename text not null default 'stmt.pdf'
);
create table public.document_versions (
  id uuid primary key default gen_random_uuid(), document_id uuid not null,
  content_sha256 text not null, byte_size bigint not null default 1
);
create table public.document_attachments (
  id uuid primary key default gen_random_uuid(), household_id uuid not null,
  document_id uuid not null, attached_by uuid, statement_id uuid,
  canonical_transaction_id uuid, paycheck_id uuid, reimbursement_claim_id uuid,
  detached_by uuid, detached_at timestamptz, attached_at timestamptz not null default now()
);
create table public.journal_batches (
  id uuid primary key default gen_random_uuid(), household_id uuid not null,
  effective_date date not null
);
create table public.journal_postings (
  id uuid primary key default gen_random_uuid(), batch_id uuid not null,
  ledger_account_id uuid not null, amount_minor bigint not null, currency char(3) not null
);
-- Reconciliation family — present only so the real keel_reconciliation_close
-- (recreated by the anchor migration) compiles under check_function_bodies. Not
-- exercised by this suite (close semantics are gate-8, tested elsewhere).
create table public.canonical_transactions (
  id uuid primary key, household_id uuid not null, account_id uuid,
  effective_date date, status text, voided_at timestamptz
);
create table public.period_locks (
  id uuid primary key default gen_random_uuid(), household_id uuid not null,
  entity_id uuid, start_date date, end_date date, locked_by uuid
);
create table public.reconciliation_sessions (
  household_id uuid not null, id uuid not null, statement_id uuid, account_id uuid,
  ledger_ending_minor bigint, difference_minor bigint, status text,
  formula_version text, period_lock_id uuid, closed_by uuid, closed_at timestamptz
);
create table public.reconciliation_items (
  household_id uuid, session_id uuid, statement_line_id uuid,
  resolution public.reconciliation_resolution, transaction_id uuid, explanation text
);
create table public.reconciliation_adjustments (
  household_id uuid, session_id uuid, kind public.reconciliation_resolution,
  amount_minor bigint, explanation text
);
create table public.close_checklists (
  household_id uuid, session_id uuid, checklist_version text, checks jsonb
);
create table public.reconciliation_status_events (
  household_id uuid, session_id uuid, transition text, actor jsonb, command_id uuid
);
-- accounts needs entity_id for the close proc's entity lookup.
alter table public.accounts add column if not exists entity_id uuid;
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

do $$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_worker') then create role keel_worker nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
end $$;

grant all on all tables in schema public to keel_api, keel_worker;
grant select on all tables in schema public to authenticated;
grant select on auth.users to keel_api, keel_worker, authenticated;

-- Stub keel_export_household so both migrations' rename-chains succeed.
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
  returns jsonb language sql stable as $$ select jsonb_build_object('tables', jsonb_build_object('statements','[]'::jsonb)) $$;

-- __SHARED_HELPERS__  (runner injects: keel_actor_from_jwt, keel_assert_member_write,
--   keel_idempotency_check, keel_payload_hash, keel_finish_command,
--   keel_recurring_account_access, keel_forbid_mutation, keel_statement_access)

-- __SLICE0_BODY__      (runner injects the real 20260720100000_approval_tokens.sql)

-- __MIGRATION1_BODY__  (runner injects the real 20260720180000_statement_extraction.sql)

-- __MIGRATION2_BODY__  (runner injects the real 20260720190000_statement_anchor_mode.sql)

-- Re-grant AFTER the migrations: the migrations `revoke all ... from
-- authenticated` on the new tables (production locks them down so the browser
-- reads only via the SECURITY DEFINER procs). This suite makes a few direct
-- table probes as the authenticated role (immutability/terminal-lock/status
-- reads), so restore an authenticated SELECT on the new tables here — the
-- production grant path is asserted by the ownership guards inside the migration.
grant select on public.statement_extractions, public.statement_extraction_lines,
  public.statement_extraction_holdings, public.document_hashes, public.statement_drafts,
  public.statements, public.approval_tokens, public.document_attachments
  to authenticated;
-- Permissive authenticated read policies so the direct verification probes below
-- can observe state (in production these reads flow through member-scoped
-- SECURITY DEFINER procs; here we probe the tables directly).
create policy _test_read_drafts on public.statement_drafts for select to authenticated using (true);
create policy _test_read_ex on public.statement_extractions for select to authenticated using (true);
create policy _test_read_attach on public.document_attachments for select to authenticated using (true);
-- The shared materialize helper is internal (revoked from authenticated in prod);
-- this suite calls it directly to prove the anchor/coalesce fix. It is SECURITY
-- DEFINER owned by keel_api (which holds the writes via the blanket grant above),
-- so we only need to let authenticated EXECUTE it here.
grant execute on function public.keel_statement_validate_and_materialize(uuid,jsonb,jsonb) to authenticated;

-- Fixtures ------------------------------------------------------------------
insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.households(id) values ('00000000-0000-4000-8000-00000000a001');
insert into public.household_memberships(household_id,user_id,role) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000001','owner'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000002','partner');
insert into public.ledger_accounts(id,household_id) values
  ('00000000-0000-4000-8000-00000000b401','00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b402','00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b403','00000000-0000-4000-8000-00000000a001');
-- a401 checking (user1 owns), a402 checking (user2 owns), a403 brokerage (user1 owns)
insert into public.accounts(id,household_id,ledger_account_id,name,subtype,currency) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000b401','Checking','checking','USD'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000b402','Other Checking','checking','USD'),
  ('00000000-0000-4000-8000-00000000a403','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000b403','Brokerage','brokerage','USD');
insert into public.account_owners(account_id,user_id) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-00000000a403','00000000-0000-4000-8000-000000000001');
-- A document + version whose content_sha256 is the SERVER source hash.
insert into public.documents(id,household_id,entity_id) values
  ('00000000-0000-4000-8000-00000000d001','00000000-0000-4000-8000-00000000a001', null);
insert into public.document_versions(id,document_id,content_sha256) values
  ('00000000-0000-4000-8000-00000000d101','00000000-0000-4000-8000-00000000d001', repeat('c',64)),
  ('00000000-0000-4000-8000-00000000d102','00000000-0000-4000-8000-00000000d001', repeat('d',64));

-- Structural assertions ------------------------------------------------------
select has_table('public','statement_extractions','extractions table exists');
select has_table('public','statement_extraction_lines','extraction lines table exists');
select has_table('public','statement_extraction_holdings','extraction holdings table exists');
select has_table('public','document_hashes','document_hashes table exists');
select has_table('public','statement_drafts','drafts table exists');
select has_function('public','keel_cmd_statements_approve_draft',
  array['uuid','text','jsonb','uuid','jsonb'],'approve_draft exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.keel_worker_persist_statement_extraction(uuid,uuid,uuid,public.extraction_status,public.statement_extract_kind,date,date,text,text,text,text,text,text,text,numeric,jsonb,text,jsonb,jsonb)'::regprocedure),
  'keel_worker','persist owned by keel_worker');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.keel_cmd_statements_approve_draft(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','approve_draft owned by keel_api');

-- ===========================================================================
-- PERSIST idempotency + draft flip. Seed a pending draft for version d101,
-- account a401, source_hash = server sha (repeat('c',64)).
-- ===========================================================================
set local role service_role;
-- Insert the pending draft directly as the api role (mirrors confirm-upload).
reset role;
set local role keel_api;
insert into public.statement_drafts(household_id,document_version_id,account_id,source_hash,status)
values('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d101',
       '00000000-0000-4000-8000-00000000a401',repeat('c',64),'pending');
reset role;

set local role service_role;
create temp table _ex as select public.keel_worker_persist_statement_extraction(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d101',
  '00000000-0000-4000-8000-00000000a401','extracted'::public.extraction_status,'bank'::public.statement_extract_kind,
  '2026-06-01','2026-06-30','10000','12000','USD','fixture','v1',null,null,0.9,'{}'::jsonb,null,
  jsonb_build_array(
    jsonb_build_object('line_no',1,'line_date','2026-06-15','amount_minor','2000','description_raw','DEPOSIT'),
    jsonb_build_object('line_no',2,'line_date','2026-06-20','amount_minor','0','description_raw','FEE')
  ),
  '[]'::jsonb
) as id;
reset role;

select ok((select id is not null from _ex),'persist returns an extraction id');
select is((select count(*)::text from public.statement_extraction_lines),'2','two lines persisted');
select is((select status::text from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d101'),
  'extracted','draft flipped pending -> extracted');

-- Replay: identical persist returns the SAME id and does NOT duplicate children.
set local role service_role;
create temp table _ex2 as select public.keel_worker_persist_statement_extraction(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d101',
  '00000000-0000-4000-8000-00000000a401','extracted'::public.extraction_status,'bank'::public.statement_extract_kind,
  '2026-06-01','2026-06-30','10000','12000','USD','fixture','v1',null,null,0.9,'{}'::jsonb,null,
  jsonb_build_array(jsonb_build_object('line_no',1,'line_date','2026-06-15','amount_minor','2000','description_raw','DEPOSIT')),
  '[]'::jsonb
) as id;
reset role;
select is((select (select id from _ex2)::text),(select (select id from _ex)::text),'replay returns the same extraction id');
select is((select count(*)::text from public.statement_extraction_lines),'2','replay did NOT duplicate children');

-- line_no > 5000 rejected BEFORE building arrays.
set local role service_role;
select throws_ok($$select public.keel_worker_persist_statement_extraction(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d102',
  '00000000-0000-4000-8000-00000000a401','extracted'::public.extraction_status,'bank'::public.statement_extract_kind,
  '2026-06-01','2026-06-30','0','0','USD','fixture','vX',null,null,null,'{}'::jsonb,null,
  jsonb_build_array(jsonb_build_object('line_no',5001,'amount_minor','1','description_raw','x')),'[]'::jsonb)$$,
  'P0009',null,'persist rejects line_no > 5000 before building children');
reset role;

-- Tenant isolation on persist: a version in ANOTHER household is refused.
insert into public.households(id) values ('00000000-0000-4000-8000-00000000a099');
insert into public.documents(id,household_id) values ('00000000-0000-4000-8000-00000000d999','00000000-0000-4000-8000-00000000a099');
insert into public.document_versions(id,document_id,content_sha256) values ('00000000-0000-4000-8000-00000000d998','00000000-0000-4000-8000-00000000d999',repeat('e',64));
set local role service_role;
select throws_ok($$select public.keel_worker_persist_statement_extraction(
  '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d998',
  '00000000-0000-4000-8000-00000000a401','extracted'::public.extraction_status,'bank'::public.statement_extract_kind,
  '2026-06-01','2026-06-30','0','0','USD','fixture','vY',null,null,null,'{}'::jsonb,null,'[]'::jsonb,'[]'::jsonb)$$,
  'P0006',null,'persist refuses a document version from another household');
reset role;

-- ===========================================================================
-- DRAFTS LIST account-scope isolation [A10]. user2 (partner) can access a402
-- (they own it) but NOT a401 (user1 owns it). Seed a draft on a402 too.
-- ===========================================================================
set local role keel_api;
insert into public.documents(id,household_id) values ('00000000-0000-4000-8000-00000000d002','00000000-0000-4000-8000-00000000a001');
insert into public.document_versions(id,document_id,content_sha256) values ('00000000-0000-4000-8000-00000000d201','00000000-0000-4000-8000-00000000d002',repeat('a',64));
insert into public.statement_drafts(household_id,document_version_id,account_id,source_hash,status)
values('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d201','00000000-0000-4000-8000-00000000a402',repeat('a',64),'extracted');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
-- user1 owns a401 + a403, NOT a402 -> sees the a401 draft, not the a402 one.
select is(
  (select jsonb_array_length(public.keel_list_statement_drafts('00000000-0000-4000-8000-00000000a001')->'rows')::text),
  '1','user1 sees only their own-account draft (a401), not a402');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  (select jsonb_array_length(public.keel_list_statement_drafts('00000000-0000-4000-8000-00000000a001')->'rows')::text),
  '1','user2 sees only their own-account draft (a402), not a401');
reset role;

-- ===========================================================================
-- ANCHOR / COALESCE: empty-array NULL bypass is dead. A zero-line STRICT
-- statement with opening<>ending must be REJECTED (coalesce(sum,0)=0, so
-- opening+0<>ending fires). Prove via the shared materialize directly.
-- Act as user1 (owns a401 + a403) so keel_recurring_account_access resolves.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.keel_statement_validate_and_materialize(
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401','period_start','2026-07-01',
    'period_end','2026-07-31','opening_minor','100','ending_minor','200','currency','USD',
    'source_hash',repeat('c',64),'lines','[]'::jsonb),
  '{"userId":"00000000-0000-4000-8000-000000000001"}'::jsonb)$$,
  'P0009',null,'zero-line STRICT with opening<>ending is rejected (empty-array NULL bypass is dead)');

-- Zero-line STRICT with opening==ending is fine (a real trivially-balanced stmt).
select lives_ok($$select public.keel_statement_validate_and_materialize(
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401','period_start','2026-07-01',
    'period_end','2026-07-31','opening_minor','500','ending_minor','500','currency','USD',
    'source_hash',repeat('7',64),'lines','[]'::jsonb),
  '{"userId":"00000000-0000-4000-8000-000000000001"}'::jsonb)$$,
  'zero-line STRICT with opening==ending materializes');

-- ANCHOR mode: only for investment/valuation subtypes. a401 (checking) refused.
select throws_ok($$select public.keel_statement_validate_and_materialize(
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401','period_start','2026-07-01',
    'period_end','2026-07-31','opening_minor','100','ending_minor','900','currency','USD',
    'source_hash',repeat('8',64),'lines','[]'::jsonb,'balance_check','anchor',
    'anchor_reason','market_value','anchor_gap_explanation','MTM valuation'),
  '{"userId":"00000000-0000-4000-8000-000000000001"}'::jsonb)$$,
  'P0009',null,'anchor refused on a checking account');

-- a403 (brokerage) accepts anchor with a typed reason + gap, no sum identity.
select lives_ok($$select public.keel_statement_validate_and_materialize(
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a403','period_start','2026-07-01',
    'period_end','2026-07-31','opening_minor','100','ending_minor','900','currency','USD',
    'source_hash',repeat('9',64),'lines','[]'::jsonb,'balance_check','anchor',
    'anchor_reason','market_value','anchor_gap_explanation','MTM valuation'),
  '{"userId":"00000000-0000-4000-8000-000000000001"}'::jsonb)$$,
  'anchor materializes on a brokerage account with typed reason + gap');
select is((select balance_check::text from public.statements where source_hash=repeat('9',64)),
  'anchor','anchor statement stored with balance_check=anchor');

-- Anchor requires typed reason + gap.
select throws_ok($$select public.keel_statement_validate_and_materialize(
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a403','period_start','2026-08-01',
    'period_end','2026-08-31','opening_minor','0','ending_minor','900','currency','USD',
    'source_hash',repeat('6',64),'lines','[]'::jsonb,'balance_check','anchor'),
  '{"userId":"00000000-0000-4000-8000-000000000001"}'::jsonb)$$,
  'P0009',null,'anchor without reason+gap rejected');

-- ===========================================================================
-- THE GATE + token lifecycle at approve. user1 (owner) approves the a401 draft.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The submitted statement body arrives already snake-cased (the API's
-- toSnakeKeys runs before the RPC). The proc constructs
--   v_payload = (statement - source_hash - account_id - balance_check)
--               || {account_id: draft.account, source_hash: server_sha, balance_check}
-- Build _body to EXACTLY equal that construction — this is the body the token
-- must be issued over. draft account = a401, server sha = repeat('c',64).
create temp table _stmt_client as select
  jsonb_build_object(
    'period_start','2026-06-01','period_end','2026-06-30',
    'opening_minor','10000','ending_minor','12000','currency','USD',
    'lines',jsonb_build_array(jsonb_build_object('line_key','deposit','date','2026-06-15','amount_minor','2000','description','DEPOSIT'))
  ) as body;
create temp table _body as select
  (select body from _stmt_client)
  || jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401',
                        'source_hash',repeat('c',64),'balance_check','strict') as body;

-- Issue a token over THAT constructed body for statements.approve_draft.
create temp table _tk as select public.keel_approval_token_issue(
  '00000000-0000-4000-8000-00000000a001','{}'::jsonb,'statements.approve_draft',
  (select body from _body),
  '{"entities":[],"accounts":["00000000-0000-4000-8000-00000000a401"],"period":"2026-06-01/2026-06-30"}'::jsonb,
  '00000000-0000-4000-8000-00000000a401','statement_draft',null,1,'statement-close-v1',900
) as out;

-- THE GATE (tamper): the client submits a DIFFERENT statement body (ending 99999)
-- than the token was issued over. The command normalizes it to v_payload and
-- redeems the token against THAT SAME v_payload -> hash mismatch -> reject. No
-- statement is written. This proves redeem-body-A / materialize-body-B is
-- impossible: there is one v_payload, and if it doesn't match the token it never
-- reaches materialize.
select throws_ok($$select public.keel_cmd_statements_approve_draft(
  gen_random_uuid(),'gate:tamper','{}'::jsonb,'00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('draftId',(select id from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d101'),
    'approvalTokenId',(select (out->>'tokenId')::uuid from _tk),'balanceCheck','strict',
    'statement',jsonb_build_object('period_start','2026-06-01','period_end','2026-06-30',
      'opening_minor','10000','ending_minor','99999','currency','USD',
      'lines',jsonb_build_array(jsonb_build_object('line_key','deposit','date','2026-06-15','amount_minor','2000','description','DEPOSIT')))))$$,
  'P0009',null,'THE GATE: a tampered body (approved A / submitted B) is rejected — one v_payload feeds both redeem and materialize');
select is((select count(*)::text from public.statements where source_hash=repeat('c',64)),'0',
  'no statement was materialized for the tampered approve');
select is((select status::text from public.approval_tokens where token_id=(select (out->>'tokenId')::uuid from _tk)),
  'issued','tampered approve did NOT consume the token (redeem rolled back)');
select is((select status::text from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d101'),
  'extracted','tampered approve left the draft extracted (not approved)');

-- Happy path: the client submits the SAME body the token was issued over. The
-- statement is materialized, the draft flips approved, the token is consumed, and
-- a document_attachment links the source file.
select lives_ok($$select public.keel_cmd_statements_approve_draft(
  gen_random_uuid(),'gate:happy','{}'::jsonb,'00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('draftId',(select id from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d101'),
    'approvalTokenId',(select (out->>'tokenId')::uuid from _tk),'balanceCheck','strict',
    'statement',jsonb_build_object('period_start','2026-06-01','period_end','2026-06-30',
      'opening_minor','10000','ending_minor','12000','currency','USD',
      'lines',jsonb_build_array(jsonb_build_object('line_key','deposit','date','2026-06-15','amount_minor','2000','description','DEPOSIT')))))$$,
  'happy approve materializes the statement');
select is((select count(*)::text from public.statements where source_hash=repeat('c',64)),'1','exactly one statement materialized on happy approve');
select is((select status::text from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d101'),
  'approved','draft flips to approved');
select is((select status::text from public.approval_tokens where token_id=(select (out->>'tokenId')::uuid from _tk)),
  'redeemed','token consumed on happy approve');
select is((select count(*)::text from public.document_attachments where statement_id is not null),'1',
  'source document attached to the new statement');
select is((select source_hash from public.statements where source_hash=repeat('c',64)),repeat('c',64),
  'source_hash is the SERVER content_sha256 (bound from document_versions, not the payload)');

-- Replay: a second approve of the redeemed token -> P0007 (one-use). The draft is
-- already approved (terminal), so this also proves the terminal lock.
select throws_ok($$select public.keel_cmd_statements_approve_draft(
  gen_random_uuid(),'gate:replay','{}'::jsonb,'00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('draftId',(select id from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d101'),
    'approvalTokenId',(select (out->>'tokenId')::uuid from _tk),'balanceCheck','strict',
    'statement',jsonb_build_object('period_start','2026-06-01','period_end','2026-06-30',
      'opening_minor','10000','ending_minor','12000','currency','USD',
      'lines',jsonb_build_array(jsonb_build_object('line_key','deposit','date','2026-06-15','amount_minor','2000','description','DEPOSIT')))))$$,
  'P0007',null,'a second approve of an approved draft is an idempotency conflict (terminal + one-use token)');

-- Wrong-version + expired token at approve. Seed a fresh extracted draft on d102
-- (in-household, a401). Both tokens are issued over the correctly-constructed body
-- but with a proposal_version / TTL that the redeem rejects.
reset role;
set local role keel_api;
insert into public.statement_drafts(household_id,document_version_id,account_id,source_hash,status,extraction_id)
values('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d102',
       '00000000-0000-4000-8000-00000000a401',repeat('d',64),'extracted',null);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
create temp table _body2 as select
  jsonb_build_object('period_start','2026-06-01','period_end','2026-06-30','opening_minor','0','ending_minor','0','currency','USD','lines','[]'::jsonb)
  || jsonb_build_object('account_id','00000000-0000-4000-8000-00000000a401','source_hash',repeat('d',64),'balance_check','strict') as body;
-- proposal_version 2 (approve redeems with version 1) -> reject.
create temp table _tkv as select public.keel_approval_token_issue(
  '00000000-0000-4000-8000-00000000a001','{}'::jsonb,'statements.approve_draft',(select body from _body2),
  '{}'::jsonb,'00000000-0000-4000-8000-00000000a401','statement_draft',null,2,'statement-close-v1',900) as out;
select throws_ok($$select public.keel_cmd_statements_approve_draft(
  gen_random_uuid(),'gate:wrongver','{}'::jsonb,'00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('draftId',(select id from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d102'),
    'approvalTokenId',(select (out->>'tokenId')::uuid from _tkv),'balanceCheck','strict',
    'statement',jsonb_build_object('period_start','2026-06-01','period_end','2026-06-30','opening_minor','0','ending_minor','0','currency','USD','lines','[]'::jsonb)))$$,
  'P0009',null,'approve rejects a token with the wrong proposal_version');
-- Expired token (1s TTL, sleep past it) -> reject at approve.
create temp table _tke as select public.keel_approval_token_issue(
  '00000000-0000-4000-8000-00000000a001','{}'::jsonb,'statements.approve_draft',(select body from _body2),
  '{}'::jsonb,'00000000-0000-4000-8000-00000000a401','statement_draft',null,1,'statement-close-v1',1) as out;
reset role;
select pg_sleep(1.2);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.keel_cmd_statements_approve_draft(
  gen_random_uuid(),'gate:expired','{}'::jsonb,'00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('draftId',(select id from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d102'),
    'approvalTokenId',(select (out->>'tokenId')::uuid from _tke),'balanceCheck','strict',
    'statement',jsonb_build_object('period_start','2026-06-01','period_end','2026-06-30','opening_minor','0','ending_minor','0','currency','USD','lines','[]'::jsonb)))$$,
  'P0009',null,'approve rejects an expired token');
select is((select status::text from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d102'),
  'extracted','neither the wrong-version nor expired approve consumed the d102 draft');

reset role;

-- ===========================================================================
-- DRAFT terminal-lock + no-delete (direct table probes, bypassing the procs).
-- ===========================================================================
select throws_ok($$update public.statement_drafts set status='pending' where document_version_id='00000000-0000-4000-8000-00000000d101'$$,
  'P0001',null,'cannot transition OUT of approved');
select throws_ok($$delete from public.statement_drafts$$,'P0001',null,'statement drafts cannot be deleted (dismiss instead)');
-- Extractions/lines/holdings are immutable.
select throws_ok($$update public.statement_extractions set status='failed'$$,'P0001',null,'extractions are immutable');
select throws_ok($$delete from public.statement_extraction_lines$$,'P0001',null,'extraction lines cannot be deleted');

-- ===========================================================================
-- DISMISS is reversible-to-terminal + account-scoped. Dismiss the a402 draft as
-- user2 (owns a402). Then it is terminal.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok($$select public.keel_cmd_statements_dismiss_draft(
  gen_random_uuid(),'dismiss:1','{}'::jsonb,'00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('draftId',(select id from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d201')))$$,
  'dismiss flips an extracted draft to dismissed');
select is((select status::text from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d201'),
  'dismissed','draft is dismissed');
-- user1 (does NOT own a402) cannot dismiss it — but it's already terminal, so use
-- a fresh draft to prove account scope on dismiss.
reset role;
set local role keel_api;
insert into public.documents(id,household_id) values ('00000000-0000-4000-8000-00000000d003','00000000-0000-4000-8000-00000000a001');
insert into public.document_versions(id,document_id,content_sha256) values ('00000000-0000-4000-8000-00000000d301','00000000-0000-4000-8000-00000000d003',repeat('b',64));
insert into public.statement_drafts(household_id,document_version_id,account_id,source_hash,status)
values('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000d301','00000000-0000-4000-8000-00000000a402',repeat('b',64),'extracted');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.keel_cmd_statements_dismiss_draft(
  gen_random_uuid(),'dismiss:scope','{}'::jsonb,'00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('draftId',(select id from public.statement_drafts where document_version_id='00000000-0000-4000-8000-00000000d301')))$$,
  'P0006',null,'user1 cannot dismiss a draft on an account they cannot write (account scope)');
reset role;

select * from finish();
rollback;
