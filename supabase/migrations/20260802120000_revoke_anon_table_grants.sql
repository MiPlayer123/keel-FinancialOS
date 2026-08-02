-- ---------------------------------------------------------------------------
-- Re-assert the anon/authenticated grant floor (INFRA.md secret boundary;
-- supabase/tests/002_rls_grants.sql "anon has no grants at all on public
-- tables"). That pgTAP assertion has been RED since ~2026-07-21 and was
-- invisible while `supabase start` was broken, so the drift went unnoticed.
--
-- Root cause: 20260710210500_grants_rls.sql revokes anon/authenticated in bulk,
-- but `revoke all on ALL TABLES IN SCHEMA public` only affects tables that
-- exist AT THAT MOMENT. Every table created afterwards silently inherits
-- Supabase's default public-schema grants (full DML to anon AND authenticated).
-- 20260720210000_statement_outbox.sql granted keel_api/keel_worker but never
-- ran the per-table `revoke ... from anon, authenticated` ritual that
-- e.g. 20260710210700 and 20260711120000 use, so it kept the defaults.
--
-- Observed on the live project before this migration: anon held all 7 privs
-- (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) on
-- statement_outbox plus the three ad-hoc zz_bak_*_20260719 backup tables
-- (which hold REAL rows: 1422 categories, 171 ledger accounts). Not
-- exploitable — RLS is enabled on all four and none has an anon-reachable
-- policy, so it was default-deny — but RLS was the ONLY thing standing in the
-- way, and the grant floor is supposed to be the outer layer of that defence.
-- Every other table shows the intended shape: authenticated = SELECT only,
-- gated by RLS; anon = nothing.
--
-- Idempotent: REVOKE is a no-op when the privilege is already absent.
-- ---------------------------------------------------------------------------

-- 1. anon must hold NO table grant anywhere. This also covers any future table
--    that inherited the defaults before its own revoke ritual ran.
revoke all on all tables in schema public from anon;

-- 2. Strip the inherited WRITE grants from authenticated on the four drifted
--    tables, restoring the SELECT-only-and-RLS-gated shape used everywhere
--    else. statement_outbox is an internal transactional outbox (written by
--    the api function as keel_api, swept as keel_worker) — no client role has
--    any business writing it.
revoke insert, update, delete, truncate, references, trigger
  on public.statement_outbox from authenticated;

-- 3. The zz_bak_* tables were created ad-hoc against the live project during
--    the 2026-07-19 recategorization; no migration creates them, so they are
--    absent on a fresh reset. Guard with to_regclass (the pattern CLAUDE.md
--    mandates for non-idempotent statements) so this migration is safe both
--    on live and in CI.
do $$
declare
  v_tbl text;
begin
  foreach v_tbl in array array[
    'zz_bak_ledger_accounts_20260719',
    'zz_bak_txn_categories_20260719',
    'zz_bak_txn_overrides_20260719'
  ] loop
    if to_regclass('public.' || v_tbl) is not null then
      execute format('revoke all on public.%I from anon, authenticated', v_tbl);
    end if;
  end loop;
end $$;
