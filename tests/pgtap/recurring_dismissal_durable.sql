-- pgTAP: a USER-DISMISSED (rejected) recurring series must NOT resurface on the
-- next detection run, while a system-withdrawn stale suggestion and a plain
-- suggested series still re-point to the freshest candidate; confirmed is
-- untouched; and idempotent replay of the same run is a no-op.
--
-- Runner (scripts/run-recurring-dismissal-durable-pgtap.sh) initdbs a throwaway
-- cluster, builds the minimal real schema the upsert touches, loads the REAL
-- keel_payload_hash helper sliced from 20260710210600, injects the REAL fix
-- migration body at the marker below, then runs this file.
--
-- The upsert's evidence gate requires a genuine live posting (canonical_txn +
-- non-reversed journal_batch + journal_posting on the account's ledger account +
-- posted/reviewed + not voided). We build exactly that minimal shape for one
-- checking account so a candidate whose evidence points at it validates.

begin;

-- ---------------------------------------------------------------------------
-- Minimal schema: only what keel_recurring_upsert_candidates reads/writes.
-- ---------------------------------------------------------------------------
create schema if not exists public;

create type public.recurring_series_status as enum
  ('suggested','confirmed','paused','cancelled','rejected','withdrawn');
create type public.recurring_transition as enum
  ('suggested','confirmed','paused','resumed','cancelled','rejected','withdrawn');
create type public.recurring_sign as enum ('inflow','outflow');

create table public.households (id uuid primary key);
create table public.ledger_accounts (
  id uuid primary key, household_id uuid not null, kind text not null,
  unique (household_id, id));
create table public.accounts (
  id uuid primary key, household_id uuid not null, ledger_account_id uuid not null,
  currency char(3) not null, archived_at timestamptz,
  unique (household_id, id),
  foreign key (household_id, ledger_account_id) references public.ledger_accounts(household_id, id));
create table public.canonical_transactions (
  id uuid primary key, household_id uuid not null, account_id uuid not null,
  status text not null, description text, effective_date date not null,
  voided_at timestamptz, unique (household_id, id),
  foreign key (household_id, account_id) references public.accounts(household_id, id));
create table public.journal_batches (
  id uuid primary key, household_id uuid not null, canonical_transaction_id uuid not null,
  reverses_batch_id uuid, posted_at timestamptz not null default now());
create table public.journal_revisions (
  id uuid primary key default gen_random_uuid(), original_batch_id uuid not null);
create table public.journal_postings (
  id uuid primary key, batch_id uuid not null, ledger_account_id uuid not null,
  amount_minor bigint not null, currency char(3) not null);
create table public.audit_log (
  id uuid primary key default gen_random_uuid(), household_id uuid, actor jsonb,
  action text, object_type text, object_id uuid, command_id uuid, before jsonb,
  after jsonb, at timestamptz not null default now());

create table public.recurring_detector_runs (
  id uuid primary key default gen_random_uuid(), household_id uuid not null,
  run_key text not null, as_of timestamptz not null, detector_version text not null,
  confidence_version text not null, normalizer_version text not null,
  candidate_snapshot_hash text not null,
  unique (household_id, run_key), unique (household_id, id));
create table public.recurring_series (
  id uuid primary key default gen_random_uuid(), household_id uuid not null,
  series_key text not null, account_id uuid not null, ledger_account_id uuid not null,
  counterparty_key text not null, currency char(3) not null,
  sign public.recurring_sign not null, status public.recurring_series_status not null,
  current_candidate_version_id uuid, confirmed_by uuid, confirmed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (household_id, id), unique (household_id, series_key));
create table public.recurring_candidate_versions (
  id uuid primary key default gen_random_uuid(), household_id uuid not null,
  series_id uuid not null, detector_run_id uuid not null, candidate_hash text not null,
  input_fingerprint text not null, detector_version text not null,
  confidence_version text not null, normalizer_version text not null,
  as_of timestamptz not null, score_bps integer not null, evidence jsonb not null,
  candidate jsonb not null, created_at timestamptz not null default now(),
  unique (household_id, id), unique (household_id, series_id, input_fingerprint));

-- Roles the migration's grants reference.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='keel_worker') then create role keel_worker nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
grant keel_worker to postgres;

