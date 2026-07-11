-- SECURITY DEFINER command procedures — the ONLY write path to canonical
-- financial truth (PLAN.md §3.5.1; INFRA.md §5). Each proc runs steps 4-11 of
-- the server command transaction atomically: authorize → validate → mutate →
-- audit → domain event → enqueue → return typed result with provenance.
--
-- TS packages compute meaning; these procs enforce and persist. They are
-- owned by keel_api (non-BYPASSRLS) and are the sole objects `authenticated`
-- may EXECUTE that touch canonical tables.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Who is calling, with the write-role check mirrored from packages/authz
-- (viewer/professional are read-only; DB re-checks what TS already checked).
create function public.keel_assert_member_write(p_household_id uuid) returns public.household_role
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_role public.household_role;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;

  select role into v_role
    from public.household_memberships
   where household_id = p_household_id and user_id = v_uid;

  if v_role is null then
    raise exception 'KEEL_SCOPE_VIOLATION: not a member of household %', p_household_id
      using errcode = 'P0006';
  end if;

  if v_role not in ('owner', 'partner') then
    raise exception 'KEEL_NOT_AUTHORIZED: role % may not write', v_role
      using errcode = 'P0005';
  end if;

  return v_role;
end;
$$;

-- Idempotency gate (Law 9). Returns the previously stored result when the
-- same economic event replays with an identical payload; conflicts hard-fail.
create function public.keel_idempotency_check(
  p_household_id uuid,
  p_key text,
  p_payload_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.command_executions%rowtype;
begin
  select * into v_existing
    from public.command_executions
   where household_id = p_household_id and economic_event_key = p_key;
  if not found then
    return null;
  end if;
  if v_existing.payload_sha256 <> p_payload_sha256 then
    raise exception
      'KEEL_IDEMPOTENCY_CONFLICT: key % replayed with a different payload', p_key
      using errcode = 'P0007';
  end if;
  return jsonb_set(v_existing.result, '{idempotentReplay}', 'true'::jsonb);
end;
$$;

create function public.keel_payload_hash(p_payload jsonb) returns text
language sql immutable
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_payload::text, 'UTF8')),
    'hex'
  );
$$;

-- Record execution + audit + domain event in the calling transaction.
create function public.keel_finish_command(
  p_command_id uuid,
  p_command text,
  p_key text,
  p_household_id uuid,
  p_actor jsonb,
  p_payload_sha256 text,
  p_event_type text,
  p_object_type text,
  p_object_id uuid,
  p_after jsonb,
  p_result jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (household_id, actor, action, object_type, object_id, command_id, before, after)
  values (p_household_id, p_actor, p_command, p_object_type, p_object_id, p_command_id, null, p_after);

  insert into public.domain_events (event_type, household_id, command_id, economic_event_key, actor, payload)
  values (p_event_type, p_household_id, p_command_id, p_key, p_actor, p_after);

  insert into public.command_executions
    (economic_event_key, command_id, command, household_id, payload_sha256, result)
  values (p_key, p_command_id, p_command, p_household_id, p_payload_sha256, p_result);
end;
$$;

-- Insert a batch's postings and return them as wire-safe jsonb (amounts as
-- text — bigint never rides a JSON number; PLAN §3.5.6). The ledger account
-- must belong to the commanding household (cross-tenant reference smuggling
-- fails closed) and each posting's entity is DERIVED from the ledger account
-- — one source of truth, no drift.
create function public.keel_insert_postings(p_household_id uuid, p_batch_id uuid, p_postings jsonb) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_posting jsonb;
  v_out jsonb := '[]'::jsonb;
  v_id uuid;
  v_ledger_account public.ledger_accounts%rowtype;
