-- pgTAP: budget-v4-plan reproduces budget-v3-split-aware-rollover EXACTLY across
-- MULTIPLE consecutive rollover months (Law 9 "reproducible numbers" invariant;
-- migration 20260720170000_budgeting_v2_plan.sql).
--
-- WHY THIS TEST EXISTS. The v4 backfill converts each historical monthly
-- `budgets` row into a standing `budget_targets` row. If those rows are left
-- OPEN-ENDED (end_month = NULL), consecutive months become OVERLAPPING live
-- targets, and:
--   (a) keel_budget_month's carry CTE expands each target over generate_series
--       from effective_month..current, so a 3-month rollover DOUBLE/TRIPLE-counts
--       the middle months -> v4 carry 60000 vs v3 carry 30000 (a >=2x inflation);
--   (b) the current-month live_targets predicate matches EVERY overlapping open
--       target, so the category is listed multiple times in `rows` and
--       leftToBudget over-subtracts.
-- The frozen unit test in packages/ledger only exercised a SINGLE month against
-- the pure resolver, so it passed spuriously. This SQL-level test spans >=2
-- consecutive rollover months + a current month and asserts carry/rows/
-- leftToBudget from keel_budget_month EXACTLY equal the pinned keel_list_budgets
-- (budget-v3) numbers. It FAILS before the backfill-contiguity fix and PASSES
-- after.
--
-- The Supabase local Docker stack is unavailable this session (same constraint
-- as networth_exclude_archived_accounts.sql), so this suite builds a MINIMAL
-- real schema with only the columns the two read models read, then loads the
-- ACTUAL shipped function bodies verbatim: the v3 read model at
-- __V3_READMODEL_BODY__ and the entire v4 migration (backfill + read model) at
-- __V4_MIGRATION_BODY__, both sliced in by the runner. These tests exercise the
-- exact SQL that ships, not a paraphrase.

begin;
select plan(6);

-- Roles referenced by the shipped grant/owner statements ---------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
grant keel_api to current_user;
grant keel_export to current_user;

create schema if not exists public;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ledger_account_kind') then
    create type public.ledger_account_kind as enum
      ('asset','liability','equity','income','expense');
  end if;
end $$;

-- Minimal schema (only the columns the read models read) ---------------------
create table public.households (id uuid primary key);
create table public.household_memberships (household_id uuid not null, user_id uuid not null);
create table public.ledger_accounts (
  id uuid primary key,
  household_id uuid not null,
  name text,
  kind public.ledger_account_kind not null,
  currency char(3) not null default 'USD',
  is_category boolean not null default false,
  parent_ledger_account_id uuid,
  archived_at timestamptz
);
create table public.budgets (
  household_id uuid not null,
  category_ledger_account_id uuid not null,
  month date not null,
  amount_minor bigint not null,
  currency char(3) not null default 'USD',
  rollover boolean not null default false,
  primary key (household_id, category_ledger_account_id, month)
);
create table public.canonical_transactions (
  id uuid primary key, household_id uuid not null, voided_at timestamptz
);
create table public.journal_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  canonical_transaction_id uuid,
  reverses_batch_id uuid,
  effective_date date not null
);
create table public.journal_postings (
  batch_id uuid not null, ledger_account_id uuid not null,
  amount_minor bigint not null, currency char(3) not null default 'USD'
);
create table public.journal_revisions (original_batch_id uuid);
create table public.transaction_categories (
  canonical_transaction_id uuid, category_ledger_account_id uuid
);
create table public.transfer_links (
  household_id uuid, status text, txn_out uuid, txn_in uuid
);

-- Envelope helpers the v4 commands call (not exercised here, but the migration
-- CREATE FUNCTIONs reference them at parse time only inside their own bodies —
-- keel_budget_month/backfill do not call them, so stubs suffice for load).
create or replace function public.keel_payload_hash(p jsonb) returns text
  language sql immutable as $$ select md5(coalesce(p::text,'')) $$;
create or replace function public.keel_assert_member_write(p uuid) returns void
  language plpgsql as $$ begin end $$;
create or replace function public.keel_actor_from_jwt() returns jsonb
  language sql stable as $$ select '{}'::jsonb $$;
create or replace function public.keel_idempotency_check(a uuid, b text, c text) returns jsonb
  language sql stable as $$ select null::jsonb $$;
create or replace function public.keel_finish_command(
  a uuid, b text, c text, d uuid, e jsonb, f text, g text, h text, i uuid, j jsonb, k jsonb
) returns void language plpgsql as $$ begin end $$;
-- Export base fn the migration wraps.
create or replace function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
  returns jsonb language sql stable as $$ select jsonb_build_object('tables', '{}'::jsonb) $$;

