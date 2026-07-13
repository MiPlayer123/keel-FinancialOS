-- Batch-8 adversarial-review follow-up: the schedule proc family
-- (keel_schedule_save/set_status/advance/enter, keel_list_schedules) was
-- still owned by the migration runner (postgres — a cluster superuser on
-- this instance). A SECURITY DEFINER body running with superuser privileges
-- is a needlessly large blast radius: any bug in these bodies could touch
-- ANY table in the cluster, not just the ones the proc is meant to reach.
-- Re-own the family to keel_api (the house definer role for user-facing
-- command procs — see 20260710210500_grants_rls.sql, 20260712120000_recurring.sql,
-- 20260713100000_manual_transactions.sql for the established pattern).
--
-- Investigated on scratch (keel9a) before writing this:
--   * household_memberships, accounts, ledger_accounts, audit_log already
--     have `grant select, insert ... to keel_api` (20260710210500) AND a
--     keel_api definer_all RLS policy from the same migration's do-block —
--     nothing new needed for those four.
--   * scheduled_transactions (created 20260713140000, after that grants
--     pass) has NEITHER a keel_api table grant NOR a keel_api RLS policy —
--     relacl was `{postgres=arwdDxt/postgres,authenticated=r/postgres,
--     keel_export=r/postgres}` and its only policies were
--     scheduled_transactions_export (keel_export) and
--     scheduled_transactions_member_read (authenticated). Re-owning the
--     procs WITHOUT fixing this would break every one of them the moment
--     keel_api stops being a superuser-owned body — this migration adds
--     both.
--   * keel_cmd_manual_transaction (called from keel_schedule_enter) is
--     already owned by keel_api with proacl
--     `keel_api=X/keel_api,authenticated=X/keel_api,postgres=X/keel_api` —
--     as owner, keel_api already holds implicit EXECUTE on it and on
--     keel_schedule_advance (called from keel_schedule_enter, also re-owned
--     below) regardless of ACL rows. Restated explicitly anyway per house
--     style (belt-and-suspenders, matches the comment already left in
--     20260713160000_schedule_enter.sql for the postgres case).
--
-- ACL note: PostgreSQL ALTER FUNCTION ... OWNER TO does not touch the
-- function's ACL (GRANT/REVOKE rows) — EXECUTE privileges granted to
-- authenticated/service_role survive the ownership change unchanged. We
-- restate them below anyway (house style: every ownership migration in this
-- repo re-issues the ACL statements so grants are legible at the point of
-- ownership, not just inherited silently).

-- ---------------------------------------------------------------------------
-- 1. scheduled_transactions: grant the table privileges the five proc bodies
-- actually use (select/insert/update — no proc ever deletes a schedule row;
-- ended schedules are soft-state via status, per Law 2) and add a keel_api
-- definer_all RLS policy matching the house pattern (20260710210500's
-- do-block, 20260712120000's recurring_series_definer_all,
-- 20260713100000's transaction_categories_definer_all).
-- ---------------------------------------------------------------------------
grant select, insert, update on public.scheduled_transactions to keel_api;

drop policy if exists scheduled_transactions_definer_all on public.scheduled_transactions;
create policy scheduled_transactions_definer_all on public.scheduled_transactions
  for all to keel_api using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 2. Re-own the five procs. OWNER TO does not touch GRANT/REVOKE state, so
-- the existing `grant execute ... to authenticated` (and `to service_role`
-- for keel_list_schedules) rows are untouched by this step alone — restated
-- explicitly in step 3 anyway.
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer)
  owner to keel_api;
alter function public.keel_schedule_set_status(uuid,uuid,text)
  owner to keel_api;
alter function public.keel_schedule_advance(uuid,uuid,date,text)
  owner to keel_api;
alter function public.keel_schedule_enter(uuid,uuid,date)
  owner to keel_api;
alter function public.keel_list_schedules(uuid)
  owner to keel_api;
revoke create on schema public from keel_api;

-- ---------------------------------------------------------------------------
-- 3. Restate EXECUTE ACLs (belt-and-suspenders; ACLs already survived the
-- ownership change above, this just keeps the grants legible in the
-- migration that changed ownership rather than relying on inheritance from
-- an earlier file).
-- ---------------------------------------------------------------------------
revoke all on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer)
  from public, anon;
grant execute on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer)
  to authenticated;

revoke all on function public.keel_schedule_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_schedule_set_status(uuid,uuid,text) to authenticated;

revoke all on function public.keel_schedule_advance(uuid,uuid,date,text) from public, anon;
grant execute on function public.keel_schedule_advance(uuid,uuid,date,text) to authenticated;

revoke all on function public.keel_schedule_enter(uuid,uuid,date) from public, anon;
grant execute on function public.keel_schedule_enter(uuid,uuid,date) to authenticated;

revoke all on function public.keel_list_schedules(uuid) from public, anon;
grant execute on function public.keel_list_schedules(uuid) to authenticated, service_role;

-- Nested calls inside keel_schedule_enter: keel_cmd_manual_transaction and
-- keel_schedule_advance are both owned by keel_api after this migration, so
-- keel_api already has implicit EXECUTE as owner — restated explicitly so a
-- future re-owning of either callee doesn't silently strand this call.
grant execute on function public.keel_cmd_manual_transaction(uuid,text,jsonb,uuid,jsonb) to keel_api;
grant execute on function public.keel_schedule_advance(uuid,uuid,date,text) to keel_api;
