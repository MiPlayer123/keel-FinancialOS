-- Worker-path SECURITY DEFINER procs (INFRA §4: internal functions use named
-- server secrets). Transport auth happens at the Edge (`secret:automations`);
-- these procs are executable ONLY by service_role and act as the system
-- actor. Owned by keel_worker — non-BYPASSRLS, minimal grants.
--
-- TS (packages/ingest) computes the promotion PLAN; these procs validate and
-- persist it atomically: normalized record + canonical txn + balanced batch +
-- revision lineage + audit + domain event in one transaction.

-- Record a raw provider event (webhook/simulator path). Duplicate delivery of
-- the same (connection, provider, event id) returns the existing row id.
create function public.keel_worker_record_raw_event(
  p_provider text,
  p_connection_external_ref text,
  p_provider_event_id text,
  p_account_external_ref text,
  p_body jsonb,
  p_received_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_raw_id uuid;
  v_duplicate boolean := false;
begin
  -- STRICT: connections are unique per household but an external_ref MAY repeat
  -- across households, so an ambiguous match must ERROR, never silently route
  -- a raw event to an arbitrary tenant (stage-exit Finding 3). The webhook is
  -- public transport; deterministic routing is a security property.
  begin
    select * into strict v_conn
      from public.connections c
     where c.provider = p_provider::public.bank_provider
       and c.external_ref = p_connection_external_ref;
  exception
    when no_data_found then
      raise exception 'KEEL_SCOPE_VIOLATION: unknown connection %', p_connection_external_ref
        using errcode = 'P0006';
    when too_many_rows then
      raise exception 'KEEL_SCOPE_VIOLATION: ambiguous connection ref %', p_connection_external_ref
        using errcode = 'P0006';
  end;

  select r.id into v_raw_id
    from public.raw_provider_events r
   where r.connection_id = v_conn.id
     and r.provider = p_provider::public.bank_provider
     and r.provider_event_id = p_provider_event_id;

  if v_raw_id is null then
    insert into public.raw_provider_events
      (household_id, connection_id, provider, provider_event_id,
       account_external_ref, body, received_at)
    values
      (v_conn.household_id, v_conn.id, p_provider::public.bank_provider,
       p_provider_event_id, p_account_external_ref, p_body, p_received_at)
    returning id into v_raw_id;

    insert into public.audit_log (household_id, actor, action, object_type, object_id, command_id, before, after)
    values (
      v_conn.household_id,
      jsonb_build_object('kind', 'system', 'processName', 'worker'),
      'ingest.record_raw_event', 'raw_provider_event', v_raw_id, gen_random_uuid(),
      null, jsonb_build_object('providerEventId', p_provider_event_id)
    );

    -- Simulator events carry the economic payload and promote directly;
    -- provider NOTIFICATIONS (plaid) trigger a sync pull instead (stage 1C).
    perform public.keel_enqueue('sync_events', jsonb_build_object(
      'jobType',
      case when p_provider = 'simulator' then 'promote_raw_event' else 'sync_notification' end,
      'economicEventKey', format('evt:%s:%s:%s:promote', p_provider, p_connection_external_ref, p_provider_event_id),
      'refs', jsonb_build_object('rawEventId', v_raw_id::text)
    ));
  else
    v_duplicate := true;
  end if;

  return jsonb_build_object('rawEventId', v_raw_id, 'duplicate', v_duplicate,
    'householdId', v_conn.household_id);
end;
$$;

-- Apply one promotion action computed by packages/ingest. p_apply_key is the
-- idempotency key for THIS application (scoped per household in
-- command_executions); the canonical transaction's own economic_event_key
-- provides economic identity.
create function public.keel_worker_apply_promotion(
  p_raw_event_id uuid,
  p_apply_key text,
  p_action jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw public.raw_provider_events%rowtype;
  v_kind text := p_action->>'kind';
  v_key text := p_action->>'economic_key';
  v_hash text := public.keel_payload_hash(p_action);
  v_replay jsonb;
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'worker');
  v_account public.accounts%rowtype;
  v_txn_id uuid;
  v_batch_id uuid;
  v_reversal_id uuid;
  v_prev_batch record;
  v_postings jsonb;
  v_result jsonb;
  v_command_id uuid := gen_random_uuid();
  v_nsr_id uuid;
begin
  select * into v_raw from public.raw_provider_events where id = p_raw_event_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown raw event' using errcode = 'P0006';
  end if;

  v_replay := public.keel_idempotency_check(v_raw.household_id, p_apply_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_kind = 'noop' then
    v_result := jsonb_build_object(
      'commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object('kind', 'noop', 'reason', p_action->>'reason'),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    insert into public.command_executions
      (household_id, economic_event_key, command_id, command, payload_sha256, result)
    values (v_raw.household_id, p_apply_key, v_command_id, 'ingest.apply_promotion', v_hash, v_result);
    return v_result;
  end if;

  -- Resolve the target account by external ref within the raw event's
  -- connection — cross-household smuggling is structurally impossible.
  select a.* into v_account
    from public.accounts a
   where a.connection_id = v_raw.connection_id
     and a.external_ref = p_action->'txn'->>'account_external_ref';
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown account ref %',
      p_action->'txn'->>'account_external_ref' using errcode = 'P0006';
  end if;

  if v_kind = 'create' then
    insert into public.normalized_source_records
      (raw_event_id, household_id, account_id, provider_transaction_id,
       amount_minor, currency, effective_date, description, pending, pending_transaction_ref)
    values
      (v_raw.id, v_raw.household_id, v_account.id,
       p_action->'txn'->>'provider_transaction_id',
       (p_action->'txn'->>'amount_minor')::bigint,
       p_action->'txn'->>'currency',
       (p_action->'txn'->>'effective_date')::date,
       p_action->'txn'->>'description',
       (p_action->'txn'->>'status') = 'pending',
       nullif(p_action->'txn'->>'pending_transaction_ref', ''))
    returning id into v_nsr_id;

    insert into public.canonical_transactions
      (household_id, entity_id, account_id, status, source, description,
       effective_date, economic_event_key)
    values
      (v_raw.household_id, v_account.entity_id, v_account.id,
       (p_action->'txn'->>'status')::public.transaction_status, 'sync',
       left(p_action->'txn'->>'description', 500),
       (p_action->'txn'->>'effective_date')::date, v_key)
    returning id into v_txn_id;

    insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr_id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_raw.household_id, v_txn_id, left(p_action->'txn'->>'description', 500),
       (p_action->'txn'->>'effective_date')::date, v_command_id)
    returning id into v_batch_id;

    v_postings := public.keel_insert_postings(v_raw.household_id, v_batch_id, p_action->'postings');

    v_result := jsonb_build_object(
      'commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'create', 'canonicalTransactionId', v_txn_id,
        'batchId', v_batch_id, 'postings', v_postings),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );

    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_promotion', p_apply_key, v_raw.household_id,
      v_actor, v_hash, 'ingest.transaction_created', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', v_key), v_result);
    return v_result;
  end if;

  -- revise / void need the existing canonical transaction + its live batch.
  select ct.id into v_txn_id
    from public.canonical_transactions ct
   where ct.household_id = v_raw.household_id and ct.economic_event_key = v_key;
  if v_txn_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown canonical txn for key %', v_key
      using errcode = 'P0006';
  end if;

  -- Newest batch that is neither a reversal nor already reversed.
  select b.id, b.effective_date into v_prev_batch
    from public.journal_batches b
   where b.canonical_transaction_id = v_txn_id
     and b.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions r where r.original_batch_id = b.id)
   order by b.posted_at desc
   limit 1;
  if v_prev_batch.id is null then
    raise exception 'KEEL_IMMUTABLE: no live batch to correct for txn %', v_txn_id
      using errcode = 'P0001';
  end if;

  -- Compensating reversal of the live batch (Law 2: original untouched).
  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (v_raw.household_id, v_txn_id, 'REVERSAL: ' || (p_action->>'reason'),
     v_prev_batch.effective_date, v_prev_batch.id, v_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p where p.batch_id = v_prev_batch.id;

  if v_kind = 'revise' then
    insert into public.normalized_source_records
      (raw_event_id, household_id, account_id, provider_transaction_id,
       amount_minor, currency, effective_date, description, pending, pending_transaction_ref)
    values
      (v_raw.id, v_raw.household_id, v_account.id,
       p_action->'txn'->>'provider_transaction_id',
       (p_action->'txn'->>'amount_minor')::bigint,
       p_action->'txn'->>'currency',
       (p_action->'txn'->>'effective_date')::date,
       p_action->'txn'->>'description',
       (p_action->'txn'->>'status') = 'pending',
       nullif(p_action->'txn'->>'pending_transaction_ref', ''))
    returning id into v_nsr_id;

    insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr_id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_raw.household_id, v_txn_id, left(p_action->'txn'->>'description', 500),
       (p_action->'txn'->>'effective_date')::date, v_command_id)
    returning id into v_batch_id;

    v_postings := public.keel_insert_postings(v_raw.household_id, v_batch_id, p_action->'postings');

    insert into public.journal_revisions (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch.id, v_reversal_id, v_batch_id, p_action->>'reason');

    update public.canonical_transactions
       set status = (p_action->'txn'->>'status')::public.transaction_status,
           description = left(p_action->'txn'->>'description', 500),
           effective_date = (p_action->'txn'->>'effective_date')::date,
           voided_at = null
     where id = v_txn_id;

    v_result := jsonb_build_object(
      'commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'revise', 'canonicalTransactionId', v_txn_id,
        'reversalBatchId', v_reversal_id, 'replacementBatchId', v_batch_id,
        'postings', v_postings),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_promotion', p_apply_key, v_raw.household_id,
      v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', v_key), v_result);
    return v_result;
  end if;

  if v_kind = 'void' then
    insert into public.journal_revisions (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch.id, v_reversal_id, null, p_action->>'reason');

    update public.canonical_transactions
       set status = 'voided', voided_at = now()
     where id = v_txn_id;

    v_result := jsonb_build_object(
      'commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'void', 'canonicalTransactionId', v_txn_id,
        'reversalBatchId', v_reversal_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_promotion', p_apply_key, v_raw.household_id,
      v_actor, v_hash, 'ingest.transaction_voided', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', v_key), v_result);
    return v_result;
  end if;

  raise exception 'KEEL_INVALID_COMMAND: unknown promotion kind %', v_kind
    using errcode = 'P0009';
end;
$$;

-- Reconstruct the planner's state view for a set of provider transaction ids
-- (packages/ingest IngestState entries). Supersession-aware: a normalized
-- record whose canonical txn was continued by a posted event still resolves.
create function public.keel_worker_lookup_state(
  p_connection_id uuid,
  p_provider_txn_ids text[]
) returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  -- lookupKey is the QUERIED provider id (the worker maps state by it), but the
  -- view's providerTransactionId/amount/status reflect the CURRENT canonical
  -- identity — the LATEST source record. After a pending→posted supersession
  -- both the pending id P and the posted id Q resolve to the same posted view
  -- (view.providerTransactionId = Q), matching the pure planner's in-memory
  -- model exactly (stage-exit Finding 5 regression: without this, a replayed
  -- 'modified' on P re-triggered a spurious revision).
  select coalesce(jsonb_agg(entry), '[]'::jsonb) from (
    select distinct on (nsr.provider_transaction_id) jsonb_build_object(
      'lookupKey', nsr.provider_transaction_id,
      'providerTransactionId', nsr_latest.provider_transaction_id,
      'economicKey', ct.economic_event_key,
      'accountExternalRef', a.external_ref,
      'amountMinor', nsr_latest.amount_minor::text,
      'status', ct.status,
      'description', nsr_latest.description,
      'effectiveDate', nsr_latest.effective_date
    ) as entry
    from public.normalized_source_records nsr
    join public.transaction_source_links tsl on tsl.normalized_source_record_id = nsr.id
    join public.canonical_transactions ct on ct.id = tsl.canonical_transaction_id
    join public.accounts a on a.id = nsr.account_id
    join lateral (
      select n2.provider_transaction_id, n2.amount_minor, n2.description, n2.effective_date
        from public.transaction_source_links t2
        join public.normalized_source_records n2 on n2.id = t2.normalized_source_record_id
       where t2.canonical_transaction_id = ct.id
       order by n2.created_at desc, n2.id desc
       limit 1
    ) nsr_latest on true
    where a.connection_id = p_connection_id
      and nsr.provider_transaction_id = any (p_provider_txn_ids)
    order by nsr.provider_transaction_id, nsr.created_at desc
  ) entries;
$$;

-- Queue plumbing for the worker: read with visibility timeout, archive after
-- success, dead-letter via archive with failure marker (PLAN §3.6.6 — never
-- pop; at-least-once + idempotent handlers).
create function public.keel_worker_queue_read(p_queue text, p_vt integer, p_qty integer)
returns setof pgmq.message_record
language sql
security definer
set search_path = public
as $$
  select * from pgmq.read(p_queue, p_vt, p_qty);
$$;

create function public.keel_worker_queue_archive(p_queue text, p_msg_id bigint) returns boolean
language sql
security definer
set search_path = public
as $$
  select pgmq.archive(p_queue, p_msg_id);
$$;

-- Ownership + grants: service_role only (Edge worker/scheduled path).
-- As with keel_api, CREATE is needed only while ownership is transferred.
grant create on schema public to keel_worker;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.keel_worker_record_raw_event(text, text, text, text, jsonb, timestamptz)',
    'public.keel_worker_apply_promotion(uuid, text, jsonb)',
    'public.keel_worker_lookup_state(uuid, text[])',
    'public.keel_worker_queue_read(text, integer, integer)',
    'public.keel_worker_queue_archive(text, bigint)'
  ] loop
    execute format('alter function %s owner to keel_worker', f);
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

