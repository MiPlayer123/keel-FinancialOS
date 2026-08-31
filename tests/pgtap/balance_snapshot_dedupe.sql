-- pgTAP: balance snapshot write amplification, phase 1
-- (20260831190000_balance_snapshot_dedupe.sql).
--
-- The Supabase stack (pgmq, pg_cron, auth, PostgREST GUCs) is unavailable in
-- the throwaway-postgres cluster used to validate this, so this suite builds a
-- MINIMAL real schema carrying exactly the tables, columns and constraints
-- keel_apply_account_balance touches, then loads two REAL files verbatim:
--
--   1. the PRIOR function body, sliced out of
--      20260717220000_account_mask.sql -- so the "before" state under test is
--      the function that is actually running in production today, not a
--      paraphrase of it; and
--   2. the ENTIRE new migration.
--
-- Between the two it exercises the old behaviour and records it, so the suite
-- proves the regression it claims to fix rather than asserting the fix in a
-- vacuum. The runner (scripts/run-balance-snapshot-dedupe-pgtap.sh)
-- concatenates the real files at the markers below.

begin;
select plan(39);

-- ---------------------------------------------------------------------------
-- Minimal schema
-- ---------------------------------------------------------------------------
create type public.ledger_account_kind as enum ('asset', 'liability', 'income', 'expense', 'equity');
create type public.bank_provider as enum ('simulator', 'plaid');
create type public.connection_status as enum ('linking', 'active', 'reauth_required', 'disconnected');

create table public.households (
  id uuid primary key,
  name text not null
);
create table public.entities (
  id uuid primary key,
  household_id uuid not null references public.households (id),
  name text not null,
  archived_at timestamptz,
  unique (household_id, id)
);
create table public.ledger_accounts (
  id uuid primary key,
  household_id uuid not null references public.households (id),
  entity_id uuid not null references public.entities (id),
  name text not null,
  kind public.ledger_account_kind not null,
  currency char(3) not null check (currency = upper(currency)),
  is_category boolean not null,
  archived_at timestamptz,
  unique (household_id, id)
);
create table public.connections (
  id uuid primary key,
  household_id uuid not null references public.households (id),
  provider public.bank_provider not null,
  external_ref text not null,
  status public.connection_status not null,
  last_successful_sync_at timestamptz,
  unique (household_id, id)
);
create table public.accounts (
  id uuid primary key,
  household_id uuid not null references public.households (id),
  entity_id uuid not null references public.entities (id),
  connection_id uuid references public.connections (id),
  ledger_account_id uuid not null unique references public.ledger_accounts (id),
  name text not null,
  subtype text not null,
  currency char(3) not null check (currency = upper(currency)),
  mask text check (mask is null or length(mask) between 1 and 10),
  archived_at timestamptz,
  unique (household_id, id)
);
create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  account_id uuid not null,
  as_of timestamptz not null,
  available_minor bigint,
  current_minor bigint not null,
  limit_minor bigint,
  currency text not null,
  source text not null,
  snapshot_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint fk_snapshot_account
    foreign key (household_id, account_id)
    references public.accounts (household_id, id)
    match simple on delete restrict
);
create table public.journal_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  canonical_transaction_id uuid,
  description text not null,
  effective_date date not null,
  reverses_batch_id uuid references public.journal_batches (id),
  command_id uuid not null,
  posted_at timestamptz not null default now()
);
create table public.journal_postings (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.journal_batches (id),
  ledger_account_id uuid not null references public.ledger_accounts (id),
  entity_id uuid not null references public.entities (id),
  amount_minor bigint not null check (amount_minor <> 0),
  currency char(3) not null check (currency = upper(currency))
);

-- Returns the SQLSTATE-bearing message of a failing statement, or 'OK'.
create function public._try(p_sql text) returns text
language plpgsql as $fn$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $fn$;

-- Snapshot count for one account's plaid series.
create function public._snaps(p_acct uuid) returns bigint
language sql stable as $fn$
  select count(*) from public.balance_snapshots
   where account_id = p_acct and source = 'plaid';
