-- Split editor write path (teardown C7 — design/TEARDOWN-STATUS-2026-07-17.md
-- build-queue item 5). Until now splits existed only at manual ENTRY
-- (keel_cmd_manual_transaction); editing them meant void + re-enter, and
-- synced transactions could never be split at all. This migration adds the
-- one missing command:
--
--   transactions.set_splits → keel_cmd_set_splits
--
-- Semantics: the cash posting is untouched; the category offsets of the LIVE
-- batch are replaced through the house correction model — reversal batch +
-- replacement batch + journal_revisions row (Law 2: corrections are
-- compensating events; originals preserved; invariant 5 reversible
-- correction). Σ amount_minor = 0 per currency is enforced here AND by the
-- deferred batch trigger (Law 3). Splits are validated with the exact same
-- lattice as manual entry (20260713100000 §1): 1–30 rows, live same-entity
-- expense/income categories in the cash currency, no duplicates, sum equal to
-- the exact negation of the cash amount.
--
-- Envelope ritual mirrored from keel_cmd_manual_transaction /
-- keel_cmd_decide_category_suggestion: member-write assert, actor from JWT
-- (forgery guard), idempotency check/replay, typed errors, finish_command
-- (audit + domain event + execution record), keel_api ownership.

-- ---------------------------------------------------------------------------
-- 0. Overlay hygiene grant: a re-split to MULTIPLE categories must delete the
-- transaction's overlay row (multi-split transactions are categorized by
-- their splits — 20260713100000 §3/§5). keel_api has select/insert/update
-- from 20260713100000 but never needed delete until now; the existing
-- transaction_categories_definer_all policy already covers delete for it.
-- ---------------------------------------------------------------------------
grant delete on public.transaction_categories to keel_api;

-- ---------------------------------------------------------------------------
-- 1. transactions.set_splits — full command envelope.
-- Payload (post-toSnakeKeys):
--   { transaction_id,
--     amount_minor: "-4500",   -- signed cash amount the CLIENT is looking at
--     splits: [ { category_ledger_account_id, amount_minor: "3000" }, ... ] }
-- amount_minor is a stale-view guard (Law 9 explicit ownership): if a sync
-- revision changed the live cash amount between the user's read and this
-- write, the command fails typed instead of silently rebalancing a different
-- total. Sign convention: debit-positive; splits sum to the exact negation of
-- the cash amount.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_set_splits(
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
  v_cash record;
  v_amount bigint;
  v_split jsonb;
  v_split_count int;
  v_split_sum bigint := 0;
  v_split_amount bigint;
  v_cat record;
  v_seen_categories uuid[] := '{}';
  v_cat_id uuid;
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

  -- Cash side: exactly ONE non-category posting (the ledger row the splits
  -- offset). Batches with several cash legs are not re-splittable here.
  select p.ledger_account_id, p.entity_id, p.amount_minor, p.currency,
         count(*) over () as n
    into v_cash
    from public.journal_postings p
    join public.ledger_accounts la
      on la.id = p.ledger_account_id and la.is_category = false
    where p.batch_id = v_batch.id
    limit 1;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: transaction has no cash posting' using errcode = 'P0009';
  end if;
  if v_cash.n > 1 then
    raise exception 'KEEL_INVALID_COMMAND: multi-account batches cannot be re-split' using errcode = 'P0009';
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

  -- Overlay coherence (20260713100000 §1/§3): a single split pins a USER
  -- classification (no rule/PFC pass may silently re-file what the user just
  -- posted); a multi-split transaction carries NO overlay — its splits ARE
  -- the categorization.
  if v_split_count = 1 then
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

-- Ownership ritual (proc owned by keel_api; execute for authenticated only) —
-- matching keel_cmd_manual_transaction / keel_cmd_decide_category_suggestion.
grant create on schema public to keel_api;
alter function public.keel_cmd_set_splits(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_set_splits(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_set_splits(uuid, text, jsonb, uuid, jsonb) to authenticated;