revoke create on schema public from keel_worker;

-- keel_worker_apply_promotion runs as keel_worker and calls shared helpers
-- owned by keel_api; the definer chain needs explicit EXECUTE.
grant execute on function public.keel_idempotency_check(uuid, text, text) to keel_worker;
grant execute on function public.keel_finish_command(uuid, text, text, uuid, jsonb, text, text, text, uuid, jsonb, jsonb) to keel_worker;
grant execute on function public.keel_insert_postings(uuid, uuid, jsonb) to keel_worker;
grant execute on function public.keel_payload_hash(jsonb) to keel_worker;
grant execute on function public.keel_enqueue(text, jsonb) to keel_worker;
-- The period-lock trigger (SECURITY INVOKER) reads period_locks whenever a
-- posting is inserted; the worker's reversal path inserts postings directly.
grant select on public.period_locks to keel_worker;
-- Revisions update the canonical header to the corrected values (the full
-- history lives in journal batches + normalized records, which stay
-- append-only).
grant update (description, effective_date) on public.canonical_transactions to keel_worker;

-- Accurate queue-emptiness probe: visibility timeouts hide retrying messages
-- from read(), so drain loops need real depth.
create function public.keel_worker_queue_depth(p_queue text) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_depth bigint;
begin
  if p_queue !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'KEEL_INVALID_COMMAND: bad queue name' using errcode = 'P0009';
  end if;
  execute format('select count(*) from pgmq.%I', 'q_' || p_queue) into v_depth;
  return v_depth;
end;
$$;
grant create on schema public to keel_worker;
alter function public.keel_worker_queue_depth(text) owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_worker_queue_depth(text) from public, anon, authenticated;
grant execute on function public.keel_worker_queue_depth(text) to service_role;
