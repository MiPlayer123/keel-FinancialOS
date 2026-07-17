-- GAP (docs/harness/plans/entities-investments-transfers.md, ENTITY-2):
-- accounts.entity_id has been not-null since day one (20260710210100), and
-- the Plaid-connect flow picks an entity at connect time, but there was no
-- way to correct a wrong pick afterward -- e.g. a business brokerage that
-- landed under the personal entity because it was the only entity that
-- existed at connect time. Manual accounts already get an entity picker
-- (add-account-dialog.tsx); connected accounts had no equivalent repair
-- path.
--
-- Follows the keel_rename_account pattern (20260714100000): bespoke small
-- proc wired directly (not through the generic /commands envelope --
-- ENTITY_ID is a plain ownership correction, no economic-event key, no
-- suggest/approve gate), keel_assert_member_write for the auth +
-- membership + write-role gate, GUC-based uid resolution for the audit
-- actor.
--
-- Deliberately does NOT touch historical journal_postings.entity_id: every
-- posting proc stamps entity_id from the ledger account's entity_id AT
-- POST TIME (see command_procs.sql:189 among others), so it is already a
-- frozen fact about what entity a transaction belonged to when it happened
-- -- rewriting it retroactively would violate source preservation (BC-v2.1
-- Law 9) and could silently change the scope of an already-generated
-- as-of report. Reassigning accounts.entity_id + ledger_accounts.entity_id
-- only changes where NEW activity on this account posts going forward;
-- past history keeps the entity it was actually recorded under.
create or replace function public.keel_reassign_account_entity(
  p_household_id uuid,
  p_account_id uuid,
  p_entity_id uuid
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
  v_row public.accounts%rowtype;
begin
  perform public.keel_assert_member_write(p_household_id);

  if not exists (
    select 1 from public.entities
     where id = p_entity_id and household_id = p_household_id and archived_at is null
  ) then
    raise exception 'KEEL_NOT_FOUND: entity' using errcode = 'P0006';
  end if;

  select * into v_row from public.accounts
    where id = p_account_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;

  -- Idempotent-safe: replaying the same entity is a no-op, no audit noise.
  if v_row.entity_id = p_entity_id then
    return;
  end if;

  update public.accounts set entity_id = p_entity_id where id = v_row.id;
  update public.ledger_accounts set entity_id = p_entity_id where id = v_row.ledger_account_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'account.reassign_entity', 'account', v_row.id,
          jsonb_build_object('entityId', v_row.entity_id),
          jsonb_build_object('entityId', p_entity_id));
end;
$$;

revoke all on function public.keel_reassign_account_entity(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_reassign_account_entity(uuid, uuid, uuid) to authenticated;

-- Same column-scoped UPDATE gap as 20260714100000_account_rename.sql --
-- keel_api holds select+insert on both tables (20260710210500) but never
-- got UPDATE on entity_id. RLS's definer_all policies already permit the
-- row; without this grant the UPDATE above fails closed with permission
-- denied.
grant update (entity_id) on public.accounts to keel_api;
grant update (entity_id) on public.ledger_accounts to keel_api;

grant create on schema public to keel_api;
alter function public.keel_reassign_account_entity(uuid, uuid, uuid) owner to keel_api;
revoke create on schema public from keel_api;
