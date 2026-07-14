-- GAP: there was no way to rename a real-world account (public.accounts.name).
-- accounts.create existed (packages/contracts/src/commands.ts) but nothing
-- let a household correct a name later — connections and categories both got
-- a rename path (keel_rename_connection, keel_rename_category); accounts
-- never did.
--
-- Follows the newest house pattern (20260713210000_entity_management.sql):
-- keel_assert_member_write for the auth + household-membership + write-role
-- gate (owner/partner only — the same bar every other mutating proc holds),
-- and GUC-based uid resolution for the audit actor, never auth.uid() — this
-- proc ends up owned by keel_api, which has no USAGE on the auth schema
-- (20260713200000_definer_uid_fix.sql).
--
-- Wired as a bespoke small proc, not through the generic /commands envelope
-- dispatcher: same shape as /entities/create, /categories/set-tax-line, and
-- /transactions/override in supabase/functions/api/index.ts, none of which
-- carry an economic-event key or appear in packages/contracts's
-- COMMAND_PAYLOAD_SCHEMAS / packages/authz's Action union — a plain metadata
-- edit gated entirely by keel_assert_member_write needs neither.
create or replace function public.keel_rename_account(
  p_household_id uuid,
  p_account_id uuid,
  p_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_row public.accounts%rowtype;
begin
  perform public.keel_assert_member_write(p_household_id);

  -- Matches the accounts.name check constraint (length between 1 and 200) —
  -- fail here with a clear P0009 rather than let it surface as an opaque
  -- constraint-violation error from the update below.
  if char_length(v_name) < 1 or char_length(v_name) > 200 then
    raise exception 'KEEL_INVALID_NAME: account name must be 1-200 characters' using errcode = 'P0009';
  end if;

  select * into v_row from public.accounts
    where id = p_account_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;

  -- Idempotent-safe: replaying the same name is a no-op, no audit noise.
  if v_row.name = v_name then
    return;
  end if;

  update public.accounts set name = v_name where id = v_row.id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'account.rename', 'account', v_row.id,
          jsonb_build_object('name', v_row.name),
          jsonb_build_object('name', v_name));
end;
$$;

-- ACL restatement per house style (create-or-replace preserves owner/ACLs;
-- this just documents/re-asserts the grant explicitly, matching the bottom
-- of 20260713210000_entity_management.sql and 20260713200000_definer_uid_fix.sql).
revoke all on function public.keel_rename_account(uuid, uuid, text) from public, anon;
grant execute on function public.keel_rename_account(uuid, uuid, text) to authenticated;

-- keel_api already holds select+insert on accounts + audit_log and the
-- definer_all RLS policy on both (20260710210500_grants_rls.sql), but the
-- base grant in that migration never included UPDATE on accounts (only
-- canonical_transactions/period_locks/connections/sync_checkpoints got
-- column-scoped UPDATE there) — this is the first accounts-mutating proc
-- to be keel_api-owned, so it needs its own scoped grant, same pattern as
-- `grant update (status) on public.connections to keel_api;` in that file.
-- RLS's `accounts_definer_all` policy permits the row; without this grant
-- the underlying UPDATE would still fail closed with permission denied.
grant update (name) on public.accounts to keel_api;

-- OWNER TO requires the receiving role to hold CREATE on the schema (the
-- prod migration role is NOT superuser — scratch masks this).
grant create on schema public to keel_api;
alter function public.keel_rename_account(uuid, uuid, text) owner to keel_api;
revoke create on schema public from keel_api;
