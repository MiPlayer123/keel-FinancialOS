-- fix(recurring) 2/2: forced clean re-detection helper + orchestrator runbook.
--
-- WHY THIS IS NEEDED (task problem 2). The currently-'suggested' series were
-- detected from the OLD, junk-included reader (1348 rows) BEFORE 20260719031000
-- excluded transfers/P2P/other_income. The reap that should have retracted them
-- never completed (see 20260719082000 header — swallowed permission errors), so
-- 34 'suggested' series persist: 22 recurring-grid-v1 + 12 recurring-grid-v2, and
-- of the 12 v2, five (brianna wang, electronic payment, electronic payment
-- received thank, payment thank you, travel credit 300 year) were snapshotted at
-- 15:00 before the exclusion fully applied and their evidence txns are NO LONGER
-- in the 302-row reader. The remaining seven v2 (deeptune payroll x2, rillavoice
-- payroll x3, spotify, connor lee uber [transportation]) are real and re-detect.
--
-- Because detection is idempotent on candidate_snapshot_hash + per-candidate
-- input_fingerprint, a re-run against the SAME input writes 0 new candidate
-- versions — but it still returns the full current detected set (the 7 real v2
-- series) from keel_recurring_upsert_candidates, and with the reap now fixed
-- (20260719082000) + p_detection_ran=true, the reap withdraws every OTHER
-- 'suggested' series (the 22 v1 + 5 stale v2 = 27). Net result: Review shows only
-- the 7 genuine series (real subscriptions + payroll + the recurring rideshare).
--
-- THE ONLY REQUIREMENT is that ONE fresh detection run actually fires with all
-- grants in place. The daily cron (keel_cron_enqueue_recurring_detection, 86400s
-- bucket) claims one detection per household per UTC day via
-- recurring_detection_claims(household_id, bucket) UNIQUE — today's bucket is
-- already claimed, so the plain daily cron will NOT re-run today. This helper
-- enqueues a run in a FRESH sub-day bucket so the claim is new and the job runs,
-- deterministically, exactly once per invocation.
--
-- keel_force_recurring_redetect(p_household_id): enqueues a recurring_detection
-- job for one household using a 1-second bucket (guaranteed-unclaimed unless
-- called twice in the same second, in which case the UNIQUE claim makes it a
-- no-op — idempotent). Returns the number of jobs enqueued (0 or 1). Worker-owned
-- SECURITY DEFINER, service_role EXECUTE only (an operator/orchestrator call, not
-- a user-facing contract). It reuses the exact enqueue shape of the cron so the
-- run_key/asOf/refs are identical in structure — no bespoke code path, no
-- detection-logic change, Law 1 preserved.
--
-- FILE ONLY — never applied to any remote DB by this agent. Validated on a
-- throwaway plain Postgres 17 cluster (see NOTES).

create or replace function public.keel_force_recurring_redetect(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket timestamptz;
  v_enqueued integer := 0;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION: household not found' using errcode = 'P0006';
  end if;
  -- Fresh 1-second bucket so recurring_detection_claims(household_id, bucket) is a
  -- new row (idempotent within the same second via the UNIQUE constraint).
  v_bucket := to_timestamp(floor(extract(epoch from statement_timestamp())));

  with claimed as (
    insert into public.recurring_detection_claims(household_id, bucket)
    values (p_household_id, v_bucket)
    on conflict do nothing
    returning household_id
  ), sent as materialized (
    select claimed.household_id,
      public.keel_enqueue('recurring_detection', jsonb_build_object(
        'jobType', 'recurring_detection',
        'economicEventKey', 'recurring:detect:' || claimed.household_id::text || ':'
          || extract(epoch from v_bucket)::bigint::text,
        'refs', jsonb_build_object(
          'householdId', claimed.household_id::text,
          'asOf', to_char(v_bucket at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
      )) as message_id
    from claimed
  )
  select count(*)::integer into v_enqueued from sent;
  return v_enqueued;
end;
$$;

grant create on schema public to keel_worker;
alter function public.keel_force_recurring_redetect(uuid) owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_force_recurring_redetect(uuid) from public, anon, authenticated;
grant execute on function public.keel_force_recurring_redetect(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- ORCHESTRATOR RUNBOOK (run in order; steps 1-2 are this branch's deliverables):
--
--   1. Apply migrations (single-transaction, live cloud project):
--        20260719082000_recurring_reap_guard_and_grants.sql
--        20260719083000_recurring_force_clean_redetect.sql
--
--   2. Deploy the worker (bundles the p_detection_ran change):
--        node scripts/build-functions.mjs
--        supabase functions deploy api worker --project-ref <ref>
--
--   3. Force ONE clean re-detection for the founder household and drain it:
--        select public.keel_force_recurring_redetect('a1ba3759-b7a7-4880-93e2-49eb6f91636c');
--        -- then let the worker drain (cron job 4 keel_cron_drain_recurring_detection
--        -- runs every minute), or invoke the worker /drain endpoint directly.
--
--   4. Verify (expect: 7 'suggested', 27 'withdrawn' newly, 0 junk):
--        select status, count(*) from public.recurring_series
--         where household_id = 'a1ba3759-b7a7-4880-93e2-49eb6f91636c' group by status;
--        select action, count(*) from public.audit_log
--         where household_id = 'a1ba3759-b7a7-4880-93e2-49eb6f91636c'
--           and action = 'recurring.withdrawn' group by action;
--        -- keel_list_recurring already hides 'withdrawn', so Review shows only the 7.
--
-- After step 3 the daily cron is self-healing: every future run passes the full
-- current detected set to the (now working) reap, so any newly-stale suggestion is
-- withdrawn automatically and no forced re-detect is needed again.
-- ---------------------------------------------------------------------------