-- ===========================================================================
-- FIXTURE. One household, one member, one rollover expense category.
-- budgets rows: Jan/Feb/Mar 2026 = 10000 each, rollover=true; current month
-- Apr 2026 also budgeted 10000 rollover=true. NO spend in any month, so v3
-- carry for Apr = (10000-0) x 3 prior rollover months = 30000 exactly.
-- ===========================================================================
insert into public.households(id) values ('00000000-0000-4000-8000-0000000000a1');
insert into public.household_memberships(household_id, user_id)
  values ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1');
insert into public.ledger_accounts(id, household_id, name, kind, currency, is_category)
  values ('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000a1',
          'Groceries','expense','USD',true);
insert into public.budgets(household_id, category_ledger_account_id, month, amount_minor, currency, rollover) values
  ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1','2026-01-01',10000,'USD',true),
  ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1','2026-02-01',10000,'USD',true),
  ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1','2026-03-01',10000,'USD',true),
  ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1','2026-04-01',10000,'USD',true);

-- ------------------------------------------------------------------ v3 body
-- __V3_READMODEL_BODY__  (replaced by the runner with the real keel_list_budgets DDL)

-- ------------------------------------------------------------ v4 migration
-- The whole shipped migration (schema for budget_targets/expected_income, the
-- backfill + contiguity fix, and keel_budget_month) is spliced in here.
-- __V4_MIGRATION_BODY__  (replaced by the runner with the real migration)

grant select on all tables in schema public to keel_api, keel_export;

-- Authenticated context for both read models (membership check).
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';

-- Pin the v3 numbers for April 2026.
select is(
  (select r->>'carryMinor'
     from jsonb_array_elements(public.keel_list_budgets('00000000-0000-4000-8000-0000000000a1','2026-04-01')->'rows') r
    where r->>'categoryLedgerAccountId'='00000000-0000-4000-8000-0000000000c1'),
  '30000',
  'v3 baseline: 3 prior rollover months carry (10000-0) x 3 = 30000');

select is(
  (select count(*)::text
     from jsonb_array_elements(public.keel_list_budgets('00000000-0000-4000-8000-0000000000a1','2026-04-01')->'rows') r
    where r->>'categoryLedgerAccountId'='00000000-0000-4000-8000-0000000000c1'),
  '1',
  'v3 baseline: category appears exactly once in rows');

-- v4 MUST equal v3 EXACTLY. carryMinor identical across >=2 consecutive rollover
-- months (the multi-month case the single-month frozen test could not catch).
select is(
  (select r->>'carryMinor'
     from jsonb_array_elements(public.keel_budget_month('00000000-0000-4000-8000-0000000000a1','2026-04-01')->'rows') r
    where r->>'categoryLedgerAccountId'='00000000-0000-4000-8000-0000000000c1'),
  '30000',
  'v4 carry EXACTLY equals v3 (no backfill x carry overlap inflation)');

-- Category listed exactly once (no overlapping-target duplication in rows).
select is(
  (select count(*)::text
     from jsonb_array_elements(public.keel_budget_month('00000000-0000-4000-8000-0000000000a1','2026-04-01')->'rows') r
    where r->>'categoryLedgerAccountId'='00000000-0000-4000-8000-0000000000c1'),
  '1',
  'v4 lists the category exactly once (contiguous single live target per month)');

-- availableMinor (resolved + carry) matches v3.
select is(
  (select r->>'availableMinor'
     from jsonb_array_elements(public.keel_budget_month('00000000-0000-4000-8000-0000000000a1','2026-04-01')->'rows') r
    where r->>'categoryLedgerAccountId'='00000000-0000-4000-8000-0000000000c1'),
  (select r->>'availableMinor'
     from jsonb_array_elements(public.keel_list_budgets('00000000-0000-4000-8000-0000000000a1','2026-04-01')->'rows') r
    where r->>'categoryLedgerAccountId'='00000000-0000-4000-8000-0000000000c1'),
  'v4 availableMinor equals v3 availableMinor');

-- leftToBudget: implicit total = sum of live amount targets. With ONE live
-- target (10000) and one row resolving to 10000, leftToBudget = 0. If overlap
-- duplicated the target, the implicit total would inflate and this breaks.
select is(
  (public.keel_budget_month('00000000-0000-4000-8000-0000000000a1','2026-04-01')->>'leftToBudgetMinor'),
  '0',
  'v4 leftToBudget = 0 (implicit total = single live amount target, no over-subtract)');

select * from finish();
rollback;
