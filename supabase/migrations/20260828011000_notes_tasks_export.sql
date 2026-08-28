grant select on public.household_notes, public.household_tasks to keel_export;

drop policy if exists keel_export_select on public.household_notes;
create policy keel_export_select on public.household_notes
  for select to keel_export using (true);

drop policy if exists keel_export_select on public.household_tasks;
create policy keel_export_select on public.household_tasks
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_notes_tasks;
revoke all on function public.keel_export_household_pre_notes_tasks(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function public.keel_export_household(
  p_household_id uuid,
  p_as_of timestamptz default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_base jsonb;
  v_tables jsonb;
begin
  v_base := public.keel_export_household_pre_notes_tasks(p_household_id, p_as_of);

  select jsonb_build_object(
    'household_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id,
        'household_id', n.household_id,
        'entity_id', n.entity_id,
        'account_id', n.account_id,
        'canonical_transaction_id', n.canonical_transaction_id,
        'category_ledger_account_id', n.category_ledger_account_id,
        'goal_id', n.goal_id,
        'schedule_id', n.schedule_id,
        'body', n.body,
        'pinned', n.pinned,
        'created_by', n.created_by,
        'created_at', to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updated_at', to_char(n.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'archived_at', case when n.archived_at is null then null else to_char(n.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
      ) order by n.id)
      from public.household_notes n
      where n.household_id = p_household_id
        and (p_as_of is null or n.created_at <= p_as_of)
    ), '[]'::jsonb),
    'household_tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'household_id', t.household_id,
        'entity_id', t.entity_id,
        'account_id', t.account_id,
        'canonical_transaction_id', t.canonical_transaction_id,
        'category_ledger_account_id', t.category_ledger_account_id,
        'goal_id', t.goal_id,
        'schedule_id', t.schedule_id,
        'title', t.title,
        'description', t.description,
        'status', t.status::text,
        'due_on', case when t.due_on is null then null else to_char(t.due_on, 'YYYY-MM-DD') end,
        'priority', t.priority::text,
        'created_by', t.created_by,
        'created_at', to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updated_at', to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'completed_at', case when t.completed_at is null then null else to_char(t.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'archived_at', case when t.archived_at is null then null else to_char(t.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
      ) order by t.id)
      from public.household_tasks t
      where t.household_id = p_household_id
        and (p_as_of is null or t.created_at <= p_as_of)
    ), '[]'::jsonb)
  ) into v_tables;

  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;

revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz)
  to service_role;
