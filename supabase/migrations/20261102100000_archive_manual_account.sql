-- GAP: there was no way to remove an account. Stage 2, BC-v2.1 §Accounts.
--
-- 2026-11-02: a new user created five manual accounts by hand (checking,
-- savings, two investment accounts, a card), then linked the same banks
-- through Plaid. The manual copies duplicated every linked account and
-- nothing in the app could remove them.
--
-- Soft delete only (CLAUDE.md: prefer soft delete; user directive
-- 2026-07-17). Removing sets accounts.archived_at; restoring clears it.
-- Postings, transactions and the backing ledger account are untouched, so
-- the operation is fully reversible and the ledger stays balanced (Law 3).
-- Every read model already filters archived_at
-- (keel-networth-active-accounts-only).
--
-- Manual accounts only. A linked account belongs to a Plaid item; removing
-- it is the connection's disconnect flow, which also calls Plaid
-- /item/remove. Archiving a linked account here would leave the item
-- billing and syncing into a hidden account.
--
-- Same shape as keel_rename_account (20260714100000): keel_assert_member_write
-- gate, GUC-based audit actor, keel_api owner. keel_api already holds
-- UPDATE (archived_at) on accounts.
create or replace function public.keel_set_account_archived(
  p_household_id uuid,
  p_account_id uuid,
  p_archived boolean
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

  if p_archived is null then
    raise exception 'KEEL_INVALID_COMMAND: archived flag required' using errcode = 'P0009';
  end if;

  select * into v_row from public.accounts
    where id = p_account_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;

  if v_row.connection_id is not null then
    raise exception 'KEEL_LINKED_ACCOUNT: disconnect the bank connection to remove a linked account'
      using errcode = 'P0009';
  end if;

  -- Idempotent: replaying the same state is a no-op with no audit noise.
  if (v_row.archived_at is not null) = p_archived then
    return;
  end if;

  update public.accounts
     set archived_at = case when p_archived then now() else null end
   where id = v_row.id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when p_archived then 'account.archive' else 'account.unarchive' end,
          'account', v_row.id,
          jsonb_build_object('archived_at', v_row.archived_at),
          jsonb_build_object('archived', p_archived));
end;
$$;

revoke all on function public.keel_set_account_archived(uuid, uuid, boolean) from public, anon;
grant execute on function public.keel_set_account_archived(uuid, uuid, boolean) to authenticated;

grant update (archived_at) on public.accounts to keel_api;

grant create on schema public to keel_api;
alter function public.keel_set_account_archived(uuid, uuid, boolean) owner to keel_api;
revoke create on schema public from keel_api;
