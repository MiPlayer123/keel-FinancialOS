-- 20260721000000_transaction_distributions.sql
--
-- DISTRIBUTION LEGS — a split leg may target a real account (an inter-account
-- transfer that lives INSIDE one ledger line), not just a category.
--
-- Motivation (root fix, user-directed): a paycheck's 401(k) is money moving from
-- checking into a retirement account. Modelling it as a SEPARATE canonical
-- transaction + transfer_link produced two ledger lines for one economic event
-- ("that defeats the purpose of the ledger one-line thing"). The correct model
-- is ONE transaction whose journal batch posts: the real net deposit to the
-- checking account, the +401(k) into the Roth ledger account, gross income as a
-- credit offset, and each tax as a debit offset — all summing to zero.
--
-- KEEL already supports this at the ledger layer: every balance / net-worth /
-- trial-balance read model aggregates journal_postings by ledger_account_id
-- (not by canonical_transactions.account_id), the Σ=0 trigger is agnostic to
-- is_category, and cash_flow/budget sum ONLY is_category postings — so a
-- non-category (real-account) leg is automatically excluded from spend/income
-- and automatically picked up by the counterparty account's balance. NO ledger,
-- net-worth, cash-flow, transfer-detection, or export change is needed.
--
-- This migration therefore does exactly three things, all CREATE OR REPLACE:
--   1. keel_cmd_set_splits         — accept an { account_id, amount_minor } leg;
--                                    re-pin the cash side to the txn's OWN
--                                    account so distributions stay re-splittable.
--   2. keel_cmd_manual_transaction — accept the same account-target leg.
--   3. keel_list_transactions_rich(_page) — pin the cash row to ct.account_id
--                                    (a two-account batch must render as ONE
--                                    row, not one per account) and fold the
--                                    non-cash account postings into the splits
--                                    array as legType='account' transfer legs.
--
-- Leg contract (both command procs): a split element is EITHER
--   { "category_ledger_account_id": <uuid>, "amount_minor": "<int>" }  (category)
--   { "account_id": <uuid>,               "amount_minor": "<int>" }    (transfer)
-- An account leg posts to that account's ledger account. It is validated for
-- household membership, postability (live, non-category, non-archived), same
-- entity + currency as the cash side, and must not target the transaction's own
-- account. It carries NO income/expense direction rule (a transfer leg can be
-- either sign). Balance (splits sum to −cash) is enforced exactly as before.
--
-- Laws honoured: deterministic spine, LLM does no arithmetic (Law 1); every
-- write balances (Law 3, invariant 1); money = bigint minor units, enums, no
-- implicit defaults (Law 4); membership re-checked, fails closed (Law 7);
-- explicit ownership — a transfer leg is a real posting, never inferred (Law 9).

