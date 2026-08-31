-- pgTAP: business expense attribution, layer 1
-- (20260831120000_business_entity_tag.sql).
--
-- The Supabase stack (pgmq, pg_cron, the real auth schema, PostgREST request
-- settings) is unavailable in the throwaway-postgres cluster used to validate
-- this, so this suite builds a MINIMAL real schema carrying the columns and
-- constraints the migration actually touches, loads the REAL
-- keel_assert_member_write body sliced out of 20260710210600_command_procs.sql,
-- and then loads the ENTIRE migration file verbatim. Nothing here is a
-- paraphrase of the shipped SQL: the runner
-- (scripts/run-business-entity-tag-pgtap.sh) concatenates the real files.
--
-- auth.uid() is stubbed with its real Supabase semantics (read the JWT sub
-- claim out of the request GUC), because two of the functions the migration
-- recreates (keel_tag_assign, keel_tag_delete) call it.

begin;
select plan(48);

-- ---------------------------------------------------------------------------
-- Minimal schema
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create table auth.users (id uuid primary key);

-- Supabase's auth.uid(): the caller id from the request JWT claims.
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

create type public.household_role as enum ('owner', 'partner', 'viewer', 'professional');
create type public.entity_kind as enum
  ('personal', 'sole_prop', 'llc_single', 'llc_multi', 's_corp', 'trust', 'other');
create type public.transaction_status as enum ('pending', 'posted', 'reviewed', 'voided');
create type public.transaction_source as enum ('sync', 'manual', 'import', 'split_child', 'system');

create table public.households (
  id uuid primary key,
  name text not null check (length(name) between 1 and 200)
);
create table public.household_memberships (
  household_id uuid not null references public.households (id),
  user_id uuid not null references auth.users (id),
  role public.household_role not null,
  primary key (household_id, user_id)
);
create table public.entities (
  id uuid primary key,
  household_id uuid not null references public.households (id),
  name text not null check (length(name) between 1 and 200),
  kind public.entity_kind not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create table public.canonical_transactions (
  id uuid primary key,
  household_id uuid not null references public.households (id),
  entity_id uuid not null references public.entities (id),
  status public.transaction_status not null,
  source public.transaction_source not null,
  description text not null,
  effective_date date not null,
  voided_at timestamptz
);
create table public.audit_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households (id),
  actor jsonb not null,
  action text not null,
  object_type text not null,
  object_id uuid,
  command_id uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);

-- tags / transaction_tags exactly as 20260713120000 ships them (pre-migration:
-- no entity_id column — the migration under test adds it).
create table public.tags (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  name         text not null check (char_length(name) between 1 and 40),
  created_at   timestamptz not null default now()
);
create unique index tags_household_name_ci on public.tags (household_id, lower(name));
create table public.transaction_tags (
  canonical_transaction_id uuid not null references public.canonical_transactions (id),
  tag_id                   uuid not null references public.tags (id) on delete cascade,
  household_id             uuid not null references public.households (id),
  created_at               timestamptz not null default now(),
  primary key (canonical_transaction_id, tag_id)
);

-- __MEMBER_WRITE_BODY__  (replaced by the runner with the real function DDL)

-- __MIGRATION_BODY__  (replaced by the runner with the real migration file)

-- ---------------------------------------------------------------------------
-- Assertion helpers. Every error case is asserted through _try so the suite
-- needs only plan/is/finish and therefore runs identically against the real
-- pgTAP extension or the runner's TAP shim.
-- ---------------------------------------------------------------------------
create function public._try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;

create function public._try_msg(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

-- A volatile function's writes are invisible to the snapshot of the statement
-- that called it, so every "bind, then assert what was bound" pair below runs
-- as two statements with the returned id parked here in between.
create temp table _ids (k text primary key, v uuid);

create function public._act(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures. Household alpha has an owner and a viewer, a personal entity and
-- two businesses. Household beta exists only to prove tenant isolation.
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),  -- owner, household alpha
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),  -- viewer, household alpha
  ('cccccccc-cccc-cccc-cccc-cccccccccccc');  -- owner, household beta

insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Alpha'),
  ('22222222-2222-2222-2222-222222222222', 'Beta');

