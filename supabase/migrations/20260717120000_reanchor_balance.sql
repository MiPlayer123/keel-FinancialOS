-- Historical backfill + opening-balance anchor correction.
--
-- PROBLEM (founder-reported, teardown anomaly-personal-profile.md): synced
-- balances read too high. Two root causes:
--   (a) Plaid only backfills a shallow transaction window (default 90 days;
--       Venmo shallower still) — fixed on the link side by requesting up to 730
--       days (api/index.ts, PLAID_TRANSACTIONS_DAYS_REQUESTED).
--   (b) The one-time auto-anchor (keel_apply_account_balance) can fire on a
--       balance-refresh cycle BEFORE the initial cursor→now backfill has landed.
--       When it fires early the account's Σ(postings) is still ~0, so it books
--       an opening entry equal to the FULL provider balance; every backfilled
--       transaction then piles on top of that opening → displayed balance =
--       provider_balance + Σ(synced txns) = inflated, permanently (the anchor
--       is booked once and never revisited).
--
-- This migration fixes both halves of (b):
--   1. keel_apply_account_balance now DEFERS its one-time anchor until the
--      account's connection has completed at least one full sync
--      (connections.last_successful_sync_at is not null). The provider snapshot
--      is still recorded every cycle (needed by the read model + re-anchor);
--      only the equity anchor waits for the backfill so Σ(postings) already
--      reflects the synced window when the delta is computed. This prevents NEW
--      accounts from inflating.
--   2. A new audited, reversible command — accounts.reanchor_balance /
--      keel_cmd_reanchor_balance — recomputes and re-books the opening anchor
--      for an ALREADY-linked account from its latest provider balance snapshot,
--      so the founder's existing (already-inflated) Venmo/other accounts can be
--      corrected without relinking. It reverses any prior opening-balance entry
--      first (Law 2: compensating batch, original preserved) then posts the
--      corrected delta, so displayed balance ties to the bank regardless of how
--      shallow the synced history is.
--
-- Sign + marker conventions are identical to keel_apply_account_balance and
-- keel_cmd_set_opening_balance (debit-positive ledger; a genuine opening batch
-- is the only null-canonical, non-reversal batch touching BOTH the account's
-- own ledger account AND the entity's Opening Balances equity account, so a
-- manual transfer can never be mistaken for one). All money is BIGINT minor
-- units (Law 4); every posting pair sums to zero (Law 3); the correction is
-- audited via keel_finish_command and reversible (Law 2).

