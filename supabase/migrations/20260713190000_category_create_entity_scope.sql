-- Allow category creation to target the importing/account entity instead of
-- always falling back to the household's first entity. This keeps Quicken/QIF
-- imports safe for multi-entity households (personal + LLC).
create or replace function public.keel_create_category(
  p_household_id uuid,
  p_name text,
  p_kind public.ledger_account_kind,
  p_parent_ledger_account_id uuid default null,
  p_entity_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_entity uuid;
  v_currency char(3);
  v_parent public.ledger_accounts%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'KEEL_INVALID_COMMAND: category name must be 1-80 characters' using errcode = 'P0009';
  end if;
  if p_kind not in ('expense', 'income') then
    raise exception 'KEEL_INVALID_COMMAND: categories are expense or income' using errcode = 'P0009';
  end if;

  if p_entity_id is not null then
    select id into v_entity from public.entities
      where id = p_entity_id and household_id = p_household_id;
    if v_entity is null then
      raise exception 'KEEL_NOT_FOUND: entity' using errcode = 'P0006';
    end if;
  else
    select id into v_entity from public.entities
      where household_id = p_household_id order by created_at limit 1;
    if v_entity is null then
      raise exception 'KEEL_NOT_FOUND: entity' using errcode = 'P0006';
    end if;
  end if;

  if p_parent_ledger_account_id is not null then
    select * into v_parent from public.ledger_accounts
      where id = p_parent_ledger_account_id and household_id = p_household_id
        and entity_id = v_entity and is_category = true and archived_at is null;
    if not found or v_parent.kind <> p_kind or v_parent.parent_ledger_account_id is not null then
      raise exception 'KEEL_INVALID_COMMAND: invalid parent category' using errcode = 'P0009';
    end if;
  end if;

  if exists (
    select 1 from public.ledger_accounts
    where entity_id = v_entity and is_category = true and archived_at is null
      and lower(name) = lower(v_name)
  ) then
    raise exception 'KEEL_INVALID_COMMAND: a category with this name exists' using errcode = 'P0009';
  end if;

  if p_parent_ledger_account_id is not null then
    v_currency := v_parent.currency;
  else
    select currency into v_currency from public.ledger_accounts
      where entity_id = v_entity and is_category = true and archived_at is null
      order by created_at, id
      limit 1;
  end if;

  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category,
     pfc_key, is_system, parent_ledger_account_id)
  values (p_household_id, v_entity, v_name, p_kind, coalesce(v_currency, 'USD'), true,
          null, false, p_parent_ledger_account_id)
  returning id into v_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (
    p_household_id,
    public.keel_actor_from_jwt(),
    'category.created',
    'ledger_account',
    v_id,
    jsonb_build_object(
      'name', v_name,
      'kind', p_kind,
      'entityId', v_entity,
      'parentLedgerAccountId', p_parent_ledger_account_id
    )
  );

  return v_id;
end;
$$;

revoke all on function public.keel_create_category(uuid, text, public.ledger_account_kind, uuid, uuid)
  from public, anon;
grant execute on function public.keel_create_category(uuid, text, public.ledger_account_kind, uuid, uuid)
  to authenticated;
