-- Stage 1C C5b: durable Plaid sync-pull orchestration and normalized-derived
-- promotion. Existing Stage 1A worker procedures remain callable unchanged.

-- The attempt records the fencing owner that opened it. Page/archive/action
-- procedures do not accept a caller-controlled owner; they prove that this
-- recorded owner still holds the connection lease instead.
alter table public.sync_attempts
  add column lease_owner uuid not null;

-- Every distinct Plaid notification advances desired work atomically with
-- immutable capture. Attempt pages use account_external_ref='item-page' and
-- must never count as new notifications.
create function public.keel_worker_note_sync_notification() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.provider = 'plaid' and new.account_external_ref <> 'item-page' then
    update public.connections
       set sync_desired_generation = sync_desired_generation + 1
     where id = new.connection_id;
  end if;
  return new;
end;
$$;

create trigger raw_provider_events_note_sync_notification
  after insert on public.raw_provider_events
  for each row execute function public.keel_worker_note_sync_notification();

create function public.keel_worker_acquire_sync_lease(
  p_connection_id uuid,
  p_owner uuid,
  p_ttl_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_base_cursor text;
begin
  if p_ttl_seconds <= 0 then
    raise exception 'KEEL_INVALID_COMMAND: sync lease TTL must be positive'
      using errcode = 'P0009';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_connection_id::text, 0));
  select * into v_conn
    from public.connections
   where id = p_connection_id
   for update;
  if not found then
    return jsonb_build_object('acquired', false, 'reason', 'connection_not_found');
  end if;
  if v_conn.status = 'reauth_required' then
    return jsonb_build_object('acquired', false, 'reason', 'reauth_required');
  end if;
  if exists (
    select 1 from public.sync_attempts a
     where a.connection_id = p_connection_id
       and a.state = 'completed'
       and a.promoted_at is null
  ) then
    return jsonb_build_object('acquired', false, 'reason', 'promotion_barrier');
  end if;
  if v_conn.sync_leased_until is not null
     and v_conn.sync_leased_until >= now()
     and v_conn.sync_lease_owner is distinct from p_owner then
    return jsonb_build_object('acquired', false, 'reason', 'lease_held');
  end if;

  update public.connections
     set sync_lease_owner = p_owner,
         sync_leased_until = now() + pg_catalog.make_interval(secs => p_ttl_seconds)
   where id = p_connection_id
     and (
       sync_leased_until is null
       or sync_leased_until < now()
       or sync_lease_owner = p_owner
     );
  if not found then
    return jsonb_build_object('acquired', false, 'reason', 'lease_lost');
  end if;

  select s.cursor into v_base_cursor
    from public.sync_checkpoints s
   where s.connection_id = p_connection_id;

  return jsonb_build_object(
    'acquired', true,
    'base_cursor', v_base_cursor,
    'committed_generation', v_conn.sync_committed_generation,
    'desired_generation', v_conn.sync_desired_generation
  );
end;
$$;

