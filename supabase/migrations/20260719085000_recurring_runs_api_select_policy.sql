-- fix(recurring) 4/4: let the reap (keel_api-owned) SEE detector runs under RLS.
--
-- Final live blocker behind the stale-suggestion reap. After the grant fixes
-- (20260719082000/084000) the reap still raised
--   KEEL_SCOPE_VIOLATION: detector run not in household
-- for a run that provably exists. Root cause: recurring_detector_runs has RLS
-- enabled with permissive policies ONLY for keel_worker (recurring_runs_worker_all,
-- ALL using true) and keel_export (recurring_runs_export, SELECT using true). The
-- reap keel_recurring_reap_stale_suggestions is SECURITY DEFINER owned by keel_api
-- (20260719082000). keel_api holds the table SELECT grant but has NO row policy on
-- this table, so its guard `select 1 from recurring_detector_runs where id=$run` is
-- filtered to zero rows and fails closed. (keel_api already has working RLS on
-- recurring_series and recurring_status_events — that is how user confirm/reject of
-- recurring series persists — so this internal bookkeeping table is the only gap.)
--
-- Minimal fix: a SELECT-only policy for keel_api mirroring the existing keel_export
-- one. keel_api is an internal service role that owns the reap; it only needs to
-- read a run row to scope-check it. No write policy is added (the reap does not
-- write this table). CREATE POLICY is not idempotent (CLAUDE.md ops fact) — pre-drop.

drop policy if exists recurring_runs_api_select on public.recurring_detector_runs;
create policy recurring_runs_api_select
  on public.recurring_detector_runs
  for select
  to keel_api
  using (true);
