-- fix(recurring) 1/2: make the stale-suggestion reap actually clean up, and make
-- it SAFE against the idempotent-empty-detection failure mode.
--
-- ROOT CAUSE (traced on the live founder household 2026-07-19, read-only):
--   The reader/upsert/reap wiring was logically correct, but the reap
--   keel_recurring_reap_stale_suggestions NEVER ONCE completed successfully — a
--   chain of swallowed permission errors killed every call:
--     * 16:18:05  ERROR: permission denied for table recurring_detector_runs
--                 (the reap's household-guard SELECT; keel_api lacked SELECT until
--                  20260719070000 granted it at 16:52:03)
--     * 16:52:40  ERROR: KEEL_SCOPE_VIOLATION: detector run not in household
--     * 16:55:54  ERROR: permission denied for function
--                 keel_recurring_reap_stale_suggestions
--   The worker treats a reap error as non-fatal (console.error only), so detection
--   reported success while 0 series were ever withdrawn. Live proof: audit_log has
--   260 'recurring.suggested' and ZERO 'recurring.withdrawn'; recurring_status_events
--   has confirmed/rejected only, no 'withdrawn'. All grants the definer needs are
--   NOW present on live (verified: keel_api has SELECT households/detector_runs/
--   recurring_series, INSERT status_events/audit_log, column UPDATE(status,updated_at)
--   on recurring_series), so the reap body will finally run to completion.
--
-- THE CORE SEMANTIC BUG (task problem 1 — the "nuke everything" hazard):
--   The reap withdraws every 'suggested' series NOT in p_emitted_series_ids. The
--   worker builds p_emitted_series_ids from keel_recurring_upsert_candidates's
--   returned candidate list, which (correctly) includes EVERY series the run
--   detected — inserted AND idempotent-conflict rows — because v_result is appended
--   unconditionally in the upsert loop. So on a normal re-run the emitted set is the
--   full CURRENT detected set and the reap withdraws only genuinely-stale series.
--   BUT if the detector legitimately produces ZERO candidates (e.g. every input row
--   excluded), the upsert loop never runs, v_result = [], the worker passes an EMPTY
--   emitted array, and `not (id = any('{}'))` matches EVERY suggested series — the
--   reap would withdraw the entire household's Review list, and idempotent detection
--   would not re-suggest them. That is the "everything vanishes" trap.
--
--   FIX: add p_detection_ran boolean. The reap only withdraws when detection
--   genuinely executed against fresh input AND produced at least one series
--   (p_detection_ran = true, which the worker sets to candidates.length > 0). A
--   zero-candidate run reaps NOTHING (returns 0) — it is not evidence that every
--   prior suggestion is stale, only that this run found nothing. This keeps the
--   two required properties: (a) a real re-detection withdraws only series no longer
--   detected; (b) an empty/idempotent-0 run never nukes the list. Deterministic and
--   replayable (Law 1/9): same inputs -> same withdrawals; the per-(run,series)
--   command_id keeps it idempotent on replay.
--
-- Signature CHANGES (adds p_detection_ran) -> this is a NEW overload. We DROP the
-- old 3-arg function so only the guarded 4-arg version exists and the worker cannot
-- accidentally call the unguarded one. keel_api-owned SECURITY DEFINER, grants
-- re-asserted. No table/column change -> export DTO + pgTAP unaffected (Law 6).
--
-- FILE ONLY — never applied to any remote DB by this agent. The orchestrator
-- applies it. Validated on a throwaway plain Postgres 17 cluster (see NOTES).

-- Drop the previous 3-arg version (replaced by the guarded 4-arg one below).
drop function if exists public.keel_recurring_reap_stale_suggestions(uuid, uuid, uuid[]);

