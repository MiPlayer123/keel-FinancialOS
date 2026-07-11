-- Stage 1C C5b: durable Plaid sync-pull SQL core (PLAN-1C D-C/D-D).
-- Lease/attempt lifecycle + collision-safe page archive + normalized fan-out +
-- normalized-derived promotion (postings computed in SQL, never trusted from a
-- caller — Law 1 determinism). The deployed keel_worker_apply_promotion
-- (simulator path) stays intact; these are additive procs the Plaid sync path
-- uses. All owned by keel_worker, service_role-only.

-- ---------------------------------------------------------------------------
-- Lease: CAS acquire with fencing, reauth guard, and promotion barrier.
-- ---------------------------------------------------------------------------
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
  v_cursor text;
begin
  -- Serialize the acquire itself with a short advisory lock (released at the
  -- end of THIS txn); the durable lease row is what spans the HTTP pull.
  perform pg_advisory_xact_lock(hashtext('keel_sync_lease' || p_connection_id::text));

  select * into v_conn from public.connections where id = p_connection_id for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown connection' using errcode = 'P0006';
  end if;

  -- Guard: no sync while an item needs re-auth (INFRA lifecycle).
  if v_conn.status = 'reauth_required' then
    return jsonb_build_object('acquired', false, 'reason', 'reauth_required');
  end if;

  -- Promotion barrier: refuse a new attempt while a completed-but-un-promoted
  -- attempt exists for this connection (ordered per-connection promotion).
  if exists (
    select 1 from public.sync_attempts a
     where a.connection_id = p_connection_id
       and a.state = 'completed' and a.promoted_at is null
  ) then
    return jsonb_build_object('acquired', false, 'reason', 'promotion_pending');
  end if;

  -- CAS: acquire only if free/expired or already ours.
  if v_conn.sync_leased_until is not null
     and v_conn.sync_leased_until > now()
     and v_conn.sync_lease_owner is distinct from p_owner then
    return jsonb_build_object('acquired', false, 'reason', 'leased');
  end if;

  update public.connections
     set sync_lease_owner = p_owner,
         sync_leased_until = now() + make_interval(secs => p_ttl_seconds)
   where id = p_connection_id;

  select cursor into v_cursor from public.sync_checkpoints where connection_id = p_connection_id;

  return jsonb_build_object(
    'acquired', true,
    'householdId', v_conn.household_id,
    'externalRef', v_conn.external_ref,
    'baseCursor', coalesce(v_cursor, ''),
    'committedGeneration', v_conn.sync_committed_generation,
    'desiredGeneration', v_conn.sync_desired_generation
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
declare
  v_rows int;
begin
  update public.connections
     set sync_leased_until = now() + make_interval(secs => p_ttl_seconds)
   where id = p_connection_id and sync_lease_owner = p_owner;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Fencing helper: raise unless p_owner still holds the lease on p_connection_id.
create function public.keel_worker_assert_lease(p_connection_id uuid, p_owner uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and sync_lease_owner = p_owner
       and sync_leased_until > now()
  ) then
    raise exception 'KEEL_LEASE_LOST' using errcode = 'P0011';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Attempt lifecycle.
-- ---------------------------------------------------------------------------
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
  perform public.keel_worker_assert_lease(p_connection_id, p_owner);
  select * into v_conn from public.connections where id = p_connection_id;
  insert into public.sync_attempts
    (household_id, connection_id, base_cursor, generation, state)
  values
    (v_conn.household_id, p_connection_id, nullif(p_base_cursor, ''),
     v_conn.sync_desired_generation, 'open')
  returning attempt_id into v_attempt_id;
  return v_attempt_id;
end;
$$;

-- Immutable page archive. provider_event_id = attempt_id:ordinal (deterministic
-- within an attempt -> idempotent re-archive on same-attempt retry; a new
-- attempt writes distinct rows). Verbatim body_text + sha256 (Law 5 evidence).
create function public.keel_worker_archive_page(
  p_attempt_id uuid,
  p_owner uuid,
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
  v_id uuid;
begin
  select * into v_attempt from public.sync_attempts where attempt_id = p_attempt_id;
  if not found or v_attempt.state <> 'open' then
    raise exception 'KEEL_INVALID_COMMAND: attempt not open' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);
  select * into v_conn from public.connections where id = v_attempt.connection_id;

  insert into public.raw_provider_events
    (household_id, connection_id, provider, provider_event_id, account_external_ref,
     body, body_text, body_sha256, received_at)
  values
    (v_conn.household_id, v_conn.id, v_conn.provider,
     p_attempt_id::text || ':' || p_page_ordinal::text, 'item-page',
     p_body_text::jsonb, p_body_text,
     encode(pg_catalog.sha256(convert_to(p_body_text, 'UTF8')), 'hex'),
     now())
  on conflict (connection_id, provider, provider_event_id) do nothing
  returning id into v_id;

  update public.sync_attempts set page_ordinal = greatest(page_ordinal, p_page_ordinal)
   where attempt_id = p_attempt_id;
  return v_id;
end;
$$;

create function public.keel_worker_abandon_attempt(p_attempt_id uuid, p_owner uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
begin
  select * into v_attempt from public.sync_attempts where attempt_id = p_attempt_id;
  if found then
    perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);
    update public.sync_attempts set state = 'abandoned' where attempt_id = p_attempt_id;
  end if;
end;
$$;

-- Pre-create a normalized event (fan-out). Removal is a tombstone: economic
-- fields null, only provider_transaction_id required (C2a CHECK enforces).
create function public.keel_worker_create_normalized(
  p_attempt_id uuid,
  p_owner uuid,
  p_account_id uuid,
  p_provider_transaction_id text,
  p_kind text,
  p_amount_minor text,
  p_currency text,
  p_effective_date text,
  p_description text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
  v_page_id uuid;
  v_id uuid;
begin
  select * into v_attempt from public.sync_attempts where attempt_id = p_attempt_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: unknown attempt' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);

  -- Link to the attempt's first archived page as the raw source.
  select id into v_page_id from public.raw_provider_events
   where connection_id = v_attempt.connection_id
     and provider_event_id = p_attempt_id::text || ':0';

  insert into public.normalized_source_records
    (raw_event_id, household_id, account_id, provider_transaction_id, kind,
     amount_minor, currency, effective_date, description, pending)
  values
    (v_page_id, v_attempt.household_id,
     case when p_kind = 'removed' then null else p_account_id end,
     p_provider_transaction_id, p_kind::public.source_record_kind,
     case when p_kind = 'removed' then null else p_amount_minor::bigint end,
     case when p_kind = 'removed' then null else p_currency end,
     case when p_kind = 'removed' then null else p_effective_date::date end,
     case when p_kind = 'removed' then null else p_description end,
     false)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply a reconciled action. Postings are DERIVED in SQL from the normalized
-- row + the account's backing ledger account + a sign-routed Uncategorized
-- offset (Law 1: no caller-supplied postings). Idempotent on p_apply_key.
-- ---------------------------------------------------------------------------
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
    'normalizedId', p_normalized_id, 'kind', p_action_kind, 'key', p_economic_key));
  v_replay jsonb;
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'sync-worker');
  v_command_id uuid := gen_random_uuid();
  v_txn_id uuid;
  v_batch_id uuid;
  v_reversal_id uuid;
  v_prev_batch record;
  v_result jsonb;