create function public.keel_worker_renew_sync_lease(
  p_connection_id uuid,
  p_owner uuid,
  p_ttl_seconds int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ttl_seconds <= 0 then
    return false;
  end if;
  update public.connections
     set sync_leased_until = now() + pg_catalog.make_interval(secs => p_ttl_seconds)
   where id = p_connection_id
     and sync_lease_owner = p_owner
     and sync_leased_until >= now()
     and status <> 'reauth_required';
  return found;
end;
$$;

create function public.keel_worker_open_attempt(
  p_connection_id uuid,
  p_owner uuid,
  p_base_cursor text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_attempt_id uuid;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id
     and sync_lease_owner = p_owner
     and sync_leased_until >= now()
     and status <> 'reauth_required'
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: sync lease lost'
      using errcode = 'P0006';
  end if;

  select a.attempt_id into v_attempt_id
    from public.sync_attempts a
   where a.connection_id = p_connection_id
     and a.lease_owner = p_owner
     and a.generation = v_conn.sync_desired_generation
     and a.state = 'open'
     and a.base_cursor is not distinct from p_base_cursor
   order by a.created_at desc
   limit 1;
  if v_attempt_id is not null then
    return v_attempt_id;
  end if;

  insert into public.sync_attempts
    (household_id, connection_id, base_cursor, next_request_cursor,
     page_ordinal, generation, state, promoted_at, lease_owner)
  values
    (v_conn.household_id, v_conn.id, p_base_cursor, p_base_cursor,
     0, v_conn.sync_desired_generation, 'open', null, p_owner)
  returning attempt_id into v_attempt_id;
  return v_attempt_id;
end;
$$;

create function public.keel_worker_archive_page(
  p_attempt_id uuid,
  p_page_ordinal int,
  p_body_text text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
  v_conn public.connections%rowtype;
  v_raw_id uuid;
  v_body jsonb;
begin
  if p_page_ordinal < 0 or p_body_text is null then
    raise exception 'KEEL_INVALID_COMMAND: invalid archived sync page'
      using errcode = 'P0009';
  end if;
  v_body := p_body_text::jsonb;

  select * into v_attempt
    from public.sync_attempts
   where attempt_id = p_attempt_id
     and state = 'open'
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: attempt is not open'
      using errcode = 'P0006';
  end if;
  select * into v_conn
    from public.connections
   where id = v_attempt.connection_id
     and sync_lease_owner = v_attempt.lease_owner
     and sync_leased_until >= now()
     and status <> 'reauth_required';
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: sync lease lost'
      using errcode = 'P0006';
  end if;

  insert into public.raw_provider_events
    (household_id, connection_id, provider, provider_event_id,
     account_external_ref, body, body_text, body_sha256, received_at)
  values
    (v_attempt.household_id, v_attempt.connection_id, v_conn.provider,
     p_attempt_id::text || ':' || p_page_ordinal::text, 'item-page', v_body,
     p_body_text,
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_body_text, 'UTF8')), 'hex'),
     now())
  on conflict (connection_id, provider, provider_event_id) do nothing
  returning id into v_raw_id;

  if v_raw_id is null then
    select r.id into v_raw_id
      from public.raw_provider_events r
     where r.connection_id = v_attempt.connection_id
       and r.provider = v_conn.provider
       and r.provider_event_id = p_attempt_id::text || ':' || p_page_ordinal::text;
  end if;

  update public.sync_attempts
     set page_ordinal = greatest(page_ordinal, p_page_ordinal + 1),
         next_request_cursor = coalesce(v_body->>'next_cursor', next_request_cursor)
   where attempt_id = p_attempt_id;
  return v_raw_id;
end;
$$;

