-- Seventh-round codex finding on PR #60, P1 -- and the most severe of the
-- night: keel_apply_account_balance (SECURITY DEFINER, owned by
-- keel_worker, no keel_assert_member_write or any auth check inside --
-- it's designed to be called ONLY by the trusted worker context) had
-- EXECUTE granted to PUBLIC, anon, AND authenticated. Confirmed live via
-- information_schema.routine_privileges before writing this fix. Any
-- caller with the publishable (anon) key, or any authenticated user,
-- could RPC this function directly with an arbitrary p_household_id /
-- p_account_id and write a fake balance_snapshots row and/or book a fake
-- opening-balance journal entry for ANY household's account -- a
-- cross-tenant financial-integrity hole, not just an authz gap.
--
-- Root cause: 20260712190000_account_balances.sql's original `grant
-- execute ... to service_role` never paired it with the `revoke all ...
-- from public, anon, authenticated` this codebase uses everywhere else
-- for worker-only SECURITY DEFINER functions (e.g.
-- keel_worker_complete_attempt) -- PostgreSQL grants EXECUTE to PUBLIC by
-- default on function creation, and an ADDITIONAL grant to service_role
-- does not remove that. Every subsequent create-or-replace/new-overload
-- (credit_limit.sql's 7-arg version, account_mask.sql's 8-arg version)
-- inherited the same gap, and PR #60's own drop of the now-orphaned 7-arg
-- overload (20260718103000) left the vulnerable 8-arg version as the
-- sole remaining implementation -- not the cause of the vulnerability,
-- but it made this the only path, so it's fixed as part of this PR
-- rather than left for a separate one.
revoke all on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)
  from public, anon, authenticated;
grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)
  to service_role;
