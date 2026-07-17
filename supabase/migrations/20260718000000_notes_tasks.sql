-- Notes & tasks: lightweight household reminders anchored to finance objects.
-- These are mutable planning records, not ledger postings. All writes go
-- through SECURITY DEFINER RPCs that re-check household membership and audit.

create type public.note_task_status as enum ('open', 'done', 'dismissed');
create type public.note_task_priority as enum ('low', 'normal', 'high');

create table if not exists public.household_notes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  entity_id uuid references public.entities (id),
  account_id uuid references public.accounts (id),
  canonical_transaction_id uuid references public.canonical_transactions (id),
  category_ledger_account_id uuid references public.ledger_accounts (id),
  goal_id uuid references public.savings_goals (id),
  schedule_id uuid references public.scheduled_transactions (id),
  body text not null check (char_length(trim(body)) between 1 and 1000),
  pinned boolean not null default false,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.household_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  entity_id uuid references public.entities (id),
  account_id uuid references public.accounts (id),
  canonical_transaction_id uuid references public.canonical_transactions (id),
  category_ledger_account_id uuid references public.ledger_accounts (id),
  goal_id uuid references public.savings_goals (id),
  schedule_id uuid references public.scheduled_transactions (id),
  title text not null check (char_length(trim(title)) between 1 and 160),
  description text check (description is null or char_length(description) <= 1000),
  status public.note_task_status not null default 'open',
  due_on date,
  priority public.note_task_priority not null default 'normal',
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  archived_at timestamptz
);

create index if not exists household_notes_household_active
  on public.household_notes (household_id, archived_at, pinned desc, updated_at desc);
create index if not exists household_tasks_household_active
  on public.household_tasks (household_id, archived_at, status, due_on nulls last, updated_at desc);

revoke all on public.household_notes, public.household_tasks from public, anon, authenticated;
grant select on public.household_notes, public.household_tasks to authenticated;

alter table public.household_notes enable row level security;
alter table public.household_tasks enable row level security;

drop policy if exists household_notes_member_read on public.household_notes;
create policy household_notes_member_read on public.household_notes
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = household_notes.household_id and m.user_id = auth.uid()
  ));

drop policy if exists household_tasks_member_read on public.household_tasks;
create policy household_tasks_member_read on public.household_tasks
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = household_tasks.household_id and m.user_id = auth.uid()
  ));

create or replace function public.keel_list_notes_tasks(p_household_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with authorized as (
    select exists (
      select 1 from public.household_memberships
      where household_id = p_household_id and user_id = auth.uid()
    ) as ok
  ), note_rows as (
    select jsonb_build_object(
      'type', 'note',
      'id', n.id,
      'body', n.body,
      'pinned', n.pinned,
      'createdAt', to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'updatedAt', to_char(n.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) as row, n.pinned, null::date as due_on, n.updated_at
    from public.household_notes n, authorized a
    where a.ok and n.household_id = p_household_id and n.archived_at is null
  ), task_rows as (
    select jsonb_build_object(
      'type', 'task',
      'id', t.id,
      'title', t.title,
      'description', t.description,
      'status', t.status,
      'dueOn', t.due_on,
      'priority', t.priority,
      'createdAt', to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'updatedAt', to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) as row, false as pinned, t.due_on, t.updated_at
    from public.household_tasks t, authorized a
    where a.ok and t.household_id = p_household_id and t.archived_at is null and t.status <> 'dismissed'
  ), combined as (
    select * from note_rows
    union all
    select * from task_rows
  )
  select case when (select ok from authorized)
    then jsonb_build_object(
      'scope', jsonb_build_object('householdId', p_household_id),
      'asOf', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'rows', coalesce(jsonb_agg(row order by pinned desc, due_on asc nulls last, updated_at desc), '[]'::jsonb)
    )
    else jsonb_build_object(
      'scope', jsonb_build_object('householdId', p_household_id),
      'asOf', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'rows', '[]'::jsonb
    )
  end
  from combined;
$$;

create or replace function public.keel_note_save(
  p_household_id uuid,
  p_note_id uuid,
  p_body text,
  p_pinned boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  if auth.uid() is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships where household_id = p_household_id and user_id = auth.uid()) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if p_body is null or char_length(trim(p_body)) = 0 or char_length(p_body) > 1000 then
    raise exception 'KEEL_INVALID_COMMAND' using errcode = 'P0009';
  end if;

  if p_note_id is null then
    insert into public.household_notes (household_id, body, pinned, created_by)
    values (p_household_id, trim(p_body), coalesce(p_pinned, false), auth.uid())
    returning id into v_id;
    select to_jsonb(n) into v_after from public.household_notes n where n.id = v_id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'notes.create', 'note', v_id, v_after);
    return v_id;
  end if;

  select to_jsonb(n) into v_before from public.household_notes n
    where n.id = p_note_id and n.household_id = p_household_id and n.archived_at is null;
  if v_before is null then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;

  update public.household_notes
    set body = trim(p_body), pinned = coalesce(p_pinned, pinned), updated_at = now()
    where id = p_note_id and household_id = p_household_id
    returning id into v_id;
  select to_jsonb(n) into v_after from public.household_notes n where n.id = v_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'notes.update', 'note', v_id, v_before, v_after);
  return v_id;
