-- User-invoked opening balance for a REAL account (checking/card/loan/etc.).
-- Plaid only backfills ~30 days of transactions, so a synced account's ledger
-- total (Σ postings) is meaningless until anchored to a real-world balance.
-- 20260712190000_account_balances.sql already anchors accounts ONCE
-- automatically from the Plaid balance snapshot, dated "today" — but a user
-- who wants the running balance to be correct for dates BEFORE that snapshot
-- (e.g. reviewing register history back to when they opened the account)
-- needs to state "as of [date], the balance was $X" and have that become the
-- new baseline the running total walks forward from.
--
-- This is a full command-envelope proc (idempotency, audit_log, domain_events
-- via keel_finish_command) — not the simpler direct-param house style used by
-- schedules/goals — because it posts real balanced money (Law 3), matching
-- the other ledger-writing procs in 20260710210600_command_procs.sql.
--
-- Sign convention (matches keel_apply_account_balance exactly, debit-positive
-- ledger, PLAN §2.4): p_balance_minor is the REAL-WORLD magnitude the user
-- reports — positive means "money in the account" for an asset, or "amount
-- owed" for a liability. The proc negates it for liabilities before posting,
-- so the internal ledger sign convention (asset +, liability −) is identical
-- everywhere in the codebase.
--
-- Correctness guard: refuse if the account already has a live (non-voided)
-- canonical_transaction dated on or before p_as_of_date — booking an opening
-- entry underneath real activity would double-count or misstate that
-- activity. Automatic Plaid-anchor entries and any PRIOR manual
-- opening-balance entry are NOT canonical_transactions (they carry
-- canonical_transaction_id = null, same as keel_apply_account_balance's own
-- entries), so this guard never blocks re-setting your own opening balance.
--
-- Idempotency / correction: the OUTER economic_event_key is per-attempt (like
-- accounts.create's `accounts.create:<commandId>`) so a network retry replays
-- cleanly. Locating "the live opening-balance entry to correct" reuses the
-- exact structural marker keel_apply_account_balance already established for
-- "this account's opening entry": a batch with canonical_transaction_id null,
-- reverses_batch_id null, not yet reversed, posting on this ledger account —
-- regardless of whether it was booked by the Plaid auto-anchor, the manual
-- account-creation flow (postOpeningBalance), or a prior call to THIS
-- command. Every such live entry is reversed (Law 2: compensating batch,
-- original preserved — never UPDATE/DELETE) before the new one is posted, so
-- at most one opening entry is ever live for an account.

create function public.keel_cmd_set_opening_balance(
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
  v_as_of_date date;
  v_balance_minor bigint;
  v_account record;
  v_opening_ledger_id uuid;
  v_target bigint;
  v_earliest_txn_date date;
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

  if jsonb_typeof(p_payload->'balance_minor') <> 'string'
     or (p_payload->>'balance_minor') !~ '^-?[0-9]+$' then
    raise exception 'KEEL_INVALID_MONEY: balance_minor must be an integer string' using errcode = 'P0008';
  end if;
  v_balance_minor := (p_payload->>'balance_minor')::bigint;

  if coalesce(p_payload->>'as_of_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'KEEL_INVALID_COMMAND: as_of_date must be YYYY-MM-DD' using errcode = 'P0009';
  end if;
  v_as_of_date := (p_payload->>'as_of_date')::date;
  if v_as_of_date < date '1900-01-01' or v_as_of_date > current_date then
    raise exception 'KEEL_INVALID_COMMAND: as_of_date out of range' using errcode = 'P0009';
  end if;

  -- Account resolution: entity/ledger account come from the row — never the
  -- payload. keel_api holds only SELECT+INSERT on accounts (never UPDATE —
  -- no proc mutates an account row in place), so this cannot take a row lock
  -- via FOR UPDATE; a rare concurrent double-correction race is instead
  -- backstopped by journal_revisions_original_once (unique on
  -- original_batch_id, 20260713100000), which fails a second concurrent
  -- reversal of the same prior batch with a hard constraint violation rather
  -- than silently double-reversing it.
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

  -- Period-lock precheck (the BEFORE INSERT posting trigger is the backstop).
  if exists (
    select 1 from public.period_locks l
    where l.household_id = p_household_id
      and (l.entity_id is null or l.entity_id = v_account.entity_id)
      and l.reopened_at is null
      and v_as_of_date between l.start_date and l.end_date
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % falls in a locked period', v_as_of_date
      using errcode = 'P0003';
  end if;

  -- CORRECTNESS GUARD: no live (non-voided) real transaction may already sit
  -- on or before the requested as-of date — otherwise this entry would
  -- double-count or misstate activity the bank/user already recorded.
  select min(ct.effective_date) into v_earliest_txn_date
    from public.canonical_transactions ct
    where ct.account_id = v_account_id
      and ct.household_id = p_household_id
      and ct.voided_at is null;
  if v_earliest_txn_date is not null and v_earliest_txn_date <= v_as_of_date then
    raise exception
      'KEEL_ACCOUNT_HAS_HISTORY: account % already has a transaction dated % (on or before %)',
      v_account_id, v_earliest_txn_date, v_as_of_date
      using errcode = 'P0012';
  end if;

  select id into v_opening_ledger_id
    from public.ledger_accounts
    where entity_id = v_account.entity_id and name = 'Opening Balances' and archived_at is null;
  if v_opening_ledger_id is null then
    raise exception 'KEEL_INVALID_COMMAND: opening balances account missing' using errcode = 'P0009';
  end if;

  -- Debit-positive convention (matches keel_apply_account_balance exactly):
  -- asset target = +reported balance, liability target = -reported balance.
  v_target := case when v_account.ledger_kind = 'liability' then -v_balance_minor else v_balance_minor end;

  -- Reverse every currently-live opening-balance marker batch for this ledger
  -- account (structural marker: no canonical transaction, not itself a
  -- reversal, not yet reversed — same predicate keel_apply_account_balance
  -- uses to decide "has this account already been anchored"). Normally at
  -- most one such batch exists; loop defensively in case more than one ever
  -- landed (Law 2: compensate, never mutate/delete).
  for v_prior in
    select jb.*
      from public.journal_batches jb
      join public.journal_postings jp on jp.batch_id = jb.id
      where jb.household_id = p_household_id
        and jb.canonical_transaction_id is null
        and jb.reverses_batch_id is null
        and jp.ledger_account_id = v_account.ledger_account_id
        and not exists (
          select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
        )
      order by jb.posted_at, jb.id
  loop
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date,
       reverses_batch_id, command_id)
    values
      (p_household_id, null, 'REVERSAL: correcting opening balance',
       v_prior.effective_date, v_prior.id, p_command_id)
    returning id into v_reversal_id;

    insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p
     where p.batch_id = v_prior.id;

    insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
    values (v_prior.id, v_reversal_id, 'Opening balance corrected');

    v_reversed_ids := v_reversed_ids || v_prior.id;
  end loop;

  -- A zero target carries no postable entry (journal_postings forbids a zero
  -- amount_minor leg) — any prior entry has just been reversed above, which
  -- alone restores a zero contribution from this account. Nothing further to
  -- post.
  if v_target <> 0 then
    v_postings_in := jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_target::text,
        'currency', v_account.ledger_currency
      ),
      jsonb_build_object(
        'ledger_account_id', v_opening_ledger_id,
        'amount_minor', (-v_target)::text,
        'currency', v_account.ledger_currency
      )
    );

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (p_household_id, null, 'Opening balance (manual)', v_as_of_date, p_command_id)
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
      'reversedBatchIds', to_jsonb(v_reversed_ids)
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'accounts.set_opening_balance', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'accounts.opening_balance_set', 'account', v_account_id,
    jsonb_build_object(
      'accountId', v_account_id, 'batchId', v_batch_id,
      'balanceMinor', v_balance_minor::text, 'asOfDate', v_as_of_date,
      'reversedBatchIds', to_jsonb(v_reversed_ids)
    ),
    v_result
  );

  return v_result;
end;
$$;

-- Ownership ritual (procs owned by keel_api; execute for authenticated only).
grant create on schema public to keel_api;
alter function public.keel_cmd_set_opening_balance(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_set_opening_balance(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_set_opening_balance(uuid, text, jsonb, uuid, jsonb) to authenticated;
