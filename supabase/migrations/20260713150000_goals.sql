-- Savings goals: earmark OVERLAY, not postings. Quicken hides goal money by
-- faking transfers; KEEL never fakes ledger entries (Law 1/3 — the spine is
-- deterministic and balanced, so nothing may pretend money moved). A goal is
-- a named target; contributions are virtual earmarks against it. Progress =
-- Σ contributions; an account's "free" balance = ledger balance − earmarks
-- pointing at it — computed at read time, never stored. Everything audited,
-- reversible (withdraw = negative contribution), exportable (Law 6).

create type public.goal_status as enum ('active', 'reached', 'archived');

create table if not exists public.savings_goals (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id),
  name          text not null check (char_length(name) between 1 and 80),
  target_minor  bigint not null check (target_minor > 0),
  target_date   date,
  -- Optional funding account: where the money notionally sits (earmark display).
  account_id    uuid references public.accounts (id),
  currency      text not null default 'USD',
  status        public.goal_status not null default 'active',
  created_at    timestamptz not null default now()
);
create index if not exists savings_goals_household
  on public.savings_goals (household_id, status);

create table if not exists public.goal_contributions (
  id             uuid primary key default gen_random_uuid(),
  goal_id        uuid not null references public.savings_goals (id) on delete cascade,
  household_id   uuid not null references public.households (id),
  -- Signed: negative = withdrawal back to "free" money (Law 4 BIGINT minor).
  amount_minor   bigint not null check (amount_minor <> 0),
  contributed_on date not null,
  created_at     timestamptz not null default now()
);
create index if not exists goal_contributions_goal on public.goal_contributions (goal_id);
create index if not exists goal_contributions_household
  on public.goal_contributions (household_id);

-- Fail-closed ACLs from birth (pgTAP 002 convention).
revoke all on public.savings_goals, public.goal_contributions from public, anon, authenticated;
grant select on public.savings_goals, public.goal_contributions to authenticated;

alter table public.savings_goals enable row level security;
alter table public.goal_contributions enable row level security;
drop policy if exists savings_goals_member_read on public.savings_goals;
create policy savings_goals_member_read on public.savings_goals
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = savings_goals.household_id and m.user_id = auth.uid()
  ));
drop policy if exists goal_contributions_member_read on public.goal_contributions;
create policy goal_contributions_member_read on public.goal_contributions
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = goal_contributions.household_id and m.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- Procs (house style: auth gate → membership gate → validate → mutate →
-- audit real changes only; revoke PUBLIC/anon, grant authenticated).
-- ---------------------------------------------------------------------------

-- Create (p_goal_id null) or update a goal.
create function public.keel_goal_save(
  p_household_id uuid,
  p_goal_id uuid,
  p_name text,
  p_target_minor bigint,
  p_target_date date,
  p_account_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_currency text := 'USD';
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
  if p_name is null or char_length(trim(p_name)) = 0 or char_length(p_name) > 80 then
    raise exception 'KEEL_INVALID_NAME' using errcode = 'P0009';
  end if;
  if p_target_minor is null or p_target_minor <= 0 then
    raise exception 'KEEL_INVALID_TARGET' using errcode = 'P0009';
  end if;
  if p_target_date is not null and
     (p_target_date < current_date or p_target_date > (current_date + interval '50 years')::date) then
    raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
  end if;
  if p_account_id is not null then
    select currency into v_currency from public.accounts
      where id = p_account_id and household_id = p_household_id;
    if not found then
      raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
    end if;
  end if;

  if p_goal_id is null then
    insert into public.savings_goals
      (household_id, name, target_minor, target_date, account_id, currency)
    values (p_household_id, trim(p_name), p_target_minor, p_target_date, p_account_id, v_currency)
    returning id into v_id;
  else
    update public.savings_goals
      set name = trim(p_name),
          target_minor = p_target_minor,
          target_date = p_target_date,
          account_id = p_account_id,
          currency = v_currency
      where id = p_goal_id and household_id = p_household_id
      returning id into v_id;
    if v_id is null then
      raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
    end if;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when p_goal_id is null then 'goal.create' else 'goal.update' end,
          'savings_goal', v_id,
          jsonb_build_object('name', trim(p_name), 'targetMinor', p_target_minor::text,
                             'targetDate', p_target_date, 'accountId', p_account_id));
  return v_id;
end;
$$;

revoke all on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid) from public, anon;
grant execute on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid) to authenticated;