create function public.keel_worker_abandon_attempt(p_attempt_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sync_attempts a
     set state = 'abandoned'
    from public.connections c
   where a.attempt_id = p_attempt_id
     and a.state = 'open'
     and c.id = a.connection_id
     and c.sync_lease_owner = a.lease_owner
     and c.sync_leased_until >= now();
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: attempt abandon lost its lease'
      using errcode = 'P0006';
  end if;
end;
$$;

create function public.keel_worker_create_normalized(
  p_attempt_id uuid,
  p_account_id uuid,
  p_provider_transaction_id text,
  p_kind text,
  p_amount_minor text,
  p_currency text,
  p_effective_date date,
  p_description text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
  v_raw_id uuid;
  v_normalized_id uuid;
  v_pending boolean := false;
  v_pending_ref text;
begin
  if p_kind not in ('added', 'modified', 'removed') then
    raise exception 'KEEL_INVALID_COMMAND: unknown normalized kind %', p_kind
      using errcode = 'P0009';
  end if;
  select a.* into v_attempt
    from public.sync_attempts a
    join public.connections c on c.id = a.connection_id
   where a.attempt_id = p_attempt_id
     and a.state = 'open'
     and c.sync_lease_owner = a.lease_owner
     and c.sync_leased_until >= now()
     and c.status <> 'reauth_required';
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: normalized write lost its lease'
      using errcode = 'P0006';
  end if;

  select r.id into v_raw_id
    from public.raw_provider_events r
   where r.connection_id = v_attempt.connection_id
     and r.provider_event_id like p_attempt_id::text || ':%'
   order by r.recorded_at, r.id
   limit 1;
  if v_raw_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: attempt has no archived page'
      using errcode = 'P0006';
  end if;

  if p_kind <> 'removed' then
    if not exists (
      select 1 from public.accounts a
       where a.id = p_account_id
         and a.household_id = v_attempt.household_id
         and a.connection_id = v_attempt.connection_id
    ) then
      raise exception 'KEEL_SCOPE_VIOLATION: account is not on sync connection'
        using errcode = 'P0006';
    end if;
    select (txn->>'pending')::boolean, nullif(txn->>'pending_transaction_id', '')
      into v_pending, v_pending_ref
      from public.raw_provider_events r
      cross join lateral jsonb_array_elements(
        coalesce(r.body->'added', '[]'::jsonb) || coalesce(r.body->'modified', '[]'::jsonb)
      ) txn
     where r.connection_id = v_attempt.connection_id
       and r.provider_event_id like p_attempt_id::text || ':%'
       and txn->>'transaction_id' = p_provider_transaction_id
     order by r.recorded_at desc
     limit 1;
  end if;

  select n.id into v_normalized_id
    from public.normalized_source_records n
   where n.raw_event_id = v_raw_id
     and n.provider_transaction_id = p_provider_transaction_id
     and n.kind = p_kind::public.source_record_kind
   order by n.created_at, n.id
   limit 1;
  if v_normalized_id is not null then
    return v_normalized_id;
  end if;

  insert into public.normalized_source_records
    (raw_event_id, household_id, account_id, provider_transaction_id,
     amount_minor, currency, effective_date, description, pending,
     pending_transaction_ref, kind)
  values
    (v_raw_id, v_attempt.household_id,
     case when p_kind = 'removed' then null else p_account_id end,
     p_provider_transaction_id,
     case when p_kind = 'removed' then null else p_amount_minor::bigint end,
     case when p_kind = 'removed' then null else p_currency end,
     case when p_kind = 'removed' then null else p_effective_date end,
     case when p_kind = 'removed' then null else p_description end,
     case when p_kind = 'removed' then false else coalesce(v_pending, false) end,
     case when p_kind = 'removed' then null else v_pending_ref end,
     p_kind::public.source_record_kind)
  returning id into v_normalized_id;
  return v_normalized_id;
end;
$$;

-- Financial values and posting accounts are derived from the immutable
-- normalized row. The caller supplies only planner intent and stable keys.
create function public.keel_worker_apply_action(
  p_normalized_id uuid,
  p_action_kind text,
  p_economic_key text,
  p_apply_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nsr public.normalized_source_records%rowtype;
  v_account public.accounts%rowtype;
  v_offset_id uuid;
  v_hash text := public.keel_payload_hash(jsonb_build_object(
    'normalizedId', p_normalized_id,
    'actionKind', p_action_kind,
    'economicKey', p_economic_key
  ));
  v_replay jsonb;
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'worker');
  v_command_id uuid := gen_random_uuid();
  v_txn_id uuid;
  v_batch_id uuid;
  v_reversal_id uuid;
  v_prev_batch record;
  v_postings jsonb;
  v_result jsonb;
  v_reason text;
  v_status public.transaction_status;
  v_attempt_id uuid;
begin
  if p_action_kind not in ('create', 'revise', 'void') then
    raise exception 'KEEL_INVALID_COMMAND: unknown promotion kind %', p_action_kind
      using errcode = 'P0009';
  end if;
  select * into v_nsr
    from public.normalized_source_records
   where id = p_normalized_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown normalized record'
      using errcode = 'P0006';
  end if;
  if p_action_kind in ('create', 'revise') and v_nsr.kind = 'removed' then
    raise exception 'KEEL_INVALID_COMMAND: tombstone cannot create or revise'
      using errcode = 'P0009';
  end if;
  if p_action_kind = 'void' and v_nsr.kind <> 'removed' then
    raise exception 'KEEL_INVALID_COMMAND: void requires a removal tombstone'
      using errcode = 'P0009';
  end if;

  -- The normalized row links to this attempt's first archived page. Derive
  -- the attempt id from that immutable page id and enforce the live fencing
  -- owner immediately before any canonical or journal write.
  select a.attempt_id into v_attempt_id
    from public.raw_provider_events r
    join public.sync_attempts a
      on a.attempt_id = pg_catalog.split_part(r.provider_event_id, ':', 1)::uuid
    join public.connections c on c.id = a.connection_id
   where r.id = v_nsr.raw_event_id
     and r.account_external_ref = 'item-page'
     and a.state = 'open'
     and c.sync_lease_owner = a.lease_owner
     and c.sync_leased_until >= now()
     and c.status <> 'reauth_required';
  if v_attempt_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: promotion lost its sync lease'
      using errcode = 'P0006';
  end if;

  v_replay := public.keel_idempotency_check(v_nsr.household_id, p_apply_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if p_action_kind in ('create', 'revise') then
    select * into v_account
      from public.accounts
     where id = v_nsr.account_id
       and household_id = v_nsr.household_id;
    if not found then
      raise exception 'KEEL_SCOPE_VIOLATION: normalized account missing'
        using errcode = 'P0006';
    end if;
    if v_nsr.amount_minor = 0 then
      raise exception 'KEEL_INVALID_MONEY: zero sync transaction'
        using errcode = 'P0008';
    end if;
    select la.id into v_offset_id
      from public.ledger_accounts la
     where la.household_id = v_nsr.household_id
       and la.entity_id = v_account.entity_id
       and la.currency = v_nsr.currency
       and la.name = case when v_nsr.amount_minor < 0
                          then 'Uncategorized Expense'
                          else 'Uncategorized Income' end;
    if v_offset_id is null then
      raise exception 'KEEL_SCOPE_VIOLATION: offset category missing'
        using errcode = 'P0006';
    end if;
    v_postings := jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_nsr.amount_minor::text,
        'currency', v_nsr.currency
      ),
      jsonb_build_object(
        'ledger_account_id', v_offset_id,
        'amount_minor', (-v_nsr.amount_minor)::text,
        'currency', v_nsr.currency
      )
    );
    v_status := case when v_nsr.pending then 'pending' else 'posted' end;
  end if;

  if p_action_kind = 'create' then
    insert into public.canonical_transactions
      (household_id, entity_id, account_id, status, source, description,
       effective_date, economic_event_key)
    values
      (v_nsr.household_id, v_account.entity_id, v_account.id, v_status, 'sync',
       left(v_nsr.description, 500), v_nsr.effective_date, p_economic_key)
    returning id into v_txn_id;

    insert into public.transaction_source_links
      (household_id, canonical_transaction_id, normalized_source_record_id)
    values (v_nsr.household_id, v_txn_id, v_nsr.id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500),
       v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;
    v_postings := public.keel_insert_postings(v_nsr.household_id, v_batch_id, v_postings);

    v_result := jsonb_build_object(
      'commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'create', 'canonicalTransactionId', v_txn_id,
        'batchId', v_batch_id, 'postings', v_postings),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
      v_actor, v_hash, 'ingest.transaction_created', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  select ct.id into v_txn_id
    from public.canonical_transactions ct
   where ct.household_id = v_nsr.household_id
     and ct.economic_event_key = p_economic_key;
  if v_txn_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown canonical transaction'
      using errcode = 'P0006';
  end if;

  select b.id, b.effective_date into v_prev_batch
    from public.journal_batches b
   where b.canonical_transaction_id = v_txn_id
     and b.reverses_batch_id is null
     and not exists (
       select 1 from public.journal_revisions r where r.original_batch_id = b.id
     )
   order by b.posted_at desc
   limit 1;
  if v_prev_batch.id is null then
    raise exception 'KEEL_IMMUTABLE: no live batch to correct'
      using errcode = 'P0001';
  end if;

  v_reason := case
    when p_action_kind = 'void' then 'provider_removed'
    when v_nsr.pending_transaction_ref is not null then 'supersession'
    else 'provider_modified'
  end;
  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (v_nsr.household_id, v_txn_id, 'REVERSAL: ' || v_reason,
     v_prev_batch.effective_date, v_prev_batch.id, v_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings
    (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_prev_batch.id;

  insert into public.transaction_source_links
    (household_id, canonical_transaction_id, normalized_source_record_id)
  values (v_nsr.household_id, v_txn_id, v_nsr.id);

  if p_action_kind = 'revise' then
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500),
       v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;
    v_postings := public.keel_insert_postings(v_nsr.household_id, v_batch_id, v_postings);

    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch.id, v_reversal_id, v_batch_id, v_reason);
    update public.canonical_transactions
       set status = v_status,
           description = left(v_nsr.description, 500),
           effective_date = v_nsr.effective_date,
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
      v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
      v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  insert into public.journal_revisions
    (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
  values (v_prev_batch.id, v_reversal_id, null, v_reason);
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
    v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
    v_actor, v_hash, 'ingest.transaction_voided', 'canonical_transaction',
    v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
  return v_result;
end;
$$;

-- Tombstones remain linked for source lineage, but the planner's current
-- economic projection must always come from the latest non-removal record.
create or replace function public.keel_worker_lookup_state(
  p_connection_id uuid,
  p_provider_txn_ids text[]
) returns jsonb
language sql
security definer
set search_path = public
stable
as $$
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
         and n2.kind <> 'removed'
       order by n2.created_at desc, n2.id desc
       limit 1
    ) nsr_latest on true
    where a.connection_id = p_connection_id
      and nsr.provider_transaction_id = any (p_provider_txn_ids)
    order by nsr.provider_transaction_id, nsr.created_at desc
  ) entries;
