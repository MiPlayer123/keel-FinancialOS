-- Debt-goal polish (Codex PR-review findings on #6, both P2):
-- 1. A debt target larger than the captured balance (or a zero balance at
--    creation) is permanently unachievable — paidMinor is capped by
--    start_balance_minor. Reject both at save time with typed errors.
-- 2. keel_list_goals returned the STORED status for debt goals, but payments
--    only create postings — nothing flips status until an unrelated edit or
--    restore. Status is derived state (batch-6 doctrine), so the list now
--    derives active/reached for debt goals at read time (archived preserved).
-- 20260713180000 is already applied in prod, so these land as a new
-- migration with create-or-replace, not edits to the shipped file.

create or replace function public.keel_goal_save(
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
    if p_target_date is not null and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;

    if v_kind = 'debt' then
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_start_balance := greatest(-v_raw_balance, 0);
      -- Unachievable goals are refused up front: paidMinor is capped by the
      -- captured balance, so a larger target could never be reached.
      if v_start_balance = 0 then
        raise exception 'KEEL_DEBT_GOAL_NOTHING_OWED' using errcode = 'P0009';
      end if;
      if p_target_minor > v_start_balance then
        raise exception 'KEEL_DEBT_GOAL_TARGET_EXCEEDS_BALANCE' using errcode = 'P0009';
      end if;
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
    if v_kind is distinct from v_row.kind then
      raise exception 'KEEL_GOAL_KIND_IMMUTABLE' using errcode = 'P0009';
    end if;
    if v_row.kind = 'debt'
       and p_account_id is distinct from v_row.account_id then
      raise exception 'KEEL_DEBT_GOAL_ACCOUNT_IMMUTABLE' using errcode = 'P0009';
    end if;
    -- Raising a debt target past the captured baseline is the same
    -- unachievable trap on the edit path.
    if v_row.kind = 'debt'
       and p_target_minor > coalesce(v_row.start_balance_minor, 0) then
      raise exception 'KEEL_DEBT_GOAL_TARGET_EXCEEDS_BALANCE' using errcode = 'P0009';
    end if;
    if p_target_date is not null
       and p_target_date is distinct from v_row.target_date
       and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;
    if p_account_id is null then
      v_currency := v_row.currency;
    end if;

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

-- Derived status at read time for debt goals: paying the card is the only
-- state change a debt goal has, and it happens in the ledger, not here.
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
           'status', case
             when g.kind = 'debt' and g.status <> 'archived' then
               case when greatest(
                 coalesce(g.start_balance_minor, 0) - greatest(-coalesce(lb.raw_balance, 0), 0), 0
               ) >= g.target_minor then 'reached'::public.goal_status
               else 'active'::public.goal_status end
             else g.status
           end,
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

-- create-or-replace preserves owner (keel_api) and ACLs; restated per house style.
revoke all on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) from public, anon;
grant execute on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) to authenticated;
revoke all on function public.keel_list_goals(uuid) from public, anon;
grant execute on function public.keel_list_goals(uuid) to authenticated, service_role;