-- Production grants the worker-owned definer these privileges (20260712120000 /
-- 20260719031000). Re-assert them here so the SECURITY DEFINER body can read/write.
grant select on public.households, public.ledger_accounts, public.accounts,
  public.canonical_transactions, public.journal_batches, public.journal_revisions,
  public.journal_postings to keel_worker;
grant select, insert on public.recurring_detector_runs,
  public.recurring_candidate_versions, public.recurring_series, public.audit_log to keel_worker;
grant update on public.recurring_series to keel_worker;

-- __SHARED_HELPERS__  (replaced by the runner with the real keel_payload_hash DDL)

-- __MIGRATION_BODY__  (replaced by the runner with the real fix migration file)

-- ---------------------------------------------------------------------------
-- Fixture: one household, one checking account, one live posting so a candidate
-- whose evidence references it passes the upsert's evidence gate.
-- ---------------------------------------------------------------------------
insert into public.households values ('a1000000-0000-4000-8000-000000000001');
insert into public.ledger_accounts values ('a1000000-0000-4000-8000-0000000000a1','a1000000-0000-4000-8000-000000000001','asset');
insert into public.accounts values ('a1000000-0000-4000-8000-0000000000b1','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000a1','USD',null);
insert into public.canonical_transactions values
  ('a1000000-0000-4000-8000-0000000000c1','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000b1','posted','ACME PAYROLL','2026-06-01',null),
  ('a1000000-0000-4000-8000-0000000000c2','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000b1','posted','ACME PAYROLL','2026-06-15',null),
  ('a1000000-0000-4000-8000-0000000000c3','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000b1','posted','ACME PAYROLL','2026-07-01',null),
  ('a1000000-0000-4000-8000-0000000000c4','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000b1','posted','ACME PAYROLL','2026-07-15',null);
insert into public.journal_batches (id, household_id, canonical_transaction_id) values
  ('a1000000-0000-4000-8000-0000000000d1','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000c1'),
  ('a1000000-0000-4000-8000-0000000000d2','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000c2'),
  ('a1000000-0000-4000-8000-0000000000d3','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000c3'),
  ('a1000000-0000-4000-8000-0000000000d4','a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-0000000000c4');
insert into public.journal_postings values
  ('a1000000-0000-4000-8000-0000000000e1','a1000000-0000-4000-8000-0000000000d1','a1000000-0000-4000-8000-0000000000a1',500000,'USD'),
  ('a1000000-0000-4000-8000-0000000000e2','a1000000-0000-4000-8000-0000000000d2','a1000000-0000-4000-8000-0000000000a1',500000,'USD'),
  ('a1000000-0000-4000-8000-0000000000e3','a1000000-0000-4000-8000-0000000000d3','a1000000-0000-4000-8000-0000000000a1',500000,'USD'),
  ('a1000000-0000-4000-8000-0000000000e4','a1000000-0000-4000-8000-0000000000d4','a1000000-0000-4000-8000-0000000000a1',500000,'USD');

-- Candidate builder: a valid candidate for the ACME series, parameterized by the
-- input_fingerprint so run 2 can carry a DIFFERENT fingerprint (a real detector
-- would, once a new occurrence lands) → v_inserted = true on the rejected series.
create or replace function _mk_candidates(p_fp text) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'seriesKey','acme-payroll-usd',
    'accountId','a1000000-0000-4000-8000-0000000000b1',
    'ledgerAccountId','a1000000-0000-4000-8000-0000000000a1',
    'counterpartyKey','acme payroll',
    'currency','USD','sign','inflow',
    'detectorVersion','d1','confidenceVersion','c1','normalizerVersion','n1',
    'asOf','2026-07-16','requiresApproval',true,
    'inputFingerprint',p_fp,'scoreBps',9000,
    'representativeAmountMinor','500000','amountKind','fixed',
    'lastSeen','2026-07-15',
    'evidence', jsonb_build_array(
      jsonb_build_object('txnId','a1000000-0000-4000-8000-0000000000c1','batchId','a1000000-0000-4000-8000-0000000000d1','postingId','a1000000-0000-4000-8000-0000000000e1'),
      jsonb_build_object('txnId','a1000000-0000-4000-8000-0000000000c2','batchId','a1000000-0000-4000-8000-0000000000d2','postingId','a1000000-0000-4000-8000-0000000000e2'),
      jsonb_build_object('txnId','a1000000-0000-4000-8000-0000000000c3','batchId','a1000000-0000-4000-8000-0000000000d3','postingId','a1000000-0000-4000-8000-0000000000e3'))
  ));