begin
  if jsonb_typeof(p_postings) <> 'array' or jsonb_array_length(p_postings) < 2 then
    raise exception 'KEEL_UNBALANCED: a batch needs at least two postings'
      using errcode = 'P0002';
  end if;

  for v_posting in select * from jsonb_array_elements(p_postings) loop
    -- amount arrives as a decimal STRING; ::bigint on text is exact (unlike
    -- a JSON number, which would already have been a float).
    if jsonb_typeof(v_posting->'amount_minor') <> 'string' then
      raise exception 'KEEL_INVALID_MONEY: amount_minor must be a string'
        using errcode = 'P0008';
    end if;

    select * into v_ledger_account
      from public.ledger_accounts la
     where la.id = (v_posting->>'ledger_account_id')::uuid
       and la.household_id = p_household_id;
    if not found then
      raise exception 'KEEL_SCOPE_VIOLATION: ledger account not in household'
        using errcode = 'P0006';
    end if;

    insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    values (
      p_batch_id,
      v_ledger_account.id,
      v_ledger_account.entity_id,
      (v_posting->>'amount_minor')::bigint,
      v_posting->>'currency'
    )
    returning id into v_id;

    v_out := v_out || jsonb_build_object(
      'postingId', v_id,
      'ledgerAccountId', v_ledger_account.id,
      'entityId', v_ledger_account.entity_id,
      'amountMinor', v_posting->>'amount_minor',
      'currency', v_posting->>'currency'
    );
  end loop;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- accounts.create — real account + backing ledger account.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_create_account(
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
  v_entity_id uuid := (p_payload->>'entity_id')::uuid;
  v_ledger_account_id uuid;
  v_account_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if not exists (
    select 1 from public.entities e where e.id = v_entity_id and e.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: entity % not in household', v_entity_id
      using errcode = 'P0006';
  end if;

  insert into public.ledger_accounts (household_id, entity_id, name, kind, currency, is_category)
  values (
    p_household_id, v_entity_id, p_payload->>'name',
    (p_payload->>'kind')::public.ledger_account_kind, p_payload->>'currency', false
  )
  returning id into v_ledger_account_id;

  insert into public.accounts
    (household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref)
  values (
    p_household_id, v_entity_id,
    nullif(p_payload->>'connection_id', '')::uuid,
    v_ledger_account_id, p_payload->>'name', p_payload->>'subtype',
    p_payload->>'currency', nullif(p_payload->>'external_ref', '')
  )
  returning id into v_account_id;

  insert into public.account_owners (account_id, user_id)
  values (
    v_account_id,
    coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  );

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'accountId', v_account_id, 'ledgerAccountId', v_ledger_account_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'accounts.create', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'accounts.created', 'account', v_account_id,
    jsonb_build_object('accountId', v_account_id, 'name', p_payload->>'name'),
    v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- ingest.record_raw_event — immutable capture; enqueue follow-up atomically.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_record_raw_event(
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
  v_connection_id uuid;
  v_raw_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  select c.id into v_connection_id
    from public.connections c
   where c.household_id = p_household_id
     and c.provider = (p_payload->>'provider')::public.bank_provider
     and c.external_ref = p_payload->>'connection_external_ref';
  if v_connection_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown connection for household'
      using errcode = 'P0006';
  end if;

  -- Duplicate provider delivery (same connection/provider/event id) is a
  -- benign replay: return the existing capture rather than failing.
  select r.id into v_raw_id
    from public.raw_provider_events r
   where r.connection_id = v_connection_id
     and r.provider = (p_payload->>'provider')::public.bank_provider
     and r.provider_event_id = p_payload->>'provider_event_id';

  if v_raw_id is null then
    insert into public.raw_provider_events
      (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
    values (
      p_household_id, v_connection_id,
      (p_payload->>'provider')::public.bank_provider,
      p_payload->>'provider_event_id',
      p_payload->>'account_external_ref',
      p_payload->'body',
      (p_payload->>'received_at')::timestamptz
    )
    returning id into v_raw_id;
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object('rawEventId', v_raw_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'ingest.record_raw_event', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'ingest.raw_event_recorded', 'raw_provider_event', v_raw_id,
    jsonb_build_object('rawEventId', v_raw_id),
    v_result
  );

  -- Atomic follow-up (TASK-000 test 7): same transaction as the mutation.
  perform public.keel_enqueue('sync_events', jsonb_build_object(
    'jobType', 'promote_raw_event',
    'economicEventKey', p_economic_event_key || ':promote',
    'refs', jsonb_build_object('rawEventId', v_raw_id::text)
  ));

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- journal.post_batch — balanced manual batch.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_post_batch(
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
  v_batch_id uuid;
  v_postings jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values (
    p_household_id,
    nullif(p_payload->>'canonical_transaction_id', '')::uuid,
    p_payload->>'description',
    (p_payload->>'effective_date')::date,
    p_command_id
  )
  returning id into v_batch_id;

  v_postings := public.keel_insert_postings(p_household_id, v_batch_id, p_payload->'postings');

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object('batchId', v_batch_id, 'postings', v_postings),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'journal.post_batch', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'journal.batch_posted', 'journal_batch', v_batch_id,
    jsonb_build_object('batchId', v_batch_id, 'postings', v_postings),
    v_result
  );

  perform public.keel_enqueue('transaction_enrichment', jsonb_build_object(
    'jobType', 'enrich_batch',
    'economicEventKey', p_economic_event_key || ':enrich',
    'refs', jsonb_build_object('batchId', v_batch_id::text)
  ));

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- ingest.promote_event — raw event → canonical transaction + balanced batch.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_promote_event(
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
  v_raw public.raw_provider_events%rowtype;
  v_txn_id uuid;
  v_batch_id uuid;
  v_postings jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_raw
    from public.raw_provider_events
   where id = (p_payload->>'raw_event_id')::uuid
     and household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: raw event not found in household'
      using errcode = 'P0006';
  end if;

  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key)
  values (
    p_household_id,
    (p_payload->>'entity_id')::uuid,
    (p_payload->>'account_id')::uuid,
    (p_payload->>'status')::public.transaction_status,
    (p_payload->>'source')::public.transaction_source,
    p_payload->>'description',
    (p_payload->>'effective_date')::date,
    p_economic_event_key
  )
  returning id into v_txn_id;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values (
    p_household_id, v_txn_id, p_payload->>'description',
    (p_payload->>'effective_date')::date, p_command_id
  )
  returning id into v_batch_id;

  v_postings := public.keel_insert_postings(p_household_id, v_batch_id, p_payload->'postings');

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
    p_command_id, 'ingest.promote_event', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'ingest.event_promoted', 'canonical_transaction', v_txn_id,
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

-- ---------------------------------------------------------------------------
-- journal.reverse_batch — compensating batch; original preserved (Law 2).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_reverse_batch(
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
  v_original public.journal_batches%rowtype;
  v_reversal_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_original
    from public.journal_batches
   where id = (p_payload->>'batch_id')::uuid and household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: batch not found in household'
      using errcode = 'P0006';
  end if;

  if exists (
    select 1 from public.journal_revisions r
     where r.original_batch_id = v_original.id
  ) then
    raise exception 'KEEL_IMMUTABLE: batch % is already reversed', v_original.id
      using errcode = 'P0001';
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values (
    p_household_id, v_original.canonical_transaction_id,
    'REVERSAL: ' || (p_payload->>'reason'),
    v_original.effective_date, v_original.id, p_command_id
  )
  returning id into v_reversal_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_original.id;

  insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
  values (v_original.id, v_reversal_id, p_payload->>'reason');

  -- Reversing the only batch of a canonical transaction voids it.
  if v_original.canonical_transaction_id is not null then
    update public.canonical_transactions
       set status = 'voided', voided_at = now()
     where id = v_original.canonical_transaction_id;
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'reversalBatchId', v_reversal_id, 'originalBatchId', v_original.id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'journal.reverse_batch', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'journal.batch_reversed', 'journal_batch', v_reversal_id,
    jsonb_build_object('reversalBatchId', v_reversal_id, 'originalBatchId', v_original.id),
    v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read surfaces: amounts leave the database as TEXT (PLAN §3.5.6).
-- ---------------------------------------------------------------------------
create function public.keel_trial_balance(p_household_id uuid) returns jsonb
language plpgsql
security definer
set search_path = public
stable
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

  select coalesce(jsonb_agg(row order by row->>'ledgerAccountId'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'ledgerAccountId', p.ledger_account_id,
        'currency', p.currency,
        'balanceMinor', sum(p.amount_minor)::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      where b.household_id = p_household_id
      group by p.ledger_account_id, p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

create function public.keel_list_transactions(p_household_id uuid) returns jsonb
language plpgsql
security definer
set search_path = public
stable
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

  select coalesce(jsonb_agg(row order by row->>'economicEventKey'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'accountId', ct.account_id,
        'status', ct.status,
        'description', ct.description,
        'effectiveDate', ct.effective_date,
        'economicEventKey', ct.economic_event_key
      ) as row
      from public.canonical_transactions ct
      where ct.household_id = p_household_id
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership + execute grants. Procs owned by keel_api so definer privileges
-- are exactly keel_api's grants — no table ownership, no BYPASSRLS.
-- ---------------------------------------------------------------------------
-- PostgreSQL requires a new function owner to hold CREATE on the containing
-- schema during ownership transfer. Grant it only for the transfer window.
grant create on schema public to keel_api;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.keel_assert_member_write(uuid)',
    'public.keel_idempotency_check(uuid, text, text)',
    'public.keel_finish_command(uuid, text, text, uuid, jsonb, text, text, text, uuid, jsonb, jsonb)',
    'public.keel_insert_postings(uuid, uuid, jsonb)',
    'public.keel_cmd_create_account(uuid, text, jsonb, uuid, jsonb)',
    'public.keel_cmd_record_raw_event(uuid, text, jsonb, uuid, jsonb)',
    'public.keel_cmd_post_batch(uuid, text, jsonb, uuid, jsonb)',
    'public.keel_cmd_promote_event(uuid, text, jsonb, uuid, jsonb)',
    'public.keel_cmd_reverse_batch(uuid, text, jsonb, uuid, jsonb)',
    'public.keel_trial_balance(uuid)',
    'public.keel_list_transactions(uuid)'
  ] loop
    execute format('alter function %s owner to keel_api', f);
    execute format('revoke all on function %s from public, anon', f);
  end loop;
end
$$;

revoke create on schema public from keel_api;

-- Internal helpers: not directly callable by clients.
revoke all on function public.keel_assert_member_write(uuid) from authenticated;
revoke all on function public.keel_idempotency_check(uuid, text, text) from authenticated;
revoke all on function public.keel_finish_command(uuid, text, text, uuid, jsonb, text, text, text, uuid, jsonb, jsonb) from authenticated;
revoke all on function public.keel_insert_postings(uuid, uuid, jsonb) from authenticated;

grant execute on function public.keel_cmd_create_account(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_record_raw_event(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_post_batch(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_promote_event(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_reverse_batch(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_trial_balance(uuid) to authenticated;
grant execute on function public.keel_list_transactions(uuid) to authenticated;
