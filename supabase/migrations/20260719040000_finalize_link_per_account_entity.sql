-- Per-account entity at link-finalize (connection-flow fix, 2026-07-19).
--
-- PROBLEM. keel_finalize_link (20260717220000) creates EVERY account in a
-- Plaid connection under one entity: v_attempt.entity_id, the single choice
-- the connect modal ("Which entity is this for?") forced the user to make for
-- the WHOLE connection. That is wrong for a multi-entity institution. The
-- user's real Fidelity connection carries two accounts that belong to
-- DIFFERENT entities:
--   * "Limited Liability Company" (brokerage)      -> Business (LLC) entity
--   * "Cash Management (Individual)" (cash mgmt)    -> Personal entity
-- One-entity-per-connection dumps both under whichever the modal picked, then
-- forces the user to hand-reassign one -- and, worse, on RECONNECT the modal's
-- per-connection choice would OVERWRITE the per-account entities they had
-- already fixed.
--
-- FIX. Make entity resolution PER ACCOUNT inside keel_finalize_link:
--   (1) PRESERVE existing entity for a reconnect. If a brand-new account looks
--       like the same real-world account as an existing (non-archived) account
--       at the same institution -- same mask, or, when either side lacks a
--       mask, same name+subtype -- inherit that existing account's entity_id
--       instead of the modal's per-connection choice. This is the SAME match
--       predicate keel_list_reconnect_matches / keel_cmd_dedupe_reconnect_account
--       use (20260718061000), so the account the user will later dedupe onto
--       already lands in the right books, and the modal choice can never stomp
--       a correct per-account entity on reconnect.
--   (2) BUSINESS-NAME HEURISTIC for genuinely new accounts. If the account's
--       Plaid name contains a clear business marker (llc / l.l.c / limited
--       liability / business / incorporated / corporation / " inc"/ "corp")
--       AND the household has EXACTLY ONE non-personal entity (business / llc /
--       s_corp / sole_prop / trust / other), auto-assign that lone business
--       entity. This lands Fidelity's "Limited Liability Company" in the LLC
--       entity with no manual step. The single-non-personal-entity guard keeps
--       it deterministic: with two+ business entities we cannot know which, so
--       we fall through to the default rather than guess (Law 9 explicit
--       ownership -- inference is only applied when it is unambiguous).
--   (3) DEFAULT to the household's Personal entity for everything else
--       (Fidelity's "Cash Management (Individual)" lands here). Falls back to
--       the modal's chosen entity (v_attempt.entity_id) only if the household
--       somehow has no 'personal' entity, so behaviour is never worse than
--       today.
--
-- Per-account reassignment (keel_reassign_account_entity) remains available for
-- anything the heuristic gets wrong -- this only sets the DEFAULT landing spot,
-- it is not a lock (AI risk ladder class B stays: nothing here is irreversible).
--
-- Money invariant untouched: entity_id is a scoping attribute on
-- ledger_accounts / accounts, never an amount. Postings still Sum to zero;
-- opening-balance booking (in keel_apply_account_balance, unchanged here) reads
-- the account's entity for its Opening Balances equity account, so a
-- correctly-placed account also books its opening balance in the right entity.
--
-- Signature is UNCHANGED: (uuid, uuid, text, timestamptz, jsonb). CREATE OR
-- REPLACE preserves the function's OID, owner (keel_api), security-definer
-- flag, search_path, and existing grant (execute to service_role only) -- no
-- drop, no grant restatement needed. The grants block at the end is a belt-and-
-- suspenders restatement guarded to be a no-op if unchanged.
--
-- NOT executed against any live database. Hand-verified against current schema
-- (entities.kind enum: personal|sole_prop|llc_single|llc_multi|s_corp|trust|
-- other; accounts.entity_id, accounts.mask, accounts.subtype all present;
-- match predicate copied verbatim from 20260718061000). Validated by loading
-- all migrations into a throwaway local Postgres cluster + pgTAP (see
-- tests/pgtap/finalize_link_entity.sql). Flagged in NOTES.md.

-- ---------------------------------------------------------------------------
-- Per-account entity resolver. Single-sourced so keel_finalize_link and the
-- pgTAP suite exercise the SAME logic (no drift between shipped code and test).
-- Returns the entity_id a newly-linked account should land in, plus a text
-- reason for the audit trail. Read-only: it never writes; the caller writes.
--
--   p_default_entity_id  : household 'personal' entity, or the modal choice as
--                          fallback (resolved once by the caller).
--   p_business_entity_id : the household's lone non-personal entity, or null
--                          when there are 0 or 2+ (heuristic disabled).
--
-- Preference order: (1) inherited entity of an existing same-institution
-- account that matches by mask (or name+subtype) -> reconnect preservation;
-- (2) the lone business entity when the name looks business-y; (3) default.
-- SECURITY DEFINER + owner keel_api so it can read public.accounts under the
-- same trust boundary as its only caller (keel_finalize_link); it takes an
-- explicit p_household_id and only ever reads within it.
-- ---------------------------------------------------------------------------
create or replace function public.keel_resolve_finalize_entity(
  p_household_id uuid,
  p_connection_id uuid,
  p_institution_id text,
  p_account_name text,
  p_account_subtype text,
  p_account_mask text,
  p_default_entity_id uuid,
  p_business_entity_id uuid,
  out o_entity_id uuid,
  out o_reason text
)
language plpgsql
security definer
set search_path = public
stable
as $resolve$
declare
  v_mask text := nullif(p_account_mask, '');
  v_inherited uuid;
  v_lower text := lower(coalesce(p_account_name, ''));
begin
  -- (1) RECONNECT PRESERVATION -- same match predicate as
  -- keel_list_reconnect_matches / keel_cmd_dedupe_reconnect_account
  -- (20260718061000): mask match when both sides have one, else name+subtype.
  select ea.entity_id
    into v_inherited
    from public.accounts ea
    join public.connections ec on ec.id = ea.connection_id
   where ea.household_id = p_household_id
     and ea.archived_at is null
     and (p_connection_id is null or ec.id <> p_connection_id)
     and ec.institution_id is not distinct from p_institution_id
     and (
       (ea.mask is not null and v_mask is not null and ea.mask = v_mask)
       or (
         (ea.mask is null or v_mask is null)
         and ea.name = p_account_name
         and ea.subtype is not distinct from p_account_subtype
       )
     )
   order by ea.created_at desc, ea.id
   limit 1;

  if v_inherited is not null then
    o_entity_id := v_inherited;
    o_reason := 'reconnect_inherited';
    return;
  end if;

  -- (2) BUSINESS-NAME HEURISTIC (only when exactly one non-personal entity).
  if p_business_entity_id is not null and (
       v_lower ~ '(^|[^a-z])l\.?l\.?c\.?([^a-z]|$)'
    or v_lower like '%limited liability%'
    or v_lower like '%business%'
    or v_lower like '%incorporated%'
    or v_lower ~ '(^|[^a-z])inc\.?([^a-z]|$)'
    or v_lower like '%corporation%'
    or v_lower ~ '(^|[^a-z])corp\.?([^a-z]|$)'
  ) then
    o_entity_id := p_business_entity_id;
    o_reason := 'business_name_heuristic';
    return;
  end if;

  -- (3) DEFAULT (household Personal, or modal choice if none).
  o_entity_id := p_default_entity_id;
  o_reason := 'default_personal';
end;
$resolve$;

do $rgrants$
begin
  execute 'alter function public.keel_resolve_finalize_entity(uuid, uuid, text, text, text, text, uuid, uuid) owner to keel_api';
exception when insufficient_privilege then
  raise notice 'keel_resolve_finalize_entity owner change skipped (insufficient_privilege)';
end;
$rgrants$;
revoke all on function public.keel_resolve_finalize_entity(uuid, uuid, text, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.keel_resolve_finalize_entity(uuid, uuid, text, text, text, text, uuid, uuid)
  to service_role, keel_api;
-- keel_api must hold EXECUTE: keel_finalize_link is a SECURITY DEFINER function
-- owned by keel_api and it calls this resolver, so at runtime the resolver is
-- invoked as keel_api. Without this grant the whole link/reconnect finalize
-- fails with permission denied. (The resolver could not be re-owned to keel_api
-- via ALTER FUNCTION here — insufficient_privilege on the cloud role — so an
-- explicit grant is the correct fix.)

create or replace function public.keel_finalize_link(
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

  select count(*), min(id)
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
$$;

-- Belt-and-suspenders grant restatement (no-op if unchanged): signature did not
-- change, so CREATE OR REPLACE already kept owner=keel_api and the single
-- execute grant to service_role. Restating is idempotent and keeps this file
-- self-describing for the audit-by-diff review process (no migration-history
-- table for manual applies).
do $grants$
begin
  execute 'alter function public.keel_finalize_link(uuid, uuid, text, timestamptz, jsonb) owner to keel_api';
  execute 'revoke all on function public.keel_finalize_link(uuid, uuid, text, timestamptz, jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.keel_finalize_link(uuid, uuid, text, timestamptz, jsonb) to service_role';
exception
  when insufficient_privilege then
    -- A manual psql apply as the project owner may not be able to reassign
    -- ownership to keel_api if it lacks role membership; CREATE OR REPLACE has
    -- already preserved the pre-existing owner/grants, so tolerate this.
    raise notice 'keel_finalize_link grant restatement skipped (insufficient_privilege); create-or-replace preserved prior owner/grants';
end;
$grants$;