$fn$;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
insert into public.households (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Alpha'),
  ('11111111-1111-1111-1111-111111111112', 'Beta');
insert into public.entities (id, household_id, name) values
  ('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', 'Household'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111112', 'Other household');

-- Opening Balances equity account per entity: the anchor's counterparty.
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category) values
  ('33333333-3333-3333-3333-333333333330', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'Opening Balances', 'equity', 'USD', false),
  ('33333333-3333-3333-3333-33333333333a', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'Prior Checking', 'asset', 'USD', false),
  ('33333333-3333-3333-3333-33333333333b', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'Checking A', 'asset', 'USD', false),
  ('33333333-3333-3333-3333-33333333333c', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'Checking B', 'asset', 'USD', false),
  ('33333333-3333-3333-3333-33333333333d', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'Lazy Checking', 'asset', 'USD', false),
  ('33333333-3333-3333-3333-33333333333e', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'Card', 'liability', 'USD', false),
  ('33333333-3333-3333-3333-33333333333f', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', 'Never Synced', 'asset', 'USD', false),
  ('33333333-3333-3333-3333-333333333340', '11111111-1111-1111-1111-111111111112', '22222222-2222-2222-2222-222222222222', 'Opening Balances', 'equity', 'USD', false),
  ('33333333-3333-3333-3333-333333333341', '11111111-1111-1111-1111-111111111112', '22222222-2222-2222-2222-222222222222', 'Beta Checking', 'asset', 'USD', false);

insert into public.connections (id, household_id, provider, external_ref, status, last_successful_sync_at) values
  ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111', 'plaid', 'conn-done', 'active', '2026-08-01T00:00:00Z'),
  ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111', 'plaid', 'conn-lazy', 'active', null),
  ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111', 'plaid', 'conn-never', 'active', null),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111112', 'plaid', 'conn-beta', 'active', '2026-08-01T00:00:00Z');

insert into public.accounts (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency) values
  ('55555555-5555-5555-5555-55555555550a', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '44444444-4444-4444-4444-444444444441', '33333333-3333-3333-3333-33333333333a', 'Prior Checking', 'checking', 'USD'),
  ('55555555-5555-5555-5555-55555555550b', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '44444444-4444-4444-4444-444444444441', '33333333-3333-3333-3333-33333333333b', 'Checking A', 'checking', 'USD'),
  ('55555555-5555-5555-5555-55555555550c', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '44444444-4444-4444-4444-444444444441', '33333333-3333-3333-3333-33333333333c', 'Checking B', 'checking', 'USD'),
  ('55555555-5555-5555-5555-55555555550d', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '44444444-4444-4444-4444-444444444442', '33333333-3333-3333-3333-33333333333d', 'Lazy Checking', 'checking', 'USD'),
  ('55555555-5555-5555-5555-55555555550e', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '44444444-4444-4444-4444-444444444441', '33333333-3333-3333-3333-33333333333e', 'Card', 'credit card', 'USD'),
  ('55555555-5555-5555-5555-55555555550f', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '44444444-4444-4444-4444-444444444443', '33333333-3333-3333-3333-33333333333f', 'Never Synced', 'checking', 'USD'),
  ('55555555-5555-5555-5555-555555555510', '11111111-1111-1111-1111-111111111112', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333341', 'Beta Checking', 'checking', 'USD');

-- ===========================================================================
-- BEFORE: the function running in production today, loaded verbatim.
-- ===========================================================================
-- __PRIOR_FUNCTION_BODY__  (replaced by the runner with 20260717220000's DDL)

-- Three refresh cycles with an unchanged balance, exactly as keel-drain-sync
-- issues them every 3 minutes.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  120000, 120000, 'USD', '2026-08-20T00:00:00Z', null, null);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  120000, 120000, 'USD', '2026-08-20T00:03:00Z', null, null);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  120000, 120000, 'USD', '2026-08-20T00:06:00Z', null, null);

-- P0: this is the amplification. Three identical observations, three rows.
select is(public._snaps('55555555-5555-5555-5555-55555555550a')::text, '3',
  'BEFORE: the shipped function writes one row per cycle even when nothing changed');

-- ===========================================================================
-- The migration under test, loaded verbatim.
-- ===========================================================================
-- __MIGRATION_BODY__  (replaced by the runner with the real migration file)

-- ---------------------------------------------------------------------------
-- The freshness column
-- ---------------------------------------------------------------------------
select is(
  (select data_type from information_schema.columns
    where table_schema='public' and table_name='accounts'
      and column_name='balance_last_observed_at'),
  'timestamp with time zone',
  'accounts.balance_last_observed_at exists and is timestamptz');

