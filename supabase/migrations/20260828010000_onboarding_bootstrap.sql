create or replace function public.keel_bootstrap_household(
  p_user_id uuid,
  p_household_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
  v_entity_id uuid;
  v_name text;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users where id = p_user_id
  ) then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('keel_bootstrap_household:' || p_user_id::text, 0)
  );

  select household_id
    into v_household_id
    from public.household_memberships
   where user_id = p_user_id
   order by created_at, household_id
   limit 1;

  if v_household_id is not null then
    return jsonb_build_object(
      'householdId', v_household_id,
      'created', false
    );
  end if;

  v_name := coalesce(nullif(trim(p_household_name), ''), 'My household');
  if char_length(v_name) > 200 then
    raise exception 'KEEL_INVALID_COMMAND: household name is too long' using errcode = 'P0009';
  end if;

  insert into public.households (name)
  values (v_name)
  returning id into v_household_id;

  insert into public.household_memberships (household_id, user_id, role)
  values (v_household_id, p_user_id, 'owner');

  insert into public.entities (household_id, name, kind)
  values (v_household_id, 'Personal', 'personal')
  returning id into v_entity_id;

  insert into public.entity_memberships (entity_id, user_id)
  values (v_entity_id, p_user_id);

  insert into public.approval_policies (household_id, risk_class, autonomy)
  values
    (v_household_id, 'A', 'auto_with_log'),
    (v_household_id, 'B', 'suggest'),
    (v_household_id, 'C', 'suggest'),
    (v_household_id, 'D', 'off');

  insert into public.audit_log (
    household_id,
    actor,
    action,
    object_type,
    object_id,
    after
  ) values (
    v_household_id,
    jsonb_build_object('kind', 'user', 'userId', p_user_id),
    'household.bootstrap',
    'household',
    v_household_id,
    jsonb_build_object('householdId', v_household_id, 'entityId', v_entity_id)
  );

  return jsonb_build_object(
    'householdId', v_household_id,
    'entityId', v_entity_id,
    'created', true
  );
end;
$$;

revoke all on function public.keel_bootstrap_household(uuid, text)
  from public, anon, authenticated;
grant execute on function public.keel_bootstrap_household(uuid, text)
  to service_role;
