-- pgTAP: per-account entity resolution at link-finalize
-- (20260719040000_finalize_link_per_account_entity.sql).
--
-- The Supabase stack (pgmq, pg_cron, auth schema, PostgREST request settings)
-- is unavailable in the throwaway-postgres cluster used to validate this, so
-- this suite builds a MINIMAL real schema (entity_kind enum + entities /
-- connections / ledger_accounts / accounts tables with the columns the
-- resolver reads) and loads the ACTUAL keel_resolve_finalize_entity function
-- body verbatim from the migration (see scripts/run-finalize-entity-pgtap.sh,
-- which slices the CREATE ... $resolve$ ... $resolve$ block out of the real
-- migration file and prepends it here). That means these tests exercise the
-- exact resolution SQL that ships in keel_finalize_link, not a paraphrase.

begin;
select plan(6);

-- Minimal schema -----------------------------------------------------------
create schema if not exists public;
do $$ begin
  if not exists (select 1 from pg_type where typname = 'entity_kind') then
    create type public.entity_kind as enum
      ('personal', 'sole_prop', 'llc_single', 'llc_multi', 's_corp', 'trust', 'other');
  end if;
end $$;

create table public.entities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  name text not null,
  kind public.entity_kind not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  institution_id text,
  status text not null default 'active'
);
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  entity_id uuid not null,
  name text not null,
  is_category boolean not null default false
);
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  entity_id uuid not null,
  connection_id uuid,
  ledger_account_id uuid,
  name text not null,
  subtype text,
  mask text,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- __RESOLVER_BODY__  (replaced by the runner with the real function DDL)

-- Fixtures: one household mirroring the live Fidelity setup -----------------
-- Personal + exactly one business (llc_single) entity.
do $seed$
declare
  v_hh uuid := '11111111-1111-1111-1111-111111111111';
  v_personal uuid := '22222222-2222-2222-2222-222222222222';
  v_business uuid := '33333333-3333-3333-3333-333333333333';
  v_old_conn uuid := '44444444-4444-4444-4444-444444444444'; -- disconnected Fidelity
  v_new_conn uuid := '55555555-5555-5555-5555-555555555555'; -- freshly relinked Fidelity
  v_la uuid;
begin
  insert into public.entities(id, household_id, name, kind)
  values (v_personal, v_hh, 'Personal', 'personal'),
         (v_business, v_hh, 'Business (LLC)', 'llc_single');

  insert into public.connections(id, household_id, institution_id, status)
  values (v_old_conn, v_hh, null, 'disconnected'),
         (v_new_conn, v_hh, null, 'active');

  -- Existing (disconnected) Fidelity accounts the user already curated:
  -- Cash Management -> Personal, Limited Liability Company -> Business.
  insert into public.ledger_accounts(household_id, entity_id, name)
    values (v_hh, v_personal, 'Cash Management (Individual)') returning id into v_la;
  insert into public.accounts(household_id, entity_id, connection_id, ledger_account_id, name, subtype, mask)
    values (v_hh, v_personal, v_old_conn, v_la, 'Cash Management (Individual)', 'cash management', '6691');

  insert into public.ledger_accounts(household_id, entity_id, name)
    values (v_hh, v_business, 'Limited Liability Company') returning id into v_la;
  insert into public.accounts(household_id, entity_id, connection_id, ledger_account_id, name, subtype, mask)
    values (v_hh, v_business, v_old_conn, v_la, 'Limited Liability Company', 'brokerage', '6027');
end
$seed$;

-- Convenience: resolve with the household's real defaults.
create or replace function pg_temp.resolve(p_name text, p_subtype text, p_mask text)
returns text language sql as $$
  select r.o_reason || ':' || r.o_entity_id::text
    from public.keel_resolve_finalize_entity(
      '11111111-1111-1111-1111-111111111111'::uuid,          -- household
      '55555555-5555-5555-5555-555555555555'::uuid,          -- new connection
      null,                                                  -- institution_id (null, like live)
      p_name, p_subtype, p_mask,
      '22222222-2222-2222-2222-222222222222'::uuid,          -- default = Personal
      '33333333-3333-3333-3333-333333333333'::uuid           -- lone business = Business
    ) r;
$$;

-- (a) RECONNECT PRESERVATION: relinked "Limited Liability Company" (mask 6027)
--     inherits the Business entity it already had -- NOT the modal default.
select is(
  pg_temp.resolve('Limited Liability Company', 'brokerage', '6027'),
  'reconnect_inherited:33333333-3333-3333-3333-333333333333',
  'reconnected LLC brokerage inherits its existing Business entity by mask'
);

-- (b) RECONNECT PRESERVATION: relinked "Cash Management (Individual)" (mask
--     6691) inherits Personal, even though the modal default is also Personal
--     -- reason must be inheritance, proving the match fired.
select is(
  pg_temp.resolve('Cash Management (Individual)', 'cash management', '6691'),
  'reconnect_inherited:22222222-2222-2222-2222-222222222222',
  'reconnected cash-management account inherits its existing Personal entity by mask'
);

-- (c) NEW business-named account (no existing match): business-name heuristic
--     lands it in the lone business entity.
select is(
  pg_temp.resolve('Acme Ventures LLC', 'checking', '4242'),
  'business_name_heuristic:33333333-3333-3333-3333-333333333333',
  'new LLC-named account auto-assigns to the lone business entity'
);

-- (d) NEW generic account (no match, not business-y): defaults to Personal.
select is(
  pg_temp.resolve('Everyday Checking', 'checking', '4243'),
  'default_personal:22222222-2222-2222-2222-222222222222',
  'new generic account defaults to the Personal entity'
);

-- (e) "Limited Liability Company" as a brand-new name with NO existing match
--     (different mask, unmatched) still hits the heuristic -> Business.
select is(
  pg_temp.resolve('Limited Liability Company', 'brokerage', '9999'),
  'business_name_heuristic:33333333-3333-3333-3333-333333333333',
  'a fresh "Limited Liability Company" account (no match) hits the business heuristic'
);

-- (f) A "Business" plain-English name also triggers the heuristic.
select is(
  pg_temp.resolve('My Business Savings', 'savings', '7777'),
  'business_name_heuristic:33333333-3333-3333-3333-333333333333',
  'a "Business"-named account triggers the heuristic'
);

select * from finish();
rollback;
