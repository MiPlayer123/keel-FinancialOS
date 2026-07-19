-- pgTAP: archived-account reconnect dedupe + superseded-account auto-archive
-- (20260719210000_dedupe_archived_duplicates.sql).
--
-- The Supabase stack (pgmq, pg_cron, auth schema, PostgREST request settings)
-- is unavailable in the throwaway-postgres cluster used to validate this, so
-- this suite builds a MINIMAL real schema (the ledger tables + command
-- plumbing tables with the columns the functions read) and loads the ACTUAL
-- shared command helpers (sliced verbatim from 20260710210600) and the ACTUAL
-- migration file (see scripts/run-dedupe-archived-pgtap.sh). These tests
-- exercise the exact SQL that ships, not a paraphrase.
--
-- Properties under test (task spec + Laws 2/9):
--   * duplicates on the archived account are voided EXACTLY ONCE, one-to-one
--     (rank pairing never lets one active txn claim two archived twins);
--   * archived-only transactions (sole record of a real economic event) are
--     NEVER voided;
--   * re-run is a no-op; idempotent replay returns the stored result;
--   * the void is a reversal (postings negate, nothing deleted) and is itself
--     reversible (compensating re-reversal restores the ledger);
--   * finalize-path auto-archive soft-archives superseded accounts (+ their
--     fully-archived disconnected connection) with audit rows, is idempotent,
--     and never touches accounts on active connections.

begin;
select plan(26);

-- Minimal schema -----------------------------------------------------------
create schema if not exists public;
do $$ begin
  if not exists (select 1 from pg_type where typname = 'household_role') then
    create type public.household_role as enum ('owner', 'partner', 'viewer', 'professional');
  end if;
  if not exists (select 1 from pg_type where typname = 'transaction_status') then
    create type public.transaction_status as enum ('pending', 'posted', 'reviewed', 'voided');
  end if;
end $$;

create table public.households (id uuid primary key);
create table public.household_memberships (
  household_id uuid not null,
  user_id uuid not null,
  role public.household_role not null
);
create table public.entities (
  id uuid primary key,
  household_id uuid not null
);
create table public.connections (
  id uuid primary key,
  household_id uuid not null,
  institution_id text,
  status text not null default 'active',
  archived_at timestamptz
);
create table public.ledger_accounts (
  id uuid primary key,
  household_id uuid not null,
  entity_id uuid not null,
  name text not null,
  kind text not null default 'asset',
  currency char(3) not null default 'USD',
  is_category boolean not null default false
);
create table public.accounts (
  id uuid primary key,
  household_id uuid not null,
  entity_id uuid not null,
  connection_id uuid,
  ledger_account_id uuid,
  name text not null,
  subtype text,
  currency char(3) not null default 'USD',
  mask text,
  archived_at timestamptz
);
create table public.canonical_transactions (
  id uuid primary key,
  household_id uuid not null,
  entity_id uuid not null,
  account_id uuid not null,
  status public.transaction_status not null,
  source text not null default 'connection',
  description text not null,
  effective_date date not null,
  economic_event_key text not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  unique (household_id, economic_event_key)
);
create table public.journal_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  canonical_transaction_id uuid,
  description text not null,
  effective_date date not null,
  reverses_batch_id uuid,
  command_id uuid not null,
  posted_at timestamptz not null default now()
);
create table public.journal_postings (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  ledger_account_id uuid not null,
  entity_id uuid not null,
  amount_minor bigint not null check (amount_minor <> 0),
  currency char(3) not null
);
create table public.journal_revisions (
  id uuid primary key default gen_random_uuid(),
  original_batch_id uuid not null,
  reversal_batch_id uuid not null,
  replacement_batch_id uuid,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (original_batch_id, reversal_batch_id)
);
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  actor jsonb not null,
  action text not null,
  object_type text not null,
  object_id uuid,
  command_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  household_id uuid not null,
  command_id uuid,
  economic_event_key text,
  actor jsonb,
  payload jsonb,
  created_at timestamptz not null default now()
);
create table public.command_executions (
  economic_event_key text not null,
  command_id uuid not null,
  command text not null,
  household_id uuid not null,
  payload_sha256 text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  unique (household_id, economic_event_key)
);

-- The harness cluster grants nothing to keel_api by default; the security
-- definer functions run AS keel_api, so mirror the live grants coarsely.
grant usage on schema public to keel_api;
grant all on all tables in schema public to keel_api;

