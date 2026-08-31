-- Balance snapshot write amplification, phase 1: stop writing snapshots that
-- say nothing new. docs/BALANCE-SNAPSHOT-COMPACTION.md §3 phase 1.
--
-- The problem, measured on the live project: keel-drain-sync runs every 3
-- minutes and keel_apply_account_balance wrote a snapshot per account per
-- cycle whether or not the balance moved. 186,889 rows for 16 snapshot-bearing
-- accounts, 50 MB, 26% of the database, growing 4,320 rows/day, of which
-- 99.94% repeat their predecessor exactly.
--
-- That is not merely storage. keel_latest_balances and
-- keel_investments_overview both read the latest row per account with
-- `distinct on (account_id) ... order by as_of desc`, which has no index-skip
-- scan available, so their cost is LINEAR in snapshot count. EXPLAIN on the
-- live household: 186,889 rows and 87,233 buffers scanned to return 10 rows,
-- 2.06 s. Those are the two slowest surfaces a real user hits.
--
-- Two things this migration is careful about, both found by an adversarial
-- audit of the proposal rather than by writing the obvious version:
--
--   1. The guard wraps ONLY the INSERT. keel_apply_account_balance runs
--      mask backfill -> snapshot insert -> last_successful_sync_at gate ->
--      opening-balance-exists check -> book the anchor. Writing this as an
--      early `return` would also skip the anchor: an account linked while its
--      balance is static would insert once, return early because the sync had
--      not completed, and then return early forever because the value never
--      changed -- so its opening balance would NEVER be booked and its ledger
--      balance would stay wrong permanently. Two live accounts have gone 43+
--      days without a value change, so this was reachable, not theoretical.
--
--   2. Comparison is NULL-SAFE (`is distinct from`). 149,481 of 186,871 rows
--      have a null limit_minor and 43,609 a null available_minor. Measured
--      over the real table, `=` identifies 20.0% of rows as duplicates;
--      `is not distinct from` identifies 99.94%. Written with `=` this
--      migration would have kept four fifths of the amplification.
--
-- Law 4 (no implicit defaults) and Law 2 are unaffected: this changes only
-- whether a redundant row is written. Nothing is deleted here; compaction of
-- the existing 186k rows is phase 2 and is deliberately a separate change.

-- ---------------------------------------------------------------------------
-- 1. Preserve "when did we last confirm this balance?"
--
--    as_of is the observation instant. Once repeats stop being written, the
--    newest row's as_of silently becomes "the instant the value last CHANGED",
--    so "unchanged since 18 July" and "not checked since 18 July" become
--    indistinguishable. keel_apply_account_balance's own comment says
--    snapshots exist for "future reconciliation", and reconciliation wants
--    "the provider asserted X at time T".
--
--    Keeping the confirmation instant on the account costs one column and one
--    in-place update per cycle, instead of a row per cycle forever, and means
--    phase 1 loses no information at all.
-- ---------------------------------------------------------------------------
alter table public.accounts
  add column if not exists balance_last_observed_at timestamptz;

comment on column public.accounts.balance_last_observed_at is
  'When the provider last CONFIRMED this account''s balance, changed or not. '
  'balance_snapshots only records changes (20260831190000), so this is the '
  'freshness signal; a snapshot''s as_of is the instant a value first appeared.';

-- Seed from what the existing snapshots already prove, so the column is not
-- null for accounts that have been syncing all along. Safe to re-run.
update public.accounts a
   set balance_last_observed_at = s.max_as_of
  from (
    select bs.account_id, max(bs.as_of) as max_as_of
      from public.balance_snapshots bs
     group by bs.account_id
  ) s
 where s.account_id = a.id
   and a.balance_last_observed_at is distinct from s.max_as_of;

