-- pgTAP: keel_cmd_documents_attach links an ALREADY-UPLOADED document to a
-- target, with tenant isolation on BOTH the document and the target, is
-- idempotent (a live link is returned, never duplicated), and refuses a
-- soft-deleted document or a cross-tenant target.
--
-- Runner (scripts/run-documents-attach-pgtap.sh) initdbs a throwaway cluster,
-- builds the minimal schema the proc touches, defines minimal real-behavior
-- stubs for the shared command helpers (keel_payload_hash / assert_member_write
-- / actor_from_jwt / idempotency_check / finish_command), injects the REAL
-- attach proc body sliced from the migration at the marker below, then runs
-- this file. A tiny TAP shim stands in for pgTAP when the extension is absent.

begin;

create schema if not exists public;

create type public.document_kind as enum ('receipt', 'statement');
create type public.document_target_type as enum
  ('transaction', 'paycheck', 'reimbursement_claim', 'statement');
create type public.household_role as enum ('viewer', 'partner', 'owner');

create table public.households (id uuid primary key);
create table public.household_memberships (
  household_id uuid not null, user_id uuid not null,
  role public.household_role not null default 'partner',
  primary key (household_id, user_id));
create table public.entities (
  id uuid primary key, household_id uuid not null, unique (household_id, id));
create table public.canonical_transactions (
  id uuid primary key, household_id uuid not null, unique (household_id, id));
create table public.paychecks (
  id uuid primary key, household_id uuid not null, unique (household_id, id));
create table public.reimbursement_claims (
  id uuid, household_id uuid not null, primary key (household_id, id));
create table public.statements (
  id uuid primary key, household_id uuid not null, unique (household_id, id));

create table public.documents (
  id uuid primary key, household_id uuid not null, entity_id uuid not null,
  kind public.document_kind not null, original_filename text not null,
  created_by uuid not null, created_at timestamptz not null default now(),
  deleted_at timestamptz);
create table public.document_attachments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null, document_id uuid not null,
  canonical_transaction_id uuid, paycheck_id uuid,
  reimbursement_claim_id uuid, statement_id uuid,
  attached_by uuid not null, attached_at timestamptz not null default now(),
  detached_by uuid, detached_at timestamptz,
  check (
    (case when canonical_transaction_id is not null then 1 else 0 end
     + case when paycheck_id is not null then 1 else 0 end
     + case when reimbursement_claim_id is not null then 1 else 0 end
     + case when statement_id is not null then 1 else 0 end) = 1));

-- Minimal real-behavior stubs for the shared command helpers the proc calls.
-- Behavior faithful to the real ones for what this proc relies on.
create table public._idem (household_id uuid, key text, hash text, result jsonb,
  primary key (household_id, key));

create function public.keel_payload_hash(p jsonb) returns text
  language sql immutable as $$ select md5(p::text) $$;

create function public.keel_actor_from_jwt() returns jsonb
  language sql stable as $$
    select jsonb_build_object('kind','user','userId',
      current_setting('test.uid', true)) $$;

create function public.keel_assert_member_write(p_household_id uuid)
  returns public.household_role language plpgsql as $$
declare v public.household_role;
begin
  select role into v from public.household_memberships
   where household_id = p_household_id
     and user_id = current_setting('test.uid', true)::uuid;
  if v is null then
    raise exception 'KEEL_SCOPE_VIOLATION: not a member' using errcode = 'P0006';
  end if;
  return v;
end $$;

create function public.keel_idempotency_check(p_household_id uuid, p_key text, p_hash text)
  returns jsonb language plpgsql as $$
declare v jsonb;
begin
  select result into v from public._idem
   where household_id = p_household_id and key = p_key and hash = p_hash;
  return v; -- null on first sight
end $$;

create function public.keel_finish_command(
  p_command_id uuid, p_command text, p_key text, p_household_id uuid, p_actor jsonb,
  p_hash text, p_event text, p_object_type text, p_object_id uuid,
  p_after jsonb, p_result jsonb) returns void language plpgsql as $$
begin
  insert into public._idem (household_id, key, hash, result)
  values (p_household_id, p_key, p_hash, p_result)
  on conflict (household_id, key) do nothing;
end $$;

-- __MIGRATION_ATTACH_PROC__  (replaced by the runner with the REAL proc body)