-- __SHARED_HELPERS__  (replaced by the runner with the real 20260710210600 helper DDL)

set local check_function_bodies = off;
-- __MIGRATION_BODY__  (replaced by the runner with the real migration file)

-- Fixtures: mirror the live Fidelity shape ---------------------------------
-- hh 1111..., archived old connection with the archived CMA account, active
-- reconnected connection with the surviving account, plus an unrelated
-- archived account whose txns coincide by date/desc/amount (mask differs).
create or replace function pg_temp.mk_txn(
  p_id uuid, p_acct uuid, p_cash_la uuid,
  p_date date, p_desc text, p_amt bigint, p_voided boolean default false
) returns uuid language plpgsql as $fn$
declare v_batch uuid := gen_random_uuid();
begin
  insert into public.canonical_transactions
    (id, household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key, voided_at)
  values
    (p_id, '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     p_acct,
     case when p_voided then 'voided' else 'posted' end::public.transaction_status,
     'connection', p_desc, p_date, 'fixture:' || p_id::text,
     case when p_voided then now() end);
  insert into public.journal_batches
    (id, household_id, canonical_transaction_id, description, effective_date, reverses_batch_id, command_id)
  values
    (v_batch, '11111111-1111-1111-1111-111111111111', p_id, p_desc, p_date, null, gen_random_uuid());
  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values (v_batch, p_cash_la, '33333333-3333-3333-3333-333333333333', p_amt, 'USD'),
         (v_batch, '44444444-0000-4000-8000-000000000001', '33333333-3333-3333-3333-333333333333', -p_amt, 'USD');
  return p_id;
end $fn$;