create or replace function public.keel_recurring_reap_stale_suggestions(
  p_household_id uuid,
  p_run_id uuid,
  p_emitted_series_ids uuid[],
  p_detection_ran boolean
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_series record;
  v_candidate_id uuid;
  v_command_id uuid;
  v_reaped integer := 0;
  v_effective_date date := (now() at time zone 'utc')::date;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION: household not found' using errcode = 'P0006';
  end if;
  -- The run must belong to the household (fail closed on a forged/foreign run).
  if not exists (
    select 1 from public.recurring_detector_runs
    where id = p_run_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: detector run not in household' using errcode = 'P0006';
  end if;

  -- SAFETY GUARD (task problem 1): never reap on a run that did not genuinely
  -- detect anything. An empty emitted set from a zero-candidate detection is NOT
  -- proof that every prior suggestion is stale — it just means this run found
  -- nothing (all input excluded, or no input). Withdrawing everything there would
  -- nuke the whole Review list and idempotent detection would not restore it. So:
  --   * p_detection_ran = false  -> no-op (return 0).
  --   * emitted set empty          -> no-op (belt-and-suspenders: a genuine
  --                                    non-empty detection always emits >=1 id).
  if p_detection_ran is not true
     or coalesce(array_length(p_emitted_series_ids, 1), 0) = 0 then
    return 0;
  end if;

  for v_series in
    select s.id, s.current_candidate_version_id, s.status
    from public.recurring_series s
    where s.household_id = p_household_id
      and s.status = 'suggested'
      and not (s.id = any(p_emitted_series_ids))
  loop
    -- A status event needs a candidate_version_id; use the series' current one.
    -- A 'suggested' series always has one (upsert sets it on insert). Guard
    -- anyway: skip a row with no current candidate rather than violate NOT NULL.
    v_candidate_id := v_series.current_candidate_version_id;
    if v_candidate_id is null then
      continue;
    end if;

    -- Deterministic command_id -> idempotent reap. Same (run, series) always
    -- produces the same id, so the unique (household_id, series_id, command_id,
    -- transition) makes the event insert a no-op on replay.
    v_command_id := md5(
      'recurring-withdraw-stale:' || p_run_id::text || ':' || v_series.id::text
    )::uuid;

    insert into public.recurring_status_events
      (household_id, series_id, candidate_version_id, transition, effective_date,
       actor, command_id)
    values
      (p_household_id, v_series.id, v_candidate_id, 'withdrawn', v_effective_date,
       jsonb_build_object('kind','system','processName','recurring-detector',
                          'reason','stale_suggestion_not_redetected'),
       v_command_id)
    on conflict (household_id, series_id, command_id, transition) do nothing;

    -- Flip the materialized status only while still 'suggested' (idempotent: a
    -- second pass finds it already 'withdrawn' and updates zero rows).
    update public.recurring_series
       set status = 'withdrawn', updated_at = now()
     where household_id = p_household_id and id = v_series.id and status = 'suggested';

    if found then
      v_reaped := v_reaped + 1;
      insert into public.audit_log
        (household_id, actor, action, object_type, object_id, command_id, before, after)
      values
        (p_household_id,
         jsonb_build_object('kind','system','processName','recurring-detector'),
         'recurring.withdrawn', 'recurring_series', v_series.id, v_command_id,
         jsonb_build_object('seriesId', v_series.id, 'status', 'suggested'),
         jsonb_build_object('seriesId', v_series.id, 'status', 'withdrawn',
                            'reason', 'stale_suggestion_not_redetected', 'runId', p_run_id));
    end if;
  end loop;

  return v_reaped;
end;
$$;

-- keel_api-owned SECURITY DEFINER (mirrors the other reap procs). Grants are
-- re-asserted defensively so a fresh apply guarantees the reap can complete end to
-- end. The definer (keel_api) needs, and already has on live: SELECT households,
-- SELECT recurring_detector_runs (20260719070000), SELECT recurring_series,
-- INSERT recurring_status_events, column UPDATE(status,updated_at) on
-- recurring_series (20260712120000), INSERT audit_log. We re-assert the ones this
-- migration is responsible for; the column-UPDATE and status_events/audit inserts
-- are owned by earlier migrations and left intact.
grant create on schema public to keel_api;
alter function public.keel_recurring_reap_stale_suggestions(uuid, uuid, uuid[], boolean)
  owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_recurring_reap_stale_suggestions(uuid, uuid, uuid[], boolean)
  from public, anon, authenticated;
grant execute on function public.keel_recurring_reap_stale_suggestions(uuid, uuid, uuid[], boolean)
  to service_role;

-- Defensive re-assert of the definer's table grants (idempotent; all already true
-- on live). These are the exact privileges the reap body exercises.
grant select on public.recurring_detector_runs to keel_api;
grant select on public.recurring_series to keel_api;
grant update (status, updated_at) on public.recurring_series to keel_api;
grant insert on public.recurring_status_events to keel_api;
-- SELECT is required in addition to INSERT: the status-event write uses
-- INSERT ... ON CONFLICT DO NOTHING, and Postgres needs SELECT on the target to
-- evaluate the conflict arbiter. Already present on live; re-asserted defensively.
grant select on public.recurring_status_events to keel_api;
grant insert on public.audit_log to keel_api;
