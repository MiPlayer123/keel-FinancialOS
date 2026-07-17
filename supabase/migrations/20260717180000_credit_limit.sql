-- C9 (teardown): capture the provider-reported credit limit so liability
-- surfaces can show utilization ("using 32% of the limit").
--
-- Plaid's balances object carries `limit` for credit accounts; until now the
-- worker dropped it on the floor — no column stored it, so the UI could only
-- show balance + available. This migration is additive:
--   1. balance_snapshots.limit_minor (nullable BIGINT minor units, Law 4) —
--      null whenever the provider reports no limit (depository accounts,
--      institutions that omit it). The UI shows utilization ONLY when a limit
--      exists; with no limit everything degrades to exactly today's rendering.
--   2. keel_apply_account_balance gains p_limit_minor. The 6-arg signature is
--      DROPPED (not overloaded) so PostgREST named-arg resolution can never go
--      ambiguous; the new parameter defaults to null so an old worker build
--      calling with 6 named args keeps working across the deploy window.
--   3. keel_latest_balances returns limitMinor per account (null passes
--      through as JSON null), so the existing `balances.latest` query is the
--      single browser-readable source — no new query surface.
--
-- No arithmetic here beyond what already existed: the limit is stored verbatim
-- as reported; utilization percentages are computed client-side with
-- scaled-integer BigInt math (display-only, not money movement).

alter table public.balance_snapshots
  add column limit_minor bigint;

-- (2) Recreate the apply proc with the limit threaded through. Body is the
-- 20260717120000 version verbatim except the snapshot insert; drop-and-create
-- (see header) instead of create-or-replace because the signature changes.
drop function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz);

create function public.keel_apply_account_balance(
  p_household_id uuid,
  p_account_id uuid,
  p_current_minor bigint,
  p_available_minor bigint,
  p_currency text,
  p_as_of timestamptz,
  p_limit_minor bigint default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
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
begin
  select a.ledger_account_id, a.entity_id, a.currency, a.connection_id
    into v_ledger, v_entity, v_curr, v_connection_id
    from public.accounts a
    where a.id = p_account_id and a.household_id = p_household_id;
  if v_ledger is null then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;
  select kind into v_kind from public.ledger_accounts where id = v_ledger;

  -- Provider snapshot (history for trend + future reconciliation + re-anchor).
  -- Recorded every cycle regardless of the anchor gate below. limit_minor is
  -- stored verbatim (null when the provider reports none).
  insert into public.balance_snapshots
    (household_id, account_id, as_of, available_minor, current_minor, limit_minor,
     currency, source, snapshot_metadata)
  values
    (p_household_id, p_account_id, p_as_of, p_available_minor, p_current_minor, p_limit_minor,
     coalesce(nullif(p_currency, ''), v_curr), 'plaid', '{}'::jsonb);

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
  -- account — a manual transfer moves between two real asset/liability accounts
  -- and never touches equity, so it can't satisfy both.
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
    (v_batch, v_ledger,         v_entity,  v_opening, coalesce(nullif(p_currency, ''), v_curr)),
    (v_batch, v_opening_ledger, v_entity, -v_opening, coalesce(nullif(p_currency, ''), v_curr));
end;
$$;

revoke all on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint)
  from public, anon, authenticated;
grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz, bigint)
  to service_role;

-- (3) Latest-balance read model: expose limitMinor. Body is the 20260713080000
-- version (membership guard preserved verbatim) plus the one field.
create or replace function public.keel_latest_balances(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  -- Service path (worker/admin) carries no user claim; user paths must be
  -- household members.
  if v_uid is not null and not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'accountId', account_id,
           'currentMinor', current_minor::text,
           'availableMinor', available_minor::text,
           'limitMinor', limit_minor::text,
           'currency', currency,
           'asOf', as_of
         )), '[]'::jsonb)
    into v_rows
    from (
      select distinct on (account_id)
             account_id, current_minor, available_minor, limit_minor, currency, as_of
        from public.balance_snapshots
        where household_id = p_household_id
        order by account_id, as_of desc
    ) latest;
  return v_rows;
end;
$$;

revoke all on function public.keel_latest_balances(uuid) from public, anon;
grant execute on function public.keel_latest_balances(uuid) to authenticated, service_role;
