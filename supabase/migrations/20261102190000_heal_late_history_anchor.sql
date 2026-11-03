-- Stage 2 / gate 5 (reproducible numbers) + gate 1 (balanced postings):
-- heal the opening-balance anchor when Plaid's historical backfill lands
-- AFTER it was booked. BC-v2.1 §9.1 invariants "reproducible numbers" and
-- "idempotent economics"; Law 2 (compensating events, never mutation);
-- Law 3 (Σ=0 per batch).
--
-- Root cause (Ray's household 9ba6a349, 2026-10-30; same pattern behind the
-- ~26 manual "Fix balance" runs on the founder household in July/August):
--   keel_apply_account_balance books a one-time "Opening balance" anchor
--   = provider current balance − Σ(postings present right now), gated only on
--   connections.last_successful_sync_at IS NOT NULL. Plaid's FIRST
--   /transactions/sync on a fresh Item returns only ~the last 30 days; the
--   multi-year history arrives over the next minutes as further
--   SYNC_UPDATES_AVAILABLE generations (KEEL does not track
--   historical_update_complete). So the anchor fires after the 30-day page,
--   and every older transaction that lands afterwards is added ON TOP of a
--   balance that already included it. Live evidence: for each depository
--   account the later "Fix balance" correction equals, to the cent, the net of
--   transactions first booked after the anchor and dated before the initial
--   window (Adv Plus −215.40, Advantage Savings +925.31, Venmo −1,678.31).
--
-- Fix: once an anchor exists, every balance refresh recomputes the late
-- backdated history against the BASE anchor (earliest live opening marker)
-- and books a compensating "Opening balance adjustment (late history)" batch
-- for any not-yet-compensated amount. Deterministic + idempotent: the target
-- for the sum of adjustment markers is −Σ(late history), so a repeat run
-- books 0 and a run after more history lands books only the increment.
--
-- "Late backdated history" for an account, relative to base anchor B:
--   canonical transactions on this ledger account whose FIRST batch was
--   posted after B.posted_at AND whose earliest effective_date is before the
--   account's initial-window floor = the earliest effective_date among
--   transactions already booked when B was posted (fallback B.effective_date
--   − 7 days when nothing was booked yet). Ordinary posting lag (a purchase
--   dated yesterday that first shows up today) is dated inside the window and
--   is therefore NEVER absorbed into the anchor — it moves the balance as a
--   real new event should. Validated read-only against live: reproduces Ray's
--   three depository corrections exactly and yields 0 for every active
--   account in the founder household (no false positives on months of
--   ordinary lagged postings).
--
-- Scope: provider-connected, non-investment accounts only. Investment
-- accounts display Plaid market value (20260813120000) and Fidelity cash is
-- governed by the core-sweep re-anchor backfill — neither is touched here.
-- Manual accounts are untouched (a user's backdated entry is intentional).
-- A locked period on the anchor date skips the heal (never bypasses a lock,
-- Law 2) — the drift stays visible and "Fix balance" still works.
--
-- keel_cmd_reanchor_balance needs no change: the adjustment batch is a
-- standard opening marker (null-canonical, touches the account ledger AND
-- Opening Balances), so "Fix balance" reverses it with the base anchor.

-- ---------------------------------------------------------------------------
-- 1. The healer (worker-only, called from keel_apply_account_balance).
-- ---------------------------------------------------------------------------
create or replace function public.keel_heal_late_history_anchor(
  p_household_id uuid,
  p_account_id uuid,
  p_ledger uuid,
  p_entity uuid,
  p_opening_ledger uuid,
  p_connection_id uuid,
  p_subtype text,
  p_currency text
) returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_base        record;
  v_floor       date;
  v_late_sum    bigint;
  v_late_count  integer;
  v_markers_sum bigint;
  v_adjust      bigint;
  v_batch       uuid;
  v_command_id  uuid;
begin
  if p_connection_id is null or public.keel_is_investment_subtype(p_subtype) then
    return 0;
  end if;

  -- Serialize against a concurrent refresh / Fix balance on this account.
  perform 1 from public.accounts where id = p_account_id for no key update;

  -- Live opening markers: same unambiguous both-legs marker used by the
  -- anchor and by keel_cmd_reanchor_balance, minus anything already reversed.
  select b.id, b.posted_at, b.effective_date, p.amount_minor
    into v_base
    from public.journal_batches b
    join public.journal_postings p on p.batch_id = b.id and p.ledger_account_id = p_ledger
   where b.household_id = p_household_id
     and b.canonical_transaction_id is null
     and b.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions r where r.original_batch_id = b.id)
     and exists (
       select 1 from public.journal_postings p2
        where p2.batch_id = b.id and p2.ledger_account_id = p_opening_ledger)
   order by b.posted_at, b.id
   limit 1;
  if not found then
    return 0;
  end if;

  select coalesce(sum(p.amount_minor), 0)
    into v_markers_sum
    from public.journal_batches b
    join public.journal_postings p on p.batch_id = b.id and p.ledger_account_id = p_ledger
   where b.household_id = p_household_id
     and b.canonical_transaction_id is null
     and b.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions r where r.original_batch_id = b.id)
     and exists (
       select 1 from public.journal_postings p2
        where p2.batch_id = b.id and p2.ledger_account_id = p_opening_ledger);

  with txn as (
    select b.canonical_transaction_id as ct,
           min(b.posted_at)      as first_posted,
           min(b.effective_date) as first_eff,
           sum(p.amount_minor)   as amt
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
     where p.ledger_account_id = p_ledger
       and b.canonical_transaction_id is not null
     group by b.canonical_transaction_id
  ), fl as (
    select coalesce(min(first_eff) filter (where first_posted <= v_base.posted_at),
                    v_base.effective_date - 7) as floor_date
      from txn
  )
  select fl.floor_date,
         coalesce(sum(t.amt) filter (where t.first_posted > v_base.posted_at
                                       and t.first_eff < fl.floor_date), 0),
         count(*) filter (where t.first_posted > v_base.posted_at
                            and t.first_eff < fl.floor_date)
    into v_floor, v_late_sum, v_late_count
    from fl left join txn t on true
   group by fl.floor_date;

  -- Target: base + Σ(adjustments) = base − late  ⇒  adjustments = −late.
  v_adjust := -v_late_sum - (v_markers_sum - v_base.amount_minor);
  if v_adjust = 0 then
    return 0;
  end if;

  -- Never bypass a period lock (Law 2); leave the drift for an explicit fix.
  if exists (
    select 1 from public.period_locks l
     where l.household_id = p_household_id
       and (l.entity_id is null or l.entity_id = p_entity)
       and l.reopened_at is null
       and v_base.effective_date between l.start_date and l.end_date
  ) then
    return 0;
  end if;

  v_command_id := gen_random_uuid();
  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id, posted_at)
  values
    (p_household_id, null, 'Opening balance adjustment (late history)',
     v_base.effective_date, v_command_id, now())
  returning id into v_batch;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values
    (v_batch, p_ledger,         p_entity,  v_adjust, p_currency),
    (v_batch, p_opening_ledger, p_entity, -v_adjust, p_currency);

  insert into public.audit_log (household_id, actor, action, object_type, object_id, command_id, before, after)
  values (
    p_household_id,
    jsonb_build_object('kind', 'system', 'processName', 'balance-refresh'),
    'accounts.opening_balance_late_history_adjusted', 'account', p_account_id, v_command_id,
    jsonb_build_object('openingMarkersMinor', v_markers_sum::text),
    jsonb_build_object(
      'batchId', v_batch,
      'baseAnchorBatchId', v_base.id,
      'baseAnchorDate', v_base.effective_date,
      'windowFloor', v_floor,
      'lateHistoryMinor', v_late_sum::text,
      'lateHistoryCount', v_late_count,
      'adjustmentMinor', v_adjust::text,
      'formulaVersion', 'late-history-anchor-v1'
    )
  );

  return v_adjust;
end;
$function$;

revoke all on function public.keel_heal_late_history_anchor(uuid, uuid, uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.keel_heal_late_history_anchor(uuid, uuid, uuid, uuid, uuid, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. The writer (body of 20260831190000 unchanged except: subtype is read,
--    and the "anchor already exists" branch calls the healer before return).
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
  v_subtype       text;
begin
  select a.ledger_account_id, a.entity_id, a.currency, a.connection_id, a.subtype
    into v_ledger, v_entity, v_curr, v_connection_id, v_subtype
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

  -- Opening balance is booked once. Once it exists, late-arriving backdated
  -- history is healed against it (keel_heal_late_history_anchor, section 1)
  -- instead of silently stacking on top of it. The unambiguous marker for "this account
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
    perform public.keel_heal_late_history_anchor(
      p_household_id, p_account_id, v_ledger, v_entity, v_opening_ledger,
      v_connection_id, v_subtype, v_effective_currency);
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

revoke all on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)
  from public, anon, authenticated;
grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint, text)
  to service_role;
