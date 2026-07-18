-- Second-round codex finding on PR #60: keel_worker_complete_attempt is
-- owned by keel_worker (SECURITY DEFINER), but keel_worker's column-scoped
-- UPDATE grant on connections (20260711130000_c5b_sync_pull.sql:489-491)
-- predates the sync_continuation_pending/sync_continuation_marked_at
-- columns added in 20260718101500. Without this grant, the function's own
-- UPDATE statement fails with a permission error the moment ANY sync
-- attempt completes -- breaking every Plaid sync, not just the reanchor
-- guard this was meant to fix. Confirmed live: keel_worker had SELECT but
-- not UPDATE on both new columns before this migration; no real sync had
-- completed against the broken worker deploy yet (checked sync_attempts
-- timestamps against the deploy time), so this was caught before it could
-- actually break anything in production. Verified the fix by calling
-- keel_worker_complete_attempt end-to-end (synthetic lease + attempt, in a
-- rolled-back transaction) both before (permission denied) and after
-- (succeeds, sync_continuation_pending flips correctly) this grant.
grant update (sync_continuation_pending, sync_continuation_marked_at)
  on public.connections to keel_worker;