-- Add to / withdraw from a goal. Withdrawing below zero saved is refused —
-- an earmark can't be negative overall.
create function public.keel_goal_contribute(
  p_household_id uuid,
  p_goal_id uuid,
  p_amount_minor bigint,
  p_contributed_on date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_goal public.savings_goals%rowtype;
  v_saved bigint;
  v_status public.goal_status;
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
  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception 'KEEL_INVALID_AMOUNT' using errcode = 'P0009';
  end if;
  if p_contributed_on is null
     or p_contributed_on < date '1900-01-01'
     or p_contributed_on > (current_date + interval '1 day')::date then
    raise exception 'KEEL_INVALID_DATE' using errcode = 'P0009';
  end if;

  select * into v_goal from public.savings_goals
    where id = p_goal_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
  end if;
  if v_goal.status = 'archived' then
    raise exception 'KEEL_GOAL_ARCHIVED' using errcode = 'P0009';
  end if;

  select coalesce(sum(amount_minor), 0) into v_saved
    from public.goal_contributions where goal_id = p_goal_id;
  if v_saved + p_amount_minor < 0 then
    raise exception 'KEEL_GOAL_OVERDRAWN' using errcode = 'P0009';
  end if;

  insert into public.goal_contributions (goal_id, household_id, amount_minor, contributed_on)
  values (p_goal_id, p_household_id, p_amount_minor, p_contributed_on);
  v_saved := v_saved + p_amount_minor;

  -- Reaching the target flips status automatically (deterministic and
  -- reversible: withdrawing back below flips it back).
  v_status := case
    when v_saved >= v_goal.target_minor then 'reached'::public.goal_status
    else 'active'::public.goal_status
  end;
  if v_goal.status is distinct from v_status then
    update public.savings_goals set status = v_status where id = p_goal_id;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when p_amount_minor > 0 then 'goal.contribute' else 'goal.withdraw' end,
          'savings_goal', p_goal_id,
          jsonb_build_object('amountMinor', p_amount_minor::text,
                             'contributedOn', p_contributed_on,
                             'savedMinor', v_saved::text, 'status', v_status));

  return jsonb_build_object('savedMinor', v_saved::text, 'status', v_status);
end;
$$;

revoke all on function public.keel_goal_contribute(uuid,uuid,bigint,date) from public, anon;
grant execute on function public.keel_goal_contribute(uuid,uuid,bigint,date) to authenticated;

-- Archive / un-archive (idempotent; no-op ≠ audit).
create function public.keel_goal_set_status(
  p_household_id uuid,
  p_goal_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_before public.goal_status;
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
  if p_status is null or not exists (
    select 1 from unnest(enum_range(null::public.goal_status)) st where st::text = p_status
  ) then
    raise exception 'KEEL_INVALID_STATUS: %', coalesce(p_status, '<null>') using errcode = 'P0009';
  end if;

  select status into v_before from public.savings_goals
    where id = p_goal_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
  end if;
  if v_before::text = p_status then
    return;
  end if;

  update public.savings_goals set status = p_status::public.goal_status where id = p_goal_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'goal.set_status', 'savings_goal', p_goal_id,
          jsonb_build_object('status', v_before), jsonb_build_object('status', p_status));
end;
$$;

revoke all on function public.keel_goal_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_goal_set_status(uuid,uuid,text) to authenticated;

-- List goals with saved totals (archived included, flagged — the UI decides).
create function public.keel_list_goals(p_household_id uuid)
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
           'goalId', g.id,
           'name', g.name,
           'targetMinor', g.target_minor::text,
           'targetDate', g.target_date,
           'accountId', g.account_id,
           'currency', g.currency,
           'status', g.status,
           'savedMinor', coalesce(c.saved, 0)::text
         ) order by g.status, g.target_date nulls last, g.name), '[]'::jsonb)
    into v_rows
    from public.savings_goals g
    left join lateral (
      select sum(gc.amount_minor) as saved
        from public.goal_contributions gc where gc.goal_id = g.id
    ) c on true
    where g.household_id = p_household_id;
  return v_rows;
end;
$$;

revoke all on function public.keel_list_goals(uuid) from public, anon;
grant execute on function public.keel_list_goals(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Export (Law 6): two new tables → grants + policies + wrapper chain link.
-- ---------------------------------------------------------------------------
grant select on public.savings_goals, public.goal_contributions to keel_export;
create policy savings_goals_export on public.savings_goals
  for select to keel_export using (true);
create policy goal_contributions_export on public.goal_contributions
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_goals;
revoke all on function public.keel_export_household_pre_goals(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_goals(p_household_id, p_as_of);
  select jsonb_build_object(
    'savings_goals', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id,
      'household_id', x.household_id,
      'name', x.name,
      'target_minor', x.target_minor::text,
      'target_date', case when x.target_date is null then null
                          else to_char(x.target_date, 'YYYY-MM-DD') end,
      'account_id', x.account_id,
      'currency', x.currency,
      'status', x.status::text,
      'created_at', to_char(x.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) order by x.id)
      from public.savings_goals x where x.household_id = p_household_id), '[]'::jsonb),
    'goal_contributions', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id,
      'goal_id', x.goal_id,
      'household_id', x.household_id,
      'amount_minor', x.amount_minor::text,
      'contributed_on', to_char(x.contributed_on, 'YYYY-MM-DD'),
      'created_at', to_char(x.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) order by x.id)
      from public.goal_contributions x where x.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
