-- Multi-entity gap fix: the schema has supported multiple financial entities
-- per household since Stage 1A (entities table + entity_kind enum), but no
-- proc ever let a user create a second one — add-account-dialog.tsx hardcoded
-- every new account to fetchFirstEntityId (whichever entity was seeded
-- first). This migration adds the write + read procs; the frontend picker
-- lands in the same commit.
--
-- Follows the definer_uid_fix.sql pattern (this file's header): these procs
-- end up owned by keel_api, so the caller id is read from the JWT claim GUCs,
-- never auth.uid() (keel_api has no USAGE on the auth schema).

create or replace function public.keel_create_entity(
  p_household_id uuid,
  p_name text,
  p_kind text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if p_name is null or char_length(trim(p_name)) = 0 or char_length(p_name) > 200 then
    raise exception 'KEEL_INVALID_NAME' using errcode = 'P0009';
  end if;
  if p_kind is null or not exists (
    select 1 from unnest(enum_range(null::public.entity_kind)) k
    where k::text = p_kind
  ) then
    raise exception 'KEEL_INVALID_KIND: %', coalesce(p_kind, '<null>')
      using errcode = 'P0009';
  end if;

  insert into public.entities (household_id, name, kind)
  values (p_household_id, trim(p_name), p_kind::public.entity_kind)
  returning id into v_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'entity.create', 'entity', v_id,
          jsonb_build_object('name', trim(p_name), 'kind', p_kind));

  return v_id;
end;
$$;

-- keel_list_entities: same read-guard shape as keel_list_categories /
-- keel_list_goals (a null uid is the service path; a present-but-foreign uid
-- is a scope violation). Archived entities are excluded — same convention as
-- archived categories/accounts not showing up in pickers.
create or replace function public.keel_list_entities(p_household_id uuid)
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
           'entityId', e.id,
           'name', e.name,
           'kind', e.kind
         ) order by e.created_at, e.name), '[]'::jsonb)
    into v_rows
    from public.entities e
    where e.household_id = p_household_id
      and e.archived_at is null;
  return v_rows;
end;
$$;

-- ACL restatement per house style (create-or-replace preserves owner/ACLs;
-- this just documents/re-asserts the grant explicitly, matching the bottom
-- of 20260713180000_debt_goals.sql and 20260713200000_definer_uid_fix.sql).
revoke all on function public.keel_create_entity(uuid,text,text) from public, anon;
grant execute on function public.keel_create_entity(uuid,text,text) to authenticated;
revoke all on function public.keel_list_entities(uuid) from public, anon;
grant execute on function public.keel_list_entities(uuid) to authenticated;

-- OWNER TO requires the receiving role to hold CREATE on the schema (the
-- prod migration role is NOT superuser — scratch masks this). keel_api
-- already holds select+insert on entities + audit_log and the definer_all
-- RLS policy on both (20260710210500_grants_rls.sql), so no new grants are
-- needed here — only the ownership handoff.
grant create on schema public to keel_api;
alter function public.keel_create_entity(uuid,text,text) owner to keel_api;
alter function public.keel_list_entities(uuid) owner to keel_api;
revoke create on schema public from keel_api;
