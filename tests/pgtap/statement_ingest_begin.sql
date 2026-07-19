-- pgTAP: atomic statement ingest-begin (SLICE 6, statement-ingestion-v2.md
-- §3 [A3], §4 [A4], §8/§12 [A12]; CLAUDE.md Laws 5/7/9/12).
--
-- Runs in a throwaway-postgres cluster (no Supabase stack). Builds a MINIMAL real
-- schema and the runner injects the ACTUAL shared helpers + the ACTUAL Slice-3
-- (20260720180000 extraction/drafts/document_hashes) + Slice-5 outbox
-- (20260720210000) + Slice-6 ingest-begin (20260720220000) migrations, so the
-- proc under test is the exact SQL that ships (scripts/run-statement-ingest-begin-pgtap.sh).
--
-- Properties under test:
--   * fresh ingest → creates document + version + document_hash + draft +
--     OUTBOX row, ATOMICALLY (both draft and outbox exist) [A12];
--   * source_hash on the draft is the SERVER content_sha256, never client input
--     (the proc has no source_hash parameter at all) [A4];
--   * re-upload of the SAME content in the SAME household → duplicate:true, the
--     prior draft is returned, and NO second draft / NO second outbox row [A4];
--   * a different account cannot ingest a file the actor cannot write [A10];
--   * replay of the SAME (document_id + content) → returns the existing draft,
--     no duplicate row (idempotent, Law 9);
--   * a second household uploading the same bytes is NOT deduped against the
--     first (tenant-scoped identity) [A4].

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
  if not exists (select 1 from pg_type where typname = 'document_kind') then
    create type public.document_kind as enum ('receipt','statement');
  end if;
end $$;

create table auth.users (id uuid primary key);
create table public.households (id uuid primary key);
create table public.entities (id uuid primary key, household_id uuid not null);
create table public.household_memberships (
  household_id uuid not null, user_id uuid not null, role public.household_role not null
);
create table public.ledger_accounts (id uuid primary key, household_id uuid not null);
create table public.accounts (
  id uuid not null, household_id uuid not null, ledger_account_id uuid,
  name text not null default 'acct', subtype text, currency char(3) not null default 'USD',
  entity_id uuid,
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
  primary key (household_id, id)
);
-- documents/document_versions carrying the REAL columns the ingest proc writes.
create table public.documents (
  id uuid primary key, household_id uuid not null, entity_id uuid,
  kind public.document_kind not null default 'statement',
  original_filename text not null default 'stmt.pdf',
  created_by uuid, created_at timestamptz not null default now()
);
create table public.document_versions (
  id uuid primary key default gen_random_uuid(), document_id uuid not null,
  storage_bucket text not null default 'statements',
  storage_path text not null default 'p',
  content_sha256 text not null,
  mime_type text not null default 'application/pdf',
  byte_size bigint not null default 1,
  created_at timestamptz not null default now(),
  unique (document_id, content_sha256)
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
-- Reconciliation family — present only so the anchor migration's close proc
-- compiles under check_function_bodies (not exercised here).
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
create table public.statement_lines (
  household_id uuid not null, id uuid not null default gen_random_uuid(),
  statement_id uuid not null, line_key text not null, line_date date not null,
  amount_minor bigint not null, description text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id)
);
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

-- pgmq shim: keel_enqueue is called by the outbox sweeper; stub it inert so the
-- Slice-5 migration compiles. The ingest proc itself does NOT enqueue (that is
-- the edge function's best-effort step); it only writes the outbox row.
create function public.keel_enqueue(queue_name text, message jsonb) returns bigint
  language sql as $$ select 0::bigint $$;

-- Stub keel_export_household so the migrations' rename-chains succeed.
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
  returns jsonb language sql stable as $$ select jsonb_build_object('tables', jsonb_build_object('statements','[]'::jsonb)) $$;

-- __SHARED_HELPERS__  (runner injects keel_idempotency_check, keel_payload_hash,
--   keel_finish_command, keel_recurring_account_access, keel_forbid_mutation,
--   keel_statement_access)

-- __SLICE0_BODY__      (runner injects the real 20260720100000_approval_tokens.sql)

-- __MIGRATION1_BODY__  (runner injects the real 20260720180000_statement_extraction.sql)

-- __MIGRATION2_BODY__  (runner injects the real 20260720190000_statement_anchor_mode.sql)

-- __MIGRATION5_BODY__  (runner injects the real 20260720210000_statement_outbox.sql)

-- __MIGRATION6_BODY__  (runner injects the real 20260720220000_statement_ingest_begin.sql)

-- Re-grant + read policies for the direct verification probes (in production
-- these tables are read only through SECURITY DEFINER procs).
grant select on public.statement_drafts, public.statement_outbox, public.document_hashes,
  public.document_versions, public.documents to authenticated;
create policy _t_drafts on public.statement_drafts for select to authenticated using (true);
create policy _t_outbox on public.statement_outbox for select to authenticated using (true);
create policy _t_hashes on public.document_hashes for select to authenticated using (true);
grant execute on function public.keel_statement_ingest_begin(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, uuid
) to authenticated;

-- Fixtures ------------------------------------------------------------------
insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.households(id) values
  ('00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000a099');
insert into public.entities(id,household_id) values
  ('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-0000000000e9','00000000-0000-4000-8000-00000000a099');
insert into public.household_memberships(household_id,user_id,role) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000001','owner'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000002','partner'),
  ('00000000-0000-4000-8000-00000000a099','00000000-0000-4000-8000-000000000001','owner');