end;
$$;

create or replace function public.keel_note_archive(p_household_id uuid, p_note_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_before jsonb; v_after jsonb;
begin
  if auth.uid() is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships where household_id = p_household_id and user_id = auth.uid()) then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;
  select to_jsonb(n) into v_before from public.household_notes n where n.id = p_note_id and n.household_id = p_household_id and n.archived_at is null;
  if v_before is null then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;
  update public.household_notes set archived_at = now(), updated_at = now() where id = p_note_id and household_id = p_household_id;
  select to_jsonb(n) into v_after from public.household_notes n where n.id = p_note_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'notes.archive', 'note', p_note_id, v_before, v_after);
end;
$$;

create or replace function public.keel_task_save(
  p_household_id uuid,
  p_task_id uuid,
  p_title text,
  p_description text default null,
  p_due_on date default null,
  p_priority text default 'normal'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_priority public.note_task_priority;
begin
  if auth.uid() is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships where household_id = p_household_id and user_id = auth.uid()) then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 160 then raise exception 'KEEL_INVALID_COMMAND' using errcode = 'P0009'; end if;
  if p_description is not null and char_length(p_description) > 1000 then raise exception 'KEEL_INVALID_COMMAND' using errcode = 'P0009'; end if;
  v_priority := coalesce(p_priority, 'normal')::public.note_task_priority;

  if p_task_id is null then
    insert into public.household_tasks (household_id, title, description, due_on, priority, created_by)
    values (p_household_id, trim(p_title), nullif(trim(coalesce(p_description, '')), ''), p_due_on, v_priority, auth.uid())
    returning id into v_id;
    select to_jsonb(t) into v_after from public.household_tasks t where t.id = v_id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'tasks.create', 'task', v_id, v_after);
    return v_id;
  end if;

  select to_jsonb(t) into v_before from public.household_tasks t where t.id = p_task_id and t.household_id = p_household_id and t.archived_at is null;
  if v_before is null then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;
  update public.household_tasks
    set title = trim(p_title), description = nullif(trim(coalesce(p_description, '')), ''), due_on = p_due_on, priority = v_priority, updated_at = now()
    where id = p_task_id and household_id = p_household_id
    returning id into v_id;
  select to_jsonb(t) into v_after from public.household_tasks t where t.id = v_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'tasks.update', 'task', v_id, v_before, v_after);
  return v_id;
end;
$$;

create or replace function public.keel_task_set_status(
  p_household_id uuid,
  p_task_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_before jsonb; v_after jsonb; v_status public.note_task_status;
begin
  if auth.uid() is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships where household_id = p_household_id and user_id = auth.uid()) then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;
  v_status := p_status::public.note_task_status;
  select to_jsonb(t) into v_before from public.household_tasks t where t.id = p_task_id and t.household_id = p_household_id and t.archived_at is null;
  if v_before is null then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;
  update public.household_tasks
    set status = v_status,
        completed_at = case when v_status = 'done' then coalesce(completed_at, now()) else null end,
        archived_at = case when v_status = 'dismissed' then coalesce(archived_at, now()) else archived_at end,
        updated_at = now()
    where id = p_task_id and household_id = p_household_id;
  select to_jsonb(t) into v_after from public.household_tasks t where t.id = p_task_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'tasks.set_status', 'task', p_task_id, v_before, v_after);
end;
$$;

revoke all on function public.keel_list_notes_tasks(uuid) from public, anon;
revoke all on function public.keel_note_save(uuid, uuid, text, boolean) from public, anon;
revoke all on function public.keel_note_archive(uuid, uuid) from public, anon;
revoke all on function public.keel_task_save(uuid, uuid, text, text, date, text) from public, anon;
revoke all on function public.keel_task_set_status(uuid, uuid, text) from public, anon;

grant execute on function public.keel_list_notes_tasks(uuid) to authenticated, service_role;
grant execute on function public.keel_note_save(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.keel_note_archive(uuid, uuid) to authenticated;
grant execute on function public.keel_task_save(uuid, uuid, text, text, date, text) to authenticated;
grant execute on function public.keel_task_set_status(uuid, uuid, text) to authenticated;
