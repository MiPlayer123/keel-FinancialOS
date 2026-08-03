-- ---------------------------------------------------------------------------
-- Sync must not clobber user-authored splits (systematic-debugging root cause).
--
-- keel_worker_apply_action's 'revise' path unconditionally reversed the live
-- batch and re-booked a flat cash + Uncategorized pair from the provider
-- payload. So when a PENDING transaction that a user had already split settled
-- (pending -> posted is a 'revise' that changes only status/description, NOT the
-- amount), the user's multi-leg split -- taxes, a 401(k) distribution leg, a
-- refund/reimbursement -- was silently destroyed and the row fell back to
-- Uncategorized. Observed on the DEEPTUNE paycheck (b8941e45) and a risk for the
-- Samay reimbursement split. Violates BC-v2.1 Law 2 (a correction must not lose
-- the thing corrected) and Law 9 / invariant "explicit ownership" (inference
-- must never silently overwrite a user's explicit decision).
--
-- Fix: in the 'revise' branch, if the live batch is USER-AUTHORED (carries a
-- 'splits edited' revision, or has more than the 2 postings a flat sync batch
-- has) AND the cash amount is UNCHANGED, preserve the split composition. Two
-- sub-cases: if the effective_date is also unchanged, move ONLY the canonical
-- status/description (no ledger write); if the date moved (a Jul-31 pending
-- settling Aug-1), the batch date drives every ledger read model, so re-date by
-- copying the split VERBATIM onto a new-dated reversal+replacement (Law 2),
-- period-lock-checked. Everything else is untouched:
--   * amount actually changed  -> falls through to the rebuild (the old split no
--     longer reconciles to the new amount);
--   * a removal ('void')       -> still reverses (the transaction is gone);
--   * a plain 2-leg sync batch  -> not user-authored, re-books exactly as before.
-- Balance is trivially preserved (no ledger write in the preserve path).
--
-- Body restated from the live definition (byte-for-byte match to
-- 20260713090000_subcategories.sql) with the two declares + the preserve block
-- added; owner/grants re-asserted (the keel_worker ritual) below.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.keel_worker_apply_action(p_normalized_id uuid, p_action_kind text, p_economic_key text, p_apply_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_nsr public.normalized_source_records%rowtype;
  v_account public.accounts%rowtype;
  v_conn public.connections%rowtype;
  v_connection_id uuid;
  v_offset_id uuid;
  v_hash text := public.keel_payload_hash(jsonb_build_object(
    'normalizedId', p_normalized_id, 'kind', p_action_kind, 'key', p_economic_key));
  v_replay jsonb;
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'sync-worker');
  v_command_id uuid := gen_random_uuid();
  v_txn_id uuid;
  v_batch_id uuid;
  v_reversal_id uuid;
  v_prev_batch record;
  v_prev_cash_minor bigint;
  v_user_authored boolean;
  v_txn_entity uuid;
  v_result jsonb;
begin
  select * into v_nsr
    from public.normalized_source_records
   where id = p_normalized_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown normalized record' using errcode = 'P0006';
  end if;

  select connection_id into v_connection_id
    from public.raw_provider_events
   where id = v_nsr.raw_event_id;
  select * into v_conn
    from public.connections
   where id = v_connection_id
   for no key update;
  if not found or v_conn.status is distinct from 'active' then
    raise exception 'KEEL_SYNC_SUPERSEDED' using errcode = 'P0007';
  end if;

  v_replay := public.keel_idempotency_check(v_nsr.household_id, p_apply_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if p_action_kind = 'noop' then
    v_result := jsonb_build_object(
      'commandId', v_command_id,
      'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object('kind', 'noop'),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    insert into public.command_executions
      (household_id, economic_event_key, command_id, command, payload_sha256, result)
    values
      (v_nsr.household_id, p_apply_key, v_command_id,
       'ingest.apply_action', v_hash, v_result);
    return v_result;
  end if;

  if p_action_kind in ('create', 'revise') and v_nsr.kind = 'removed' then
    raise exception 'KEEL_INVALID_COMMAND: removed record cannot be % ', p_action_kind
      using errcode = 'P0009';
  end if;

  if p_action_kind = 'create' then
    select * into v_account from public.accounts where id = v_nsr.account_id;
    select la.id into v_offset_id
      from public.ledger_accounts la
     where la.entity_id = v_account.entity_id
       and la.pfc_key = case when v_nsr.amount_minor < 0 then 'uncategorized_expense'
                             else 'uncategorized_income' end;
    if v_offset_id is null then
      raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
    end if;

    insert into public.canonical_transactions
      (household_id, entity_id, account_id, status, source, description,
       effective_date, economic_event_key)
    values
      (v_nsr.household_id, v_account.entity_id, v_account.id,
       case when v_nsr.pending then 'pending'::public.transaction_status
            else 'posted'::public.transaction_status end,
       'sync', left(v_nsr.description, 500), v_nsr.effective_date, p_economic_key)
    returning id into v_txn_id;

    insert into public.transaction_source_links
      (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr.id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500),
       v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(v_nsr.household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_nsr.amount_minor::text,
        'currency', v_nsr.currency),
      jsonb_build_object(
        'ledger_account_id', v_offset_id,
        'amount_minor', (-v_nsr.amount_minor)::text,
        'currency', v_nsr.currency)
    ));

    v_result := jsonb_build_object(
      'commandId', v_command_id,
      'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'create', 'canonicalTransactionId', v_txn_id, 'batchId', v_batch_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
      v_actor, v_hash, 'ingest.transaction_created', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  select id into v_txn_id
    from public.canonical_transactions
   where household_id = v_nsr.household_id
     and economic_event_key = p_economic_key;
  if v_txn_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown canonical for key %', p_economic_key
      using errcode = 'P0006';
  end if;

  select b.id, b.effective_date into v_prev_batch
    from public.journal_batches b
   where b.canonical_transaction_id = v_txn_id
     and b.reverses_batch_id is null
     and not exists (
       select 1 from public.journal_revisions r where r.original_batch_id = b.id
     )
   order by b.posted_at desc, b.id desc
   limit 1;
  if v_prev_batch.id is null then
    raise exception 'KEEL_IMMUTABLE: no live batch to correct' using errcode = 'P0001';
  end if;

  -- PRESERVE user-authored splits across a money-unchanged sync REVISE
  -- (20260803120000). A pending->posted settle (or a description drift) issues a
  -- 'revise' whose only real change is metadata, but the code below would reverse
  -- the live batch and re-book a flat cash + Uncategorized pair -- silently
  -- destroying a user's multi-leg split, distribution, or refund (Law 2/9:
  -- inference must never overwrite an explicit user decision, and a correction
  -- must not lose it). If the live batch is user-authored AND the cash amount is
  -- unchanged, keep the batch intact and move ONLY the status/description/date.
  -- (A genuine amount change still falls through to the rebuild -- the old split
  -- no longer reconciles; a void still reverses; a plain 2-leg sync batch is not
  -- user-authored and re-books as before.)
  if p_action_kind = 'revise' then
    select p.amount_minor into v_prev_cash_minor
      from public.accounts a
      join public.journal_postings p
        on p.batch_id = v_prev_batch.id and p.ledger_account_id = a.ledger_account_id
     where a.id = v_nsr.account_id and a.household_id = v_nsr.household_id;

    v_user_authored := (
      exists (
        select 1 from public.journal_revisions r
         where r.replacement_batch_id = v_prev_batch.id and r.reason = 'splits edited')
      or (select count(*) from public.journal_postings p
            where p.batch_id = v_prev_batch.id) > 2
    );

    if v_user_authored
       and v_prev_cash_minor is not distinct from v_nsr.amount_minor then
      insert into public.transaction_source_links
        (canonical_transaction_id, normalized_source_record_id)
      values (v_txn_id, v_nsr.id);

      if v_prev_batch.effective_date is not distinct from v_nsr.effective_date then
        -- (a) DATE unchanged: pure metadata move, no ledger write at all.
        update public.canonical_transactions
           set status = case when v_nsr.pending then 'pending'::public.transaction_status
                             else 'posted'::public.transaction_status end,
               description = left(v_nsr.description, 500),
               effective_date = v_nsr.effective_date,
               voided_at = null
         where id = v_txn_id;
      else
        -- (b) DATE moved (e.g. a Jul-31 pending settling Aug-1). Ledger read
        -- models -- cash flow, budgets, reconciliation, export -- key off
        -- journal_batches.effective_date, so a metadata-only date bump would
        -- leave the money booked in the old period while views show the new
        -- one. Re-date by copying the split VERBATIM onto a new-dated
        -- replacement (Law 2 correction); the composition is unchanged, only
        -- the date moves. Period-lock precheck on BOTH dates (the deferred
        -- posting trigger is the backstop).
        select entity_id into v_txn_entity
          from public.canonical_transactions where id = v_txn_id;
        if exists (
          select 1 from public.period_locks l
          where l.household_id = v_nsr.household_id
            and (l.entity_id is null or l.entity_id = v_txn_entity)
            and l.reopened_at is null
            and (v_prev_batch.effective_date between l.start_date and l.end_date
                 or v_nsr.effective_date between l.start_date and l.end_date)
        ) then
          raise exception 'KEEL_PERIOD_LOCKED: re-dating % into a locked period',
            v_nsr.effective_date using errcode = 'P0003';
        end if;

        insert into public.journal_batches
          (household_id, canonical_transaction_id, description, effective_date,
           reverses_batch_id, command_id)
        values
          (v_nsr.household_id, v_txn_id, 'REVERSAL: sync revise (re-date)',
           v_prev_batch.effective_date, v_prev_batch.id, v_command_id)
        returning id into v_reversal_id;

        insert into public.journal_postings
          (batch_id, ledger_account_id, entity_id, amount_minor, currency)
        select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
          from public.journal_postings p where p.batch_id = v_prev_batch.id;

        insert into public.journal_batches
          (household_id, canonical_transaction_id, description, effective_date, command_id)
        values
          (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500),
           v_nsr.effective_date, v_command_id)
        returning id into v_batch_id;

        -- Verbatim copy: same ledger accounts, same amounts -> the user's split
        -- survives; only the date changes.
        insert into public.journal_postings
          (batch_id, ledger_account_id, entity_id, amount_minor, currency)
        select v_batch_id, p.ledger_account_id, p.entity_id, p.amount_minor, p.currency
          from public.journal_postings p where p.batch_id = v_prev_batch.id;

        -- reason 'splits edited' keeps the replacement flagged user-authored, so
        -- a later same-amount revise preserves it again.
        insert into public.journal_revisions
          (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
        values (v_prev_batch.id, v_reversal_id, v_batch_id, 'splits edited');

        update public.canonical_transactions
           set status = case when v_nsr.pending then 'pending'::public.transaction_status
                             else 'posted'::public.transaction_status end,
               description = left(v_nsr.description, 500),
               effective_date = v_nsr.effective_date,
               voided_at = null
         where id = v_txn_id;
      end if;

      v_result := jsonb_build_object(
        'commandId', v_command_id,
        'economicEventKey', p_apply_key,
        'idempotentReplay', false,
        'effects', jsonb_build_object(
          'kind', 'revise', 'canonicalTransactionId', v_txn_id,
          'postingsPreserved', true,
          'reDated', (v_prev_batch.effective_date is distinct from v_nsr.effective_date)),
        'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      );
      perform public.keel_finish_command(
        v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
        v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
        v_txn_id, jsonb_build_object('economicKey', p_economic_key,
                                     'postingsPreserved', true), v_result);
      return v_result;
    end if;
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (v_nsr.household_id, v_txn_id, 'REVERSAL: sync ' || p_action_kind,
     v_prev_batch.effective_date, v_prev_batch.id, v_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings
    (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_prev_batch.id;

  if p_action_kind = 'revise' then
    select * into v_account from public.accounts where id = v_nsr.account_id;
    select la.id into v_offset_id
      from public.ledger_accounts la
     where la.entity_id = v_account.entity_id
       and la.pfc_key = case when v_nsr.amount_minor < 0 then 'uncategorized_expense'
                             else 'uncategorized_income' end;
    if v_offset_id is null then
      raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
    end if;

    insert into public.transaction_source_links
      (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr.id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500),
       v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(v_nsr.household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_nsr.amount_minor::text,
        'currency', v_nsr.currency),
      jsonb_build_object(
        'ledger_account_id', v_offset_id,
        'amount_minor', (-v_nsr.amount_minor)::text,
        'currency', v_nsr.currency)
    ));

    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch.id, v_reversal_id, v_batch_id, 'sync supersession');

    update public.canonical_transactions
       set status = case when v_nsr.pending then 'pending'::public.transaction_status
                         else 'posted'::public.transaction_status end,
           description = left(v_nsr.description, 500),
           effective_date = v_nsr.effective_date,
           voided_at = null
     where id = v_txn_id;

    v_result := jsonb_build_object(
      'commandId', v_command_id,
      'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'revise', 'canonicalTransactionId', v_txn_id,
        'reversalBatchId', v_reversal_id, 'replacementBatchId', v_batch_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
      v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  insert into public.journal_revisions
    (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
  values (v_prev_batch.id, v_reversal_id, null, 'sync removal');
  insert into public.transaction_source_links
    (canonical_transaction_id, normalized_source_record_id)
  values (v_txn_id, v_nsr.id);
  update public.canonical_transactions
     set status = 'voided', voided_at = now()
   where id = v_txn_id;

  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'economicEventKey', p_apply_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'kind', 'void', 'canonicalTransactionId', v_txn_id,
      'reversalBatchId', v_reversal_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
    v_actor, v_hash, 'ingest.transaction_voided', 'canonical_transaction',
    v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
  return v_result;
end;
$function$;

-- create-or-replace preserves owner/grants, but re-assert the worker ritual
-- exactly as 20260713090000 did (defense against a fresh-db replay ordering).
grant create on schema public to keel_worker;
alter function public.keel_worker_apply_action(uuid, text, text, text) owner to keel_worker;
revoke all on function public.keel_worker_apply_action(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.keel_worker_apply_action(uuid, text, text, text)
  to service_role;
revoke create on schema public from keel_worker;