-- The backfill must recover the confirmation instant the old rows already
-- prove, so phase 1 loses no information for accounts that were syncing all
-- along.
select is(
  (select balance_last_observed_at::text from public.accounts
    where id = '55555555-5555-5555-5555-55555555550a'),
  '2026-08-20 00:06:00+00',
  'backfill seeds balance_last_observed_at from the newest existing snapshot');

-- ---------------------------------------------------------------------------
-- The guard: does a redundant observation write a row?
-- ---------------------------------------------------------------------------
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  120000, 120000, 'USD', '2026-08-20T00:09:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550a')::text, '3',
  'AFTER: an unchanged balance writes no new snapshot');

select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  120000, 120000, 'USD', '2026-08-20T00:12:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550a')::text, '3',
  'AFTER: still nothing on the cycle after that');

-- ...but the freshness signal advances on every one of those suppressed
-- cycles. This is what makes "unchanged since" and "not checked since"
-- distinguishable once repeats stop being stored.
select is(
  (select balance_last_observed_at::text from public.accounts
    where id = '55555555-5555-5555-5555-55555555550a'),
  '2026-08-20 00:12:00+00',
  'balance_last_observed_at advances on a cycle whose snapshot was suppressed');

-- Out-of-order delivery must not rewind the freshness signal (the sync
-- simulator emits delayed and out-of-order events by design).
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  120000, 120000, 'USD', '2026-08-19T00:00:00Z', null, null);
select is(
  (select balance_last_observed_at::text from public.accounts
    where id = '55555555-5555-5555-5555-55555555550a'),
  '2026-08-20 00:12:00+00',
  'an out-of-order older observation never rewinds balance_last_observed_at');

-- A real move is still recorded.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  119000, 119000, 'USD', '2026-08-20T00:15:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550a')::text, '4',
  'a changed current_minor writes exactly one snapshot');

-- available_minor alone moving is a real change too (a pending hold landing).
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550a',
  119000, 118000, 'USD', '2026-08-20T00:18:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550a')::text, '5',
  'available_minor moving on its own writes a snapshot');

-- ---------------------------------------------------------------------------
-- NULL-safety. 149,481 of 186,871 live rows have a null limit_minor and
-- 43,609 a null available_minor. Written with `=` instead of
-- `is distinct from`, the guard would compare NULL = NULL -> NULL -> "not
-- equal" and keep writing a row per cycle for four fifths of the table.
-- ---------------------------------------------------------------------------
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, 'USD', '2026-08-20T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550b')::text, '1',
  'first-ever observation always writes a snapshot');

select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, 'USD', '2026-08-20T00:03:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550b')::text, '1',
  'a repeat with NULL available_minor AND NULL limit_minor is suppressed');

select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, 'USD', '2026-08-20T00:06:00Z', 900000, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550b')::text, '2',
  'limit_minor appearing (null -> value) is new information and is written');

select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, 'USD', '2026-08-20T00:09:00Z', 900000, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550b')::text, '2',
  'a repeat with a non-null limit_minor is suppressed');

select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, 'USD', '2026-08-20T00:12:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550b')::text, '3',
  'limit_minor disappearing (value -> null) is new information and is written');

-- Currency is part of the comparison: the same integer in a different currency
-- is a different fact.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, 'EUR', '2026-08-20T00:15:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550b')::text, '4',
  'a currency change writes a snapshot');

-- Empty p_currency falls back to the account currency, exactly as before. The
-- guard must compare the EFFECTIVE currency, not the raw parameter, or every
-- '' cycle would look like a change.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, 'USD', '2026-08-20T00:18:00Z', null, null);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550b',
  50000, null, '', '2026-08-20T00:21:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550b')::text, '5',
  'an empty p_currency resolves to the account currency and is not a change');

-- ---------------------------------------------------------------------------
-- Series isolation: the guard must never look at another account, another
-- household, or another source.
-- ---------------------------------------------------------------------------
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550c',
  50000, null, 'USD', '2026-08-20T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550c')::text, '1',
  'an identical balance on a DIFFERENT account is still its own first snapshot');

select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111112', '55555555-5555-5555-5555-555555555510',
  50000, null, 'USD', '2026-08-20T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-555555555510')::text, '1',
  'an identical balance in a DIFFERENT household is still its own first snapshot');

