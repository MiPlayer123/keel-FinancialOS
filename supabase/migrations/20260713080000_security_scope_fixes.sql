-- SECURITY: two SECURITY DEFINER read procs shipped without membership
-- checks (adversarial review findings B1/M1). Any authenticated user could
-- pass another household's id and read its balances / category taxonomy —
-- fail-closed scoping (Law 9, invariant 6) requires the guard INSIDE the
-- definer proc. Single-user production today, so no actual exposure, but
-- this must land with the next migration batch.

create or replace function public.keel_latest_balances(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  -- Service path (worker/admin) carries no user claim; user paths must be
  -- household members.
  if v_uid is not null and not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'accountId', account_id,
           'currentMinor', current_minor::text,
           'availableMinor', available_minor::text,
           'currency', currency,
           'asOf', as_of
         )), '[]'::jsonb)
    into v_rows
    from (
      select distinct on (account_id)
             account_id, current_minor, available_minor, currency, as_of
        from public.balance_snapshots
        where household_id = p_household_id
        order by account_id, as_of desc
    ) latest;
  return v_rows;
end;
$$;

grant execute on function public.keel_latest_balances(uuid) to authenticated, service_role;

-- keel_list_categories: same hole. Reproduce the original output shape
-- (plain array of category objects) with the guard added.
create or replace function public.keel_list_categories(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is not null and not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ledgerAccountId', la.id,
           'name', la.name,
           'kind', la.kind,
           'entityId', la.entity_id
         ) order by la.kind, la.name), '[]'::jsonb)
    into v_rows
    from public.ledger_accounts la
    where la.household_id = p_household_id
      and la.is_category = true
      and la.archived_at is null
      and la.name not in ('Opening Balances');
  return v_rows;
end;
$$;

grant execute on function public.keel_list_categories(uuid) to authenticated, service_role;
