-- Stage 1C exit hardening: exact sync provenance/pending state, durable
-- normalize-time skips, and same-command link-attempt ownership.

-- ---------------------------------------------------------------------------
-- PLAN §6: immutable, tenant-scoped normalize-time skip evidence. The narrow
-- writer derives household + connection from the archived raw page.
-- ---------------------------------------------------------------------------
create table public.ingestion_skips (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  connection_id uuid not null,
  raw_event_id uuid not null references public.raw_provider_events (id),
  provider_transaction_id text not null
    check (length(provider_transaction_id) between 1 and 256),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  reason text not null check (reason = 'non_usd'),
  created_at timestamptz not null default now(),
  constraint fk_ingestion_skips_connection_tenant
    foreign key (household_id, connection_id)
    references public.connections (household_id, id)
    match simple on delete restrict,
  unique (raw_event_id, provider_transaction_id, reason)
);

create trigger ingestion_skips_immutable
  before update or delete on public.ingestion_skips
  for each row execute function public.keel_forbid_mutation();

alter table public.ingestion_skips enable row level security;
revoke all on public.ingestion_skips from public, anon, authenticated;
grant select on public.ingestion_skips to authenticated, service_role;
grant select, insert on public.ingestion_skips to keel_worker;

create policy ingestion_skips_member_read on public.ingestion_skips
  for select to authenticated
  using (public.keel_is_household_member(household_id));
create policy ingestion_skips_worker_insert on public.ingestion_skips
  for insert to keel_worker with check (true);
create policy ingestion_skips_worker_select on public.ingestion_skips
  for select to keel_worker using (true);