begin
  select * into v_nsr from public.normalized_source_records where id = p_normalized_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown normalized record' using errcode = 'P0006';
  end if;

  v_replay := public.keel_idempotency_check(v_nsr.household_id, p_apply_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if p_action_kind = 'noop' then
    v_result := jsonb_build_object('commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false, 'effects', jsonb_build_object('kind', 'noop'),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    insert into public.command_executions
      (household_id, economic_event_key, command_id, command, payload_sha256, result)
    values (v_nsr.household_id, p_apply_key, v_command_id, 'ingest.apply_action', v_hash, v_result);
    return v_result;
  end if;

  -- CREATE: brand-new canonical from an added normalized row.
  if p_action_kind = 'create' then
    select * into v_account from public.accounts where id = v_nsr.account_id;
    select la.id into v_offset_id from public.ledger_accounts la
      where la.entity_id = v_account.entity_id
        and la.name = case when v_nsr.amount_minor < 0 then 'Uncategorized Expense'
                           else 'Uncategorized Income' end;
    if v_offset_id is null then
      raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
    end if;

    insert into public.canonical_transactions
      (household_id, entity_id, account_id, status, source, description,
       effective_date, economic_event_key)
    values (v_nsr.household_id, v_account.entity_id, v_account.id, 'posted', 'sync',
            left(v_nsr.description, 500), v_nsr.effective_date, p_economic_key)
    returning id into v_txn_id;

    insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr.id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500), v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(v_nsr.household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object('ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_nsr.amount_minor::text, 'currency', v_nsr.currency),
      jsonb_build_object('ledger_account_id', v_offset_id,
        'amount_minor', (-v_nsr.amount_minor)::text, 'currency', v_nsr.currency)
    ));

    v_result := jsonb_build_object('commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object('kind', 'create', 'canonicalTransactionId', v_txn_id, 'batchId', v_batch_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    perform public.keel_finish_command(v_command_id, 'ingest.apply_action', p_apply_key,
      v_nsr.household_id, v_actor, v_hash, 'ingest.transaction_created', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  -- revise / void need the existing canonical + its live batch.
  select id into v_txn_id from public.canonical_transactions
   where household_id = v_nsr.household_id and economic_event_key = p_economic_key;
  if v_txn_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown canonical for key %', p_economic_key using errcode = 'P0006';
  end if;

  select b.id, b.effective_date into v_prev_batch
    from public.journal_batches b
   where b.canonical_transaction_id = v_txn_id and b.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions r where r.original_batch_id = b.id)
   order by b.posted_at desc limit 1;
  if v_prev_batch.id is null then
    raise exception 'KEEL_IMMUTABLE: no live batch to correct' using errcode = 'P0001';
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, reverses_batch_id, command_id)
  values (v_nsr.household_id, v_txn_id, 'REVERSAL: sync ' || p_action_kind,
          v_prev_batch.effective_date, v_prev_batch.id, v_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p where p.batch_id = v_prev_batch.id;

  if p_action_kind = 'revise' then
    select * into v_account from public.accounts where id = v_nsr.account_id;
    select la.id into v_offset_id from public.ledger_accounts la
      where la.entity_id = v_account.entity_id
        and la.name = case when v_nsr.amount_minor < 0 then 'Uncategorized Expense'
                           else 'Uncategorized Income' end;

    insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr.id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500), v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(v_nsr.household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object('ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_nsr.amount_minor::text, 'currency', v_nsr.currency),
      jsonb_build_object('ledger_account_id', v_offset_id,
        'amount_minor', (-v_nsr.amount_minor)::text, 'currency', v_nsr.currency)
    ));

    insert into public.journal_revisions (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch.id, v_reversal_id, v_batch_id, 'sync supersession');

    update public.canonical_transactions
       set status = 'posted', description = left(v_nsr.description, 500),
           effective_date = v_nsr.effective_date, voided_at = null
     where id = v_txn_id;

    v_result := jsonb_build_object('commandId', v_command_id, 'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object('kind', 'revise', 'canonicalTransactionId', v_txn_id,
        'reversalBatchId', v_reversal_id, 'replacementBatchId', v_batch_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    perform public.keel_finish_command(v_command_id, 'ingest.apply_action', p_apply_key,
      v_nsr.household_id, v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  -- void
  insert into public.journal_revisions (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
  values (v_prev_batch.id, v_reversal_id, null, 'sync removal');
  insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
  values (v_txn_id, v_nsr.id);
  update public.canonical_transactions set status = 'voided', voided_at = now() where id = v_txn_id;

  v_result := jsonb_build_object('commandId', v_command_id, 'economicEventKey', p_apply_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object('kind', 'void', 'canonicalTransactionId', v_txn_id, 'reversalBatchId', v_reversal_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(v_command_id, 'ingest.apply_action', p_apply_key,
    v_nsr.household_id, v_actor, v_hash, 'ingest.transaction_voided', 'canonical_transaction',
    v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
  return v_result;
end;
$$;

-- Complete: mark attempt promoted, advance cursor + committed generation,
-- release lease. Atomic (single txn) — the promotion barrier holds because
-- completed+promoted_at land together.
create function public.keel_worker_complete_attempt(
  p_attempt_id uuid,
  p_owner uuid,
  p_next_cursor text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
begin
  select * into v_attempt from public.sync_attempts where attempt_id = p_attempt_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: unknown attempt' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);

  update public.sync_attempts set state = 'completed', promoted_at = now(),
         next_request_cursor = p_next_cursor
   where attempt_id = p_attempt_id;

  insert into public.sync_checkpoints (connection_id, cursor)
  values (v_attempt.connection_id, p_next_cursor)
  on conflict (connection_id) do update set cursor = excluded.cursor, updated_at = now();

  update public.connections
     set sync_committed_generation = v_attempt.generation,
         last_successful_sync_at = now(),
         sync_lease_owner = null, sync_leased_until = null
   where id = v_attempt.connection_id;

  return jsonb_build_object('completed', true, 'generation', v_attempt.generation);
end;
$$;

-- Bump desired generation on a new sync notification (coalesces concurrent).
create function public.keel_worker_bump_generation(p_connection_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.connections set sync_desired_generation = sync_desired_generation + 1
   where id = p_connection_id;
end;
$$;

-- The SECURITY DEFINER sync procs run as keel_worker and touch the C2a
-- sync-lifecycle tables/columns, which were granted to service_role but not to
-- keel_worker. Grant exactly what the procs need.
grant update (sync_lease_owner, sync_leased_until, sync_desired_generation,
              sync_committed_generation, last_successful_sync_at)
  on public.connections to keel_worker;
grant select, insert, update on public.sync_attempts to keel_worker;
-- service_role reads sync_attempts for diagnostics/tests (it bypasses RLS but
-- the C2a table postdates the historical blanket service_role select grant).
grant select on public.sync_attempts to service_role;
-- RLS applies to keel_worker (non-superuser); the SECURITY DEFINER procs need a
-- permissive policy (matches the 1A *_definer_all pattern). Authorization is
-- enforced above this layer by the lease/fencing logic, not RLS.
create policy sync_attempts_worker_all on public.sync_attempts
  for all to keel_worker using (true) with check (true);

-- Ownership + grants: service_role only (Edge worker path). keel_worker needs
-- CREATE on public to own functions there; grant temporarily, revoke after
-- (matches the deployed 210800 pattern).
grant create on schema public to keel_worker;
do $$
declare f text;
begin
  foreach f in array array[
    'keel_worker_acquire_sync_lease(uuid, uuid, integer)',
    'keel_worker_renew_sync_lease(uuid, uuid, integer)',
    'keel_worker_assert_lease(uuid, uuid)',
    'keel_worker_open_attempt(uuid, uuid, text)',
    'keel_worker_archive_page(uuid, uuid, integer, text)',
    'keel_worker_abandon_attempt(uuid, uuid)',
    'keel_worker_create_normalized(uuid, uuid, uuid, text, text, text, text, text, text)',
    'keel_worker_apply_action(uuid, text, text, text)',
    'keel_worker_complete_attempt(uuid, uuid, text)',
    'keel_worker_bump_generation(uuid)'
  ] loop
    execute format('alter function public.%s owner to keel_worker', f);
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
revoke create on schema public from keel_worker;

-- ---------------------------------------------------------------------------
-- Test-support ONLY: deterministic, network-free injection of the pages a
-- connection's next /transactions/sync would return. Empty in production (the
-- worker calls real Plaid when no rows exist). Server-only, no client access.
-- Each row is one page; `body` is the verbatim Plaid /transactions/sync JSON
-- (added/modified/removed/next_cursor/has_more), or a mutation-restart marker
-- {"error_code":"TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"}.
-- ---------------------------------------------------------------------------
create table public.sync_test_pages (
  connection_id uuid not null references public.connections (id),
  page_index int not null,
  body_text text not null,
  primary key (connection_id, page_index)
);
revoke all on public.sync_test_pages from anon, authenticated;
grant select, insert, delete on public.sync_test_pages to service_role;
alter table public.sync_test_pages enable row level security;
create policy sync_test_pages_service on public.sync_test_pages
  for all to service_role using (true) with check (true);