do $seed$
begin
  insert into public.households (id) values ('11111111-1111-1111-1111-111111111111');
  insert into public.household_memberships (household_id, user_id, role)
  values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'owner');
  insert into public.entities (id, household_id)
  values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111');

  insert into public.ledger_accounts (id, household_id, entity_id, name, kind, is_category) values
    ('44444444-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Income', 'income', true),
    ('44444444-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Cash Management (Individual)', 'asset', false),
    ('44444444-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Fidelity (Individual)', 'asset', false),
    ('44444444-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Other Checking', 'asset', false),
    ('44444444-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Old Savings', 'asset', false),
    ('44444444-0000-4000-8000-000000000006', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Live Savings', 'asset', false),
    ('44444444-0000-4000-8000-000000000007', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'New Savings', 'asset', false),
    ('44444444-0000-4000-8000-000000000008', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'New Savings 2', 'asset', false);

  insert into public.connections (id, household_id, institution_id, status, archived_at) values
    ('55555555-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', null, 'disconnected', now()),  -- old (archived)
    ('55555555-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', null, 'active', null),         -- new (reconnect)
    ('55555555-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', null, 'disconnected', null),   -- superseded, not yet archived
    ('55555555-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', null, 'active', null);         -- still-active other connection

  insert into public.accounts (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, mask, archived_at) values
    -- old archived CMA (mask 6691) on the archived connection
    ('66666666-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     '55555555-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002',
     'Cash Management (Individual)', 'cash management', '6691', now()),
    -- new active account, same mask, different Plaid name (live shape)
    ('66666666-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     '55555555-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000003',
     'Fidelity (Individual)', 'cash management', '6691', null),
    -- unrelated ARCHIVED account, different mask: coincidental txns must not match
    ('66666666-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     '55555555-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000004',
     'Other Checking', 'checking', '9999', now()),
    -- superseded (not yet archived) account on disconnected conn3, mask 7777
    ('66666666-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     '55555555-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000005', 'Old Savings', 'savings', '7777', null),
    -- same-mask account on a still-ACTIVE connection: must never be auto-archived
    ('66666666-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     '55555555-0000-4000-8000-000000000004', '44444444-0000-4000-8000-000000000006', 'Live Savings', 'savings', '8888', null),
    -- the new connection's counterparts for masks 7777 / 8888
    ('66666666-0000-4000-8000-000000000006', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     '55555555-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000007', 'New Savings', 'savings', '7777', null),
    ('66666666-0000-4000-8000-000000000007', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
     '55555555-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000008', 'New Savings 2', 'savings', '8888', null);
end $seed$;

-- Transactions. OLD side = archived account 6666...0001 (cash ledger 4444...0002),
-- NEW side = active account 6666...0002 (cash ledger 4444...0003).
select pg_temp.mk_txn('aaaaaaaa-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', '2026-05-29', 'DIVIDEND RECEIVED FGMM', 2903);              -- oldT1: duplicate
select pg_temp.mk_txn('aaaaaaaa-0000-4000-8000-000000000002', '66666666-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000003', '2026-05-29', 'DIVIDEND RECEIVED FGMM', 2903);              -- newT1
select pg_temp.mk_txn('dddddddd-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', '2026-06-01', 'DIVIDEND TWIN', 600);                        -- oldT2a: twin, rank 1
select pg_temp.mk_txn('dddddddd-0000-4000-8000-000000000002', '66666666-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', '2026-06-01', 'DIVIDEND TWIN', 600);                        -- oldT2b: twin, rank 2
select pg_temp.mk_txn('dddddddd-0000-4000-8000-000000000003', '66666666-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000003', '2026-06-01', 'DIVIDEND TWIN', 600);                        -- newT2: only ONE active copy
select pg_temp.mk_txn('bbbbbbbb-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', '2026-06-30', 'DIVIDEND SOLO', 461);                        -- oldT3: archived-only (live a663ee75 shape)
select pg_temp.mk_txn('bbbbbbbb-0000-4000-8000-000000000002', '66666666-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', '2026-05-29', 'DIVIDEND RECEIVED FGMM', 500);               -- oldT4: same date+desc, DIFFERENT amount
select pg_temp.mk_txn('cccccccc-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', '2026-06-05', 'ALREADY GONE', 777);                         -- oldT5: active twin exists but is VOIDED
select pg_temp.mk_txn('cccccccc-0000-4000-8000-000000000002', '66666666-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000003', '2026-06-05', 'ALREADY GONE', 777, true);                   -- newT5: voided -> not a live match
select pg_temp.mk_txn('eeeeeeee-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000004', '2026-05-29', 'DIVIDEND RECEIVED FGMM', 2903);              -- otherT: coincidental, unrelated account

-- Authenticated caller (owner) for the security-definer command path.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

-- Remember the old cash ledger's pre-void balance for the restore test.
create temp table pre as
  select coalesce(sum(amount_minor), 0) as s
    from public.journal_postings
   where ledger_account_id = '44444444-0000-4000-8000-000000000002';

-- (1) Matching core preview: exactly the two one-to-one pairs.
select is(
  (select count(*)::text from public.keel_archived_duplicate_pairs(
    '11111111-1111-1111-1111-111111111111',
    '66666666-0000-4000-8000-000000000001',
    '66666666-0000-4000-8000-000000000002')),
  '2', 'pairing core finds exactly the 2 one-to-one duplicates');

-- (2)+(3) Review reader: one account match, previewing 2 voidable duplicates.
create temp table reader as
  select public.keel_list_archived_duplicate_matches('11111111-1111-1111-1111-111111111111') as r;
select is((select jsonb_array_length(r->'rows')::text from reader), '1',
  'reader surfaces exactly one archived/active account match');
select is((select r->'rows'->0->>'duplicateCount' from reader), '2',
  'reader previews 2 voidable duplicate transactions');

-- Run the command ----------------------------------------------------------
create temp table run1 as
  select public.keel_cmd_dedupe_archived_duplicates(
    'aaaaaaaa-1111-4000-8000-000000000001',
    'itest:dedupe-archived:run1',
    null,
    '11111111-1111-1111-1111-111111111111',
    jsonb_build_object(
      'old_account_id', '66666666-0000-4000-8000-000000000001',
      'new_account_id', '66666666-0000-4000-8000-000000000002')) as r;

-- (4) Exactly 2 voided.
select is((select r->'effects'->>'voidedCount' from run1), '2',
  'command voids exactly 2 archived-side duplicates');

-- (5) The voided set is exactly {oldT1, oldT2a} -- the rank-1 twin, never both.
select is(
  (select string_agg(id::text, ',' order by id::text)
     from public.canonical_transactions
    where account_id = '66666666-0000-4000-8000-000000000001' and voided_at is not null),
  'aaaaaaaa-0000-4000-8000-000000000001,dddddddd-0000-4000-8000-000000000001',
  'voided set is exactly the matched archived-side copies');

-- (6) Archived-only transaction (sole record of a real event) untouched.
select is(
  (select (voided_at is null)::text from public.canonical_transactions
    where id = 'bbbbbbbb-0000-4000-8000-000000000001'),
  'true', 'archived-only transaction (no active copy) is preserved');

-- (7) Same date+description but different amount: no match, preserved.
select is(
  (select (voided_at is null)::text from public.canonical_transactions
    where id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  'true', 'same-day same-description different-amount transaction is preserved');

-- (8) Active-side copy already voided: archived copy is the only live record, preserved.
select is(
  (select (voided_at is null)::text from public.canonical_transactions
    where id = 'cccccccc-0000-4000-8000-000000000001'),
  'true', 'archived txn whose active twin is already voided is preserved');

-- (9) Coincidental identical txn on an UNRELATED archived account untouched.
select is(
  (select (voided_at is null)::text from public.canonical_transactions
    where id = 'eeeeeeee-0000-4000-8000-000000000001'),
  'true', 'coincidental duplicate on an unrelated account is untouched');

-- (10) One-to-one: exactly one of the two identical archived twins voided.
select is(
  (select count(*)::text from public.canonical_transactions
    where id in ('dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002')
      and voided_at is not null),
  '1', 'exactly one of two identical same-day archived twins is voided');

-- (11) Void = reversal: oldT1 now carries original + reversal batches whose
-- postings fully negate (4 postings, net 0) -- Law 3 conserved, Law 2 reversible.
select is(
  (select 'n=' || count(*) || ',sum=' || coalesce(sum(p.amount_minor), 0)
     from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
    where b.canonical_transaction_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'n=4,sum=0', 'void is a balanced reversal batch, not a mutation');

-- (12) Soft delete only: every canonical row still exists.
select is(
  (select count(*)::text from public.canonical_transactions
    where account_id = '66666666-0000-4000-8000-000000000001'),
  '6', 'no canonical transaction rows were deleted');

-- (13) Re-run (fresh key) is a no-op: voided rows left the candidate set.
select is(
  (select public.keel_cmd_dedupe_archived_duplicates(
    'aaaaaaaa-1111-4000-8000-000000000002',
    'itest:dedupe-archived:run2',
    null,
    '11111111-1111-1111-1111-111111111111',
    jsonb_build_object(
      'old_account_id', '66666666-0000-4000-8000-000000000001',
      'new_account_id', '66666666-0000-4000-8000-000000000002'))->'effects'->>'voidedCount'),
  '0', 're-run with a fresh key voids nothing (no-op)');

-- (14) Idempotent replay (same key, same payload) returns the stored result.
select is(
  (select public.keel_cmd_dedupe_archived_duplicates(
    'aaaaaaaa-1111-4000-8000-000000000003',
    'itest:dedupe-archived:run1',
    null,
    '11111111-1111-1111-1111-111111111111',
    jsonb_build_object(
      'old_account_id', '66666666-0000-4000-8000-000000000001',
      'new_account_id', '66666666-0000-4000-8000-000000000002'))->>'idempotentReplay'),
  'true', 'replay of the same economic event key is an idempotent replay');

-- (15) Command plumbing: two executions recorded (run1 + no-op run2), each audited.
select is(
  (select count(*)::text from public.command_executions
    where household_id = '11111111-1111-1111-1111-111111111111'
      and economic_event_key like 'itest:dedupe-archived:%'),
  '2', 'each distinct run records exactly one command execution');
select is(
  (select count(*)::text from public.audit_log
    where action = 'accounts.dedupe_archived'),
  '2', 'each run writes an audit_log row (Law 2: every mutation audited)');

-- (16)+(17) Conservative validation: refuse non-archived old side and
-- fingerprint mismatches outright.
create or replace function pg_temp.try_cmd(p_old uuid, p_new uuid) returns text
language plpgsql as $fn$
begin
  perform public.keel_cmd_dedupe_archived_duplicates(
    gen_random_uuid(), 'itest:try:' || gen_random_uuid()::text, null,
    '11111111-1111-1111-1111-111111111111',
    jsonb_build_object('old_account_id', p_old, 'new_account_id', p_new));
  return 'no-error';
exception when others then
  return sqlerrm;
end $fn$;

select is(
  pg_temp.try_cmd('66666666-0000-4000-8000-000000000002', '66666666-0000-4000-8000-000000000006'),
  'KEEL_INVALID_COMMAND: the old account must be archived (use accounts.dedupe_reconnect before archiving)',
  'refuses a non-archived old account');
select is(
  pg_temp.try_cmd('66666666-0000-4000-8000-000000000003', '66666666-0000-4000-8000-000000000002'),
  'KEEL_INVALID_COMMAND: accounts do not match by mask (or name+subtype) -- not a reconnect match',
  'refuses a fingerprint mismatch (unrelated account pair)');

-- (18) Reversible correction (Law 2): compensate the void reversal and clear
-- voided_at -> the old cash ledger returns to its pre-void balance minus only
-- the still-voided twin (600).
do $undo$
declare
  v_void_batch uuid;
  v_orig_batch uuid;
  v_rerev uuid;
begin
  select rev.reversal_batch_id, rev.original_batch_id into v_void_batch, v_orig_batch
    from public.journal_revisions rev
    join public.journal_batches jb on jb.id = rev.original_batch_id
   where jb.canonical_transaction_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, reverses_batch_id, command_id)
  values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001',
          'UNDO: restore wrongly-voided duplicate', '2026-05-29', v_void_batch, gen_random_uuid())
  returning id into v_rerev;
  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_rerev, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p where p.batch_id = v_void_batch;
  insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
  values (v_void_batch, v_rerev, 'restore wrongly-voided duplicate');
  update public.canonical_transactions
     set status = 'posted', voided_at = null
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';
end $undo$;

select is(
  (select coalesce(sum(amount_minor), 0)::text
     from public.journal_postings
    where ledger_account_id = '44444444-0000-4000-8000-000000000002'),
  (select (s - 600)::text from pre),
  'compensating re-reversal restores the voided transaction''s ledger effect');

-- Auto-archive of superseded accounts at finalize --------------------------
-- (19) First run archives exactly the superseded account (mask 7777 on the
-- disconnected conn3); the same-mask account on the ACTIVE conn4 is untouched.
select is(
  (select public.keel_archive_superseded_accounts(
    '11111111-1111-1111-1111-111111111111',
    '55555555-0000-4000-8000-000000000002',
    '{"kind":"user","userId":"22222222-2222-2222-2222-222222222222"}'::jsonb,
    'aaaaaaaa-2222-4000-8000-000000000001')::text),
  '1', 'auto-archive archives exactly the superseded disconnected-connection account');

-- (20) The superseded account is soft-archived and audited.
select is(
  (select (a.archived_at is not null)::text || '/' ||
          (select count(*)::text from public.audit_log al
            where al.action = 'account.archived' and al.object_id = a.id
              and al.after->>'reason' = 'superseded_by_reconnect')
     from public.accounts a where a.id = '66666666-0000-4000-8000-000000000004'),
  'true/1', 'superseded account is soft-archived with one audit row');

-- (21) Its connection (now fully archived) is archived too, with an audit row.
select is(
  (select (c.archived_at is not null)::text || '/' ||
          (select count(*)::text from public.audit_log al
            where al.action = 'connection.archived' and al.object_id = c.id)
     from public.connections c where c.id = '55555555-0000-4000-8000-000000000003'),
  'true/1', 'fully-superseded disconnected connection is archived with one audit row');

-- (22) Accounts on ACTIVE connections are never auto-archived.
select is(
  (select (archived_at is null)::text from public.accounts
    where id = '66666666-0000-4000-8000-000000000005'),
  'true', 'same-fingerprint account on an ACTIVE connection is never archived');

-- (23) The active connection itself is untouched.
select is(
  (select (archived_at is null)::text from public.connections
    where id = '55555555-0000-4000-8000-000000000004'),
  'true', 'active connection is never archived');

-- (24)+(25) Re-run is a no-op: nothing more archived, no duplicate audit rows.
select is(
  (select public.keel_archive_superseded_accounts(
    '11111111-1111-1111-1111-111111111111',
    '55555555-0000-4000-8000-000000000002',
    '{"kind":"user","userId":"22222222-2222-2222-2222-222222222222"}'::jsonb,
    'aaaaaaaa-2222-4000-8000-000000000002')::text),
  '0', 'auto-archive re-run archives nothing (idempotent)');
select is(
  (select count(*)::text from public.audit_log
    where action in ('account.archived', 'connection.archived')),
  '2', 'auto-archive re-run writes no duplicate audit rows');

select * from finish();
rollback;