-- (1) Defer the one-time auto-anchor until the initial backfill has landed.
-- create-or-replace preserves the original owner/ACLs (service_role execute).
create or replace function public.keel_apply_account_balance(
  p_household_id uuid,
  p_account_id uuid,
  p_current_minor bigint,
  p_available_minor bigint,
  p_currency text,
  p_as_of timestamptz
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
  -- Recorded every cycle regardless of the anchor gate below.
  insert into public.balance_snapshots
    (household_id, account_id, as_of, available_minor, current_minor, currency, source, snapshot_metadata)
  values
    (p_household_id, p_account_id, p_as_of, p_available_minor, p_current_minor,
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

grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz)
  to service_role;

-- (2) Audited, reversible re-anchor for an already-linked account.
--
-- Unlike keel_cmd_set_opening_balance (which takes a user-stated balance "as of
-- date X" that must sit BEFORE all history), this command reads the SERVER-side
-- provider balance snapshot and books a delta dated today so that
-- Σ(postings) == provider balance no matter how much history synced — exactly
-- the math keel_apply_account_balance uses, but wrapped in the command envelope
-- (idempotency, audit_log, domain_events) and preceded by a Law 2 reversal of
-- any prior opening-balance entry (including an inflated legacy auto-anchor).
-- The browser never supplies the balance — Law 1 keeps ledger arithmetic off
-- the client, and the number is read from provider truth on the server.
create function public.keel_cmd_reanchor_balance(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_account_id uuid := nullif(p_payload->>'account_id', '')::uuid;
  v_account record;
  v_opening_ledger_id uuid;
  v_snapshot record;
  v_target bigint;
  v_current_sum bigint;
  v_opening bigint;
  v_prior public.journal_batches%rowtype;
  v_reversal_id uuid;
  v_reversed_ids uuid[] := '{}';
  v_batch_id uuid;
  v_postings jsonb := null;
  v_postings_in jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_account_id is null then
    raise exception 'KEEL_INVALID_COMMAND: account_id is required' using errcode = 'P0009';
  end if;

  -- Account resolution: entity/ledger come from the row, never the payload.
  select a.id, a.entity_id, a.ledger_account_id, a.archived_at,
         la.kind as ledger_kind, la.currency as ledger_currency,
         la.is_category as ledger_is_category, la.archived_at as ledger_archived_at
    into v_account
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
    where a.id = v_account_id and a.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: account not in household' using errcode = 'P0006';
  end if;
  if v_account.archived_at is not null
     or v_account.ledger_is_category
     or v_account.ledger_archived_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: account is not postable' using errcode = 'P0009';
  end if;
  if v_account.ledger_kind not in ('asset', 'liability') then
    raise exception 'KEEL_INVALID_COMMAND: only asset or liability accounts carry an opening balance'
      using errcode = 'P0009';
  end if;

  -- Provider truth: the latest recorded balance snapshot for this account.
  -- current_minor is the real-world magnitude the provider reported (positive =
  -- money in the account for an asset, or amount owed for a liability), exactly
  -- as keel_apply_account_balance consumes it.
  select current_minor, as_of into v_snapshot
    from public.balance_snapshots
    where household_id = p_household_id and account_id = v_account_id
    order by as_of desc, id desc
    limit 1;
  if not found then
    raise exception
      'KEEL_INVALID_COMMAND: no provider balance snapshot yet; refresh balances before re-anchoring'
      using errcode = 'P0009';
  end if;

  -- Period-lock precheck against today (the anchor batch is dated today).
  if exists (
    select 1 from public.period_locks l
    where l.household_id = p_household_id
      and (l.entity_id is null or l.entity_id = v_account.entity_id)
      and l.reopened_at is null
      and current_date between l.start_date and l.end_date
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % falls in a locked period', current_date
      using errcode = 'P0003';
  end if;

  select id into v_opening_ledger_id
    from public.ledger_accounts
    where entity_id = v_account.entity_id and name = 'Opening Balances' and archived_at is null;
  if v_opening_ledger_id is null then
    raise exception 'KEEL_INVALID_COMMAND: opening balances account missing' using errcode = 'P0009';
  end if;

  -- Reverse every currently-live opening-balance marker batch for this ledger
  -- account (Law 2: compensate, never mutate/delete). This clears an inflated
  -- legacy auto-anchor or a prior re-anchor before we re-book. Same unambiguous
  -- both-legs marker used everywhere: null-canonical, not itself a reversal, not
  -- yet reversed, posting to BOTH this account's ledger account AND the entity's
  -- Opening Balances equity account.
  for v_prior in
    select jb.*
      from public.journal_batches jb
      where jb.household_id = p_household_id
        and jb.canonical_transaction_id is null
        and jb.reverses_batch_id is null
        and not exists (
          select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
        )
        and exists (
          select 1 from public.journal_postings jp
          where jp.batch_id = jb.id and jp.ledger_account_id = v_account.ledger_account_id
        )
        and exists (
          select 1 from public.journal_postings jp2
          where jp2.batch_id = jb.id and jp2.ledger_account_id = v_opening_ledger_id
        )
      order by jb.posted_at, jb.id
  loop
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date,
       reverses_batch_id, command_id)
    values
      (p_household_id, null, 'REVERSAL: re-anchoring opening balance',
       v_prior.effective_date, v_prior.id, p_command_id)
    returning id into v_reversal_id;

    insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p
     where p.batch_id = v_prior.id;

    insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
    values (v_prior.id, v_reversal_id, 'Opening balance re-anchored');

    v_reversed_ids := v_reversed_ids || v_prior.id;
  end loop;

  -- Debit-positive convention: asset target = +reported balance, liability
  -- target = -reported balance. The delta walks Σ(postings) to that target;
  -- because the reversals above are already booked, v_current_sum reflects the
  -- real synced transactions only (any prior opening now nets to zero).
  v_target := case when v_account.ledger_kind = 'liability'
                   then -v_snapshot.current_minor else v_snapshot.current_minor end;
  select coalesce(sum(amount_minor), 0) into v_current_sum
    from public.journal_postings where ledger_account_id = v_account.ledger_account_id;
  v_opening := v_target - v_current_sum;

  -- A zero delta carries no postable entry (journal_postings forbids a zero
  -- amount_minor leg); the reversal alone already restored a zero contribution.
  if v_opening <> 0 then
    v_postings_in := jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_opening::text,
        'currency', v_account.ledger_currency
      ),
      jsonb_build_object(
        'ledger_account_id', v_opening_ledger_id,
        'amount_minor', (-v_opening)::text,
        'currency', v_account.ledger_currency
      )
    );

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (p_household_id, null, 'Opening balance (re-anchored)', current_date, p_command_id)
    returning id into v_batch_id;

    v_postings := public.keel_insert_postings(p_household_id, v_batch_id, v_postings_in);
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'accountId', v_account_id,
      'batchId', v_batch_id,
      'postings', v_postings,
      'openingMinor', v_opening::text,
      'providerBalanceMinor', v_snapshot.current_minor::text,
      'reversedBatchIds', to_jsonb(v_reversed_ids)
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'accounts.reanchor_balance', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'accounts.balance_reanchored', 'account', v_account_id,
    jsonb_build_object(
      'accountId', v_account_id, 'batchId', v_batch_id,
      'openingMinor', v_opening::text,
      'providerBalanceMinor', v_snapshot.current_minor::text,
      'reversedBatchIds', to_jsonb(v_reversed_ids)
    ),
    v_result
  );

  return v_result;
end;
$$;

-- Ownership ritual (procs owned by keel_api; execute for authenticated only),
-- matching keel_cmd_set_opening_balance.
grant create on schema public to keel_api;
alter function public.keel_cmd_reanchor_balance(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_reanchor_balance(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_reanchor_balance(uuid, text, jsonb, uuid, jsonb) to authenticated;