-- A statement-sourced snapshot sitting on top of the plaid series must neither
-- be compared against nor suppressed by it.
insert into public.balance_snapshots
  (household_id, account_id, as_of, available_minor, current_minor, limit_minor, currency, source, snapshot_metadata)
values
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550c',
   '2026-08-21T00:00:00Z', null, 999999, null, 'USD', 'statement', '{}'::jsonb);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550c',
  50000, null, 'USD', '2026-08-22T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550c')::text, '1',
  'a newer non-plaid snapshot does not un-suppress an unchanged plaid observation');

-- ...and the tie-break. as_of is the edge function's own wall clock with no
-- unique constraint, so two rows can share it. `order by as_of desc, id desc`
-- has to pick one deterministically; whichever it picks, an observation equal
-- to the newest row must be suppressed and one that differs must be written.
insert into public.balance_snapshots
  (id, household_id, account_id, as_of, available_minor, current_minor, limit_minor, currency, source, snapshot_metadata)
values
  ('66666666-6666-6666-6666-666666666661', '11111111-1111-1111-1111-111111111111',
   '55555555-5555-5555-5555-55555555550c', '2026-08-23T00:00:00Z', null, 111, null, 'USD', 'plaid', '{}'::jsonb),
  ('66666666-6666-6666-6666-666666666662', '11111111-1111-1111-1111-111111111111',
   '55555555-5555-5555-5555-55555555550c', '2026-08-23T00:00:00Z', null, 222, null, 'USD', 'plaid', '{}'::jsonb);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550c',
  222, null, 'USD', '2026-08-24T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550c')::text, '3',
  'on an as_of tie the highest id wins, so re-observing it is suppressed');
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550c',
  111, null, 'USD', '2026-08-25T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550c')::text, '4',
  'the loser of the tie is not treated as current: re-observing it writes');

-- snapshot_metadata is hardcoded '{}' by every writer today, but it is an
-- exported column. If anything ever populates it, that is information the
-- guard must not collapse away.
insert into public.balance_snapshots
  (household_id, account_id, as_of, available_minor, current_minor, limit_minor, currency, source, snapshot_metadata)
values
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550c',
   '2026-08-26T00:00:00Z', null, 111, null, 'USD', 'plaid', '{"note":"reconciled"}'::jsonb);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550c',
  111, null, 'USD', '2026-08-27T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550c')::text, '6',
  'a newest row carrying snapshot_metadata is never treated as equal to a bare one');

-- ---------------------------------------------------------------------------
-- THE REGRESSION THE GUARD COULD HAVE CAUSED (proposal P0-2).
--
-- keel_apply_account_balance runs: snapshot insert -> last_successful_sync_at
-- gate (returns) -> opening-balance-exists check (returns) -> book the anchor.
-- Written as an early `return` on "nothing changed", an account linked while
-- its balance is static would insert once, return early because the first sync
-- had not completed, and then return early FOREVER because the value never
-- moved -- so its opening balance would never be booked and its ledger balance
-- would stay wrong permanently. Two live accounts have gone 43+ days without a
-- value change, so this was reachable.
-- ---------------------------------------------------------------------------
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550d',
  77000, 77000, 'USD', '2026-08-20T00:00:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550d')::text, '1',
  'a freshly linked account records its first snapshot before the sync completes');
select is(
  (select count(*)::text from public.journal_postings
    where ledger_account_id = '33333333-3333-3333-3333-33333333333d'),
  '0',
  'and books no anchor yet, because the first full sync has not finished');

update public.connections set last_successful_sync_at = '2026-08-20T00:01:00Z'
 where id = '44444444-4444-4444-4444-444444444442';

-- The next cycle carries the SAME balance, so the snapshot is suppressed.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550d',
  77000, 77000, 'USD', '2026-08-20T00:03:00Z', null, null);
select is(public._snaps('55555555-5555-5555-5555-55555555550d')::text, '1',
  'the post-sync cycle writes no snapshot, because the balance did not move');
select is(
  (select coalesce(sum(amount_minor), 0)::text from public.journal_postings
    where ledger_account_id = '33333333-3333-3333-3333-33333333333d'),
  '77000',
  'THE ANCHOR STILL BOOKS on a cycle whose snapshot was suppressed');

