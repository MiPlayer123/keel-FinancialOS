-- fix(connections): keel_finalize_link used min(id) on entities.id (uuid) to find
-- the lone business entity, but Postgres has no min(uuid) aggregate — every bank
-- link/reconnect threw 'function min(uuid) does not exist' (500 on /connections/link).
-- Introduced by 20260719040000 (per-account entity). Replaced with a uuid-safe
-- (array_agg(id order by id::text))[1]. Verified live end-to-end: finalize succeeds,
-- LLC brokerage->Business, Cash Mgmt->Personal. Already hand-applied to live; this
-- migration makes it durable/reproducible.
CREATE OR REPLACE FUNCTION public.keel_finalize_link(p_attempt_id uuid, p_household_id uuid, p_institution_id text, p_consent_expires_at timestamp with time zone, p_accounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Per-account entity resolution (2026-07-19):
  v_default_entity_id uuid;       -- household Personal entity, else modal choice
  v_business_entity_id uuid;      -- the LONE non-personal entity, when exactly one
  v_business_entity_count int;
  v_target_entity_id uuid;        -- resolved per account
  v_account_name text;
  v_account_subtype text;
  v_account_mask text;
  v_entity_reason text;
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

  -- ---------------------------------------------------------------------------
  -- Resolve the household's entity defaults ONCE (before the per-account loop).
  --   * v_default_entity_id: the household's 'personal' entity when present,
  --     otherwise fall back to the modal's per-connection choice so behaviour is
  --     never worse than the old one-entity-per-connection rule.
  --   * v_business_entity_id: the household's non-personal entity IFF there is
  --     exactly one -- the only case where the business-name heuristic can act
  --     without guessing which business.
  -- ---------------------------------------------------------------------------
  select id into v_default_entity_id
    from public.entities
   where household_id = p_household_id
     and kind = 'personal'
     and archived_at is null
   order by created_at, id
   limit 1;
  if v_default_entity_id is null then
    v_default_entity_id := v_attempt.entity_id;
  end if;

  select count(*), (array_agg(id order by id::text))[1]
    into v_business_entity_count, v_business_entity_id
    from public.entities
   where household_id = p_household_id
     and kind <> 'personal'
     and archived_at is null;
  if v_business_entity_count <> 1 then
    v_business_entity_id := null;  -- 0 or 2+: cannot disambiguate, disable heuristic
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

    v_account_name    := v_account->>'name';
    v_account_subtype := v_account->>'subtype';
    v_account_mask    := nullif(v_account->>'mask', '');

    -- Per-account entity: reconnect-inherit -> business-name heuristic ->
    -- default Personal. institution_id is compared with `is not distinct from`
    -- inside the resolver so two nulls still match (current live data has null
    -- institution_id on every connection). Single-sourced in
    -- keel_resolve_finalize_entity so the pgTAP suite tests the same code.
    select r.o_entity_id, r.o_reason
      into v_target_entity_id, v_entity_reason
      from public.keel_resolve_finalize_entity(
        p_household_id, v_connection_id, p_institution_id,
        v_account_name, v_account_subtype, v_account_mask,
        v_default_entity_id, v_business_entity_id
      ) r;

    insert into public.ledger_accounts
      (household_id, entity_id, name, kind, currency, is_category)
    values
      (p_household_id, v_target_entity_id, v_account->>'name', v_kind, 'USD', false)
    returning id into v_ledger_account_id;

    insert into public.accounts
      (household_id, entity_id, connection_id, ledger_account_id,
       name, subtype, currency, external_ref, mask)
    values
      (p_household_id, v_target_entity_id, v_connection_id, v_ledger_account_id,
       v_account->>'name', v_account->>'subtype', 'USD', v_account->>'external_ref',
       v_account_mask)
    returning id into v_account_id;

    insert into public.account_owners (account_id, user_id)
    values (v_account_id, v_attempt.initiated_by_user_id);

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (p_household_id, v_actor, 'connection.account_linked', 'account', v_account_id,
       v_attempt.command_id,
       jsonb_build_object('accountId', v_account_id, 'connectionId', v_connection_id,
                          'externalRef', v_account->>'external_ref', 'kind', v_kind,
                          'entityId', v_target_entity_id,
                          'entitySource', v_entity_reason));
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
$function$

