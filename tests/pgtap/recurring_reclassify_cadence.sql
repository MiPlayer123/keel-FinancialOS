-- pgTAP: keel_recurring_reclassify_cadence (editable cadence, 20260722320000).
-- Run via scripts/run-recurring-reclassify-cadence-pgtap.sh (throwaway PG; the
-- runner injects the real keel_payload_hash + keel_recurring_cadence_dates +
-- the real reclassify migration at the markers below).
--
-- Worked example (doc 10 §2.4 convention): the founder's Deeptune payroll,
-- confirmed as biweekly, corrected to semimonthly [15, last day].

begin;

create extension if not exists pgcrypto;
create role keel_api;
create role keel_worker;
create role anon;

create type public.recurring_cadence as enum ('weekly','biweekly','semimonthly','monthly','quarterly','annual');
create type public.recurring_sign as enum ('inflow','outflow');
create type public.recurring_series_status as enum ('suggested','confirmed','paused','cancelled','rejected','withdrawn');
create type public.recurring_transition as enum ('suggested','confirmed','paused','resumed','cancelled','rejected','withdrawn');
create type public.recurring_amount_kind as enum ('fixed','variable');

create table public.recurring_series(id uuid primary key default gen_random_uuid(), household_id uuid, series_key text, account_id uuid, ledger_account_id uuid, counterparty_key text, currency char(3), sign public.recurring_sign, status public.recurring_series_status, current_candidate_version_id uuid, confirmed_by uuid, confirmed_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.recurring_candidate_versions(id uuid primary key default gen_random_uuid(), household_id uuid, series_id uuid, detector_run_id uuid, candidate_hash text, input_fingerprint text, detector_version text, confidence_version text, normalizer_version text, as_of timestamptz, score_bps int, evidence jsonb, candidate jsonb, created_at timestamptz default now(), unique(household_id, series_id, input_fingerprint));
create table public.recurring_detector_runs(id uuid primary key default gen_random_uuid(), household_id uuid, run_key text, as_of timestamptz, detector_version text, confidence_version text, normalizer_version text, candidate_snapshot_hash text, created_at timestamptz default now(), unique(household_id, run_key));
create table public.recurring_occurrences(id uuid primary key default gen_random_uuid(), household_id uuid, series_id uuid, candidate_version_id uuid, occurrence_key text, expected_date date, expected_amount_minor bigint, currency char(3), amount_kind public.recurring_amount_kind, status text, matched_txn_id uuid, score_bps int, evidence jsonb, input_fingerprint text, detector_version text, confidence_version text, as_of timestamptz, unique(household_id, series_id, candidate_version_id, expected_date));
create table public.recurring_status_events(id uuid primary key default gen_random_uuid(), household_id uuid, series_id uuid, candidate_version_id uuid, transition public.recurring_transition, effective_date date, actor jsonb, command_id uuid, created_at timestamptz default now());
create table public.audit_log(id bigserial primary key, household_id uuid, actor jsonb, action text, object_type text, object_id uuid, command_id uuid, before jsonb, after jsonb);
create table public.domain_events(id bigserial primary key, event_type text, household_id uuid, command_id uuid, economic_event_key text, actor jsonb, payload jsonb);
create table public.command_executions(id bigserial primary key, household_id uuid, economic_event_key text, command_id uuid, command text, payload_sha256 text, result jsonb);

grant all on all tables in schema public to keel_api, keel_worker;
grant all on all sequences in schema public to keel_api, keel_worker;

-- __SHARED_HELPERS__  (replaced by the runner with the real keel_payload_hash DDL)

create function public.keel_assert_member_write(h uuid) returns text language sql as $$ select 'owner'::text $$;
create function public.keel_actor_from_jwt() returns jsonb language sql as $$ select jsonb_build_object('kind','user','userId','00000000-0000-4000-8000-000000000001') $$;
create function public.keel_idempotency_check(h uuid, e text, x text) returns jsonb language sql as $$ select null::jsonb $$;
create function public.keel_recurring_account_access(h uuid, a uuid, w boolean) returns boolean language sql as $$ select true $$;

-- __CADENCE_DATES__  (replaced by the runner with the real keel_recurring_cadence_dates DDL)

-- __MIGRATION_BODY__  (replaced by the runner with the real reclassify migration file)

-- Seed: a CONFIRMED biweekly Deeptune-style series (variable amount).
insert into public.recurring_detector_runs(id,household_id,run_key,as_of,detector_version,confidence_version,normalizer_version,candidate_snapshot_hash)
values ('00000000-0000-4000-8000-0000000000aa','a1ba3759-b7a7-4880-93e2-49eb6f91636c','detrun-0001-detrun','2026-04-30','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1', repeat('a',64));
insert into public.recurring_series(id,household_id,series_key,account_id,ledger_account_id,counterparty_key,currency,sign,status)
values ('1c446787-bfc0-44a6-8838-b77d5f1be8eb','a1ba3759-b7a7-4880-93e2-49eb6f91636c','d80a36224a973717','89176108-9cfc-444c-a6f0-2e2a9b27cf50','c8d992ab-e9fd-4c1f-bcfd-51b1b3d31c5e','deeptune payroll','USD','inflow','confirmed');
insert into public.recurring_candidate_versions(id,household_id,series_id,detector_run_id,candidate_hash,input_fingerprint,detector_version,confidence_version,normalizer_version,as_of,score_bps,evidence,candidate)
values ('80e86dda-40eb-43e5-b82d-06ebc15a2a0f','a1ba3759-b7a7-4880-93e2-49eb6f91636c','1c446787-bfc0-44a6-8838-b77d5f1be8eb','00000000-0000-4000-8000-0000000000aa', repeat('b',64),'aa53eccd1808b665','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1','2026-04-30',2460,
  '[{"txnId":"834c613f-46ee-40a0-b70e-fae224d54b1b","batchId":"a7d4bda4-57b5-47d1-9436-e75770608d4e","postingId":"b30bf321-7ad6-4690-974f-a1fc00b1dabe"},{"txnId":"d44440bf-2450-4dd3-b9e2-2faf0552a683","batchId":"e13c2737-8264-4583-ac2f-0f57eaa09f16","postingId":"6a181bed-a39a-4f7a-a1f4-1dfc3f8723a3"},{"txnId":"dbf6d195-28a6-4be1-9700-27db6c5fe8cf","batchId":"6dbacef8-e438-4b8e-b48a-246facb14083","postingId":"a5a552b5-ca44-484e-b122-38ff51f0274b"}]'::jsonb,
  jsonb_build_object('cadence','biweekly','cadenceAnchor',jsonb_build_object('kind','epoch_grid','intervalDays',14,'anchorEpochDay',20395),'amountKind','variable','representativeAmountMinor',null,'amountSummary',jsonb_build_object('lowerMedianMinor','104326'),'lastSeen','2026-04-30'));
update public.recurring_series set current_candidate_version_id='80e86dda-40eb-43e5-b82d-06ebc15a2a0f' where id='1c446787-bfc0-44a6-8838-b77d5f1be8eb';
insert into public.recurring_status_events(household_id,series_id,candidate_version_id,transition,effective_date,actor,command_id)
values ('a1ba3759-b7a7-4880-93e2-49eb6f91636c','1c446787-bfc0-44a6-8838-b77d5f1be8eb','80e86dda-40eb-43e5-b82d-06ebc15a2a0f','confirmed','2026-05-01','{}'::jsonb, gen_random_uuid());

select plan(8);

-- 1. reclassify to semimonthly [15,31] returns the new cadence.
select is(
  (public.keel_recurring_reclassify_cadence(
    gen_random_uuid(), 'recurring.reclassify_cadence:1c446787:2026-05-02',
    '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
    'a1ba3759-b7a7-4880-93e2-49eb6f91636c',
    jsonb_build_object('series_id','1c446787-bfc0-44a6-8838-b77d5f1be8eb','cadence','semimonthly',
      'cadence_anchor', jsonb_build_object('kind','day_pair','days', jsonb_build_array(15,31)),
      'effective_date','2026-05-02','horizon_days',366)
  )->'effects'->>'cadence'),
  'semimonthly', 'reclassify returns semimonthly');

-- 2. current candidate is now semimonthly, manual provenance.
select is(
  (select v.candidate->>'cadence'||'/'||(v.candidate->>'detectorVersion')||'/'||(v.candidate->>'manualCadenceOverride')
     from public.recurring_candidate_versions v
     join public.recurring_series s on s.current_candidate_version_id = v.id
    where s.id='1c446787-bfc0-44a6-8838-b77d5f1be8eb'),
  'semimonthly/manual-cadence-v1/true', 'current candidate flipped to manual semimonthly override');

-- 3. occurrences land on the 15th (12 of them across the horizon).
select is(
  (select count(*)::text from public.recurring_occurrences o
     join public.recurring_series s on s.current_candidate_version_id=o.candidate_version_id and s.id=o.series_id
    where s.id='1c446787-bfc0-44a6-8838-b77d5f1be8eb' and extract(day from o.expected_date)=15),
  '12', 'twelve 15th occurrences projected');

-- 4. month-end clamps correctly: Feb 2027 lands on the 28th, never 31.
select ok(
  exists(select 1 from public.recurring_occurrences o
     join public.recurring_series s on s.current_candidate_version_id=o.candidate_version_id and s.id=o.series_id
    where s.id='1c446787-bfc0-44a6-8838-b77d5f1be8eb' and o.expected_date='2027-02-28'),
  'Feb 2027 month-end occurrence clamps to the 28th');

-- 5. never generates an impossible Feb 31 / Apr 31.
select ok(
  not exists(select 1 from public.recurring_occurrences o
     join public.recurring_series s on s.current_candidate_version_id=o.candidate_version_id and s.id=o.series_id
    where s.id='1c446787-bfc0-44a6-8838-b77d5f1be8eb'
      and to_char(o.expected_date,'MM-DD') in ('02-31','02-30','04-31','06-31','09-31','11-31')),
  'no impossible calendar dates projected');

-- 6. April/June month-ends land on the 30th (last day of a 30-day month).
select ok(
  exists(select 1 from public.recurring_occurrences o
     join public.recurring_series s on s.current_candidate_version_id=o.candidate_version_id and s.id=o.series_id
    where s.id='1c446787-bfc0-44a6-8838-b77d5f1be8eb' and o.expected_date='2026-06-30')
  and exists(select 1 from public.recurring_occurrences o
     join public.recurring_series s on s.current_candidate_version_id=o.candidate_version_id and s.id=o.series_id
    where s.id='1c446787-bfc0-44a6-8838-b77d5f1be8eb' and o.expected_date='2026-05-31'),
  '30-day months land on the 30th, 31-day months on the 31st');

-- 7. the prior candidate is preserved (append-only; exactly 2 versions exist).
select is(
  (select count(*)::text from public.recurring_candidate_versions where series_id='1c446787-bfc0-44a6-8838-b77d5f1be8eb'),
  '2', 'original candidate preserved alongside the manual override (append-only)');

-- 8. cadence/anchor mismatch is rejected (semimonthly with an epoch_grid anchor).
-- Capture the raised P0009 inside a plpgsql block so the outer test transaction
-- survives to report the result.
create or replace function public._test_mismatch_rejected() returns boolean language plpgsql as $$
begin
  perform public.keel_recurring_reclassify_cadence(
    gen_random_uuid(), 'x:mismatch',
    '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
    'a1ba3759-b7a7-4880-93e2-49eb6f91636c',
    jsonb_build_object('series_id','1c446787-bfc0-44a6-8838-b77d5f1be8eb','cadence','semimonthly',
      'cadence_anchor', jsonb_build_object('kind','epoch_grid','intervalDays',14,'anchorEpochDay',20400),
      'effective_date','2026-05-03','horizon_days',90));
  return false;  -- no error raised -> guard failed
exception when sqlstate 'P0009' then
  return true;   -- rejected as expected
end $$;
select ok((select public._test_mismatch_rejected()), 'cadence/anchor mismatch is rejected (P0009)');

select finish();
rollback;