insert into public.household_memberships (household_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'viewer'),
  ('22222222-2222-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'owner');

insert into public.entities (id, household_id, name, kind) values
  ('e1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Household', 'personal'),
  ('e2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Acme LLC', 'llc_single'),
  ('e3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Beta Studio', 'sole_prop'),
  ('e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'Closed Co', 'llc_single'),
  ('e5555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 'Foreign LLC', 'llc_single');
update public.entities set archived_at = now()
  where id = 'e4444444-4444-4444-4444-444444444444';

insert into public.canonical_transactions
  (id, household_id, entity_id, status, source, description, effective_date, voided_at) values
  ('11111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'e1111111-1111-1111-1111-111111111111', 'posted', 'sync', 'Laptop stand', '2026-08-01', null),
  ('11111111-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'e1111111-1111-1111-1111-111111111111', 'posted', 'sync', 'Client lunch', '2026-08-02', null),
  ('11111111-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'e1111111-1111-1111-1111-111111111111', 'posted', 'sync', 'Voided row', '2026-08-03', now()),
  ('22222222-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'e5555555-5555-5555-5555-555555555555', 'posted', 'sync', 'Foreign txn', '2026-08-01', null);

-- Two entities whose names collide once truncated to tags' 40-char limit, and
-- one whose name is whitespace only (reachable through seeds/imports, since
-- entities' own check only requires 1..200 characters).
insert into public.entities (id, household_id, name, kind) values
  ('e6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111',
   'Northwest Consulting Group of Greater Seattle LLC', 'llc_single'),
  ('e7777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
   'Northwest Consulting Group of Greater Seattle Inc', 'llc_single'),
  ('e8888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111',
   '   ', 'llc_single'),
  ('e9999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
   'Gamma Works', 'sole_prop');

select public._act('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ---------------------------------------------------------------------------
-- A. Binding a business tag to an entity
-- ---------------------------------------------------------------------------
insert into _ids (k, v) values ('acme1', public.keel_entity_business_tag_ensure(
  '11111111-1111-1111-1111-111111111111', 'e2222222-2222-2222-2222-222222222222'));

select is(
  (select t.name from public.tags t join _ids i on i.v = t.id where i.k = 'acme1'),
  'Acme LLC',
  'A1 ensure creates a business tag named after the entity'
);

insert into _ids (k, v) values ('acme2', public.keel_entity_business_tag_ensure(
  '11111111-1111-1111-1111-111111111111', 'e2222222-2222-2222-2222-222222222222'));

select is(
  ((select v from _ids where k = 'acme1') = (select v from _ids where k = 'acme2'))::text,
  'true',
  'A2 ensure is idempotent: a second call returns the same tag, not a duplicate'
);

select is(
  (select count(*)::text from public.tags
    where household_id = '11111111-1111-1111-1111-111111111111'),
  '1',
  'A3 ensure created exactly one tag across both calls'
);

select is(
  public._try($$select public.keel_entity_business_tag_ensure(
    '11111111-1111-1111-1111-111111111111', 'e1111111-1111-1111-1111-111111111111')$$),
  'P0009',
  'A4 a personal entity is refused a business tag'
);

select is(
  public._try($$select public.keel_entity_business_tag_ensure(
    '11111111-1111-1111-1111-111111111111', 'e4444444-4444-4444-4444-444444444444')$$),
  'P0006',
  'A5 an archived entity is not found'
);

select is(
  public._try($$select public.keel_entity_business_tag_ensure(
    '11111111-1111-1111-1111-111111111111', 'e5555555-5555-5555-5555-555555555555')$$),
  'P0006',
  'A6 an entity in another household is not found (no cross-tenant binding)'
);

-- Adoption: a hand-rolled tag with the business's name is bound, not duplicated.
insert into public.tags (household_id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Beta Studio');

insert into _ids (k, v) values ('beta', public.keel_entity_business_tag_ensure(
  '11111111-1111-1111-1111-111111111111', 'e3333333-3333-3333-3333-333333333333'));

select is(
  (select (t.entity_id = 'e3333333-3333-3333-3333-333333333333')::text
     from public.tags t join _ids i on i.v = t.id where i.k = 'beta'),
  'true',
  'A7 an existing unbound tag with the entity name is adopted, not duplicated'
);

select is(
  (select count(*)::text from public.tags
    where household_id = '11111111-1111-1111-1111-111111111111'),
  '2',
  'A8 adoption did not create a second "Beta Studio" tag'
);

-- The partial unique index makes "the business tag" singular.
select is(
  public._try($$insert into public.tags (household_id, name, entity_id)
    values ('11111111-1111-1111-1111-111111111111', 'Acme LLC 2',
            'e2222222-2222-2222-2222-222222222222')$$),
  '23505',
  'A9 a second business tag for the same entity violates the partial unique index'
);

-- ---------------------------------------------------------------------------
-- B. Marking a transaction as business
-- ---------------------------------------------------------------------------
select is(
  (public.keel_transaction_set_business(
     '11111111-1111-1111-1111-111111111111',
     '11111111-0000-0000-0000-000000000001',
     'e2222222-2222-2222-2222-222222222222')
   = (select id from public.tags where entity_id = 'e2222222-2222-2222-2222-222222222222'))::text,
  'true',
  'B1 set_business returns the entity''s business tag id'
);

select is(
  (select count(*)::text from public.transaction_tags
    where canonical_transaction_id = '11111111-0000-0000-0000-000000000001'),
  '1',
  'B2 the business tag is attached to the transaction'
);

select is(
  (select count(*)::text from public.audit_log
    where action = 'transaction.set_business'
      and object_id = '11111111-0000-0000-0000-000000000001'),
  '1',
  'B3 the attribution is audited (Law 2)'
);

-- Idempotent replay: same business again changes nothing and audits nothing.
do $$ begin perform public.keel_transaction_set_business(
  '11111111-1111-1111-1111-111111111111',
  '11111111-0000-0000-0000-000000000001',
  'e2222222-2222-2222-2222-222222222222'); end $$;

select is(
  (select count(*)::text from public.audit_log
    where action = 'transaction.set_business'
      and object_id = '11111111-0000-0000-0000-000000000001'),
  '1',
  'B4 re-setting the same business is a no-op and writes no second audit row'
);

-- Switching business replaces rather than accumulating.
do $$ begin perform public.keel_transaction_set_business(
  '11111111-1111-1111-1111-111111111111',
  '11111111-0000-0000-0000-000000000001',
  'e3333333-3333-3333-3333-333333333333'); end $$;

select is(
  (select string_agg(t.name, ',' order by t.name)
     from public.transaction_tags tt join public.tags t on t.id = tt.tag_id
    where tt.canonical_transaction_id = '11111111-0000-0000-0000-000000000001'),
  'Beta Studio',
  'B5 switching business replaces the previous business tag, never accumulates'
);

select is(
  (select before->'entityIds'->>0 from public.audit_log
    where action = 'transaction.set_business'
      and object_id = '11111111-0000-0000-0000-000000000001'
    order by id desc limit 1),
  'e2222222-2222-2222-2222-222222222222',
  'B6 the switch audits the previous business as its before-image'
);

-- Clearing.
select is(
  coalesce(public.keel_transaction_set_business(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000001',
    null)::text, 'null'),
  'null',
  'B7 clearing returns null'
);

select is(
  (select count(*)::text from public.transaction_tags
    where canonical_transaction_id = '11111111-0000-0000-0000-000000000001'),
  '0',
  'B8 clearing removes the business tag'
);

select is(
  (select count(*)::text from public.audit_log
    where action = 'transaction.clear_business'
      and object_id = '11111111-0000-0000-0000-000000000001'),
  '1',
  'B9 clearing is audited'
);

select is(
  public._try($$select public.keel_transaction_set_business(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000001', null)$$),
  'ok',
  'B10 clearing an already-clear transaction succeeds silently'
);

select is(
  (select count(*)::text from public.audit_log
    where action = 'transaction.clear_business'
      and object_id = '11111111-0000-0000-0000-000000000001'),
  '1',
  'B11 the redundant clear wrote no second audit row'
);

select is(
  public._try($$select public.keel_transaction_set_business(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000003',
    'e2222222-2222-2222-2222-222222222222')$$),
  'P0006',
  'B12 a voided transaction cannot be attributed'
);

select is(
  public._try($$select public.keel_transaction_set_business(
    '11111111-1111-1111-1111-111111111111',
    '22222222-0000-0000-0000-000000000001',
    'e2222222-2222-2222-2222-222222222222')$$),
  'P0006',
  'B13 another household''s transaction is not found (tenant isolation)'
);

-- ---------------------------------------------------------------------------
-- C. Authorization
-- ---------------------------------------------------------------------------
select public._act('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
select is(
  public._try($$select public.keel_transaction_set_business(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000002',
    'e2222222-2222-2222-2222-222222222222')$$),
  'P0005',
  'C1 a viewer may not attribute a transaction to a business (read-only role)'
);

select public._act('cccccccc-cccc-cccc-cccc-cccccccccccc');
select is(
  public._try($$select public.keel_transaction_set_business(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000002',
    'e2222222-2222-2222-2222-222222222222')$$),
  'P0006',
  'C2 a non-member of the household is a scope violation'
);

select public._act('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ---------------------------------------------------------------------------
-- D. The ambiguity guard on the generic tag picker
-- ---------------------------------------------------------------------------
do $$ begin perform public.keel_transaction_set_business(
  '11111111-1111-1111-1111-111111111111',
  '11111111-0000-0000-0000-000000000002',
  'e2222222-2222-2222-2222-222222222222'); end $$;

select is(
  public._try(format($$select public.keel_tag_assign(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000002', %L, true)$$,
    (select id from public.tags where entity_id = 'e3333333-3333-3333-3333-333333333333'))),
  'P0009',
  'D1 assigning a SECOND business tag through the tag picker is refused'
);

select is(
  (select count(*)::text
     from public.transaction_tags tt join public.tags t on t.id = tt.tag_id
    where tt.canonical_transaction_id = '11111111-0000-0000-0000-000000000002'
      and t.entity_id is not null),
  '1',
  'D2 the refused assignment left the original attribution intact'
);

select is(
  public._try(format($$select public.keel_tag_assign(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000002', %L, true)$$,
    (select id from public.tags where entity_id = 'e2222222-2222-2222-2222-222222222222'))),
  'ok',
  'D3 re-assigning the SAME business tag is still idempotent, not ambiguous'
);

insert into public.tags (household_id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Reimbursable'),
         ('11111111-1111-1111-1111-111111111111', 'Reimbursable-2');
select is(
  public._try(format($$select public.keel_tag_assign(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000002', %L, true)$$,
    (select id from public.tags where name = 'Reimbursable'))),
  'ok',
  'D4 an ordinary tag still applies alongside a business tag'
);

-- ---------------------------------------------------------------------------
-- E. The delete guard
-- ---------------------------------------------------------------------------
select is(
  public._try(format($$select public.keel_tag_delete(
    '11111111-1111-1111-1111-111111111111', %L)$$,
    (select id from public.tags where entity_id = 'e2222222-2222-2222-2222-222222222222'))),
  'P0009',
  'E1 a business tag cannot be deleted (it would un-attribute the business)'
);

select is(
  public._try(format($$select public.keel_tag_delete(
    '11111111-1111-1111-1111-111111111111', %L)$$,
    (select id from public.tags where name = 'Reimbursable'))),
  'ok',
  'E2 an ordinary tag still deletes'
);

-- ---------------------------------------------------------------------------
-- G. Adoption must not manufacture the ambiguity the design refuses
--    (review finding H2). Adopting a hand-rolled tag retro-attributes every
--    transaction already carrying it, in bulk, with no per-transaction audit.
-- ---------------------------------------------------------------------------
insert into public.tags (household_id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Gamma Works');
insert into public.transaction_tags (canonical_transaction_id, tag_id, household_id)
  select '11111111-0000-0000-0000-000000000002',
         t.id,
         '11111111-1111-1111-1111-111111111111'
    from public.tags t
   where t.household_id = '11111111-1111-1111-1111-111111111111'
     and t.name = 'Gamma Works';

select is(
  public._try($$select public.keel_entity_business_tag_ensure(
    '11111111-1111-1111-1111-111111111111', 'e9999999-9999-9999-9999-999999999999')$$),
  'P0009',
  'G1 adopting a tag that sits on a transaction already owned by another business is refused'
);

select is(
  (select count(*)::text
     from public.transaction_tags tt join public.tags t on t.id = tt.tag_id
    where tt.canonical_transaction_id = '11111111-0000-0000-0000-000000000002'
      and t.entity_id is not null),
  '1',
  'G2 the refused adoption left the transaction with exactly one business'
);

select is(
  (select coalesce(entity_id::text, 'null') from public.tags
    where household_id = '11111111-1111-1111-1111-111111111111' and name = 'Gamma Works'),
  'null',
  'G3 the refused adoption did not bind the tag'
);

-- Adoption IS allowed when the tag sits only on unattributed transactions.
insert into public.transaction_tags (canonical_transaction_id, tag_id, household_id)
  select '11111111-0000-0000-0000-000000000001',
         t.id,
         '11111111-1111-1111-1111-111111111111'
    from public.tags t
   where t.household_id = '11111111-1111-1111-1111-111111111111'
     and t.name = 'Reimbursable-2';
select is(
  public._try($$select public.keel_entity_business_tag_ensure(
    '11111111-1111-1111-1111-111111111111', 'e9999999-9999-9999-9999-999999999999')$$),
  'P0009',
  'G4 still refused while the clashing transaction stands (guard is on the tag, not the caller)'
);

-- ---------------------------------------------------------------------------
-- H. Truncation and degenerate names (review findings L1, L2, L3)
-- ---------------------------------------------------------------------------
insert into _ids (k, v) values ('nw1', public.keel_entity_business_tag_ensure(
  '11111111-1111-1111-1111-111111111111', 'e6666666-6666-6666-6666-666666666666'));

select is(
  (select length(t.name)::text from public.tags t join _ids i on i.v = t.id where i.k = 'nw1'),
  '40',
  'H1 a long entity name is truncated to the 40-char tag limit'
);

select is(
  (select (t.name = btrim(t.name))::text
     from public.tags t join _ids i on i.v = t.id where i.k = 'nw1'),
  'true',
  'H2 truncation never leaves a trailing space'
);

select is(
  public._try($$select public.keel_entity_business_tag_ensure(
    '11111111-1111-1111-1111-111111111111', 'e7777777-7777-7777-7777-777777777777')$$),
  'P0009',
  'H3 a second entity truncating to the same 40 chars is refused, not silently merged'
);

select is(
  public._try($$select public.keel_entity_business_tag_ensure(
    '11111111-1111-1111-1111-111111111111', 'e8888888-8888-8888-8888-888888888888')$$),
  'P0009',
  'H4 a whitespace-only entity name raises a KEEL error, not a raw check violation'
);

-- ---------------------------------------------------------------------------
-- I. A voided transaction is on nobody's books, through EITHER door
--    (review finding M4)
-- ---------------------------------------------------------------------------
select is(
  public._try(format($$select public.keel_tag_assign(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000003', %L, true)$$,
    (select id from public.tags where entity_id = 'e2222222-2222-2222-2222-222222222222'))),
  'P0009',
  'I1 the tag picker cannot attribute a VOIDED transaction to a business either'
);

select is(
  public._try(format($$select public.keel_tag_assign(
    '11111111-1111-1111-1111-111111111111',
    '11111111-0000-0000-0000-000000000003', %L, true)$$,
    (select id from public.tags where name = 'Reimbursable-2'))),
  'ok',
  'I2 an ORDINARY tag still applies to a voided row (no drift from 20260713120000)'
);

-- ---------------------------------------------------------------------------
-- J. The bind is undoable (review finding M3)
-- ---------------------------------------------------------------------------
select is(
  (public.keel_entity_business_tag_unbind(
     '11111111-1111-1111-1111-111111111111', 'e6666666-6666-6666-6666-666666666666')
   = (select v from _ids where k = 'nw1'))::text,
  'true',
  'J1 unbind returns the tag it released'
);

select is(
  (select coalesce(t.entity_id::text, 'null')
     from public.tags t join _ids i on i.v = t.id where i.k = 'nw1'),
  'null',
  'J2 the tag is no longer a business tag'
);

select is(
  (select before->>'assignments' from public.audit_log
    where action = 'tags.unbind_entity' order by id desc limit 1),
  '0',
  'J3 unbind audits how many assignments it released'
);

select is(
  coalesce(public.keel_entity_business_tag_unbind(
    '11111111-1111-1111-1111-111111111111', 'e6666666-6666-6666-6666-666666666666')::text, 'null'),
  'null',
  'J4 unbinding an already-unbound entity is idempotent'
);

select is(
  public._try(format($$select public.keel_tag_delete(
    '11111111-1111-1111-1111-111111111111', %L)$$, (select v from _ids where k = 'nw1'))),
  'ok',
  'J5 once unbound, the tag deletes like any other (the guard has a way out)'
);

-- ---------------------------------------------------------------------------
-- K. The clear before-image is complete (review finding M2)
-- ---------------------------------------------------------------------------
select is(
  (select after->>'entityId' is not null
     from public.audit_log where action = 'tags.bind_entity' order by id desc limit 1)::text,
  'true',
  'K1 bind records the entity it bound'
);

select is(
  (select before from public.audit_log
    where action = 'transaction.clear_business'
      and object_id = '11111111-0000-0000-0000-000000000001'
    order by id desc limit 1)->>'entityIds',
  '["e3333333-3333-3333-3333-333333333333"]',
  'K2 clearing records EVERY attribution it removed, as a list, not just the first'
);

-- ---------------------------------------------------------------------------
-- F. The read model
-- ---------------------------------------------------------------------------
select is(
  (select x->>'entityId'
     from jsonb_array_elements(
       public.keel_list_tags('11111111-1111-1111-1111-111111111111')) x
    where x->>'name' = 'Acme LLC'),
  'e2222222-2222-2222-2222-222222222222',
  'F1 tags.list carries entityId so the client can derive business attribution'
);

select * from finish();
rollback;
