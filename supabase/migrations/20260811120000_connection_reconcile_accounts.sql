-- Plaid update-mode account reconcile (in-place re-authorization, 2026-08-11).
--
-- PROBLEM. When a card is reissued with a new number, its underlying Plaid
-- account drops out of the linked item. The item stays 'active' (sibling
-- accounts keep syncing) so no ITEM_LOGIN_REQUIRED / PENDING_EXPIRATION reauth
-- prompt ever fires. The card silently goes stale: the ongoing sync path does
-- NOT create accounts (worker/index.ts returns `unknown account` and drops the
-- transaction) — accounts are only ever created at initial link via
-- keel_finalize_link. So even after the user re-authorizes the item in Plaid
-- update mode (which re-surfaces the reissued card), the card's transactions
-- would reference an account KEEL has no row for and vanish.
--
-- FIX. keel_reconcile_connection_accounts discovers the item's CURRENT accounts
-- (the caller supplies them from /accounts/get → mapAccountsGetToKeel) and
-- INSERTS ANY MISSING ONES under the EXISTING connection, with the same
-- per-account entity resolution and asset/liability mapping keel_finalize_link
-- uses. INSERT-MISSING-ONLY: it never updates or archives an existing account —
-- a transient Plaid omission must not archive a live account (decision:
-- add-missing-only). Idempotent: a second identical call adds nothing.
--
-- This is the account-discovery half of true Plaid update mode; the link-token
-- half (passing the existing item's access_token to /link/token/create) lives
-- in the `api` edge function. Both reuse the existing decrypt path
-- (keel_get_connection_credential_envelope) and authz (connections.link).
--
-- Money invariant untouched: entity_id is a scoping attribute, never an amount.
-- No postings are created here (opening balance / transactions arrive via the
-- normal sync path once the account row exists).
--
-- Actor from request.jwt.claim.sub (via keel_actor_from_jwt); p_actor is not a
-- parameter — this is a user-scoped command invoked over the user's JWT, so the
-- grant mirrors keel_cmd_set_splits: owner keel_api, execute to `authenticated`.
--
-- NOT executed against any live database by this file. Validated by
-- supabase/tests/039_connection_reconcile_accounts.sql under `supabase test db`
-- against the full migrated schema. Flagged in NOTES.md.

create or replace function public.keel_reconcile_connection_accounts(
  p_household_id uuid,
  p_connection_id uuid,
  p_accounts jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor jsonb;
  v_uid uuid;
  v_institution_id text;
  v_connection_archived timestamptz;
  v_account jsonb;
  v_kind public.ledger_account_kind;
  v_ledger_account_id uuid;
  v_account_id uuid;
  v_account_name text;
  v_account_subtype text;
  v_account_mask text;
  v_external_ref text;
  -- Entity defaults (resolved once, mirrors keel_finalize_link).
  v_default_entity_id uuid;
  v_business_entity_id uuid;
  v_business_entity_count int;
  v_target_entity_id uuid;
  v_entity_reason text;
  v_added jsonb := '[]'::jsonb;
begin
  -- Actor + write authorization (owner or partner — a link-class write).
  v_actor := public.keel_actor_from_jwt();
  v_uid := (v_actor->>'userId')::uuid;
  perform public.keel_assert_member_write(p_household_id);

  -- Connection must be in the household and live. Read its institution_id for
  -- per-account entity resolution.
  select institution_id, archived_at
    into v_institution_id, v_connection_archived
    from public.connections
   where id = p_connection_id
     and household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: connection not in household' using errcode = 'P0006';
  end if;
  if v_connection_archived is not null then
    raise exception 'KEEL_INVALID_COMMAND: connection is archived' using errcode = 'P0009';
  end if;

  if jsonb_typeof(p_accounts) <> 'array' then
    raise exception 'KEEL_INVALID_COMMAND: accounts must be an array' using errcode = 'P0009';
  end if;

  -- Household entity defaults (resolved ONCE, identical to keel_finalize_link):
  --   default = household 'personal' entity (no modal fallback here — reconcile
  --   always runs against an established household that has a personal entity);
  --   business = the LONE non-personal entity, else null (heuristic disabled).
  select id into v_default_entity_id
    from public.entities
   where household_id = p_household_id
     and kind = 'personal'
     and archived_at is null
   order by created_at, id
   limit 1;
  if v_default_entity_id is null then
    raise exception 'KEEL_INVALID_COMMAND: household has no personal entity' using errcode = 'P0009';
  end if;

  select count(*), min(id)
    into v_business_entity_count, v_business_entity_id
    from public.entities
   where household_id = p_household_id
     and kind <> 'personal'
     and archived_at is null;
  if v_business_entity_count <> 1 then
    v_business_entity_id := null;
  end if;

  for v_account in select value from jsonb_array_elements(p_accounts) loop
    v_external_ref := v_account->>'external_ref';
    if coalesce(v_external_ref, '') = '' then
      raise exception 'KEEL_INVALID_COMMAND: account missing external_ref' using errcode = 'P0009';
    end if;

    -- INSERT-MISSING-ONLY: skip any account already present under this
    -- connection (archived or not — external_ref is the item-stable key).
    if exists (
      select 1 from public.accounts
       where connection_id = p_connection_id
         and external_ref = v_external_ref
    ) then
      continue;
    end if;

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

    -- Per-account entity: reconnect-inherit → business-name heuristic → default
    -- Personal. Single-sourced in keel_resolve_finalize_entity (same code
    -- keel_finalize_link runs). p_connection_id is THIS connection, so a
    -- sibling account on the same item is never mistaken for a prior link.
    select r.o_entity_id, r.o_reason
      into v_target_entity_id, v_entity_reason
      from public.keel_resolve_finalize_entity(
        p_household_id, p_connection_id, v_institution_id,
        v_account_name, v_account_subtype, v_account_mask,
        v_default_entity_id, v_business_entity_id
      ) r;

    insert into public.ledger_accounts
      (household_id, entity_id, name, kind, currency, is_category)
    values
      (p_household_id, v_target_entity_id, v_account_name, v_kind, 'USD', false)
    returning id into v_ledger_account_id;

    insert into public.accounts
      (household_id, entity_id, connection_id, ledger_account_id,
       name, subtype, currency, external_ref, mask)
    values
      (p_household_id, v_target_entity_id, p_connection_id, v_ledger_account_id,
       v_account_name, v_account_subtype, 'USD', v_external_ref, v_account_mask)
    returning id into v_account_id;

    insert into public.account_owners (account_id, user_id)
    values (v_account_id, v_uid);

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.account_reconciled', 'account', v_account_id,
       jsonb_build_object('accountId', v_account_id, 'connectionId', p_connection_id,
                          'externalRef', v_external_ref, 'kind', v_kind,
                          'entityId', v_target_entity_id, 'entitySource', v_entity_reason));

    v_added := v_added || jsonb_build_object('accountId', v_account_id, 'externalRef', v_external_ref);
  end loop;

  -- One summary audit row for the reconcile action itself.
  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, after)
  values
    (p_household_id, v_actor, 'connections.accounts_reconciled', 'connection', p_connection_id,
     jsonb_build_object('connectionId', p_connection_id, 'added', v_added));

  return jsonb_build_object('added', v_added, 'addedCount', jsonb_array_length(v_added));
end;
$$;

-- Grant model mirrors keel_cmd_set_splits (a user-scoped, JWT-actor command):
-- owner keel_api, security definer; execute to `authenticated` only. Invoked by
-- the api edge function over the user's JWT (ctx.supabase.rpc) so
-- request.jwt.claim.sub is populated for keel_actor_from_jwt. keel_api must own
-- it because it calls keel_resolve_finalize_entity (execute-granted to keel_api)
-- under its own definer boundary.
do $grants$
begin
  execute 'alter function public.keel_reconcile_connection_accounts(uuid, uuid, jsonb) owner to keel_api';
exception when insufficient_privilege then
  raise notice 'keel_reconcile_connection_accounts owner change skipped (insufficient_privilege); create-or-replace preserved prior owner';
end;
$grants$;
revoke all on function public.keel_reconcile_connection_accounts(uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.keel_reconcile_connection_accounts(uuid, uuid, jsonb)
  to authenticated;
