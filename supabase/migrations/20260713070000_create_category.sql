-- Custom categories, create-only slice (T0.5). Rename/archive are deferred:
-- PFC auto-categorization and the picker filter join categories BY NAME
-- (audit finding) — those need a stable system-category key first. Creating
-- NEW user categories is safe: they can never collide with the seeded
-- system taxonomy (case-insensitive uniqueness enforced here).

-- Race-proof the case-insensitive name check (concurrent creates).
create unique index if not exists ledger_accounts_category_name_ci
  on public.ledger_accounts (entity_id, lower(name))
  where is_category = true and archived_at is null;

create or replace function public.keel_create_category(
  p_household_id uuid,
  p_name text,
  p_kind public.ledger_account_kind
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_entity uuid;
  v_currency char(3);
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

  select id into v_entity from public.entities
    where household_id = p_household_id order by created_at limit 1;
  if v_entity is null then
    raise exception 'KEEL_NOT_FOUND: entity' using errcode = 'P0006';
  end if;

  if exists (
    select 1 from public.ledger_accounts
    where entity_id = v_entity and is_category = true and archived_at is null
      and lower(name) = lower(v_name)
  ) then
    raise exception 'KEEL_INVALID_COMMAND: a category with this name exists' using errcode = 'P0009';
  end if;

  select currency into v_currency from public.ledger_accounts
    where entity_id = v_entity and is_category = true and archived_at is null
    order by created_at, id
    limit 1;

  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category)
  values (p_household_id, v_entity, v_name, p_kind, coalesce(v_currency, 'USD'), true)
  returning id into v_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'categories.create', 'ledger_account', v_id,
          jsonb_build_object('name', v_name, 'kind', p_kind));
  return v_id;
end;
$$;

revoke all on function public.keel_create_category(uuid, text, public.ledger_account_kind)
  from public, anon;
grant execute on function public.keel_create_category(uuid, text, public.ledger_account_kind)
  to authenticated;