-- ---------------------------------------------------------------------------
-- 2. The writer, with the insert guarded and everything after it untouched.
-- ---------------------------------------------------------------------------
create or replace function public.keel_apply_account_balance(
  p_household_id uuid,
  p_account_id uuid,
  p_current_minor bigint,
  p_available_minor bigint,
  p_currency text,
  p_as_of timestamp with time zone,
  p_limit_minor bigint default null::bigint,
  p_mask text default null::text
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ledger        uuid;
  v_entity        uuid;
  v_curr          char(3);
  v_kind          public.ledger_account_kind;
  v_opening_ledger uuid;
  v_target        bigint;
  v_current_sum   bigint;
  v_opening       bigint;
  v_batch         uuid;
  v_has_opening   boolean;
  v_connection_id uuid;
  v_sync_done     timestamptz;
  v_effective_currency text;
  v_last          public.balance_snapshots%rowtype;
  v_found         boolean;
begin
  select a.ledger_account_id, a.entity_id, a.currency, a.connection_id
    into v_ledger, v_entity, v_curr, v_connection_id
    from public.accounts a
    where a.id = p_account_id and a.household_id = p_household_id;
  if v_ledger is null then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;
  select kind into v_kind from public.ledger_accounts where id = v_ledger;

  -- Mask backfill (D-050 residual fix): every refresh cycle, not just link
  -- time. Never clears an existing mask — only fills it in or updates it
  -- when the provider actually reports a non-empty value this cycle.
  if p_mask is not null and p_mask <> '' then
    update public.accounts set mask = p_mask where id = p_account_id and mask is distinct from p_mask;
  end if;

  v_effective_currency := coalesce(nullif(p_currency, ''), v_curr);

  -- Freshness: recorded EVERY cycle, whether or not a snapshot follows. This
  -- is what keeps "last confirmed" knowable once repeats stop being stored.
  update public.accounts
     set balance_last_observed_at = greatest(coalesce(balance_last_observed_at, p_as_of), p_as_of)
   where id = p_account_id
     and balance_last_observed_at is distinct from
         greatest(coalesce(balance_last_observed_at, p_as_of), p_as_of);

  -- Provider snapshot (history for trend + future reconciliation + re-anchor).
  -- Written only when it differs from the newest row of this account's series,
  -- compared NULL-safely. `id desc` breaks as_of ties deterministically:
  -- as_of is the edge function's own wall clock and carries no unique
  -- constraint, so ties are possible even though the live table has none.
  select * into v_last
    from public.balance_snapshots bs
   where bs.household_id = p_household_id
     and bs.account_id = p_account_id
     and bs.source = 'plaid'
   order by bs.as_of desc, bs.id desc
   limit 1;
  v_found := found;

  if not v_found
     or v_last.current_minor      is distinct from p_current_minor
     or v_last.available_minor    is distinct from p_available_minor
     or v_last.limit_minor        is distinct from p_limit_minor
     or v_last.currency           is distinct from v_effective_currency
     -- snapshot_metadata is hardcoded '{}' by every writer today, but it is an
     -- exported column: if anything ever populates it, that is new information
     -- and must not be collapsed away.
     or v_last.snapshot_metadata  is distinct from '{}'::jsonb
  then
    insert into public.balance_snapshots
      (household_id, account_id, as_of, available_minor, current_minor, limit_minor,
       currency, source, snapshot_metadata)
    values
      (p_household_id, p_account_id, p_as_of, p_available_minor, p_current_minor, p_limit_minor,
       v_effective_currency, 'plaid', '{}'::jsonb);
  end if;

  -- EVERYTHING BELOW THIS LINE RUNS WHETHER OR NOT A SNAPSHOT WAS WRITTEN.
  -- The guard above is an `if` around one INSERT, deliberately not an early
  -- return: the opening-balance anchor lives past two `return`s down there and
  -- must still be reachable on a cycle whose balance did not move.

  -- Defer the one-time anchor until the connection's first full sync has
  -- completed, so the backfilled window is already in Σ(postings) when we take
  -- the delta. A provider-connected account with no completed sync yet skips
  -- the anchor this cycle; a later refresh (after the backfill lands) books it
  -- correctly. Accounts without a connection (manual) are never gated.
  if v_connection_id is not null then
    select last_successful_sync_at into v_sync_done
      from public.connections where id = v_connection_id;
    if v_sync_done is null then
      return;
    end if;
  end if;

  select id into v_opening_ledger
    from public.ledger_accounts
    where entity_id = v_entity and name = 'Opening Balances' and archived_at is null;
  if v_opening_ledger is null then
    raise exception 'KEEL_INVALID_COMMAND: opening balances account missing' using errcode = 'P0009';
  end if;

  -- Opening balance is booked once. The unambiguous marker for "this account
  -- already has an opening entry" is a live (non-reversal) batch touching BOTH
  -- this account's own ledger account AND the entity's Opening Balances equity
  -- account -- a manual transfer moves between two real asset/liability
  -- accounts and never touches equity, so it can't satisfy both.
  select exists (
    select 1
      from public.journal_batches b
      where b.household_id = p_household_id
        and b.canonical_transaction_id is null
        and b.reverses_batch_id is null
        and exists (
          select 1 from public.journal_postings p
          where p.batch_id = b.id and p.ledger_account_id = v_ledger
        )
        and exists (
          select 1 from public.journal_postings p2
          where p2.batch_id = b.id and p2.ledger_account_id = v_opening_ledger
        )
  ) into v_has_opening;
  if v_has_opening then
    return;
  end if;

  v_target := case when v_kind = 'liability' then -p_current_minor else p_current_minor end;
  select coalesce(sum(amount_minor), 0) into v_current_sum
    from public.journal_postings where ledger_account_id = v_ledger;
  v_opening := v_target - v_current_sum;
  if v_opening = 0 then
    return;
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id, posted_at)
  values
    (p_household_id, null, 'Opening balance', current_date, gen_random_uuid(), now())
  returning id into v_batch;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values
    (v_batch, v_ledger,         v_entity,  v_opening, v_effective_currency),
    (v_batch, v_opening_ledger, v_entity, -v_opening, v_effective_currency);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Re-assert the execute lockdown from 20260718104500.
--
--    CREATE OR REPLACE FUNCTION preserves privileges, so this is belt and
--    braces rather than a fix -- but this function is SECURITY DEFINER with no
--    internal authz (it is worker-only by contract), and it was once granted to
--    PUBLIC/anon/authenticated by default. Restating the lockdown beside every
--    redefinition means the file cannot be the one that quietly reopens it.
-- ---------------------------------------------------------------------------
revoke all on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)
  from public, anon, authenticated;
grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)
  to service_role;
