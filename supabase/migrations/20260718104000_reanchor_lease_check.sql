-- Sixth-round codex finding on PR #60, P1: the 15-minute continuation
-- staleness escape hatch (20260718101500) can be WRONG at the exact
-- moment a worker resumes a long-delayed continuation. Confirmed directly:
-- keel_worker_acquire_sync_lease (20260711130000_c5b_sync_pull.sql:11-58)
-- sets sync_lease_owner/sync_leased_until but never touches
-- sync_continuation_pending/sync_continuation_marked_at -- so a worker can
-- pick a stale (>15min) continuation back up, hold a live unexpired lease,
-- and actively be posting new transactions right now, while
-- sync_continuation_marked_at still reads as stale and the FOR NO KEY
-- UPDATE lock from 20260718103500 (which only fences NEW lease
-- acquisitions/generation bumps starting during THIS transaction) doesn't
-- catch it, since the worker's lease-acquire already happened and
-- committed as its own separate, already-finished transaction before this
-- one even started.
--
-- Fix: also reject while an unexpired lease exists, independent of the
-- continuation-staleness heuristic. sync_leased_until is the authoritative
-- signal for "is a worker actively claiming this connection right now" --
-- a crashed/abandoned worker's lease expires on its own TTL regardless, so
-- this doesn't reopen the "genuinely stuck connection" escape hatch the
-- staleness cutoff exists for; it only blocks while a worker verifiably
-- still holds the lease.
create or replace function public.keel_cmd_reanchor_balance(
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
  v_conn_desired_gen int;
  v_conn_committed_gen int;
  v_conn_continuation_pending boolean;
  v_conn_continuation_marked_at timestamptz;
  v_conn_leased_until timestamptz;
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
  select a.id, a.entity_id, a.ledger_account_id, a.archived_at, a.connection_id,
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

  -- Sync-in-progress guard: see migration headers (20260718100000,
  -- 20260718101500, 20260718103500, 20260718104000). FOR NO KEY UPDATE
  -- holds this row lock through the rest of the transaction so no
  -- concurrent sync can transition generation/lease state while
  -- Σ(journal_postings) below is computed. The lease check below is
  -- independent of the staleness heuristic: it catches a worker that has
  -- ALREADY acquired the lease (possibly resuming a long-stale
  -- continuation) before this transaction started.
  if v_account.connection_id is not null then
    select sync_desired_generation, sync_committed_generation,
           sync_continuation_pending, sync_continuation_marked_at, sync_leased_until
      into v_conn_desired_gen, v_conn_committed_gen,
           v_conn_continuation_pending, v_conn_continuation_marked_at, v_conn_leased_until
      from public.connections
      where id = v_account.connection_id and household_id = p_household_id
      for no key update;
    if v_conn_desired_gen is distinct from v_conn_committed_gen
       or (v_conn_continuation_pending
           and v_conn_continuation_marked_at > now() - interval '15 minutes')
       or (v_conn_leased_until is not null and v_conn_leased_until > now())
    then
      raise exception
        'KEEL_INVALID_COMMAND: this account is still syncing -- wait for the sync to finish before fixing the balance'
        using errcode = 'P0009';
    end if;
  end if;

  -- Provider truth: the latest recorded balance snapshot for this account.
  -- current_minor is the real-world magnitude the provider reported (positive =
  -- money in the account for an asset, or amount owed for a liability), exactly
  -- as keel_apply_account_balance consumes it.
  select current_minor, as_of, currency into v_snapshot
    from public.balance_snapshots
    where household_id = p_household_id and account_id = v_account_id
    order by as_of desc, id desc
    limit 1;
  if not found then
    raise exception
      'KEEL_INVALID_COMMAND: no provider balance snapshot yet; refresh balances before re-anchoring'
      using errcode = 'P0009';
  end if;

  -- Currency guard (review finding): the anchor magnitude is booked in the
  -- ledger account's currency, so a provider snapshot in a different currency
  -- would silently anchor a foreign amount as if it were the ledger currency
  -- (Law 4 — never conflate currencies). Fail closed rather than write a wrong
  -- number; FX re-anchoring is out of scope until an as-of rate + formula
  -- version exists (Law 9).
  if v_snapshot.currency is distinct from v_account.ledger_currency then
    raise exception
      'KEEL_INVALID_COMMAND: provider balance is in % but the account ledger is in %; cannot re-anchor across currencies',
      v_snapshot.currency, v_account.ledger_currency
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

  -- Period-lock precheck on the PRIOR openings we're about to reverse (review
  -- finding). A reversal batch inherits its target's effective_date, and the
  -- journal_postings trigger enforces the lock on that date — so a prior
  -- opening dated inside a now-locked period would make the reversal (and the
  -- whole re-anchor) fail deep in the loop with a raw trigger error. Surface a
  -- clear, actionable message up front instead (fail closed either way; Law 2
  -- locks are never bypassed).
  if exists (
    select 1
      from public.journal_batches jb
      join public.period_locks l
        on l.household_id = jb.household_id
       and (l.entity_id is null or l.entity_id = v_account.entity_id)
       and l.reopened_at is null
       and jb.effective_date between l.start_date and l.end_date
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
  ) then
    raise exception
      'KEEL_PERIOD_LOCKED: a prior opening-balance entry sits in a locked period; reopen that period before re-anchoring this account'
      using errcode = 'P0003';
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
