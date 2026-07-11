-- Stage 1C C3: Plaid link/disconnect saga, credential lifecycle, orphan
-- reaping, and race-free sync fencing. Plaintext provider credentials never
-- cross this database boundary.

-- ---------------------------------------------------------------------------
-- Saga schema and server-only token-free test injection.
-- ---------------------------------------------------------------------------
alter table public.link_attempts
  add column command_id uuid,
  add column credential_id uuid,
  add column plaid_item_id text,
  add column credential_iv bytea,
  add column credential_wrapped_dek bytea,
  add column credential_wrap_iv bytea,
  add column credential_kek_version int,
  add column entity_id uuid,
  add column expires_at timestamptz not null default (now() + interval '30 minutes'),
  add column reap_attempts int not null default 0,
  add column reap_claim_id uuid,
  add column reap_claimed_at timestamptz,
  add column last_reap_error text,
  add column last_reaped_at timestamptz;

alter table public.link_attempts
  drop constraint link_attempts_state_check,
  add constraint link_attempts_state_check
    check (state in ('initiated', 'exchanged', 'succeeded', 'failed', 'expired', 'reaping', 'reaped')),
  add constraint link_attempts_credential_envelope_check
    check (
      (
        credential_ciphertext is null
        and credential_iv is null
        and credential_wrapped_dek is null
        and credential_wrap_iv is null
        and credential_kek_version is null
      )
      or (
        octet_length(credential_iv) = 12
        and octet_length(credential_wrapped_dek) = 48
        and octet_length(credential_wrap_iv) = 12
        and octet_length(credential_ciphertext) >= 16
        and credential_kek_version > 0
      )
    ),
  add constraint fk_link_attempts_entity_tenant
    foreign key (household_id, entity_id)
    references public.entities (household_id, id)
    match simple on delete restrict,
  add constraint fk_link_attempts_connection_tenant
    foreign key (household_id, connection_id)
    references public.connections (household_id, id)
    match simple on delete restrict;

create unique index link_attempts_household_command_key
  on public.link_attempts (household_id, command_id)
  where command_id is not null;

alter table public.removal_attempts
  add column failure_code text;

alter table public.connection_credentials
  add constraint connection_credentials_one_per_conn
    unique (household_id, connection_id),
  add constraint connection_credentials_envelope_check
    check (
      octet_length(iv) = 12
      and octet_length(wrapped_dek) = 48
      and octet_length(wrap_iv) = 12
      and octet_length(ciphertext) >= 16
      and kek_version > 0
    );

create table public.plaid_test_responses (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null,
  kind text not null,
  ordinal int not null default 0,
  body_text text not null,
  created_at timestamptz not null default now()
);

create index plaid_test_responses_lookup
  on public.plaid_test_responses (scope_key, kind, ordinal);

alter table public.plaid_test_responses enable row level security;
revoke all on public.plaid_test_responses from anon, authenticated;
grant select, insert, delete on public.plaid_test_responses to service_role;

