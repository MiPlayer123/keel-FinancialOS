-- Task #24 (docket, flagged 2026-07-17): "quicken also lets u edit dates" —
-- TxnEditForm has no way to correct a transaction's effective_date; Quicken
-- and every other ledger app lets you fix a fat-fingered or bank-lagged
-- date directly. Adds:
--
--   transactions.set_date → keel_cmd_set_date
--
-- Same house-correction model as keel_cmd_set_splits (20260717190000): the
-- live batch's postings are UNCHANGED in composition, just moved. The
-- reversal batch posts AS OF THE ORIGINAL DATE (so the old date nets to
-- zero — nothing silently vanishes from a period that already closed
-- against it) and the replacement batch posts AS OF THE NEW DATE with every
-- posting copied verbatim (Law 2 reversible correction; Law 9 reproducible
-- numbers — the old date's reports are still explainable after the edit).
-- canonical_transactions.effective_date is updated in place to match: unlike
-- journal_batches/journal_postings, canonical_transactions carries no
-- keel_forbid_mutation trigger (it is the mutable classification/date
-- surface; journal_batches is the immutable source-of-truth ledger).
create function public.keel_cmd_set_date(
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
  v_new_date date;
  v_postings_in jsonb := '[]'::jsonb;
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

  if jsonb_typeof(p_payload->'effective_date') <> 'string'
     or (p_payload->>'effective_date') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'KEEL_INVALID_COMMAND: effective_date must be YYYY-MM-DD' using errcode = 'P0009';
  end if;
  v_new_date := (p_payload->>'effective_date')::date;

  -- FOR UPDATE: serializes concurrent date edits/re-splits/voids the same
  -- way keel_cmd_set_splits does — a second writer sees the revised batch or
  -- the voided flag and fails typed instead of racing.
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

  -- No-op replay guard (same shape as keel_reassign_account_entity): resaving
  -- the date already on the books is harmless and shouldn't post a spurious
  -- reversal/replacement pair or audit-log entry.
  if v_txn.effective_date = v_new_date then
    return jsonb_build_object(
      'commandId', p_command_id,
      'economicEventKey', p_economic_event_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object('canonicalTransactionId', v_txn.id, 'unchanged', true),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
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
    raise exception 'KEEL_IMMUTABLE: no live batch to re-date' using errcode = 'P0001';
  end if;

  -- Period-lock precheck (the deferred posting trigger is the backstop):
  -- the reversal lands on the OLD date, the replacement on the NEW date —
  -- either one falling in a locked period blocks the whole edit.
  if exists (
    select 1
      from public.journal_postings p
      join public.period_locks l
        on l.household_id = p_household_id
       and (l.entity_id is null or l.entity_id = p.entity_id)
       and l.reopened_at is null
     where p.batch_id = v_batch.id
       and (v_batch.effective_date between l.start_date and l.end_date
            or v_new_date between l.start_date and l.end_date)
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % or % falls in a locked period',
      v_batch.effective_date, v_new_date using errcode = 'P0003';
  end if;

  -- Correction model: reversal batch (old date) + replacement batch (new
  -- date, postings copied verbatim) + revision record.
  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (p_household_id, v_txn.id, left('REDATE: ' || v_batch.description, 500),
     v_batch.effective_date, v_batch.id, p_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_batch.id;

  select jsonb_agg(jsonb_build_object(
           'ledger_account_id', p.ledger_account_id,
           'amount_minor', p.amount_minor::text,
           'currency', p.currency
         ))
    into v_postings_in
    from public.journal_postings p
   where p.batch_id = v_batch.id;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_txn.id, v_batch.description, v_new_date, p_command_id)
  returning id into v_new_batch_id;

  v_postings := public.keel_insert_postings(p_household_id, v_new_batch_id, v_postings_in);

  insert into public.journal_revisions
    (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
  values (v_batch.id, v_reversal_id, v_new_batch_id, 'effective date edited');

  update public.canonical_transactions set effective_date = v_new_date where id = v_txn.id;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'canonicalTransactionId', v_txn.id,
      'originalBatchId', v_batch.id,
      'reversalBatchId', v_reversal_id,
      'newBatchId', v_new_batch_id,
      'effectiveDate', v_new_date,
      'postings', v_postings
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'transactions.set_date', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'transactions.date_set', 'canonical_transaction', v_txn.id,
    jsonb_build_object(
      'canonicalTransactionId', v_txn.id,
      'originalBatchId', v_batch.id,
      'reversalBatchId', v_reversal_id,
      'newBatchId', v_new_batch_id,
      'oldEffectiveDate', v_batch.effective_date,
      'newEffectiveDate', v_new_date
    ),
    v_result
  );

  return v_result;
end;
$$;

-- keel_api holds no UPDATE grant on canonical_transactions.effective_date
-- (20260710210500 only granted status/voided_at) — RLS's definer_all policy
-- already permits the row; without this the UPDATE above fails closed with
-- permission denied.
grant update (effective_date) on public.canonical_transactions to keel_api;

grant create on schema public to keel_api;
alter function public.keel_cmd_set_date(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_set_date(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_set_date(uuid, text, jsonb, uuid, jsonb) to authenticated;
