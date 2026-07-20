-- Fix: keel_recurring_reclassify_cadence (PR #139, migration 20260723020000) is
-- SECURITY DEFINER owned by keel_api, but keel_api was never granted the writes
-- the command performs on the detector tables. It was authored/tested on a
-- throwaway PG where keel_api had broader access; on the live cloud project the
-- command fails at runtime — so the "Fix schedule" UI (recurring.reclassify_cadence)
-- is broken for every user, not just an orchestrator probe.
--
-- Exact gaps (confirmed live via has_table_privilege + a SET ROLE keel_api probe):
--   * recurring_detector_runs   — keel_api has INSERT,SELECT table grants but only
--       a SELECT RLS policy (recurring_runs_api_select). The command does
--       `INSERT ... ON CONFLICT DO UPDATE`, which RLS blocks ("new row violates
--       row-level security policy", 42501). Needs UPDATE grant + a write RLS policy.
--   * recurring_candidate_versions — RLS already has an ALL policy for keel_api
--       (recurring_candidates_definer_all) but the TABLE grant is SELECT-only, so
--       INSERT is "permission denied". Needs INSERT grant.
--   * recurring_series — RLS already ALL for keel_api (recurring_series_definer_all)
--       but the TABLE grant is SELECT-only; the command UPDATEs
--       current_candidate_version_id. Needs UPDATE grant.
--
-- recurring_occurrences already has both (INSERT,SELECT grant + api_all policy) —
-- left unchanged. Every write still flows through the SECURITY DEFINER command,
-- which calls keel_assert_member_write(p_household_id) first, so the with-check(true)
-- policy mirrors the existing recurring_occurrences_api_all / statement_outbox_api_all
-- pattern (the command layer is the tenant gate, not the RLS row filter).
-- Idempotent: grants are no-ops if present; policy create guarded by pg_policies.

grant update on public.recurring_detector_runs to keel_api;
grant insert on public.recurring_candidate_versions to keel_api;
grant update on public.recurring_series to keel_api;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='recurring_detector_runs' and policyname='recurring_runs_api_write') then
    create policy recurring_runs_api_write on public.recurring_detector_runs
      for all to keel_api using (true) with check (true);
  end if;
end$$;