create function public.keel_consume_plaid_test_response(
  p_scope_key text,
  p_kind text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body text;
begin
  delete from public.plaid_test_responses
   where id = (
     select id
       from public.plaid_test_responses
      where scope_key = p_scope_key and kind = p_kind
      order by ordinal
      limit 1
   )
  returning body_text into v_body;
  return v_body;
end;
$$;

-- ---------------------------------------------------------------------------
-- User-facing saga beginnings. These are the only C3 functions exposed to
-- authenticated users; every later transition is service-only.
-- ---------------------------------------------------------------------------
create function public.keel_begin_link(
  p_command_id uuid,
  p_household_id uuid,
  p_entity_id uuid,
  p_provider text,
  p_institution_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor jsonb;
  v_attempt public.link_attempts%rowtype;
  v_inserted_id uuid;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();

  if p_provider <> 'plaid' then
    raise exception 'KEEL_INVALID_COMMAND: provider must be plaid' using errcode = 'P0009';
  end if;
  if not exists (
    select 1 from public.entities
     where id = p_entity_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: entity not in household' using errcode = 'P0006';
  end if;

  insert into public.link_attempts
    (command_id, household_id, initiated_by_user_id, entity_id, provider,
     institution_id, state, credential_id)
  values
    (p_command_id, p_household_id, (v_actor->>'userId')::uuid, p_entity_id,
     'plaid', p_institution_id, 'initiated', gen_random_uuid())
  on conflict (household_id, command_id) where command_id is not null do nothing
  returning id into v_inserted_id;

  select * into v_attempt
    from public.link_attempts
   where household_id = p_household_id and command_id = p_command_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: command id is required' using errcode = 'P0009';
  end if;

  if v_inserted_id is not null then
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (p_household_id, v_actor, 'connection.link_begin', 'link_attempt',
       v_attempt.id, p_command_id,
       jsonb_build_object('attemptId', v_attempt.id, 'credentialId', v_attempt.credential_id));
  end if;

  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'credentialId', v_attempt.credential_id,
    'state', v_attempt.state,
    'connectionId', v_attempt.connection_id
  );
end;
$$;

create function public.keel_disconnect_begin(
  p_household_id uuid,
  p_connection_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor jsonb;
  v_conn public.connections%rowtype;
  v_removal_id uuid;
  v_has_credentials boolean;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();

  select * into v_conn
    from public.connections
   where id = p_connection_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: connection not in household' using errcode = 'P0006';
  end if;
  if v_conn.status = 'disconnected' then
    raise exception 'KEEL_INVALID_COMMAND: connection already disconnected' using errcode = 'P0009';
  end if;

  if v_conn.status = 'disconnecting' then
    select id into v_removal_id
      from public.removal_attempts
     where household_id = p_household_id
       and connection_id = p_connection_id
       and state = 'pending'
     order by started_at desc
     limit 1;
  end if;

  if v_removal_id is null then
    update public.connections
       set status = 'disconnecting',
           sync_desired_generation = sync_desired_generation + 1,
           sync_lease_owner = null,
           sync_leased_until = null
     where id = p_connection_id;

    insert into public.removal_attempts
      (household_id, connection_id, initiated_by_user_id, state, reason)
    values
      (p_household_id, p_connection_id, (v_actor->>'userId')::uuid, 'pending', p_reason)
    returning id into v_removal_id;

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.disconnect_begin', 'connection',
       p_connection_id,
       jsonb_build_object('connectionId', p_connection_id, 'removalAttemptId', v_removal_id,
                          'reason', p_reason));
  end if;

  select exists (
    select 1 from public.connection_credentials
     where household_id = p_household_id and connection_id = p_connection_id
  ) into v_has_credentials;

  return jsonb_build_object(
    'removalAttemptId', v_removal_id,
    'hasCredentials', v_has_credentials
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal link/disconnect transitions.
-- ---------------------------------------------------------------------------
create function public.keel_record_link_exchange(
  p_attempt_id uuid,
  p_household_id uuid,
  p_credential_id uuid,
  p_plaid_item_id text,
  p_ciphertext_b64 text,
  p_iv_b64 text,
  p_wrapped_dek_b64 text,
  p_wrap_iv_b64 text,
  p_kek_version int
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
    raise exception 'KEEL_SCOPE_VIOLATION: link attempt not in household' using errcode = 'P0006';
  end if;
  if v_attempt.credential_id is distinct from p_credential_id then
    raise exception 'KEEL_INVALID_COMMAND: credential id mismatch' using errcode = 'P0009';
  end if;
  if v_attempt.state = 'exchanged'
     and v_attempt.plaid_item_id = p_plaid_item_id
     and v_attempt.credential_id = p_credential_id then
    return;
  end if;
  if v_attempt.state <> 'initiated' then
    raise exception 'KEEL_INVALID_COMMAND: link attempt is not initiated' using errcode = 'P0009';
  end if;

  update public.link_attempts
     set state = 'exchanged',
         plaid_item_id = p_plaid_item_id,
         credential_ciphertext = decode(p_ciphertext_b64, 'base64'),
         credential_iv = decode(p_iv_b64, 'base64'),
         credential_wrapped_dek = decode(p_wrapped_dek_b64, 'base64'),
         credential_wrap_iv = decode(p_wrap_iv_b64, 'base64'),
         credential_kek_version = p_kek_version
   where id = p_attempt_id;

  v_actor := jsonb_build_object('kind', 'user', 'userId', v_attempt.initiated_by_user_id);
  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, after)
  values
    (p_household_id, v_actor, 'connection.link_exchange', 'link_attempt', p_attempt_id,
     v_attempt.command_id,
     jsonb_build_object('attemptId', p_attempt_id, 'credentialId', p_credential_id,
                        'itemId', p_plaid_item_id));
end;
$$;

create function public.keel_finalize_link(
  p_attempt_id uuid,
  p_household_id uuid,
  p_institution_id text,
  p_consent_expires_at timestamptz,
  p_accounts jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.link_attempts%rowtype;
  v_existing_connection_id uuid;
  v_connection_id uuid;
  v_ledger_account_id uuid;
  v_account_id uuid;
  v_account_ids jsonb;
  v_account jsonb;
  v_kind public.ledger_account_kind;
  v_actor jsonb;
begin
  select * into v_attempt
    from public.link_attempts
   where id = p_attempt_id
   for update;
  if not found or v_attempt.household_id <> p_household_id then
    raise exception 'KEEL_SCOPE_VIOLATION: link attempt not in household' using errcode = 'P0006';
  end if;

  if v_attempt.state = 'succeeded' then
    select coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      into v_account_ids
      from public.accounts
     where connection_id = v_attempt.connection_id;
    return jsonb_build_object('connectionId', v_attempt.connection_id, 'accountIds', v_account_ids);
  end if;
  if v_attempt.state in ('reaping', 'reaped', 'failed', 'expired') then
    raise exception 'KEEL_INVALID_COMMAND: link attempt is terminal' using errcode = 'P0009';
  end if;
  if v_attempt.state <> 'exchanged' then
    raise exception 'KEEL_INVALID_COMMAND: link attempt is not exchanged' using errcode = 'P0009';
  end if;
  if v_attempt.credential_ciphertext is null then
    raise exception 'KEEL_INVALID_COMMAND: credential envelope unavailable' using errcode = 'P0009';
  end if;

  select c.id into v_existing_connection_id
    from public.connections c
    join public.connection_credentials cc
      on cc.household_id = c.household_id and cc.connection_id = c.id
   where c.household_id = p_household_id
     and c.provider = 'plaid'
     and c.external_ref = v_attempt.plaid_item_id
     and c.status = 'active'
   limit 1;

  v_actor := jsonb_build_object('kind', 'user', 'userId', v_attempt.initiated_by_user_id);
  if v_existing_connection_id is not null then
    update public.link_attempts
       set state = 'failed',
           failure_code = 'duplicate_item',
           connection_id = v_existing_connection_id,
           completed_at = now()
     where id = p_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (p_household_id, v_actor, 'connection.link_duplicate', 'link_attempt', p_attempt_id,
       v_attempt.command_id,
       jsonb_build_object('attemptId', p_attempt_id,
                          'connectionId', v_existing_connection_id,
                          'itemId', v_attempt.plaid_item_id));
    select coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      into v_account_ids
      from public.accounts
     where connection_id = v_existing_connection_id;
    return jsonb_build_object('connectionId', v_existing_connection_id, 'accountIds', v_account_ids);
  end if;

  if jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) = 0 then
    raise exception 'KEEL_INVALID_COMMAND: at least one USD account is required' using errcode = 'P0009';
  end if;

  insert into public.connections
    (household_id, provider, external_ref, status, institution_id,
     consent_expires_at, sync_desired_generation, sync_committed_generation)
  values
    (p_household_id, 'plaid', v_attempt.plaid_item_id, 'active', p_institution_id,
     p_consent_expires_at, 0, 0)
  returning id into v_connection_id;

  insert into public.connection_credentials
    (id, household_id, connection_id, credential_owner_user_id,
     ciphertext, iv, wrapped_dek, wrap_iv, kek_version)
  values
    (v_attempt.credential_id, p_household_id, v_connection_id,
     v_attempt.initiated_by_user_id, v_attempt.credential_ciphertext,
     v_attempt.credential_iv, v_attempt.credential_wrapped_dek,
     v_attempt.credential_wrap_iv, v_attempt.credential_kek_version);

  for v_account in select value from jsonb_array_elements(p_accounts) loop
    if v_account->>'currency' <> 'USD' then
      raise exception 'KEEL_CURRENCY_MISMATCH: linked account must be USD' using errcode = 'P0010';
    end if;
    v_kind := (v_account->>'kind')::public.ledger_account_kind;
    if v_kind not in ('asset', 'liability') then
      raise exception 'KEEL_INVALID_COMMAND: linked account kind must be asset or liability'
        using errcode = 'P0009';
    end if;

    insert into public.ledger_accounts
      (household_id, entity_id, name, kind, currency, is_category)
    values
      (p_household_id, v_attempt.entity_id, v_account->>'name', v_kind, 'USD', false)
    returning id into v_ledger_account_id;

    insert into public.accounts
      (household_id, entity_id, connection_id, ledger_account_id,
       name, subtype, currency, external_ref)
    values
      (p_household_id, v_attempt.entity_id, v_connection_id, v_ledger_account_id,
       v_account->>'name', v_account->>'subtype', 'USD', v_account->>'external_ref')
    returning id into v_account_id;

    insert into public.account_owners (account_id, user_id)
    values (v_account_id, v_attempt.initiated_by_user_id);

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (p_household_id, v_actor, 'connection.account_linked', 'account', v_account_id,
       v_attempt.command_id,
       jsonb_build_object('accountId', v_account_id, 'connectionId', v_connection_id,
                          'externalRef', v_account->>'external_ref', 'kind', v_kind));
  end loop;

  update public.link_attempts
     set state = 'succeeded',
         completed_at = now(),
         connection_id = v_connection_id,
         credential_ciphertext = null,
         credential_iv = null,
         credential_wrapped_dek = null,
         credential_wrap_iv = null,
         credential_kek_version = null
   where id = p_attempt_id;

  perform public.keel_enqueue('sync_events', jsonb_build_object(
    'jobType', 'sync_notification',
    'economicEventKey', 'plaid:link:' || v_connection_id::text,
    'refs', jsonb_build_object('connectionId', v_connection_id::text)
  ));

  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, after)
  values
    (p_household_id, v_actor, 'connection.linked', 'connection', v_connection_id,
     v_attempt.command_id,
     jsonb_build_object('connectionId', v_connection_id, 'itemId', v_attempt.plaid_item_id,
                        'credentialId', v_attempt.credential_id));

  select coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
    into v_account_ids
    from public.accounts
   where connection_id = v_connection_id;
  return jsonb_build_object('connectionId', v_connection_id, 'accountIds', v_account_ids);
end;
$$;

create function public.keel_fail_link_attempt(
  p_attempt_id uuid,
  p_household_id uuid,
  p_reason text,
  p_removed boolean
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
    raise exception 'KEEL_SCOPE_VIOLATION: link attempt not in household' using errcode = 'P0006';
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

create function public.keel_disconnect_complete(
  p_household_id uuid,
  p_connection_id uuid,
  p_removal_attempt_id uuid,
  p_removed boolean,
  p_failure text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_attempt public.removal_attempts%rowtype;
  v_actor jsonb;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: connection not in household' using errcode = 'P0006';
  end if;
  select * into v_attempt
    from public.removal_attempts
   where id = p_removal_attempt_id
     and household_id = p_household_id
     and connection_id = p_connection_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: removal attempt mismatch' using errcode = 'P0006';
  end if;

  if v_conn.status = 'disconnected' and v_attempt.state = 'succeeded' then
    return;
  end if;
  if v_conn.status <> 'disconnecting' or v_attempt.state <> 'pending' then
    raise exception 'KEEL_INVALID_COMMAND: stale disconnect transition' using errcode = 'P0009';
  end if;

  v_actor := jsonb_build_object('kind', 'user', 'userId', v_attempt.initiated_by_user_id);
  if p_removed then
    delete from public.connection_credentials
     where household_id = p_household_id and connection_id = p_connection_id;
    update public.connections set status = 'disconnected' where id = p_connection_id;
    update public.removal_attempts
       set state = 'succeeded', completed_at = now(), failure_code = null
     where id = p_removal_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.disconnected', 'connection', p_connection_id,
       jsonb_build_object('connectionId', p_connection_id,
                          'removalAttemptId', p_removal_attempt_id));
  else
    update public.removal_attempts
       set state = 'failed', completed_at = now(), failure_code = p_failure
     where id = p_removal_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.disconnect_failed', 'connection', p_connection_id,
       jsonb_build_object('connectionId', p_connection_id,
                          'removalAttemptId', p_removal_attempt_id,
                          'failureCode', p_failure));
  end if;
end;
$$;

create function public.keel_set_connection_reauth(
  p_connection_id uuid,
  p_event_type text,
  p_required boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_new_status public.connection_status;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown connection' using errcode = 'P0006';
  end if;

  if p_required and v_conn.status = 'active' then
    v_new_status := 'reauth_required';
    update public.connections
       set status = v_new_status,
           sync_desired_generation = sync_desired_generation + 1,
           sync_lease_owner = null,
           sync_leased_until = null
     where id = p_connection_id;
  elsif not p_required and v_conn.status = 'reauth_required' then
    v_new_status := 'active';
    update public.connections set status = v_new_status where id = p_connection_id;
  else
    return;
  end if;

  insert into public.connection_health_events
    (household_id, connection_id, event_type, severity, details)
  values
    (v_conn.household_id, p_connection_id, p_event_type,
     case when p_required then 'error' else 'info' end,
     jsonb_build_object('eventType', p_event_type));

  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, after)
  values
    (v_conn.household_id,
     jsonb_build_object('kind', 'system', 'processName', 'connection-lifecycle'),
     'connection.reauth_changed', 'connection', p_connection_id,
     jsonb_build_object('connectionId', p_connection_id, 'status', v_new_status,
                        'eventType', p_event_type));
end;
$$;

create function public.keel_get_connection_credential_envelope(
  p_connection_id uuid
) returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'credentialId', cc.id,
    'householdId', cc.household_id,
    'provider', 'plaid',
    'ciphertext', replace(encode(cc.ciphertext, 'base64'), E'\n', ''),
    'iv', replace(encode(cc.iv, 'base64'), E'\n', ''),
    'wrappedDek', replace(encode(cc.wrapped_dek, 'base64'), E'\n', ''),
    'wrapIv', replace(encode(cc.wrap_iv, 'base64'), E'\n', ''),
    'kekVersion', cc.kek_version
  )
  from public.connection_credentials cc
  where cc.connection_id = p_connection_id
  limit 1;
$$;

create function public.keel_reap_orphan_link_attempts(
  p_now timestamptz default now(),
  p_limit int default 25
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed public.link_attempts%rowtype;
  v_result jsonb := '[]'::jsonb;
begin
  for v_claimed in
    with candidates as (
      select id
        from public.link_attempts
       where credential_ciphertext is not null
         and reap_attempts < 5
         and (
           (state in ('exchanged', 'failed') and expires_at < p_now)
           or (state = 'reaping' and reap_claimed_at < p_now - interval '10 minutes')
         )
       order by expires_at
       for update skip locked
       limit p_limit
    ), claimed as (
      update public.link_attempts attempt
         set state = 'reaping',
             reap_claim_id = gen_random_uuid(),
             reap_claimed_at = p_now
        from candidates
       where attempt.id = candidates.id
      returning attempt.*
    )
    select * from claimed
  loop
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (v_claimed.household_id,
       jsonb_build_object('kind', 'system', 'processName', 'link-reaper'),
       'connection.link_reap_claimed', 'link_attempt', v_claimed.id,
       v_claimed.command_id,
       jsonb_build_object('attemptId', v_claimed.id,
                          'reapClaimId', v_claimed.reap_claim_id));

    v_result := v_result || jsonb_build_object(
      'attemptId', v_claimed.id,
      'householdId', v_claimed.household_id,
      'credentialId', v_claimed.credential_id,
      'plaidItemId', v_claimed.plaid_item_id,
      'reapClaimId', v_claimed.reap_claim_id,
      'ciphertext', replace(encode(v_claimed.credential_ciphertext, 'base64'), E'\n', ''),
      'iv', replace(encode(v_claimed.credential_iv, 'base64'), E'\n', ''),
      'wrappedDek', replace(encode(v_claimed.credential_wrapped_dek, 'base64'), E'\n', ''),
      'wrapIv', replace(encode(v_claimed.credential_wrap_iv, 'base64'), E'\n', ''),
      'kekVersion', v_claimed.credential_kek_version
    );
  end loop;
  return v_result;
end;
$$;

create function public.keel_mark_link_attempt_reaped(
  p_attempt_id uuid,
  p_reap_claim_id uuid,
  p_removed boolean,
  p_error text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.link_attempts%rowtype;
  v_next_attempts int;
  v_action text;
begin
  select * into v_attempt
    from public.link_attempts
   where id = p_attempt_id
   for update;
  if not found
     or v_attempt.state <> 'reaping'
     or v_attempt.reap_claim_id is distinct from p_reap_claim_id then
    raise exception 'KEEL_INVALID_COMMAND: stale reap claim' using errcode = 'P0009';
  end if;

  if p_removed then
    update public.link_attempts
       set state = 'reaped',
           credential_ciphertext = null,
           credential_iv = null,
           credential_wrapped_dek = null,
           credential_wrap_iv = null,
           credential_kek_version = null,
           reap_claim_id = null,
           reap_claimed_at = null,
           last_reap_error = null,
           last_reaped_at = now()
     where id = p_attempt_id;
    v_action := 'connection.link_reaped';
  else
    v_next_attempts := v_attempt.reap_attempts + 1;
    update public.link_attempts
       set state = case when v_next_attempts >= 5 then 'failed' else 'exchanged' end,
           reap_attempts = v_next_attempts,
           last_reap_error = p_error,
           reap_claim_id = null,
           reap_claimed_at = null
     where id = p_attempt_id;
    v_action := case when v_next_attempts >= 5
      then 'connection.link_reap_exhausted'
      else 'connection.link_reap_retry'
    end;
  end if;

  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, after)
  values
    (v_attempt.household_id,
     jsonb_build_object('kind', 'system', 'processName', 'link-reaper'),
     v_action, 'link_attempt', p_attempt_id, v_attempt.command_id,
     jsonb_build_object('attemptId', p_attempt_id, 'removed', p_removed,
                        'failureCode', p_error,
                        'reapAttempts', coalesce(v_next_attempts, v_attempt.reap_attempts)));
end;
$$;

-- ---------------------------------------------------------------------------
-- C3 definer grants and policies.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.link_attempts to keel_api;
grant select, insert, delete on public.connection_credentials to keel_api;
grant select, insert, update on public.removal_attempts to keel_api;
grant insert on public.connection_health_events to keel_api;
grant update (sync_desired_generation, sync_lease_owner, sync_leased_until)
  on public.connections to keel_api;
grant select on public.connections to keel_worker;

create policy connection_credentials_api_all on public.connection_credentials
  for all to keel_api using (true) with check (true);
create policy link_attempts_api_all on public.link_attempts
  for all to keel_api using (true) with check (true);
create policy removal_attempts_api_all on public.removal_attempts
  for all to keel_api using (true) with check (true);
create policy connection_health_events_api_all on public.connection_health_events
  for all to keel_api using (true) with check (true);

grant create on schema public to keel_api;
do $$
declare f text;
begin
  foreach f in array array[
    'keel_begin_link(uuid, uuid, uuid, text, text)',
    'keel_disconnect_begin(uuid, uuid, text)',
    'keel_record_link_exchange(uuid, uuid, uuid, text, text, text, text, text, integer)',
    'keel_finalize_link(uuid, uuid, text, timestamptz, jsonb)',
    'keel_fail_link_attempt(uuid, uuid, text, boolean)',
    'keel_disconnect_complete(uuid, uuid, uuid, boolean, text)',
    'keel_set_connection_reauth(uuid, text, boolean)',
    'keel_get_connection_credential_envelope(uuid)',
    'keel_reap_orphan_link_attempts(timestamptz, integer)',
    'keel_mark_link_attempt_reaped(uuid, uuid, boolean, text)'
  ] loop
    execute format('alter function public.%s owner to keel_api', f);
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;

  grant execute on function public.keel_begin_link(uuid, uuid, uuid, text, text) to authenticated;
  grant execute on function public.keel_disconnect_begin(uuid, uuid, text) to authenticated;
  grant execute on function public.keel_record_link_exchange(uuid, uuid, uuid, text, text, text, text, text, integer) to service_role;
  grant execute on function public.keel_finalize_link(uuid, uuid, text, timestamptz, jsonb) to service_role;
  grant execute on function public.keel_fail_link_attempt(uuid, uuid, text, boolean) to service_role;
  grant execute on function public.keel_disconnect_complete(uuid, uuid, uuid, boolean, text) to service_role;
  grant execute on function public.keel_set_connection_reauth(uuid, text, boolean) to service_role, keel_worker;
  grant execute on function public.keel_get_connection_credential_envelope(uuid) to service_role;
  grant execute on function public.keel_reap_orphan_link_attempts(timestamptz, integer) to service_role;
  grant execute on function public.keel_mark_link_attempt_reaped(uuid, uuid, boolean, text) to service_role;
end
$$;
revoke create on schema public from keel_api;

-- The injection consumer remains owned by the migration role, as explicitly
-- allowed by §1b. Its definer can consume the server-only table without
-- widening keel_api's production table privileges or RLS policies.
revoke all on function public.keel_consume_plaid_test_response(text, text)
  from public, anon, authenticated;
grant execute on function public.keel_consume_plaid_test_response(text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Race-free C5b fencing. Bodies are copied from C5b and changed only at the
-- connection status/generation guards required by C3 §1e.
-- ---------------------------------------------------------------------------
create or replace function public.keel_worker_acquire_sync_lease(
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

  -- C3 fence: only active connections may acquire a sync lease.
  if v_conn.status <> 'active' then
    return jsonb_build_object('acquired', false, 'reason', v_conn.status);
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

create or replace function public.keel_worker_assert_lease(
  p_connection_id uuid,
  p_owner uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id
   for no key update;
  if not found
     or v_conn.sync_lease_owner is distinct from p_owner
     or v_conn.sync_leased_until <= now()
     or v_conn.status <> 'active' then
    raise exception 'KEEL_LEASE_LOST' using errcode = 'P0011';
  end if;
end;
$$;

create or replace function public.keel_worker_apply_action(
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
  select * into v_nsr from public.normalized_source_records where id = p_normalized_id;
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
  -- Fail CLOSED (post-build review Finding 1): a missing/NULL connection lookup
  -- must not fall through to a canonical write. `is distinct from` treats a NULL
  -- status (no row found) as non-active, so the fence raises instead of no-oping.
  if not found or v_conn.status is distinct from 'active' then
    raise exception 'KEEL_SYNC_SUPERSEDED' using errcode = 'P0007';
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

  -- Defense in depth (review M3): a removed tombstone must never reach create/
  -- revise (the reconciler routes it to void); its economic fields are null.
  if p_action_kind in ('create', 'revise') and v_nsr.kind = 'removed' then
    raise exception 'KEEL_INVALID_COMMAND: removed record cannot be % ', p_action_kind
      using errcode = 'P0009';
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
   order by b.posted_at desc, b.id desc limit 1;  -- deterministic tiebreak (review M5)
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
    if v_offset_id is null then  -- review B1: mirror the create-branch guard
      raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
    end if;

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

create or replace function public.keel_worker_complete_attempt(
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
  v_conn public.connections%rowtype;
begin
  select * into v_attempt from public.sync_attempts where attempt_id = p_attempt_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: unknown attempt' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);

  select * into v_conn
    from public.connections
   where id = v_attempt.connection_id
   for no key update;
  if v_conn.status <> 'active'
     or v_attempt.generation < v_conn.sync_desired_generation then
    raise exception 'KEEL_SYNC_SUPERSEDED' using errcode = 'P0007';
  end if;

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
