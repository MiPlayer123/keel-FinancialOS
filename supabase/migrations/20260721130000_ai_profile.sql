-- AI agent SLICE 5 — personal context (authored). A per-household free-text
-- profile the user maintains (goals, how they think about money, tone) that is
-- injected into the agent's system prompt as TRUSTED, user-authored context.
-- It is user-tier, not ingested data, and never a ledger record. Writes go
-- through a SECURITY DEFINER RPC that re-checks membership and audits (Law 2).
-- Additive + idempotent; grants match the notes procs.

create table if not exists public.household_ai_profile (
  household_id uuid primary key references public.households (id),
  profile_text text not null check (char_length(profile_text) <= 4000),
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid()
);

revoke all on public.household_ai_profile from public, anon, authenticated;
grant select on public.household_ai_profile to authenticated;

alter table public.household_ai_profile enable row level security;
drop policy if exists household_ai_profile_member_read on public.household_ai_profile;
create policy household_ai_profile_member_read on public.household_ai_profile
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = household_ai_profile.household_id and m.user_id = auth.uid()
  ));

-- Read: returns the profile text (empty string when unset).
create or replace function public.keel_ai_profile_get(p_household_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (select p.profile_text from public.household_ai_profile p
      where p.household_id = p_household_id
        and exists (select 1 from public.household_memberships m
                    where m.household_id = p_household_id and m.user_id = auth.uid())),
    ''
  );
$$;

-- Save: upsert the profile (empty/blank clears it). Membership re-check + audit.
create or replace function public.keel_ai_profile_save(p_household_id uuid, p_profile_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_before jsonb; v_after jsonb; v_text text;
begin
  if auth.uid() is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships where household_id = p_household_id and user_id = auth.uid()) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if p_profile_text is not null and char_length(p_profile_text) > 4000 then
    raise exception 'KEEL_INVALID_COMMAND' using errcode = 'P0009';
  end if;
  v_text := nullif(trim(coalesce(p_profile_text, '')), '');
  select to_jsonb(p) into v_before from public.household_ai_profile p where p.household_id = p_household_id;

  if v_text is null then
    delete from public.household_ai_profile where household_id = p_household_id;
  else
    insert into public.household_ai_profile (household_id, profile_text, updated_by)
    values (p_household_id, v_text, auth.uid())
    on conflict (household_id) do update
      set profile_text = excluded.profile_text, updated_at = now(), updated_by = auth.uid();
  end if;

  select to_jsonb(p) into v_after from public.household_ai_profile p where p.household_id = p_household_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'ai_profile.save', 'ai_profile', p_household_id, v_before, v_after);
end;
$$;

revoke all on function public.keel_ai_profile_get(uuid) from public, anon;
revoke all on function public.keel_ai_profile_save(uuid, text) from public, anon;
grant execute on function public.keel_ai_profile_get(uuid) to authenticated;
grant execute on function public.keel_ai_profile_save(uuid, text) to authenticated;