-- ===========================================================================
-- 1. keel_cmd_set_splits — account-target legs + cash pinned to own account
-- ===========================================================================
create or replace function public.keel_cmd_set_splits(
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
  v_txn public.canonical_transactions%rowtype;
  v_batch public.journal_batches%rowtype;
  v_cash_ledger_id uuid;
  v_cash record;
  v_amount bigint;
  v_split jsonb;
  v_split_count int;
  v_split_sum bigint := 0;
  v_split_amount bigint;
  v_cat record;
  v_seen_categories uuid[] := '{}';
  v_cat_id uuid;
  v_acct_id uuid;
  v_leg record;
  v_seen_accounts uuid[] := '{}';
  v_postings_in jsonb;
  v_postings jsonb;
  v_reversal_id uuid;
  v_new_batch_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- FOR UPDATE: serializes concurrent re-splits/voids with DIFFERENT client
  -- keys (same race the manual-void row lock closes) — the second in line
  -- then sees the revised batch or the voided flag and fails typed.
  select * into v_txn
    from public.canonical_transactions
    where id = (p_payload->>'transaction_id')::uuid
      and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: transaction not in household' using errcode = 'P0006';
  end if;
  if v_txn.voided_at is not null then
    raise exception 'KEEL_IMMUTABLE: transaction is voided' using errcode = 'P0001';
  end if;

  -- The live batch: non-reversal, not superseded by a revision.
  select jb.* into v_batch
    from public.journal_batches jb
    where jb.canonical_transaction_id = v_txn.id
      and jb.reverses_batch_id is null
      and not exists (
        select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
      )
    order by jb.posted_at desc, jb.id desc
    limit 1;
  if not found then
    raise exception 'KEEL_IMMUTABLE: no live batch to re-split' using errcode = 'P0001';
  end if;

  -- Cash side: the posting on the transaction's OWN account
  -- (canonical_transactions.account_id). A distribution batch has MORE THAN ONE
  -- non-category posting (the account-transfer legs), so "the sole non-category
  -- posting" is no longer a valid cash identifier — the transaction's own
  -- account is. This also makes distributions re-splittable (the previous guard
  -- rejected any multi-account batch here).
  select a.ledger_account_id into v_cash_ledger_id
    from public.accounts a
    where a.id = v_txn.account_id and a.household_id = p_household_id;
  if v_cash_ledger_id is null then
    raise exception 'KEEL_INVALID_COMMAND: transaction has no owning account' using errcode = 'P0009';
  end if;
  select p.ledger_account_id, p.entity_id, p.amount_minor, p.currency
    into v_cash
    from public.journal_postings p
    where p.batch_id = v_batch.id
      and p.ledger_account_id = v_cash_ledger_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: transaction has no cash posting' using errcode = 'P0009';
  end if;

  -- Stale-view guard: the client re-splits the amount it is LOOKING at.
  if jsonb_typeof(p_payload->'amount_minor') <> 'string'
     or (p_payload->>'amount_minor') !~ '^-?[0-9]+$' then
    raise exception 'KEEL_INVALID_MONEY: amount_minor must be an integer string' using errcode = 'P0008';
  end if;
  v_amount := (p_payload->>'amount_minor')::bigint;
  if v_amount <> v_cash.amount_minor then
    raise exception 'KEEL_INVALID_COMMAND: transaction amount changed — reload and retry'
      using errcode = 'P0009';
  end if;

  -- Splits validation: identical lattice to keel_cmd_manual_transaction.
  if jsonb_typeof(p_payload->'splits') <> 'array' then
    raise exception 'KEEL_INVALID_COMMAND: splits must be an array' using errcode = 'P0009';
  end if;
  v_split_count := jsonb_array_length(p_payload->'splits');
  if v_split_count < 1 or v_split_count > 30 then
    raise exception 'KEEL_INVALID_COMMAND: 1-30 splits per transaction' using errcode = 'P0009';
  end if;

  v_postings_in := jsonb_build_array(jsonb_build_object(
    'ledger_account_id', v_cash.ledger_account_id,
    'amount_minor', v_cash.amount_minor::text,
    'currency', v_cash.currency
  ));

  for v_split in select * from jsonb_array_elements(p_payload->'splits') loop
    if jsonb_typeof(v_split->'amount_minor') <> 'string'
       or (v_split->>'amount_minor') !~ '^-?[0-9]+$' then
      raise exception 'KEEL_INVALID_MONEY: split amount_minor must be an integer string' using errcode = 'P0008';
    end if;
    v_split_amount := (v_split->>'amount_minor')::bigint;
    if v_split_amount = 0 then
      raise exception 'KEEL_INVALID_MONEY: split amount cannot be zero' using errcode = 'P0008';
    end if;

    if v_split ? 'account_id' and nullif(v_split->>'account_id', '') is not null then
      -- ACCOUNT-TRANSFER LEG: posts into another real account inside this batch
      -- (an inter-account transfer that stays one ledger line). No income/expense
      -- direction rule — a transfer leg is either sign; balance still enforced.
      v_acct_id := (v_split->>'account_id')::uuid;
      select a.id, a.entity_id, a.ledger_account_id, a.archived_at,
             la.currency as ledger_currency, la.is_category as ledger_is_category,
             la.archived_at as ledger_archived_at
        into v_leg
        from public.accounts a
        join public.ledger_accounts la on la.id = a.ledger_account_id
        where a.id = v_acct_id and a.household_id = p_household_id;
      if not found then
        raise exception 'KEEL_SCOPE_VIOLATION: transfer account not in household' using errcode = 'P0006';
      end if;
      if v_leg.archived_at is not null or v_leg.ledger_is_category
         or v_leg.ledger_archived_at is not null then
        raise exception 'KEEL_INVALID_COMMAND: transfer account is not postable' using errcode = 'P0009';
      end if;
      if v_leg.ledger_account_id = v_cash.ledger_account_id then
        raise exception 'KEEL_INVALID_COMMAND: transfer leg cannot target the transaction''s own account'
          using errcode = 'P0009';
      end if;
      if v_leg.entity_id <> v_cash.entity_id then
        raise exception 'KEEL_INVALID_COMMAND: transfer account belongs to a different entity' using errcode = 'P0009';
      end if;
      if v_leg.ledger_currency <> v_cash.currency then
        raise exception 'KEEL_CURRENCY_MISMATCH: transfer currency % on % transaction',
          v_leg.ledger_currency, v_cash.currency using errcode = 'P0010';
      end if;
      if v_acct_id = any (v_seen_accounts) then
        raise exception 'KEEL_INVALID_COMMAND: duplicate transfer account — merge the amounts' using errcode = 'P0009';
      end if;
      v_seen_accounts := v_seen_accounts || v_acct_id;

      v_split_sum := v_split_sum + v_split_amount;
      v_postings_in := v_postings_in || jsonb_build_object(
        'ledger_account_id', v_leg.ledger_account_id,
        'amount_minor', v_split->>'amount_minor',
        'currency', v_cash.currency
      );
    else
      -- CATEGORY LEG (existing behaviour).
      v_cat_id := (v_split->>'category_ledger_account_id')::uuid;
      select la.id, la.kind, la.currency, la.entity_id, la.is_category, la.archived_at
        into v_cat
        from public.ledger_accounts la
        where la.id = v_cat_id and la.household_id = p_household_id;
      if not found then
        raise exception 'KEEL_SCOPE_VIOLATION: split category not in household' using errcode = 'P0006';
      end if;
      if v_cat.is_category is not true or v_cat.archived_at is not null
         or v_cat.kind not in ('expense', 'income') then
        raise exception 'KEEL_INVALID_COMMAND: split target is not a live category' using errcode = 'P0009';
      end if;
      if v_cat.entity_id <> v_cash.entity_id then
        raise exception 'KEEL_INVALID_COMMAND: split category belongs to a different entity' using errcode = 'P0009';
      end if;
      -- Per-leg direction rule (amended 20260720230000 for balanced mixed splits,
      -- e.g. a paycheck: gross income leg + tax expense legs + 401k transfer =
      -- net). Validates each category leg against ITS OWN offset sign: an expense
      -- offset is positive (debit), an income offset is negative (credit). A
      -- genuinely misassigned leg still rejects. Account legs are exempt (above).
      if v_cat.kind::text <> (case when v_split_amount > 0 then 'expense' else 'income' end) then
        raise exception 'KEEL_INVALID_COMMAND: split category direction does not match its offset sign'
          using errcode = 'P0009';
      end if;
      if v_cat.currency <> v_cash.currency then
        raise exception 'KEEL_CURRENCY_MISMATCH: split currency % on % transaction',
          v_cat.currency, v_cash.currency using errcode = 'P0010';
      end if;
      if v_cat_id = any (v_seen_categories) then
        raise exception 'KEEL_INVALID_COMMAND: duplicate split category — merge the amounts' using errcode = 'P0009';
      end if;
      v_seen_categories := v_seen_categories || v_cat_id;

      v_split_sum := v_split_sum + v_split_amount;
      v_postings_in := v_postings_in || jsonb_build_object(
        'ledger_account_id', v_cat_id,
        'amount_minor', v_split->>'amount_minor',
        'currency', v_cash.currency
      );
    end if;
  end loop;

  if v_split_sum <> -v_amount then
    raise exception 'KEEL_UNBALANCED: splits sum to % but must equal % (delta %)',
      v_split_sum, -v_amount, v_split_sum + v_amount using errcode = 'P0002';
  end if;

  -- Period-lock precheck (the deferred posting trigger is the backstop):
  -- reversal + replacement both post on the batch's effective date.
  if exists (
    select 1 from public.period_locks l
    where l.household_id = p_household_id
      and (l.entity_id is null or l.entity_id = v_cash.entity_id)
      and l.reopened_at is null
      and v_batch.effective_date between l.start_date and l.end_date
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % falls in a locked period', v_batch.effective_date
      using errcode = 'P0003';
  end if;

  -- Correction model: reversal batch + replacement batch + revision record.
  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (p_household_id, v_txn.id, left('RESPLIT: ' || v_batch.description, 500),
     v_batch.effective_date, v_batch.id, p_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_batch.id;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_txn.id, v_batch.description, v_batch.effective_date, p_command_id)
  returning id into v_new_batch_id;

  v_postings := public.keel_insert_postings(p_household_id, v_new_batch_id, v_postings_in);

  insert into public.journal_revisions
    (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
  values (v_batch.id, v_reversal_id, v_new_batch_id, 'splits edited');

  -- Overlay coherence (20260713100000 §1/§3): a single CATEGORY split pins a
  -- USER classification (no rule/PFC pass may silently re-file it); anything
  -- else (multi-split, or a lone account-transfer leg) carries NO overlay — its
  -- postings ARE the categorization.
  if v_split_count = 1 and coalesce(array_length(v_seen_categories, 1), 0) = 1 then
    insert into public.transaction_categories
      (canonical_transaction_id, household_id, category_ledger_account_id, source)
    values (v_txn.id, p_household_id, v_seen_categories[1], 'user')
    on conflict (canonical_transaction_id) do update
      set category_ledger_account_id = excluded.category_ledger_account_id,
          source = 'user', rule_id = null, updated_at = now();
  else
    delete from public.transaction_categories where canonical_transaction_id = v_txn.id;
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'canonicalTransactionId', v_txn.id,
      'originalBatchId', v_batch.id,
      'reversalBatchId', v_reversal_id,
      'newBatchId', v_new_batch_id,
      'splitCount', v_split_count,
      'postings', v_postings
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'transactions.set_splits', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'transactions.splits_set', 'canonical_transaction', v_txn.id,
    jsonb_build_object(
      'canonicalTransactionId', v_txn.id,
      'originalBatchId', v_batch.id,
      'reversalBatchId', v_reversal_id,
      'newBatchId', v_new_batch_id,
      'splitCount', v_split_count
    ),
    v_result
  );

  return v_result;
end;
$$;

-- Ownership ritual (proc owned by keel_api; execute for authenticated only).
grant create on schema public to keel_api;
alter function public.keel_cmd_set_splits(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_set_splits(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_set_splits(uuid, text, jsonb, uuid, jsonb) to authenticated;

-- ===========================================================================
-- 2. keel_cmd_manual_transaction — account-target legs
-- ===========================================================================
create or replace function public.keel_cmd_manual_transaction(
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
  v_account record;
  v_description text := btrim(coalesce(p_payload->>'description', ''));
  v_date date;
  v_status text := p_payload->>'status';
  v_amount bigint;
  v_split jsonb;
  v_split_count int;
  v_split_sum bigint := 0;
  v_split_amount bigint;
  v_cat record;
  v_seen_categories uuid[] := '{}';
  v_cat_id uuid;
  v_acct_id uuid;
  v_leg record;
  v_seen_accounts uuid[] := '{}';
  v_postings_in jsonb;
  v_postings jsonb;
  v_txn_id uuid;
  v_batch_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- Canonical-key precheck: a manual key colliding with an existing canonical
  -- row (e.g. a sync key) must surface as a typed conflict, not a raw 23505.
  if exists (
    select 1 from public.canonical_transactions
    where household_id = p_household_id and economic_event_key = p_economic_event_key
  ) then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: economic event key % already used', p_economic_event_key
      using errcode = 'P0007';
  end if;

  -- Account resolution: entity comes from the account row — never the payload.
  select a.id, a.entity_id, a.ledger_account_id, a.archived_at,
         la.currency as ledger_currency, la.is_category as ledger_is_category,
         la.archived_at as ledger_archived_at
    into v_account
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
    where a.id = (p_payload->>'account_id')::uuid
      and a.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: account not in household' using errcode = 'P0006';
  end if;
  if v_account.archived_at is not null
     or v_account.ledger_is_category
     or v_account.ledger_archived_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: account is not postable' using errcode = 'P0009';
  end if;

  -- Field validation (typed errors before any raw CHECK/cast failure).
  if char_length(v_description) < 1 or char_length(v_description) > 500 then
    raise exception 'KEEL_INVALID_COMMAND: description must be 1-500 characters' using errcode = 'P0009';
  end if;
  if coalesce(p_payload->>'effective_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'KEEL_INVALID_COMMAND: effective_date must be YYYY-MM-DD' using errcode = 'P0009';
  end if;
  v_date := (p_payload->>'effective_date')::date;
  -- Sanity bounds: typos like year 0206 or 9999 would silently distort every
  -- report; a year of forward-dating covers real prepayments.
  if v_date < date '1900-01-01' or v_date > current_date + interval '1 year' then
    raise exception 'KEEL_INVALID_COMMAND: effective_date out of range' using errcode = 'P0009';
  end if;
  if v_status not in ('pending', 'posted') then
    raise exception 'KEEL_INVALID_COMMAND: status must be pending or posted' using errcode = 'P0009';
  end if;
  if jsonb_typeof(p_payload->'amount_minor') <> 'string'
     or (p_payload->>'amount_minor') !~ '^-?[0-9]+$' then
    raise exception 'KEEL_INVALID_MONEY: amount_minor must be an integer string' using errcode = 'P0008';
  end if;
  v_amount := (p_payload->>'amount_minor')::bigint;
  if v_amount = 0 then
    raise exception 'KEEL_INVALID_MONEY: amount cannot be zero' using errcode = 'P0008';
  end if;

  -- Splits validation: 1-30 rows, each EITHER a live same-entity expense/income
  -- category OR an { account_id } transfer leg targeting another real account in
  -- the same entity/currency; duplicates rejected (deterministic postings).
  if jsonb_typeof(p_payload->'splits') <> 'array' then
    raise exception 'KEEL_INVALID_COMMAND: splits must be an array' using errcode = 'P0009';
  end if;
  v_split_count := jsonb_array_length(p_payload->'splits');
  if v_split_count < 1 or v_split_count > 30 then
    raise exception 'KEEL_INVALID_COMMAND: 1-30 splits per transaction' using errcode = 'P0009';
  end if;

  v_postings_in := jsonb_build_array(jsonb_build_object(
    'ledger_account_id', v_account.ledger_account_id,
    'amount_minor', p_payload->>'amount_minor',
    'currency', v_account.ledger_currency
  ));

  for v_split in select * from jsonb_array_elements(p_payload->'splits') loop
    if jsonb_typeof(v_split->'amount_minor') <> 'string'
       or (v_split->>'amount_minor') !~ '^-?[0-9]+$' then
      raise exception 'KEEL_INVALID_MONEY: split amount_minor must be an integer string' using errcode = 'P0008';
    end if;
    v_split_amount := (v_split->>'amount_minor')::bigint;
    if v_split_amount = 0 then
      raise exception 'KEEL_INVALID_MONEY: split amount cannot be zero' using errcode = 'P0008';
    end if;

    if v_split ? 'account_id' and nullif(v_split->>'account_id', '') is not null then
      -- ACCOUNT-TRANSFER LEG: posts into another real account in this batch.
      v_acct_id := (v_split->>'account_id')::uuid;
      select a.id, a.entity_id, a.ledger_account_id, a.archived_at,
             la.currency as ledger_currency, la.is_category as ledger_is_category,
             la.archived_at as ledger_archived_at
        into v_leg
        from public.accounts a
        join public.ledger_accounts la on la.id = a.ledger_account_id
        where a.id = v_acct_id and a.household_id = p_household_id;
      if not found then
        raise exception 'KEEL_SCOPE_VIOLATION: transfer account not in household' using errcode = 'P0006';
      end if;
      if v_leg.archived_at is not null or v_leg.ledger_is_category
         or v_leg.ledger_archived_at is not null then
        raise exception 'KEEL_INVALID_COMMAND: transfer account is not postable' using errcode = 'P0009';
      end if;
      if v_leg.ledger_account_id = v_account.ledger_account_id then
        raise exception 'KEEL_INVALID_COMMAND: transfer leg cannot target the transaction''s own account'
          using errcode = 'P0009';
      end if;
      if v_leg.entity_id <> v_account.entity_id then
        raise exception 'KEEL_INVALID_COMMAND: transfer account belongs to a different entity' using errcode = 'P0009';
      end if;
      if v_leg.ledger_currency <> v_account.ledger_currency then
        raise exception 'KEEL_CURRENCY_MISMATCH: transfer currency % on % account',
          v_leg.ledger_currency, v_account.ledger_currency using errcode = 'P0010';
      end if;
      if v_acct_id = any (v_seen_accounts) then
        raise exception 'KEEL_INVALID_COMMAND: duplicate transfer account — merge the amounts' using errcode = 'P0009';
      end if;
      v_seen_accounts := v_seen_accounts || v_acct_id;

      v_split_sum := v_split_sum + v_split_amount;
      v_postings_in := v_postings_in || jsonb_build_object(
        'ledger_account_id', v_leg.ledger_account_id,
        'amount_minor', v_split->>'amount_minor',
        'currency', v_account.ledger_currency
      );
    else
      -- CATEGORY LEG (existing behaviour).
      v_cat_id := (v_split->>'category_ledger_account_id')::uuid;
      select la.id, la.kind, la.currency, la.entity_id, la.is_category, la.archived_at
        into v_cat
        from public.ledger_accounts la
        where la.id = v_cat_id and la.household_id = p_household_id;
      if not found then
        raise exception 'KEEL_SCOPE_VIOLATION: split category not in household' using errcode = 'P0006';
      end if;
      if v_cat.is_category is not true or v_cat.archived_at is not null
         or v_cat.kind not in ('expense', 'income') then
        raise exception 'KEEL_INVALID_COMMAND: split target is not a live category' using errcode = 'P0009';
      end if;
      if v_cat.entity_id <> v_account.entity_id then
        raise exception 'KEEL_INVALID_COMMAND: split category belongs to a different entity' using errcode = 'P0009';
      end if;
      if v_cat.currency <> v_account.ledger_currency then
        raise exception 'KEEL_CURRENCY_MISMATCH: split currency % on % account',
          v_cat.currency, v_account.ledger_currency using errcode = 'P0010';
      end if;
      if v_cat_id = any (v_seen_categories) then
        raise exception 'KEEL_INVALID_COMMAND: duplicate split category — merge the amounts' using errcode = 'P0009';
      end if;
      v_seen_categories := v_seen_categories || v_cat_id;

      v_split_sum := v_split_sum + v_split_amount;
      v_postings_in := v_postings_in || jsonb_build_object(
        'ledger_account_id', v_cat_id,
        'amount_minor', v_split->>'amount_minor',
        'currency', v_account.ledger_currency
      );
    end if;
  end loop;

  if v_split_sum <> -v_amount then
    raise exception 'KEEL_UNBALANCED: splits sum to % but must equal % (delta %)',
      v_split_sum, -v_amount, v_split_sum + v_amount using errcode = 'P0002';
  end if;

  -- Period-lock precheck (the BEFORE INSERT posting trigger is the backstop).
  if exists (
    select 1 from public.period_locks l
    where l.household_id = p_household_id
      and (l.entity_id is null or l.entity_id = v_account.entity_id)
      and l.reopened_at is null
      and v_date between l.start_date and l.end_date
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % falls in a locked period', v_date
      using errcode = 'P0003';
  end if;

  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key)
  values
    (p_household_id, v_account.entity_id, v_account.id,
     v_status::public.transaction_status, 'manual'::public.transaction_source,
     v_description, v_date, p_economic_event_key)
  returning id into v_txn_id;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_txn_id, v_description, v_date, p_command_id)
  returning id into v_batch_id;

  v_postings := public.keel_insert_postings(p_household_id, v_batch_id, v_postings_in);

  -- Single CATEGORY split: pin the overlay as a USER classification so no rule
  -- can silently re-display the category the user posted. Multi-split or a lone
  -- account-transfer leg get no overlay (categorized by their postings).
  if v_split_count = 1 and coalesce(array_length(v_seen_categories, 1), 0) = 1 then
    insert into public.transaction_categories
      (canonical_transaction_id, household_id, category_ledger_account_id, source)
    values (v_txn_id, p_household_id, v_seen_categories[1], 'user');
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'canonicalTransactionId', v_txn_id, 'batchId', v_batch_id, 'postings', v_postings
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'transactions.manual_create', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'transactions.manual_created', 'canonical_transaction', v_txn_id,
    jsonb_build_object('canonicalTransactionId', v_txn_id, 'batchId', v_batch_id),
    v_result
  );

  perform public.keel_enqueue('transaction_enrichment', jsonb_build_object(
    'jobType', 'enrich_transaction',
    'economicEventKey', p_economic_event_key || ':enrich',
    'refs', jsonb_build_object('canonicalTransactionId', v_txn_id::text)
  ));

  return v_result;
end;
$$;

-- Ownership ritual — matching the schedule_ownership grants (keel_api owner,
-- executable by authenticated + keel_api + postgres for nested schedule calls).
grant create on schema public to keel_api;
alter function public.keel_cmd_manual_transaction(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_manual_transaction(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_manual_transaction(uuid, text, jsonb, uuid, jsonb) to authenticated, keel_api, postgres;

-- ===========================================================================
-- 3. keel_list_transactions_rich(_page) — pin cash to own account + show legs
-- ===========================================================================
-- Restated verbatim from the live 20260720230000 (entityId + categoryPfcKey)
-- definitions with TWO changes each:
--   (a) the cash row is pinned to the transaction's OWN account
--       (accounts.id = ct.account_id), so a two-account batch renders as ONE
--       row (previously the "any non-category posting" join fanned out to one
--       row per real account);
--   (b) the offsets lateral now also gathers non-cash real-account postings
--       (account-transfer legs) into the splits array as legType='account', and
--       counts them in `n` so a paycheck-with-401k reads as a Split with the
--       transfer leg visible.

create or replace function public.keel_list_transactions_rich(p_household_id uuid)
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
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(row order by row->>'effectiveDate' desc, row->>'transactionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'note', tov.note,
        'status', ct.status,
        'source', ct.source,
        'accountId', acc.id,
        'accountName', acc.name,
        'accountMask', acc.mask,
        'entityId', acc.entity_id,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId',
          case when offs.n = 1 then coalesce(catov.id, offs.one_id) end,
        'categoryName',
          case when offs.n = 1 then coalesce(catov.name, offs.one_name) else 'Split' end,
        'categoryKind',
          case when offs.n = 1 then coalesce(catov.kind::text, offs.one_kind) end,
        'categoryPfcKey',
          case when offs.n = 1 then
            case when catov.id is not null then catov.pfc_key else offs.one_pfc_key end
          end,
        'categorySource', case when offs.n > 1 then 'user' else tc.source end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status,
        'transferLinkId', tl.id,
        'transferBooked', tl.booked_txn is not null,
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end,
        'reconciled', exists (
          select 1 from public.reconciliation_items ri
           where ri.household_id = ct.household_id
             and ri.transaction_id = ct.id
             and ri.resolution = 'matched_transaction'
        )
      ) as row
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      -- Cash row pinned to the transaction's OWN account (one row per txn even
      -- when the batch posts to a second real account — a distribution).
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings cashp
        on cashp.batch_id = jb.id and cashp.ledger_account_id = acc.ledger_account_id
      cross join lateral (
        select count(*)::int as n,
               (min(legs.cat_id::text) filter (where legs.leg_type = 'category'))::uuid as one_id,
               min(legs.name)    filter (where legs.leg_type = 'category') as one_name,
               min(legs.kind)    filter (where legs.leg_type = 'category') as one_kind,
               min(legs.pfc_key) filter (where legs.leg_type = 'category') as one_pfc_key,
               jsonb_agg(jsonb_build_object(
                 'categoryLedgerAccountId', legs.cat_id,
                 'name', legs.name,
                 'kind', legs.kind,
                 'amountMinor', legs.amount_minor::text,
                 'legType', legs.leg_type,
                 'accountId', legs.acct_id
               ) order by legs.amount_minor desc, legs.pid) as splits
          from (
            select op.id as pid, op.amount_minor,
                   oc.id as cat_id, oc.name, oc.kind::text as kind, oc.pfc_key,
                   'category'::text as leg_type, null::uuid as acct_id
              from public.journal_postings op
              join public.ledger_accounts oc
                on oc.id = op.ledger_account_id and oc.is_category = true
             where op.batch_id = jb.id
            union all
            select op.id as pid, op.amount_minor,
                   null::uuid as cat_id, oacc.name, 'transfer'::text as kind, null::text as pfc_key,
                   'account'::text as leg_type, oacc.id as acct_id
              from public.journal_postings op
              join public.ledger_accounts ola
                on ola.id = op.ledger_account_id and ola.is_category = false
              join public.accounts oacc on oacc.ledger_account_id = ola.id
             where op.batch_id = jb.id
               and op.ledger_account_id <> acc.ledger_account_id
          ) legs
      ) offs
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('tagId', tg.id, 'name', tg.name)
                 order by tg.name), '[]'::jsonb) as tags
          from public.transaction_tags tt
          join public.tags tg on tg.id = tt.tag_id
         where tt.canonical_transaction_id = ct.id
      ) tgs
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
      left join lateral (
        select cpacc.id as account_id, cpacc.name as account_name, cpct.id as txn_id
          from public.canonical_transactions cpct
          join public.journal_batches cpjb
            on cpjb.canonical_transaction_id = cpct.id and cpjb.reverses_batch_id is null
           and not exists (
             select 1 from public.journal_revisions rev where rev.original_batch_id = cpjb.id
           )
          join public.accounts cpacc on cpacc.id = cpct.account_id
         where cpct.id = case when tl.txn_out = ct.id then tl.txn_in else tl.txn_out end
         limit 1
      ) cp on tl.status = 'confirmed'
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and offs.n >= 1
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_transactions_rich(uuid) from public, anon;
grant execute on function public.keel_list_transactions_rich(uuid) to authenticated, service_role;

create or replace function public.keel_list_transactions_rich_page(
  p_household_id uuid,
  p_limit integer default 100,
  p_cursor_date date default null,
  p_cursor_id uuid default null,
  p_account_id uuid default null,
  p_category_id uuid default null,
  p_search text default null
)
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
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_rows jsonb;
  v_next jsonb := null;
  v_last_date text;
  v_last_id text;
  v_count int;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  if v_search is not null then
    v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with page as (
    select jsonb_build_object(
        'transactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'note', tov.note,
        'status', ct.status,
        'source', ct.source,
        'accountId', acc.id,
        'accountName', acc.name,
        'accountMask', acc.mask,
        'entityId', acc.entity_id,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId',
          case when offs.n = 1 then coalesce(catov.id, offs.one_id) end,
        'categoryName',
          case when offs.n = 1 then coalesce(catov.name, offs.one_name) else 'Split' end,
        'categoryKind',
          case when offs.n = 1 then coalesce(catov.kind::text, offs.one_kind) end,
        'categoryPfcKey',
          case when offs.n = 1 then coalesce(catov.pfc_key, offs.one_pfc_key) end,
        'categorySource', case when offs.n > 1 then 'user' else tc.source end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status,
        'transferLinkId', tl.id,
        'transferBooked', tl.booked_txn is not null,
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end,
        'reconciled', exists (
          select 1 from public.reconciliation_items ri
           where ri.household_id = ct.household_id
             and ri.transaction_id = ct.id
             and ri.resolution = 'matched_transaction'
        )
      ) as row,
      ct.effective_date as eff_date,
      ct.id as txn_id
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      -- Cash row pinned to the transaction's OWN account (see rich() above).
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings cashp
        on cashp.batch_id = jb.id and cashp.ledger_account_id = acc.ledger_account_id
      cross join lateral (
        select count(*)::int as n,
               (min(legs.cat_id::text) filter (where legs.leg_type = 'category'))::uuid as one_id,
               min(legs.name)    filter (where legs.leg_type = 'category') as one_name,
               min(legs.kind)    filter (where legs.leg_type = 'category') as one_kind,
               min(legs.pfc_key) filter (where legs.leg_type = 'category') as one_pfc_key,
               jsonb_agg(jsonb_build_object(
                 'categoryLedgerAccountId', legs.cat_id,
                 'name', legs.name,
                 'kind', legs.kind,
                 'amountMinor', legs.amount_minor::text,
                 'legType', legs.leg_type,
                 'accountId', legs.acct_id
               ) order by legs.amount_minor desc, legs.pid) as splits
          from (
            select op.id as pid, op.amount_minor,
                   oc.id as cat_id, oc.name, oc.kind::text as kind, oc.pfc_key,
                   'category'::text as leg_type, null::uuid as acct_id
              from public.journal_postings op
              join public.ledger_accounts oc
                on oc.id = op.ledger_account_id and oc.is_category = true
             where op.batch_id = jb.id
            union all
            select op.id as pid, op.amount_minor,
                   null::uuid as cat_id, oacc.name, 'transfer'::text as kind, null::text as pfc_key,
                   'account'::text as leg_type, oacc.id as acct_id
              from public.journal_postings op
              join public.ledger_accounts ola
                on ola.id = op.ledger_account_id and ola.is_category = false
              join public.accounts oacc on oacc.ledger_account_id = ola.id
             where op.batch_id = jb.id
               and op.ledger_account_id <> acc.ledger_account_id
          ) legs
      ) offs
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('tagId', tg.id, 'name', tg.name)
                 order by tg.name), '[]'::jsonb) as tags
          from public.transaction_tags tt
          join public.tags tg on tg.id = tt.tag_id
         where tt.canonical_transaction_id = ct.id
      ) tgs
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
      left join lateral (
        select cpacc.id as account_id, cpacc.name as account_name, cpct.id as txn_id
          from public.canonical_transactions cpct
          join public.journal_batches cpjb
            on cpjb.canonical_transaction_id = cpct.id and cpjb.reverses_batch_id is null
           and not exists (
             select 1 from public.journal_revisions rev where rev.original_batch_id = cpjb.id
           )
          join public.accounts cpacc on cpacc.id = cpct.account_id
         where cpct.id = case when tl.txn_out = ct.id then tl.txn_in else tl.txn_out end
         limit 1
      ) cp on tl.status = 'confirmed'
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and offs.n >= 1
        and (p_account_id is null or acc.id = p_account_id)
        and (
          p_category_id is null
          or (offs.n = 1 and coalesce(catov.id, offs.one_id) = p_category_id)
        )
        and (
          v_pattern is null
          or coalesce(tov.display_description, rr.display_name, ct.description) ilike v_pattern
          or ct.description ilike v_pattern
          or acc.name ilike v_pattern
        )
        and (
          p_cursor_date is null
          or ct.effective_date < p_cursor_date
          or (ct.effective_date = p_cursor_date and ct.id < p_cursor_id)
        )
      order by ct.effective_date desc, ct.id desc
      limit v_limit + 1
  )
  select coalesce(jsonb_agg(row order by eff_date desc, txn_id desc)
                    filter (where rn <= v_limit), '[]'::jsonb),
         count(*),
         max(eff_date::text) filter (where rn = v_limit),
         max(txn_id::text) filter (where rn = v_limit)
    into v_rows, v_count, v_last_date, v_last_id
    from (
      select row, eff_date, txn_id,
             row_number() over (order by eff_date desc, txn_id desc) as rn
        from page
    ) ranked;

  if v_count > v_limit then
    v_next := jsonb_build_object(
      'effectiveDate', v_last_date,
      'transactionId', v_last_id
    );
  end if;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows,
    'nextCursor', v_next
  );
end;
$$;

revoke all on function public.keel_list_transactions_rich_page(uuid, integer, date, uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.keel_list_transactions_rich_page(uuid, integer, date, uuid, uuid, uuid, text)
  to authenticated, service_role;
