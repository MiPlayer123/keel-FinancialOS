-- Debt paydown goals: a second goal kind alongside savings. A savings goal's
-- progress is a virtual earmark (Σ contributions) because nothing in the
-- ledger tracks "money set aside". A debt goal is the opposite: the ledger
-- ALREADY tracks the truth (the liability account's balance), so progress
-- must be DERIVED from journal_postings at read time, never from a parallel
-- contributions ledger (Law 1 — no shadow arithmetic; Law 9 reproducible
-- numbers — paidMinor is always recomputable from source rows). Contributions
-- are therefore refused for debt goals: there is exactly one way to make
-- progress on a debt goal, which is to pay down the account.

create type public.goal_kind as enum ('savings', 'debt');

alter table public.savings_goals
  add column kind public.goal_kind not null default 'savings';
alter table public.savings_goals
  add column start_balance_minor bigint;

comment on column public.savings_goals.kind is
  'savings: progress = Σ goal_contributions (virtual earmark). debt: progress derived from the ledger balance of account_id; contributions refused.';
comment on column public.savings_goals.start_balance_minor is
  'Debt goals only: liability balance magnitude captured at creation. Immutable once set — paidMinor = start_balance_minor - current balance magnitude, floored at 0.';

-- ---------------------------------------------------------------------------
-- keel_goal_save: signature gains p_kind. Signature change => drop first
-- (grants die with the old signature; restated below for the new one).
-- ---------------------------------------------------------------------------
drop function public.keel_goal_save(uuid, uuid, text, bigint, date, uuid);

create function public.keel_goal_save(
  p_household_id uuid,
  p_goal_id uuid,
  p_name text,
  p_target_minor bigint,
  p_target_date date,
  p_account_id uuid,
  p_kind text default 'savings'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_currency text := 'USD';
  v_row public.savings_goals%rowtype;
  v_saved bigint;
  v_paid bigint;
  v_status public.goal_status;
  v_kind public.goal_kind;
  v_ledger_kind public.ledger_account_kind;
  v_ledger_account_id uuid;
  v_raw_balance bigint;
  v_start_balance bigint;
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
  if p_target_date is not null and p_target_date > (current_date + interval '50 years')::date then
    raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
  end if;
  if p_kind is null or p_kind not in ('savings', 'debt') then
    raise exception 'KEEL_INVALID_KIND' using errcode = 'P0009';
  end if;
  v_kind := p_kind::public.goal_kind;
  if v_kind = 'debt' and p_account_id is null then
    raise exception 'KEEL_DEBT_GOAL_REQUIRES_ACCOUNT' using errcode = 'P0009';
  end if;

  if p_account_id is not null then
    select a.currency, a.ledger_account_id, la.kind
      into v_currency, v_ledger_account_id, v_ledger_kind
      from public.accounts a
      join public.ledger_accounts la on la.id = a.ledger_account_id
      where a.id = p_account_id and a.household_id = p_household_id;
    if not found then
      raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
    end if;
    if v_kind = 'debt' and v_ledger_kind is distinct from 'liability'::public.ledger_account_kind then
      raise exception 'KEEL_DEBT_GOAL_REQUIRES_LIABILITY' using errcode = 'P0009';
    end if;
  end if;

  if p_goal_id is null then
    -- A NEW goal can't target the past; an existing overdue goal must stay
    -- editable (rename etc.) while keeping its own date.
    if p_target_date is not null and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;

    if v_kind = 'debt' then
      -- Current ledger balance, debit-positive convention (keel_apply_account_balance):
      -- a liability's "owed" magnitude is -Σ postings, floored at 0.
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_start_balance := greatest(-v_raw_balance, 0);
    else
      v_start_balance := null;
    end if;

    insert into public.savings_goals
      (household_id, name, target_minor, target_date, account_id, currency, kind, start_balance_minor)
    values (p_household_id, trim(p_name), p_target_minor, p_target_date, p_account_id, v_currency,
            v_kind, v_start_balance)
    returning id into v_id;
  else
    select * into v_row from public.savings_goals
      where id = p_goal_id and household_id = p_household_id
      for update;
    if not found then
      raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
    end if;
    -- Kind is set at creation and never migrates in place: a debt goal's
    -- start_balance_minor and a savings goal's contributions mean different
    -- things and neither survives a kind switch honestly.
    if v_kind is distinct from v_row.kind then
      raise exception 'KEEL_GOAL_KIND_IMMUTABLE' using errcode = 'P0009';
    end if;
    -- A debt goal's start_balance_minor was captured against ONE account at
    -- creation; re-pointing it would freeze paidMinor against a stale
    -- baseline (reproducible numbers, BC-v2.1 §9.1). Immutable like kind.
    if v_row.kind = 'debt'
       and p_account_id is distinct from v_row.account_id then
      raise exception 'KEEL_DEBT_GOAL_ACCOUNT_IMMUTABLE' using errcode = 'P0009';
    end if;
    -- Past dates are refused only when the date actually changes.
    if p_target_date is not null
       and p_target_date is distinct from v_row.target_date
       and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;
    -- No funding account given: the goal keeps its currency. Contributions
    -- carry no currency of their own — the unit must never drift under an
    -- earmark (Law 4).
    if p_account_id is null then
      v_currency := v_row.currency;
    end if;

    -- 'reached' is derived state; a target change recomputes it (archived
    -- goals keep their lifecycle status). Savings derives from Σ
    -- contributions; debt derives from the ledger balance of account_id.
    if v_row.kind = 'debt' then
      select a.ledger_account_id into v_ledger_account_id
        from public.accounts a where a.id = coalesce(p_account_id, v_row.account_id);
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_paid := greatest(coalesce(v_row.start_balance_minor, 0) - greatest(-v_raw_balance, 0), 0);
      v_status := case
        when v_row.status = 'archived' then 'archived'::public.goal_status
        when v_paid >= p_target_minor then 'reached'::public.goal_status
        else 'active'::public.goal_status
      end;
    else
      select coalesce(sum(amount_minor), 0) into v_saved
        from public.goal_contributions where goal_id = p_goal_id;
      v_status := case
        when v_row.status = 'archived' then 'archived'::public.goal_status
        when v_saved >= p_target_minor then 'reached'::public.goal_status
        else 'active'::public.goal_status
      end;
    end if;

    update public.savings_goals
      set name = trim(p_name),
          target_minor = p_target_minor,
          target_date = p_target_date,
          account_id = p_account_id,
          currency = v_currency,
          status = v_status
      where id = p_goal_id
      returning id into v_id;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when p_goal_id is null then 'goal.create' else 'goal.update' end,
          'savings_goal', v_id,
          jsonb_build_object('name', trim(p_name), 'targetMinor', p_target_minor::text,
                             'targetDate', p_target_date, 'accountId', p_account_id,
                             'kind', v_kind::text, 'startBalanceMinor', v_start_balance::text));
  return v_id;
end;
$$;

revoke all on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) from public, anon;
grant execute on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- keel_goal_contribute: refuse contributions to debt goals. No signature
-- change, so create-or-replace is sufficient.
-- ---------------------------------------------------------------------------
create or replace function public.keel_goal_contribute(
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
  -- Debt-goal progress is derived from the ledger, never from a parallel
  -- earmark ledger: a contribution here would be double bookkeeping.
  if v_goal.kind = 'debt' then
    raise exception 'KEEL_DEBT_GOAL_NO_CONTRIB' using errcode = 'P0009';
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

-- ---------------------------------------------------------------------------
-- keel_goal_set_status: restoring to 'active' recomputes 'reached'. Branch on
-- kind — debt derives from the ledger, savings from Σ contributions.
-- ---------------------------------------------------------------------------
create or replace function public.keel_goal_set_status(
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
  v_goal public.savings_goals%rowtype;
  v_ledger_account_id uuid;
  v_raw_balance bigint;
  v_paid bigint;
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
  -- 'reached' is derived (from Σ contributions or the ledger vs target),
  -- never set by hand.
  if p_status is null or p_status not in ('active', 'archived') then
    raise exception 'KEEL_INVALID_STATUS: %', coalesce(p_status, '<null>') using errcode = 'P0009';
  end if;

  select * into v_goal from public.savings_goals
    where id = p_goal_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
  end if;
  v_before := v_goal.status;

  -- Restoring recomputes active vs reached instead of blindly trusting the caller.
  if p_status = 'active' then
    if v_goal.kind = 'debt' then
      select a.ledger_account_id into v_ledger_account_id
        from public.accounts a where a.id = v_goal.account_id;
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_paid := greatest(coalesce(v_goal.start_balance_minor, 0) - greatest(-v_raw_balance, 0), 0);
      p_status := case when v_paid >= v_goal.target_minor then 'reached' else 'active' end;
    else
      select case
        when coalesce(sum(amount_minor), 0) >= v_goal.target_minor
        then 'reached' else 'active' end
        into p_status
        from public.goal_contributions where goal_id = p_goal_id;
    end if;
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

-- ---------------------------------------------------------------------------
-- keel_list_goals: emit kind; debt goals additionally emit paidMinor
-- (derived, floored at 0) and currentBalanceMinor from live postings.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_goals(p_household_id uuid)
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
           'kind', g.kind,
           'savedMinor', coalesce(c.saved, 0)::text
         ) || case when g.kind = 'debt' then jsonb_build_object(
                'paidMinor', greatest(
                  coalesce(g.start_balance_minor, 0) - greatest(-coalesce(lb.raw_balance, 0), 0), 0
                )::text,
                'currentBalanceMinor', greatest(-coalesce(lb.raw_balance, 0), 0)::text
              ) else '{}'::jsonb end
         order by g.status, g.target_date nulls last, g.name), '[]'::jsonb)
    into v_rows
    from public.savings_goals g
    left join lateral (
      select sum(gc.amount_minor) as saved
        from public.goal_contributions gc where gc.goal_id = g.id
    ) c on true
    left join lateral (
      select sum(jp.amount_minor) as raw_balance
        from public.accounts a
        join public.journal_postings jp on jp.ledger_account_id = a.ledger_account_id
        where a.id = g.account_id
    ) lb on g.kind = 'debt'
    where g.household_id = p_household_id;
  return v_rows;