-- ---------------------------------------------------------------------------
-- Fixtures: two tenants (A owns everything; B is the intruder).
-- ---------------------------------------------------------------------------
insert into public.households (id) values
  ('aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000001');
insert into public.household_memberships (household_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','partner'),
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','partner');
insert into public.entities (id, household_id) values
  ('e1111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001');
insert into public.canonical_transactions (id, household_id) values
  ('c1111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001'),
  ('cb222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000001');
insert into public.documents (id, household_id, entity_id, kind, original_filename, created_by) values
  ('d1111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
   'e1111111-1111-1111-1111-111111111111','receipt','r.pdf','11111111-1111-1111-1111-111111111111'),
  ('dd222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001',
   'e1111111-1111-1111-1111-111111111111','receipt','gone.pdf','11111111-1111-1111-1111-111111111111');
-- One soft-deleted document (must be un-attachable).
update public.documents set deleted_at = now()
  where id = 'dd222222-2222-2222-2222-222222222222';

select plan(7);

-- Actor = household A member.
set local test.uid = '11111111-1111-1111-1111-111111111111';

-- 1. Attach A's document to A's transaction → creates a live attachment.
select is(
  (select public.keel_cmd_documents_attach(
    '00000000-0000-0000-0000-0000000000a1', 'documents.attach:1', null,
    'aaaaaaaa-0000-0000-0000-000000000001',
    jsonb_build_object('documentId','d1111111-1111-1111-1111-111111111111',
      'targetType','transaction','targetId','c1111111-1111-1111-1111-111111111111')
  )->'effects'->>'alreadyAttached'),
  'false', 'first attach creates a new link');

select ok(
  (select count(*) = 1 from public.document_attachments
    where document_id = 'd1111111-1111-1111-1111-111111111111'
      and canonical_transaction_id = 'c1111111-1111-1111-1111-111111111111'
      and detached_at is null),
  'exactly one live attachment row exists');

-- 2. Idempotent: same document+target again returns the existing link, no dup.
select is(
  (select public.keel_cmd_documents_attach(
    '00000000-0000-0000-0000-0000000000a2', 'documents.attach:2', null,
    'aaaaaaaa-0000-0000-0000-000000000001',
    jsonb_build_object('documentId','d1111111-1111-1111-1111-111111111111',
      'targetType','transaction','targetId','c1111111-1111-1111-1111-111111111111')
  )->'effects'->>'alreadyAttached'),
  'true', 're-attaching a live link reports alreadyAttached');

select ok(
  (select count(*) = 1 from public.document_attachments
    where document_id = 'd1111111-1111-1111-1111-111111111111'
      and canonical_transaction_id = 'c1111111-1111-1111-1111-111111111111'
      and detached_at is null),
  'still exactly one live attachment (no duplicate)');

-- 3. A soft-deleted document cannot be attached.
select throws_ok($$
  select public.keel_cmd_documents_attach(
    '00000000-0000-0000-0000-0000000000a3', 'documents.attach:3', null,
    'aaaaaaaa-0000-0000-0000-000000000001',
    jsonb_build_object('documentId','dd222222-2222-2222-2222-222222222222',
      'targetType','transaction','targetId','c1111111-1111-1111-1111-111111111111'))
  $$, 'P0006', null, 'soft-deleted document is rejected (P0006)');

-- 4. Cross-tenant target: A's document onto B's transaction is refused.
select throws_ok($$
  select public.keel_cmd_documents_attach(
    '00000000-0000-0000-0000-0000000000a4', 'documents.attach:4', null,
    'aaaaaaaa-0000-0000-0000-000000000001',
    jsonb_build_object('documentId','d1111111-1111-1111-1111-111111111111',
      'targetType','transaction','targetId','cb222222-2222-2222-2222-222222222222'))
  $$, 'P0006', null, 'target in another household is rejected (P0006)');

-- 5. Non-member actor cannot attach in household A.
set local test.uid = '22222222-2222-2222-2222-222222222222';
select throws_ok($$
  select public.keel_cmd_documents_attach(
    '00000000-0000-0000-0000-0000000000a5', 'documents.attach:5', null,
    'aaaaaaaa-0000-0000-0000-000000000001',
    jsonb_build_object('documentId','d1111111-1111-1111-1111-111111111111',
      'targetType','transaction','targetId','c1111111-1111-1111-1111-111111111111'))
  $$, 'P0006', null, 'non-member actor is rejected (P0006)');

select * from finish();
rollback;