$$;

-- Bounded invocations hand the same fenced attempt to a fresh queue message.
create function public.keel_worker_enqueue_sync_continuation(p_attempt_id uuid) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
begin
  select a.* into v_attempt
    from public.sync_attempts a
    join public.connections c on c.id = a.connection_id
   where a.attempt_id = p_attempt_id
     and a.state = 'open'
     and c.sync_lease_owner = a.lease_owner
     and c.sync_leased_until >= now();
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: continuation lost its lease'
      using errcode = 'P0006';
  end if;
  return public.keel_enqueue('sync_events', jsonb_build_object(
    'jobType', 'sync_notification',
    'economicEventKey', format('sync:%s:attempt:%s', v_attempt.connection_id, v_attempt.attempt_id),
    'refs', jsonb_build_object(
      'connectionId', v_attempt.connection_id::text,
      'attemptId', v_attempt.attempt_id::text,
      'leaseOwner', v_attempt.lease_owner::text
    )
  ));
end;
$$;

create function public.keel_worker_complete_attempt(
  p_attempt_id uuid,
  p_next_cursor text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
  v_conn public.connections%rowtype;
  v_current_cursor text;
begin
  if p_next_cursor is null then
    raise exception 'KEEL_INVALID_COMMAND: completed sync cursor is required'
      using errcode = 'P0009';
  end if;
  select * into v_attempt
    from public.sync_attempts
   where attempt_id = p_attempt_id
     and state = 'open'
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: attempt is not open'
      using errcode = 'P0006';
  end if;
  select * into v_conn
    from public.connections
   where id = v_attempt.connection_id
     and sync_lease_owner = v_attempt.lease_owner
     and sync_leased_until >= now()
     and status <> 'reauth_required'
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: completion lost its lease'
      using errcode = 'P0006';
  end if;

  select s.cursor into v_current_cursor
    from public.sync_checkpoints s
   where s.connection_id = v_attempt.connection_id
   for update;
  if found then
    if v_current_cursor is distinct from v_attempt.base_cursor then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: committed cursor changed under attempt'
        using errcode = 'P0007';
    end if;
    update public.sync_checkpoints
       set cursor = p_next_cursor, updated_at = now()
     where connection_id = v_attempt.connection_id
       and cursor is not distinct from v_attempt.base_cursor;
    if not found then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: cursor compare-and-swap lost'
        using errcode = 'P0007';
    end if;
  else
    if v_attempt.base_cursor is not null then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: missing base checkpoint'
        using errcode = 'P0007';
    end if;
    insert into public.sync_checkpoints (connection_id, cursor, updated_at)
    values (v_attempt.connection_id, p_next_cursor, now());
  end if;

  update public.sync_attempts
     set state = 'completed', promoted_at = now(), next_request_cursor = p_next_cursor
   where attempt_id = p_attempt_id;
  update public.connections
     set sync_committed_generation = v_attempt.generation,
         sync_lease_owner = null,
         sync_leased_until = null,
         last_successful_sync_at = now()
   where id = v_attempt.connection_id
     and sync_lease_owner = v_attempt.lease_owner;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: completion fence lost'
      using errcode = 'P0006';
  end if;

  if v_conn.sync_desired_generation > v_attempt.generation then
    perform public.keel_enqueue('sync_events', jsonb_build_object(
      'jobType', 'sync_notification',
      'economicEventKey', format(
        'sync:%s:generation:%s', v_attempt.connection_id, v_conn.sync_desired_generation
      ),
      'refs', jsonb_build_object('connectionId', v_attempt.connection_id::text)
    ));
  end if;
end;
$$;

-- New C2a tables did not inherit the Stage 1A worker policies/ACLs.
grant select, insert, update on public.sync_attempts to keel_worker;
grant select on public.connection_credentials to keel_worker;
grant update (
  sync_lease_owner, sync_leased_until, sync_desired_generation,
  sync_committed_generation, last_successful_sync_at
) on public.connections to keel_worker;

create policy sync_attempts_worker_all on public.sync_attempts
  for all to keel_worker using (true) with check (true);
create policy connection_credentials_worker_read on public.connection_credentials
  for select to keel_worker using (true);

-- service_role reads connection credentials in Edge memory and test/ops may
-- inspect attempts. There is still no service-role direct write surface.
grant select on public.connection_credentials, public.sync_attempts to service_role;

grant create on schema public to keel_worker;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.keel_worker_note_sync_notification()',
    'public.keel_worker_acquire_sync_lease(uuid, uuid, integer)',
    'public.keel_worker_renew_sync_lease(uuid, uuid, integer)',
    'public.keel_worker_open_attempt(uuid, uuid, text)',
    'public.keel_worker_archive_page(uuid, integer, text)',
    'public.keel_worker_abandon_attempt(uuid)',
    'public.keel_worker_create_normalized(uuid, uuid, text, text, text, text, date, text)',
    'public.keel_worker_apply_action(uuid, text, text, text)',
    'public.keel_worker_enqueue_sync_continuation(uuid)',
    'public.keel_worker_complete_attempt(uuid, text)'
  ] loop
    execute format('alter function %s owner to keel_worker', f);
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

revoke create on schema public from keel_worker;

-- Definer chain dependencies used by apply/continuation.
grant execute on function public.keel_idempotency_check(uuid, text, text) to keel_worker;
grant execute on function public.keel_finish_command(
  uuid, text, text, uuid, jsonb, text, text, text, uuid, jsonb, jsonb
) to keel_worker;
grant execute on function public.keel_insert_postings(uuid, uuid, jsonb) to keel_worker;
grant execute on function public.keel_payload_hash(jsonb) to keel_worker;
grant execute on function public.keel_enqueue(text, jsonb) to keel_worker;
grant select on public.period_locks to keel_worker;
grant update (status, voided_at, description, effective_date)
  on public.canonical_transactions to keel_worker;
