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
-- ##  Idempotent (a second run suppresses ZERO additional rows, and the    ##
-- ##  re-anchor step below only touches an account that gained a NEW      ##
-- ##  suppression THIS run — so a repeat invocation is a true no-op, not   ##
-- ##  just zero-suppressions-with-silent-extra-audit-churn): the RPC's own ##
-- ##  advisory lock + "not already actively suppressed" candidate filter   ##
-- ##  make a repeat invocation of the suppression itself a no-op once      ##
-- ##  every eligible pair has been suppressed once.                        ##
-- ##                                                                       ##
-- ##  It depends on 20260725000000 (this fix's migration) having been      ##
-- ##  applied first: it needs regular_core_sweep_allowlist to already      ##
-- ##  carry a row for this connection (that migration seeds it, guarded by ##
-- ##  a `where exists` so it only takes effect once this connection row    ##
-- ##  actually exists in the target database) and the                     ##
-- ##  keel_reconcile_regular_core_sweeps/regular_core_sweep_suppressions   ##
-- ##  objects to exist.                                                    ##
-- ##                                                                       ##
-- ##  RE-ANCHOR STEP (live dry-run finding, added after the suppression    ##
-- ##  logic above was first written and proved correct on its own terms):  ##
-- ##  this account's opening-balance anchor was set earlier via            ##
-- ##  keel_cmd_reanchor_balance, reading Plaid's live                      ##
-- ##  balance_snapshots.current_minor, BEFORE this suppression existed —   ##
-- ##  computed under the OLD transaction history where each phantom-       ##
-- ##  REDEMPTION + real-TRANSFERRED pair already netted to zero on its     ##
-- ##  own. Retroactively voiding only the phantom half of an ALREADY-      ##
-- ##  anchored pair shifts the account's ledger total away from Plaid's    ##
-- ##  true balance, by the full magnitude of the voided leg. Confirmed     ##
-- ##  live (rolled-back dry run): an account that correctly summed to      ##
-- ##  $48.24 summed to -$39,956.92 immediately after suppressing 6 pairs,  ##
-- ##  then summed back to $48.24 the instant keel_cmd_reanchor_balance was ##
-- ##  re-run for it. So THIS script's FINAL step re-anchors every account  ##
-- ##  that gained at least one new active suppression during this run —   ##
-- ##  and only those accounts, so a repeat (already-suppressed) run does   ##
-- ##  not re-anchor anything and stays a true no-op.                       ##
-- ##                                                                       ##
-- ##  Why investment_flow_backfill.sql did NOT need this: its suppression  ##
-- ##  voids one self-contained 2-leg batch (the account's own leg + its    ##
-- ##  offset leg) that always nets to zero entirely on its own — nothing   ##
-- ##  else in the ledger was ever counting on that batch's magnitude, so   ##
-- ##  voiding it cannot move Σ(postings) away from a previously-anchored   ##
-- ##  target. THIS fix's suppression is asymmetric ACROSS TWO SEPARATE     ##
-- ##  transactions (the phantom REDEMPTION/PURCHASE/REINVESTMENT candidate ##
-- ##  and the real TRANSFERRED/deposit counterpart): only the candidate's  ##
-- ##  batch is voided, the counterpart's stays live, so Σ(postings) moves  ##
-- ##  by the candidate's full magnitude — exactly the gap an anchor        ##
-- ##  computed under the old (unsuppressed) history needs corrected. A     ##
-- ##  future engineer touching either backfill: the question to ask is    ##
-- ##  "does this suppression's own batch net to zero by itself, or does it ##
-- ##  depend on a live counterpart transaction elsewhere?" — only the      ##
-- ##  latter needs a re-anchor. See NOTES.md for the full before/after     ##
-- ##  live-dry-run numbers.                                                ##
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
  v_owner_user_id uuid;
  v_reanchor_result jsonb;
  v_final_ledger_sum bigint;
  v_reanchored_count int := 0;
  r_acct record;
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

  -- Snapshot ACTIVE suppression counts per account under this connection
  -- BEFORE the reconcile call, keyed by account_id (not just this one known
  -- cash-management account) so a future connection with several cash-
  -- management accounts only re-anchors the ones actually touched by THIS
  -- run. Dropped automatically at transaction end (--single-transaction).
  create temp table tmp_core_sweep_reanchor_accounts (
    account_id uuid primary key,
    before_active_suppressions int not null,
    after_active_suppressions int
  ) on commit drop;

  insert into tmp_core_sweep_reanchor_accounts (account_id, before_active_suppressions)
  select a.id, count(s.id)
    from public.accounts a
    left join public.regular_core_sweep_suppressions s
      on s.account_id = a.id and s.released_at is null
   where a.household_id = v_household and a.connection_id = v_connection
   group by a.id;

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

  -- -------------------------------------------------------------------------
  -- Re-anchor step (see header comment for why this backfill needs it and
  -- investment_flow_backfill.sql does not). Snapshot the AFTER counts, then
  -- re-anchor every account whose active-suppression count actually changed
  -- this run — never an account with zero new suppressions, so a repeat run
  -- against an already-suppressed connection re-anchors nothing.
  -- -------------------------------------------------------------------------
  update tmp_core_sweep_reanchor_accounts t
     set after_active_suppressions = sub.cnt
    from (
      select a.id as account_id, count(s.id) as cnt
        from public.accounts a
        left join public.regular_core_sweep_suppressions s
          on s.account_id = a.id and s.released_at is null
       where a.household_id = v_household and a.connection_id = v_connection
       group by a.id
    ) sub
   where t.account_id = sub.account_id;

  -- keel_cmd_reanchor_balance derives the trusted actor from
  -- request.jwt.claim.sub via keel_actor_from_jwt() (p_actor is ignored — a
  -- forgery guard) and keel_assert_member_write requires an owner/partner
  -- role. Outside a real HTTP request there is no JWT, so we simulate the
  -- household owner's JWT for the duration of each call, exactly the
  -- precedent already used for the one-off Chase-checking manual re-anchor
  -- documented in NOTES.md (`set_config('request.jwt.claim.sub', ..., true)`
  -- — session-local, not persisted beyond this transaction).
  select m.user_id into v_owner_user_id
    from public.household_memberships m
   where m.household_id = v_household and m.role = 'owner'
   order by m.created_at
   limit 1;
  if v_owner_user_id is null then
    select m.user_id into v_owner_user_id
      from public.household_memberships m
     where m.household_id = v_household and m.role = 'partner'
     order by m.created_at
     limit 1;
  end if;

  for r_acct in
    select account_id, before_active_suppressions, after_active_suppressions
      from tmp_core_sweep_reanchor_accounts
     where after_active_suppressions is distinct from before_active_suppressions
     order by account_id
  loop
    if v_owner_user_id is null then
      -- Hard failure by design (not a skip/swallow): leaving a wrong ledger
      -- sum on an account we just know is wrong is worse than aborting the
      -- whole backfill for a human to fix the membership and re-run.
      raise exception
        'regular core-sweep backfill: account % gained new suppressions (% -> %) and MUST be '
        're-anchored, but household % has no owner/partner membership to act as the reanchor '
        'command actor -- refusing to leave the ledger sum wrong; add/fix the membership and '
        're-run this script',
        r_acct.account_id, r_acct.before_active_suppressions, r_acct.after_active_suppressions,
        v_household;
    end if;

    perform set_config('request.jwt.claim.sub', v_owner_user_id::text, true);

    -- No exception handler around this call (deliberate): if
    -- keel_cmd_reanchor_balance raises for its own documented reasons (most
    -- notably "no provider balance snapshot yet; refresh balances before
    -- re-anchoring" when balance_snapshots has no row for this account), that
    -- must abort this entire script rather than leave a known-wrong balance
    -- un-corrected. ON_ERROR_STOP + --single-transaction (per this script's
    -- header) already roll back everything above on any uncaught error.
    v_reanchor_result := public.keel_cmd_reanchor_balance(
      gen_random_uuid(),
      'core-sweep-backfill-reanchor:' || r_acct.account_id::text,
      '{}'::jsonb,
      v_household,
      jsonb_build_object('account_id', r_acct.account_id)
    );

    select coalesce(sum(p.amount_minor), 0) into v_final_ledger_sum
      from public.journal_postings p
      join public.accounts a on a.ledger_account_id = p.ledger_account_id
     where a.id = r_acct.account_id;

    v_reanchored_count := v_reanchored_count + 1;
    raise notice
      'regular core-sweep backfill: re-anchored account % (active suppressions % -> %) -- '
      'confirmed post-reanchor ledger sum = % minor; rpc_result=%',
      r_acct.account_id, r_acct.before_active_suppressions, r_acct.after_active_suppressions,
      v_final_ledger_sum, v_reanchor_result;
  end loop;

  raise notice
    'regular core-sweep backfill: total accounts re-anchored this run = %', v_reanchored_count;
end $$;