-- Law 3: the anchor it booked balances.
select is(
  (select coalesce(sum(p.amount_minor), 0)::text
     from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
    where b.description = 'Opening balance'
      and exists (select 1 from public.journal_postings p2
                   where p2.batch_id = b.id
                     and p2.ledger_account_id = '33333333-3333-3333-3333-33333333333d')),
  '0',
  'the suppressed-cycle anchor is balanced: sum(amount_minor) = 0');

-- And it is booked once, not once per suppressed cycle.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550d',
  77000, 77000, 'USD', '2026-08-20T00:06:00Z', null, null);
select is(
  (select count(*)::text from public.journal_postings
    where ledger_account_id = '33333333-3333-3333-3333-33333333333d'),
  '1',
  'the anchor is still booked exactly once across further suppressed cycles');

-- The sync gate itself is untouched: a connection that has never synced books
-- nothing, however many cycles run.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550f',
  1000, 1000, 'USD', '2026-08-20T00:00:00Z', null, null);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550f',
  1000, 1000, 'USD', '2026-08-20T00:03:00Z', null, null);
select is(
  (select count(*)::text from public.journal_postings
    where ledger_account_id = '33333333-3333-3333-3333-33333333333f'),
  '0',
  'the last_successful_sync_at gate still blocks the anchor');

-- Liability sign convention survives the same path.
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550e',
  45000, null, 'USD', '2026-08-20T00:00:00Z', 900000, null);
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550e',
  45000, null, 'USD', '2026-08-20T00:03:00Z', 900000, null);
select is(
  (select coalesce(sum(amount_minor), 0)::text from public.journal_postings
    where ledger_account_id = '33333333-3333-3333-3333-33333333333e'),
  '-45000',
  'a liability anchors debit-negative, unchanged by the guard');
select is(public._snaps('55555555-5555-5555-5555-55555555550e')::text, '1',
  'and its second identical cycle wrote no snapshot');

-- ---------------------------------------------------------------------------
-- Untouched behaviour
-- ---------------------------------------------------------------------------
select is(
  substring(public._try($$select public.keel_apply_account_balance(
    '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-5555555555ff',
    1, 1, 'USD', '2026-08-20T00:00:00Z', null, null)$$) from 'KEEL_NOT_FOUND'),
  'KEEL_NOT_FOUND',
  'an unknown account still raises KEEL_NOT_FOUND');

-- Mask backfill still runs, and still runs on a suppressed cycle (it sits
-- above the guard for exactly this reason).
select public.keel_apply_account_balance(
  '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-55555555550e',
  45000, null, 'USD', '2026-08-20T00:06:00Z', 900000, '4321');
select is(
  (select mask from public.accounts where id = '55555555-5555-5555-5555-55555555550e'),
  '4321',
  'the mask backfill still runs on a cycle whose snapshot was suppressed');

-- ---------------------------------------------------------------------------
-- The execute lockdown from 20260718104500 must survive the replace.
-- ---------------------------------------------------------------------------
-- A NULL proacl is not "no grants": it means the built-in default, which for a
-- function is EXECUTE to PUBLIC. Counting aclexplode rows alone would score
-- the wide-open case as clean, so require proacl to be materialised AND carry
-- no PUBLIC (grantee 0) entry.
select is(
  (select (p.proacl is not null
           and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text
     from pg_proc p where p.proname = 'keel_apply_account_balance'),
  'true',
  'PUBLIC has no EXECUTE on keel_apply_account_balance after the replace');
select is(
  has_function_privilege('anon',
    'public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)',
    'execute')::text,
  'false',
  'anon has no EXECUTE');
select is(
  has_function_privilege('authenticated',
    'public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)',
    'execute')::text,
  'false',
  'authenticated has no EXECUTE');
select is(
  has_function_privilege('service_role',
    'public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)',
    'execute')::text,
  'true',
  'service_role keeps EXECUTE');

-- No overload was created: replacing must not leave two implementations
-- reachable, which is how the 7-arg orphan (20260718103000) happened.
select is(
  (select count(*)::text from pg_proc where proname = 'keel_apply_account_balance'),
  '1',
  'exactly one keel_apply_account_balance implementation exists');

select is(
  (select prosecdef::text from pg_proc where proname = 'keel_apply_account_balance'),
  'true',
  'it is still SECURITY DEFINER');

select * from finish();
rollback;
