-- Admin/maintenance correction: void a canonical_transaction that turned out
-- to be a duplicate of one already captured under a DIFFERENT connection
-- (e.g. disconnect+relink of the same real bank account creates a new
-- connection/external_ref and re-pulls the same historical window under a
-- new economic-key namespace). `keel_cmd_manual_void` is deliberately
-- restricted to source='manual' so the generic sync/void machinery stays the
-- only writer for synced rows — this is that "generic machinery" for exactly
-- one narrow case: a KNOWN duplicate, identified administratively, not a
-- provider-reported removal. Same reversal-batch/journal_revisions mechanics
-- as keel_cmd_manual_void (Law 2: compensating reversal, original untouched)
-- but requires the surviving transaction_id it duplicates, so the audit
-- trail always records why. service_role only — not a user-facing command.
create function public.keel_admin_void_relink_duplicate(
  p_household_id uuid,
  p_transaction_id uuid,
  p_matched_transaction_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_command_id uuid := gen_random_uuid();
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'admin_maintenance');
  v_key text := 'admin-void-duplicate:' || p_transaction_id::text;
  v_hash text := public.keel_payload_hash(jsonb_build_object(
    'transactionId', p_transaction_id,
    'matchedTransactionId', p_matched_transaction_id,
    'reason', p_reason
  ));
  v_replay jsonb;
  v_txn public.canonical_transactions%rowtype;
  v_matched public.canonical_transactions%rowtype;
  v_batch public.journal_batches%rowtype;
  v_reversal_id uuid;
  v_result jsonb;
begin
  v_replay := public.keel_idempotency_check(p_household_id, v_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if char_length(btrim(p_reason)) < 1 or char_length(p_reason) > 500 then
    raise exception 'KEEL_INVALID_COMMAND: reason must be 1-500 characters' using errcode = 'P0009';
  end if;

  select * into v_txn
    from public.canonical_transactions
   where id = p_transaction_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: transaction not in household' using errcode = 'P0006';
  end if;
  if v_txn.voided_at is not null then
    raise exception 'KEEL_IMMUTABLE: transaction is already voided' using errcode = 'P0001';
  end if;

  -- The duplicate must genuinely correspond to a real, still-live surviving
  -- transaction in the SAME household — never void into a void, never let a
  -- caller fabricate a match.
  select * into v_matched
    from public.canonical_transactions
   where id = p_matched_transaction_id and household_id = p_household_id;
  if not found or v_matched.voided_at is not null then
    raise exception 'KEEL_SCOPE_VIOLATION: matched transaction not live in household' using errcode = 'P0006';
  end if;

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
    raise exception 'KEEL_IMMUTABLE: no live batch to void' using errcode = 'P0001';
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (p_household_id, v_txn.id, left('VOID: ' || p_reason, 500),
     v_batch.effective_date, v_batch.id, v_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_batch.id;

  insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
  values (v_batch.id, v_reversal_id, p_reason);

  update public.canonical_transactions
     set status = 'voided', voided_at = now()
   where id = v_txn.id;

  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'economicEventKey', v_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'canonicalTransactionId', v_txn.id,
      'matchedTransactionId', v_matched.id,
      'originalBatchId', v_batch.id,
      'reversalBatchId', v_reversal_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    v_command_id, 'admin.void_relink_duplicate', v_key, p_household_id, v_actor,
    v_hash, 'admin.transaction_voided_duplicate', 'canonical_transaction', v_txn.id,
    jsonb_build_object('matchedTransactionId', v_matched.id, 'reason', p_reason), v_result
  );

  return v_result;
end;
$$;

revoke all on function public.keel_admin_void_relink_duplicate(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.keel_admin_void_relink_duplicate(uuid, uuid, uuid, text) to service_role;