insert into public.ledger_accounts(id,household_id) values
  ('00000000-0000-4000-8000-00000000b401','00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b402','00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b409','00000000-0000-4000-8000-00000000a099');
-- a401 checking (user1 owns), a402 checking (user2 owns), a409 in the OTHER hh.
insert into public.accounts(id,household_id,ledger_account_id,name,subtype,currency,entity_id) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000b401','Checking','checking','USD','00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000b402','Other','checking','USD','00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-00000000a409','00000000-0000-4000-8000-00000000a099','00000000-0000-4000-8000-00000000b409','Elsewhere','checking','USD','00000000-0000-4000-8000-0000000000e9');
insert into public.account_owners(account_id,user_id) values
  ('00000000-0000-4000-8000-00000000a401','00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000a402','00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-00000000a409','00000000-0000-4000-8000-000000000001');

-- Structural assertions ------------------------------------------------------
select has_function('public','keel_statement_ingest_begin',
  array['uuid','uuid','uuid','uuid','text','text','text','text','bigint','text','uuid'],
  'keel_statement_ingest_begin exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
     where p.oid='public.keel_statement_ingest_begin(uuid,uuid,uuid,uuid,text,text,text,text,bigint,text,uuid)'::regprocedure),
  'keel_api','ingest_begin owned by keel_api');

-- ===========================================================================
-- 1. Fresh ingest → draft + outbox created atomically; source_hash server-bound.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := public.keel_statement_ingest_begin(
    '00000000-0000-4000-8000-00000000a001',            -- household
    '00000000-0000-4000-8000-0000000000e1',            -- entity
    '00000000-0000-4000-8000-00000000d001',            -- document_id
    '00000000-0000-4000-8000-00000000a401',            -- account (user1 owns)
    'statements', '00000000-0000-4000-8000-00000000a001/00000000-0000-4000-8000-00000000d001/x',
    repeat('a',64), 'application/pdf', 4096, 'jan.pdf',
    '00000000-0000-4000-8000-000000000001'             -- created_by (owner)
  );
  create temporary table _r1 on commit drop as select v as j;
end $$;

select is((select (j->>'duplicate')::boolean::text from _r1), 'false', 'fresh ingest is not a duplicate');
select ok((select j->>'draftId' from _r1) is not null, 'fresh ingest returns a draftId');
select is(
  (select count(*)::text from public.statement_drafts
     where household_id='00000000-0000-4000-8000-00000000a001'
       and account_id='00000000-0000-4000-8000-00000000a401'),
  '1', 'exactly one draft row exists');
select is(
  (select source_hash from public.statement_drafts
     where household_id='00000000-0000-4000-8000-00000000a001'
       and account_id='00000000-0000-4000-8000-00000000a401'),
  repeat('a',64), 'draft.source_hash is the SERVER content_sha256 (proc has no source_hash param) [A4]');
select is(
  (select status::text from public.statement_drafts
     where household_id='00000000-0000-4000-8000-00000000a001'
       and account_id='00000000-0000-4000-8000-00000000a401'),
  'pending', 'fresh draft is pending');
-- ATOMIC: the outbox row exists for the SAME version as the draft [A12].
select is(
  (select count(*)::text
     from public.statement_outbox o
     join public.statement_drafts d on d.document_version_id = o.document_version_id
    where d.household_id='00000000-0000-4000-8000-00000000a001'
      and d.account_id='00000000-0000-4000-8000-00000000a401'),
  '1', 'a committed draft has a committed outbox row (atomic) [A12]');
select is(
  (select status::text from public.statement_outbox
     where household_id='00000000-0000-4000-8000-00000000a001'),
  'pending', 'outbox row is pending');
select is(
  (select count(*)::text from public.document_hashes
     where household_id='00000000-0000-4000-8000-00000000a001'
       and content_sha256=repeat('a',64)),
  '1', 'document_hash registered for the content');