create function public.keel_worker_record_ingestion_skip(
  p_raw_event_id uuid,
  p_provider_transaction_id text,
  p_currency text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw public.raw_provider_events%rowtype;
  v_skip_id uuid;
begin
  if p_reason is distinct from 'non_usd' then
    raise exception 'KEEL_INVALID_COMMAND: ingestion skip reason is not allowed'
      using errcode = 'P0009';
  end if;

  select * into v_raw
    from public.raw_provider_events
   where id = p_raw_event_id;
  if not found or v_raw.provider <> 'plaid' then
    raise exception 'KEEL_SCOPE_VIOLATION: raw Plaid page not found'
      using errcode = 'P0006';
  end if;

  insert into public.ingestion_skips
    (household_id, connection_id, raw_event_id, provider_transaction_id,
     currency, reason)
  values
    (v_raw.household_id, v_raw.connection_id, v_raw.id,
     p_provider_transaction_id, p_currency, p_reason)
  on conflict (raw_event_id, provider_transaction_id, reason) do nothing
  returning id into v_skip_id;

  if v_skip_id is not null then
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (v_raw.household_id,
       jsonb_build_object('kind', 'system', 'processName', 'sync-worker'),
       'ingest.transaction_skipped', 'ingestion_skip', v_skip_id,
       gen_random_uuid(),
       jsonb_build_object('skipId', v_skip_id, 'rawEventId', v_raw.id,
                          'reason', 'non_usd'));
  end if;
end;
$$;

-- Archive replay is idempotent only when the exact immutable bytes match.
-- Return the existing raw id so a same-attempt continuation retry can retain
-- exact provenance instead of dead-lettering on a NULL RETURNING value.
create or replace function public.keel_worker_archive_page(
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
  v_existing_body_text text;
  v_existing_body_sha256 text;
  v_body_sha256 text := encode(
    pg_catalog.sha256(convert_to(p_body_text, 'UTF8')), 'hex');
begin
  select * into v_attempt
    from public.sync_attempts
   where attempt_id = p_attempt_id;
  if not found or v_attempt.state <> 'open' then
    raise exception 'KEEL_INVALID_COMMAND: attempt not open' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);
  select * into v_conn from public.connections where id = v_attempt.connection_id;

  insert into public.raw_provider_events
    (household_id, connection_id, provider, provider_event_id,
     account_external_ref, body, body_text, body_sha256, received_at)
  values
    (v_conn.household_id, v_conn.id, v_conn.provider,
     p_attempt_id::text || ':' || p_page_ordinal::text, 'item-page',
     p_body_text::jsonb, p_body_text, v_body_sha256, now())
  on conflict (connection_id, provider, provider_event_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id, body_text, body_sha256
      into v_id, v_existing_body_text, v_existing_body_sha256
      from public.raw_provider_events
     where connection_id = v_attempt.connection_id
       and provider = v_conn.provider
       and provider_event_id = p_attempt_id::text || ':' || p_page_ordinal::text;
    if not found
       or v_existing_body_text is distinct from p_body_text
       or v_existing_body_sha256 is distinct from v_body_sha256 then
      raise exception 'KEEL_INVALID_COMMAND: raw page replay body mismatch'
        using errcode = 'P0009';
    end if;
  end if;

  update public.sync_attempts
     set page_ordinal = greatest(page_ordinal, p_page_ordinal)
   where attempt_id = p_attempt_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- M4/B2: replace (never overload) normalized creation so each row retains the
-- adapter's pending bit and the exact archived page that supplied the event.
-- ---------------------------------------------------------------------------
drop function if exists public.keel_worker_create_normalized(
  uuid, uuid, uuid, text, text, text, text, text, text
);
drop function if exists public.keel_worker_create_normalized(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, boolean
);

create function public.keel_worker_create_normalized(
  p_attempt_id uuid,
  p_owner uuid,
  p_raw_event_id uuid,
  p_account_id uuid,
  p_provider_transaction_id text,
  p_kind text,
  p_amount_minor text,
  p_currency text,
  p_effective_date text,
  p_description text,
  p_pending boolean
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
  v_page public.raw_provider_events%rowtype;
  v_id uuid;
begin
  select * into v_attempt
    from public.sync_attempts
   where attempt_id = p_attempt_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: unknown attempt' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);

  select * into v_page
    from public.raw_provider_events
   where id = p_raw_event_id
     and household_id = v_attempt.household_id
     and connection_id = v_attempt.connection_id
     and provider_event_id like p_attempt_id::text || ':%';
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: raw page is not part of attempt'
      using errcode = 'P0006';
  end if;
  if p_kind <> 'removed' and p_pending is null then
    raise exception 'KEEL_INVALID_COMMAND: pending state is required'
      using errcode = 'P0009';
  end if;

  insert into public.normalized_source_records
    (raw_event_id, household_id, account_id, provider_transaction_id, kind,
     amount_minor, currency, effective_date, description, pending)
  values
    (v_page.id, v_attempt.household_id,
     case when p_kind = 'removed' then null else p_account_id end,
     p_provider_transaction_id, p_kind::public.source_record_kind,
     case when p_kind = 'removed' then null else p_amount_minor::bigint end,
     case when p_kind = 'removed' then null else p_currency end,
     case when p_kind = 'removed' then null else p_effective_date::date end,
     case when p_kind = 'removed' then null else p_description end,
     case when p_kind = 'removed' then false else p_pending end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Preserve the final C3 status fence while deriving canonical status from the
-- normalized source in both economic create and typed revise branches.
drop function if exists public.keel_worker_apply_action(uuid, text, text, text);

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
       and la.name = case when v_nsr.amount_minor < 0 then 'Uncategorized Expense'
                          else 'Uncategorized Income' end;
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
       and la.name = case when v_nsr.amount_minor < 0 then 'Uncategorized Expense'
                          else 'Uncategorized Income' end;
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
$$;

-- ---------------------------------------------------------------------------
-- C3 #2: only the invocation whose Plaid item is stored may fail an exchanged
-- shared command attempt. Replace the legacy four-argument overload.
-- ---------------------------------------------------------------------------
drop function if exists public.keel_fail_link_attempt(uuid, uuid, text, boolean);
drop function if exists public.keel_fail_link_attempt(uuid, uuid, text, boolean, text);

create function public.keel_fail_link_attempt(
  p_attempt_id uuid,
  p_household_id uuid,
  p_reason text,
  p_removed boolean,
  p_plaid_item_id text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.link_attempts%rowtype;
  v_actor jsonb;
begin
  select * into v_attempt
    from public.link_attempts
   where id = p_attempt_id
   for update;
  if not found or v_attempt.household_id <> p_household_id then
    raise exception 'KEEL_SCOPE_VIOLATION: link attempt not in household'
      using errcode = 'P0006';
  end if;
  if v_attempt.state = 'exchanged'
     and v_attempt.plaid_item_id is distinct from p_plaid_item_id then
    return;
  end if;
  if v_attempt.state not in ('initiated', 'exchanged') then
    return;
  end if;

  update public.link_attempts
     set state = 'failed',
         failure_code = p_reason,
         completed_at = now(),
         credential_ciphertext = case when p_removed then null else credential_ciphertext end,
         credential_iv = case when p_removed then null else credential_iv end,
         credential_wrapped_dek = case when p_removed then null else credential_wrapped_dek end,
         credential_wrap_iv = case when p_removed then null else credential_wrap_iv end,
         credential_kek_version = case when p_removed then null else credential_kek_version end
   where id = p_attempt_id;

  v_actor := jsonb_build_object('kind', 'user', 'userId', v_attempt.initiated_by_user_id);
  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, after)
  values
    (p_household_id, v_actor, 'connection.link_failed', 'link_attempt', p_attempt_id,
     v_attempt.command_id,
     jsonb_build_object('attemptId', p_attempt_id, 'failureCode', p_reason,
                        'removed', p_removed));
end;
$$;

-- Restore exact ownership and service-only execution after DROP/CREATE.
grant create on schema public to keel_worker;
do $$
declare f text;
begin
  foreach f in array array[
    'keel_worker_record_ingestion_skip(uuid, text, text, text)',
    'keel_worker_create_normalized(uuid, uuid, uuid, uuid, text, text, text, text, text, text, boolean)',
    'keel_worker_apply_action(uuid, text, text, text)'
  ] loop
    execute format('alter function public.%s owner to keel_worker', f);
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
revoke create on schema public from keel_worker;

grant create on schema public to keel_api;
alter function public.keel_fail_link_attempt(uuid, uuid, text, boolean, text)
  owner to keel_api;
revoke all on function public.keel_fail_link_attempt(uuid, uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.keel_fail_link_attempt(uuid, uuid, text, boolean, text)
  to service_role;
revoke create on schema public from keel_api;
