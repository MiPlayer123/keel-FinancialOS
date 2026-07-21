-- ###########################################################################
-- ##  REVIEW BEFORE APPLYING — data migration on the LIVE ledger.          ##
-- ##                                                                       ##
-- ##  DELIBERATELY LIVES OUTSIDE supabase/migrations/ (per                 ##
-- ##  20260725000000_regular_core_sweep_suppression.sql and the same       ##
-- ##  precedent as scripts/backfills/investment_flow_backfill.sql): the    ##
-- ##  Supabase GitHub integration auto-applies everything under            ##
-- ##  supabase/migrations/ on merge to main (see deploy-functions.yml      ##
-- ##  header comment). A backfill that VOIDS live ledger transactions must ##
-- ##  NEVER be able to run un-reviewed just because a PR merged — apply it ##
-- ##  by hand: `source supabase/.env.remote && psql                       ##
-- ##  "postgresql://postgres@db.<ref>.supabase.co:5432/postgres"          ##
-- ##  -v ON_ERROR_STOP=1 --single-transaction -f                          ##
-- ##  scripts/backfills/regular_core_sweep_backfill.sql` (per CLAUDE.md    ##
-- ##  ops facts — no local Docker step; this project applies migrations   ##
-- ##  straight to the live cloud project).                                ##
-- ##                                                                       ##
-- ##  This script does NOT duplicate the candidate/pairing predicate: it   ##
-- ##  calls the SAME `keel_reconcile_regular_core_sweeps` RPC the worker    ##
-- ##  calls at the end of every sync attempt and during the periodic       ##
-- ##  refresh-balances cycle. It is scoped to the ONE reviewed, evidenced  ##
-- ##  connection (household a1ba3759-b7a7-4880-93e2-49eb6f91636c,          ##
-- ##  connection 7e9bdccf-8fdc-4bdd-9805-5f3d4ac526e6 — the live Fidelity  ##
-- ##  cash-management connection, confirmed via live data: distinct paired ##
-- ##  Plaid transaction ids, same date, exactly offsetting amounts, one    ##
-- ##  row causing a mid-list -$24,951.76 register balance on an account    ##
-- ##  whose true balance is $48.24). It writes compensating REVERSAL       ##
-- ##  batches (Law 2) and NEVER UPDATEs/DELETEs prior postings — it VOIDS  ##
-- ##  (status='voided', voided_at) and records a suppression provenance    ##
-- ##  row, exactly like the go-forward sync/periodic call sites.          ##
-- ##                                                                       ##
-- ##  Idempotent (a second run suppresses ZERO additional rows): the RPC's ##
-- ##  own advisory lock + "not already actively suppressed" candidate      ##
-- ##  filter make a repeat invocation a no-op once every eligible pair has ##
-- ##  been suppressed once.                                               ##
-- ##                                                                       ##
-- ##  It depends on 20260725000000 (this fix's migration) having been      ##
-- ##  applied first: it needs regular_core_sweep_allowlist to already      ##
-- ##  carry a row for this connection (that migration seeds it, guarded by ##
-- ##  a `where exists` so it only takes effect once this connection row    ##
-- ##  actually exists in the target database) and the                     ##
-- ##  keel_reconcile_regular_core_sweeps/regular_core_sweep_suppressions   ##
-- ##  objects to exist.                                                    ##
-- ###########################################################################

do $$
declare
  v_household  uuid := 'a1ba3759-b7a7-4880-93e2-49eb6f91636c';
  v_connection uuid := '7e9bdccf-8fdc-4bdd-9805-5f3d4ac526e6';
  v_before_active_suppressions int;
  v_before_voided_regular_sync int;
  v_result jsonb;
  v_after_active_suppressions int;
  v_after_voided_regular_sync int;
begin
  if not exists (
    select 1 from public.connections c
     where c.id = v_connection and c.household_id = v_household
  ) then
    raise exception
      'regular core-sweep backfill: connection % not found in household % on this database — '
      'refusing to run (this script targets ONE specific live connection; a missing row here '
      'means you are pointed at the wrong database)',
      v_connection, v_household;
  end if;

  if not exists (
    select 1 from public.regular_core_sweep_allowlist a
     where a.household_id = v_household and a.connection_id = v_connection
  ) then
    raise exception
      'regular core-sweep backfill: connection % is not on regular_core_sweep_allowlist — '
      'apply migration 20260725000000_regular_core_sweep_suppression.sql first (its seed insert '
      'targets exactly this household/connection pair).',
      v_connection;
  end if;

  select count(*) into v_before_active_suppressions
    from public.regular_core_sweep_suppressions
   where household_id = v_household and connection_id = v_connection and released_at is null;

  select count(*) into v_before_voided_regular_sync
    from public.canonical_transactions ct
    join public.accounts acc on acc.id = ct.account_id
   where ct.household_id = v_household
     and acc.connection_id = v_connection
     and ct.source = 'sync'
     and ct.voided_at is not null;

  -- The reconcile RPC itself does all detection + pairing + suppression;
  -- this script only reports before/after, per the migration's design (do
  -- NOT duplicate the candidate/pairing predicate in a second copy here).
  v_result := public.keel_reconcile_regular_core_sweeps(v_household, v_connection);

  select count(*) into v_after_active_suppressions
    from public.regular_core_sweep_suppressions
   where household_id = v_household and connection_id = v_connection and released_at is null;

  select count(*) into v_after_voided_regular_sync
    from public.canonical_transactions ct
    join public.accounts acc on acc.id = ct.account_id
   where ct.household_id = v_household
     and acc.connection_id = v_connection
     and ct.source = 'sync'
     and ct.voided_at is not null;

  raise notice
    'regular core-sweep backfill: before_active_suppressions=% after_active_suppressions=% '
    'before_voided_sync_txns=% after_voided_sync_txns=% rpc_result=%',
    v_before_active_suppressions, v_after_active_suppressions,
    v_before_voided_regular_sync, v_after_voided_regular_sync, v_result;
  raise notice
    'regular core-sweep backfill summary: suppressed=% candidatesConsidered=% '
    'excludedByPolicy=% ambiguousSkipped=%',
    v_result->>'suppressed', v_result->>'candidatesConsidered',
    v_result->>'excludedByPolicy', v_result->>'ambiguousSkipped';
end $$;