-- ===========================================================================
-- 2. Re-upload of the SAME content (fresh document_id) → duplicate, no 2nd draft.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := public.keel_statement_ingest_begin(
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-0000000000e1',
    '00000000-0000-4000-8000-00000000d002',            -- DIFFERENT document_id
    '00000000-0000-4000-8000-00000000a401',
    'statements', '00000000-0000-4000-8000-00000000a001/00000000-0000-4000-8000-00000000d002/y',
    repeat('a',64),                                     -- SAME content
    'application/pdf', 4096, 'jan-again.pdf',
    '00000000-0000-4000-8000-000000000001'
  );
  create temporary table _r2 on commit drop as select v as j;
end $$;

select is((select (j->>'duplicate')::boolean::text from _r2), 'true', 're-upload of same content → duplicate:true [A4]');
select ok((select j->>'draftId' from _r2) is not null, 'duplicate returns the prior draftId');
select is((select j->>'draftId' from _r2), (select j->>'draftId' from _r1), 'duplicate returns the SAME prior draft');
select is(
  (select count(*)::text from public.statement_drafts
     where household_id='00000000-0000-4000-8000-00000000a001'
       and account_id='00000000-0000-4000-8000-00000000a401'),
  '1', 'still exactly one draft after re-upload (no second draft) [A4]');
select is(
  (select count(*)::text from public.statement_outbox
     where household_id='00000000-0000-4000-8000-00000000a001'),
  '1', 'still exactly one outbox row after re-upload');

-- ===========================================================================
-- 3. Replay of the SAME (document_id + content) → same draft, idempotent (Law 9).
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := public.keel_statement_ingest_begin(
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-0000000000e1',
    '00000000-0000-4000-8000-00000000d001',            -- SAME document_id as #1
    '00000000-0000-4000-8000-00000000a401',
    'statements', '00000000-0000-4000-8000-00000000a001/00000000-0000-4000-8000-00000000d001/x',
    repeat('a',64), 'application/pdf', 4096, 'jan.pdf',
    '00000000-0000-4000-8000-000000000001'
  );
  create temporary table _r3 on commit drop as select v as j;
end $$;
select is((select j->>'draftId' from _r3), (select j->>'draftId' from _r1), 'replay returns the same draft (idempotent, Law 9)');
select is(
  (select count(*)::text from public.statement_drafts
     where household_id='00000000-0000-4000-8000-00000000a001'),
  '1', 'replay creates no duplicate draft');

-- ===========================================================================
-- 4a. Account NOT in the named household → refused (cross-tenant) [A10].
--     a409 lives in household a099; the call names household a001.
-- 4b. Account in-household but the actor cannot write it → refused [A10].
--     user1 does NOT own a402 (user2 does) and holds no edit permission on it.
-- ===========================================================================
select throws_ok($$
  select public.keel_statement_ingest_begin(
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-0000000000e1',
    '00000000-0000-4000-8000-00000000d003',
    '00000000-0000-4000-8000-00000000a409',            -- account in the OTHER household
    'statements', '00000000-0000-4000-8000-00000000a001/00000000-0000-4000-8000-00000000d003/z',
    repeat('b',64), 'application/pdf', 100, 'x.pdf',
    '00000000-0000-4000-8000-000000000001'
  ) $$,
  'P0006', null, 'cross-household account is refused [A10]');

-- 4b: in-household account the actor cannot write (user1 does not own a402).
select throws_ok($$
  select public.keel_statement_ingest_begin(
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-0000000000e1',
    '00000000-0000-4000-8000-00000000d004',
    '00000000-0000-4000-8000-00000000a402',            -- user2 owns this, not user1
    'statements', '00000000-0000-4000-8000-00000000a001/00000000-0000-4000-8000-00000000d004/q',
    repeat('f',64), 'application/pdf', 100, 'x.pdf',
    '00000000-0000-4000-8000-000000000001'
  ) $$,
  'P0006', null, 'in-household account the actor cannot write is refused [A10]');

-- ===========================================================================
-- 5. Same bytes in a DIFFERENT household are NOT deduped (tenant-scoped) [A4].
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := public.keel_statement_ingest_begin(
    '00000000-0000-4000-8000-00000000a099',            -- OTHER household
    '00000000-0000-4000-8000-0000000000e9',
    '00000000-0000-4000-8000-00000000d009',
    '00000000-0000-4000-8000-00000000a409',            -- its own account, user1 owns
    'statements', '00000000-0000-4000-8000-00000000a099/00000000-0000-4000-8000-00000000d009/w',
    repeat('a',64),                                     -- SAME bytes as hh a001
    'application/pdf', 4096, 'jan.pdf',
    '00000000-0000-4000-8000-000000000001'
  );
  create temporary table _r5 on commit drop as select v as j;
end $$;
select is((select (j->>'duplicate')::boolean::text from _r5), 'false', 'same bytes in a different household is NOT a duplicate (tenant-scoped) [A4]');
select is(
  (select count(*)::text from public.statement_drafts
     where household_id='00000000-0000-4000-8000-00000000a099'),
  '1', 'the other household gets its own draft');

select finish();
rollback;