$$;

select plan(9);

-- ===========================================================================
-- RUN 1: first detection creates the series as 'suggested'.
-- ===========================================================================
select is(
  (public.keel_recurring_upsert_candidates(
    'a1000000-0000-4000-8000-000000000001','run-1','2026-07-16T00:00:00Z',
    'd1','c1','n1', _mk_candidates('fp-0000000000000001'))
   ->'candidates'->0->>'inserted'),
  'true', 'run1: candidate inserted (new series)');
select is(
  (select status::text from public.recurring_series where series_key='acme-payroll-usd'),
  'suggested', 'run1: series is suggested');

-- User DISMISSES it (the Recurring/Review "Dismiss" → recurring.reject → status
-- rejected). We set it directly here (the transition-core state machine is tested
-- elsewhere); this test isolates the UPSERT resurface behavior.
update public.recurring_series set status='rejected' where series_key='acme-payroll-usd';

-- ===========================================================================
-- RUN 2: re-detection with a DIFFERENT input_fingerprint (a new occurrence
-- landed) → v_inserted = true. The BUG flipped the rejected series back to
-- 'suggested'; the FIX must leave it 'rejected'.
-- ===========================================================================
select is(
  (public.keel_recurring_upsert_candidates(
    'a1000000-0000-4000-8000-000000000001','run-2','2026-07-16T00:00:00Z',
    'd1','c1','n1', _mk_candidates('fp-0000000000000002'))
   ->'candidates'->0->>'inserted'),
  'true', 'run2: NEW candidate version inserted (different fingerprint)');
select is(
  (select status::text from public.recurring_series where series_key='acme-payroll-usd'),
  'rejected', 'run2: DISMISSAL IS DURABLE — rejected series stays rejected');
-- History preserved (Law 9): both candidate versions exist for the series.
select is(
  (select count(*)::text from public.recurring_candidate_versions cv
     join public.recurring_series s on s.id=cv.series_id where s.series_key='acme-payroll-usd'),
  '2', 'run2: new candidate version still recorded (append-only history intact)');

-- ===========================================================================
-- A SYSTEM-WITHDRAWN stale suggestion DOES come back (unchanged behavior).
-- ===========================================================================
update public.recurring_series set status='withdrawn' where series_key='acme-payroll-usd';
select public.keel_recurring_upsert_candidates(
  'a1000000-0000-4000-8000-000000000001','run-3','2026-07-16T00:00:00Z',
  'd1','c1','n1', _mk_candidates('fp-0000000000000003'));
select is(
  (select status::text from public.recurring_series where series_key='acme-payroll-usd'),
  'suggested', 'withdrawn (system reap) is re-suggested when re-detected');

-- ===========================================================================
-- A CONFIRMED series is never disturbed by detection.
-- ===========================================================================
update public.recurring_series set status='confirmed' where series_key='acme-payroll-usd';
select public.keel_recurring_upsert_candidates(
  'a1000000-0000-4000-8000-000000000001','run-4','2026-07-16T00:00:00Z',
  'd1','c1','n1', _mk_candidates('fp-0000000000000004'));
select is(
  (select status::text from public.recurring_series where series_key='acme-payroll-usd'),
  'confirmed', 'confirmed series untouched by detection');

-- ===========================================================================
-- IDEMPOTENT REPLAY: re-run an identical run (same run_key + same fingerprint)
-- against a rejected series → same snapshot hash → no new candidate, no flip.
-- ===========================================================================
update public.recurring_series set status='rejected' where series_key='acme-payroll-usd';
select is(
  (public.keel_recurring_upsert_candidates(
    'a1000000-0000-4000-8000-000000000001','run-2','2026-07-16T00:00:00Z',
    'd1','c1','n1', _mk_candidates('fp-0000000000000002'))
   ->'candidates'->0->>'inserted'),
  'false', 'replay of run-2: no new candidate (idempotent)');
select is(
  (select status::text from public.recurring_series where series_key='acme-payroll-usd'),
  'rejected', 'replay: rejected series unchanged (idempotent, dismissal durable)');

select * from finish();
rollback;