end;
$$;

revoke all on function public.keel_list_goals(uuid) from public, anon;
grant execute on function public.keel_list_goals(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Export (Law 6): savings_goals gained 2 columns. The 20260713150000
-- _pre_goals wrapper link is already on main (possibly deployed) — add a NEW
-- chain link rather than editing it. Table count stays 67 (columns only).
-- ---------------------------------------------------------------------------
alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_debt_goals;
revoke all on function public.keel_export_household_pre_debt_goals(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_debt_goals(p_household_id, p_as_of);
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
      'created_at', to_char(x.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'kind', x.kind::text,
      'start_balance_minor', x.start_balance_minor::text
    ) order by x.id)
      from public.savings_goals x where x.household_id = p_household_id), '[]'::jsonb)
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

-- ---------------------------------------------------------------------------
-- Ownership hardening (same rationale as 20260713170000 for schedules): the
-- goal procs run SECURITY DEFINER; the migration runner is a superuser
-- locally, a needlessly large blast radius. keel_api owns them; grants +
-- definer_all policies make every table the bodies touch reachable.
-- ---------------------------------------------------------------------------
grant select, insert, update on public.savings_goals to keel_api;
grant select, insert on public.goal_contributions to keel_api;
drop policy if exists savings_goals_definer_all on public.savings_goals;
create policy savings_goals_definer_all on public.savings_goals
  for all to keel_api using (true) with check (true);
drop policy if exists goal_contributions_definer_all on public.goal_contributions;
create policy goal_contributions_definer_all on public.goal_contributions
  for all to keel_api using (true) with check (true);

alter function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) owner to keel_api;
alter function public.keel_goal_contribute(uuid,uuid,bigint,date) owner to keel_api;
alter function public.keel_goal_set_status(uuid,uuid,text) owner to keel_api;
alter function public.keel_list_goals(uuid) owner to keel_api;

-- ACLs survive OWNER TO; restated per house style.
revoke all on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) from public, anon;
grant execute on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) to authenticated;
revoke all on function public.keel_goal_contribute(uuid,uuid,bigint,date) from public, anon;
grant execute on function public.keel_goal_contribute(uuid,uuid,bigint,date) to authenticated;
revoke all on function public.keel_goal_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_goal_set_status(uuid,uuid,text) to authenticated;
revoke all on function public.keel_list_goals(uuid) from public, anon;
grant execute on function public.keel_list_goals(uuid) to authenticated, service_role;
